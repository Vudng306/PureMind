import json
import uuid

import httpx
import pytest
from sqlalchemy import func, select, update

from app.core.config import get_settings
from app.core.messages import MSG
from app.db.session import SessionLocal
from app.models import ChatConversation, ChatMessage, DocumentChunk, User
from app.services import ai_quota, doc_chat, embeddings, openai_client
from app.services.openai_client import AIError, Usage
from tests.pdfs import text_pdf
from tests.test_summaries import consent, new_doc

# The fake embedding of a text counts these phrases, so a question about page 3 really is nearest the
# passage that mentions page 3 — the ranking itself is exercised, not stubbed out.
VOCAB = ("page 1", "page 2", "page 3", "chapter", "machine learning")


def fake_vector(text: str) -> list[float]:
    lowered = text.lower()
    return [float(lowered.count(word)) for word in VOCAB] + [0.5]


class FakeEmbed:
    def __init__(self):
        self.calls: list[tuple[str, list[str]]] = []

    async def __call__(self, settings, texts, *, purpose, usage):
        self.calls.append((purpose, list(texts)))
        usage.add(Usage(len(texts), 0))
        return [fake_vector(t) for t in texts]

    def purposes(self, name: str) -> int:
        return sum(1 for purpose, _ in self.calls if purpose == name)


class FakeAnswer:
    """Stands in for the streamed OpenAI answer; answers are used in order (an Exception is raised)."""

    def __init__(self, *answers: str | Exception):
        self.answers = list(answers)
        self.calls: list[list[dict]] = []

    def __call__(self, settings, messages, usage):
        self.calls.append(messages)
        answer = self.answers.pop(0) if len(self.answers) > 1 else self.answers[0]

        async def stream():
            if isinstance(answer, Exception):
                raise answer
            usage.add(Usage(120, 30))
            for word in answer.split(" "):
                yield word + " "

        return stream()

    @property
    def passages(self) -> str:
        """The passages given to the model in the last call."""
        return self.calls[-1][-1]["content"]


@pytest.fixture
def chat_ai(monkeypatch):
    settings = get_settings()
    monkeypatch.setattr(settings, "openai_api_key", "sk-test")
    monkeypatch.setattr(settings, "openai_model", "gpt-test")
    monkeypatch.setattr(settings, "openai_chat_model", "gpt-ask-test")
    from app.api.routes import chat

    chat._running.clear()
    embed = FakeEmbed()
    monkeypatch.setattr(embeddings, "embed", embed)

    def install(*answers: str | Exception) -> tuple[FakeEmbed, FakeAnswer]:
        answer = FakeAnswer(*answers)
        monkeypatch.setattr(doc_chat, "answer", answer)
        return embed, answer

    return install


async def start(client, headers, pdf: bytes | None = None) -> tuple[str, str]:
    """A document with text, consent given and an empty conversation."""
    doc = await new_doc(client, headers, pdf or text_pdf(3))
    await consent(client, headers)
    r = await client.post(f"/api/documents/{doc}/chat/conversations", headers=headers)
    assert r.status_code == 201, r.text
    return doc, r.json()["id"]


async def messages_in(conversation_id: str) -> int:
    async with SessionLocal() as session:
        return await session.scalar(
            select(func.count())
            .select_from(ChatMessage)
            .where(ChatMessage.conversation_id == uuid.UUID(conversation_id))
        )


async def ask(client, headers, doc: str, conv: str, question: str, **body):
    return await client.post(
        f"/api/documents/{doc}/chat/conversations/{conv}/messages",
        headers=headers,
        json={"content": question, **body},
    )


async def test_question_is_answered_from_the_document(client, auth, chat_ai):
    h = auth()
    embed, answer = chat_ai("Tài liệu nói về học máy [2] và có ví dụ [3].")
    doc = await new_doc(client, h, text_pdf(3))

    # Nothing is sent before the user agrees (NFR-PRV).
    r = await client.post(f"/api/documents/{doc}/chat/conversations", headers=h)
    conv = r.json()["id"]
    r = await ask(client, h, doc, conv, "Tài liệu này nói về gì?")
    assert r.status_code == 403 and not embed.calls and not answer.calls
    await consent(client, h)

    r = await ask(client, h, doc, conv, "Tài liệu này nói về gì?")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["question"]["role"] == "user" and body["question"]["content"] == "Tài liệu này nói về gì?"
    assert body["answer"]["role"] == "assistant"
    assert body["answer"]["content"].startswith("Tài liệu nói về học máy [2]")
    assert body["answer"]["ai_model"] == "gpt-ask-test"  # questions use the stronger model
    # Only the cited passages are kept with the answer, numbered as the model saw them.
    assert [c["position"] for c in body["answer"]["citations"]] == [2, 3]
    assert all(c["page_number"] in (1, 2, 3) for c in body["answer"]["citations"])
    assert body["chat_quota_remaining"] == get_settings().chat_daily_quota - 1

    # The document was indexed once, the question embedded separately.
    assert embed.purposes("chat_index") == 1 and embed.purposes("chat_query") == 1
    async with SessionLocal() as session:
        chunks = await session.scalar(
            select(func.count()).select_from(DocumentChunk).where(DocumentChunk.document_id == uuid.UUID(doc))
        )
        assert chunks >= 3
        stored = await session.scalar(
            select(ChatMessage.prompt_tokens).where(ChatMessage.role == "assistant")
        )
        assert stored == 120

    # The thread is stored, named after the first question, and listed for this document.
    r = await client.get(f"/api/documents/{doc}/chat/conversations/{conv}", headers=h)
    assert r.status_code == 200
    assert [m["content"] for m in r.json()["messages"]] == [
        "Tài liệu này nói về gì?",
        "Tài liệu nói về học máy [2] và có ví dụ [3].",
    ]
    r = await client.get(f"/api/documents/{doc}/chat/conversations", headers=h)
    assert r.status_code == 200
    assert r.json()[0]["title"] == "Tài liệu này nói về gì?" and r.json()[0]["message_count"] == 2
    assert (await client.get("/api/account", headers=h)).json()["chat_quota_remaining"] == 49


async def test_passages_match_the_question_and_are_indexed_once(client, auth, chat_ai):
    h = auth()
    embed, answer = chat_ai("Trang 3 nói về học máy [1].")
    doc, conv = await start(client, h)

    assert (await ask(client, h, doc, conv, "What is written on page 3?")).status_code == 200
    first = answer.passages
    assert "page 3" in first and "<passages>" in first and "Question: What is written on page 3?" in first

    # A second question reuses the index and carries the earlier turns into the prompt.
    assert (await ask(client, h, doc, conv, "And page 1?")).status_code == 200
    assert embed.purposes("chat_index") == 1 and embed.purposes("chat_query") == 2
    roles = [m["role"] for m in answer.calls[-1]]
    assert roles == ["system", "user", "assistant", "user"]
    assert answer.calls[-1][1]["content"] == "What is written on page 3?"  # the earlier question


async def test_streaming_sends_sources_then_the_answer(client, auth, chat_ai):
    h = auth()
    _, answer = chat_ai("Câu trả lời ngắn [1].")
    doc, conv = await start(client, h)

    async with client.stream(
        "POST",
        f"/api/documents/{doc}/chat/conversations/{conv}/messages",
        headers={**h, "Accept": "text/event-stream"},
        json={"content": "Nói về chương 1?", "quote": "Chapter 1"},
    ) as res:
        assert res.status_code == 200
        events = []
        async for line in res.aiter_lines():
            if line.startswith("event:"):
                events.append([line[6:].strip(), ""])
            elif line.startswith("data:") and events:
                events[-1][1] += line[5:].strip()

    names = [name for name, _ in events]
    assert names[0] == "sources" and "delta" in names and names[-1] == "done"
    sources = json.loads(events[0][1])["sources"]
    assert sources and sources[0]["position"] == 1 and "text" in sources[0]
    streamed = "".join(json.loads(data)["text"] for name, data in events if name == "delta")
    done = json.loads(events[-1][1])
    assert streamed.strip() == "Câu trả lời ngắn [1]." == done["answer"]["content"]
    # The selected passage is passed to the model as part of the question (FR-CHAT-02).
    assert "Chapter 1" in answer.passages


async def test_a_failed_answer_is_not_stored_and_costs_nothing(client, auth, chat_ai):
    h = auth()
    chat_ai(AIError("boom"))
    doc, conv = await start(client, h)

    r = await ask(client, h, doc, conv, "Câu hỏi?")
    assert r.status_code == 502 and r.json()["detail"] == MSG["MSG-26"]
    assert await messages_in(conv) == 0
    assert (await client.get("/api/account", headers=h)).json()["chat_quota_remaining"] == 50


async def test_question_limits_and_quota(client, auth, chat_ai):
    h = auth()
    chat_ai("Trả lời [1].")
    doc, conv = await start(client, h)

    r = await ask(client, h, doc, conv, "   ")
    assert r.status_code == 422 and r.json()["detail"] == MSG["MSG-CHAT-EMPTY"]
    r = await ask(client, h, doc, conv, "x" * 2001)
    assert r.status_code == 422 and r.json()["detail"] == MSG["MSG-CHAT-LONG"]

    # No questions left today.
    async with SessionLocal() as session:
        await session.execute(update(User).values(chat_quota_used=50, chat_quota_date=ai_quota.today_vn()))
        await session.commit()
    r = await ask(client, h, doc, conv, "Còn lượt không?")
    assert r.status_code == 429 and r.json()["detail"] == MSG["MSG-CHAT-QUOTA"]


async def test_conversations_are_private_and_deletable(client, auth, chat_ai):
    h, other = auth(), auth()
    chat_ai("Trả lời [1].")
    doc, conv = await start(client, h)
    assert (await ask(client, h, doc, conv, "Câu hỏi?")).status_code == 200

    # Someone else's conversation is simply not found (NFR-SEC-04).
    assert (
        await client.get(f"/api/documents/{doc}/chat/conversations/{conv}", headers=other)
    ).status_code == 404
    r = await ask(client, other, doc, conv, "Của người khác?")
    assert r.status_code == 404 and r.json()["detail"] in (MSG["MSG-19"], MSG["MSG-CHAT-NOT-FOUND"])

    assert (
        await client.delete(f"/api/documents/{doc}/chat/conversations/{conv}", headers=h)
    ).status_code == 204
    assert await messages_in(conv) == 0  # the turns go with the thread

    # Deleting the document takes its conversations and indexed passages with it.
    doc2, conv2 = await start(client, h)
    assert (await ask(client, h, doc2, conv2, "Câu hỏi khác?")).status_code == 200
    assert (await client.delete(f"/api/documents/{doc2}", headers=h)).status_code == 204
    async with SessionLocal() as session:
        left = await session.scalar(
            select(func.count())
            .select_from(ChatConversation)
            .where(ChatConversation.document_id == uuid.UUID(doc2))
        )
        chunks = await session.scalar(
            select(func.count())
            .select_from(DocumentChunk)
            .where(DocumentChunk.document_id == uuid.UUID(doc2))
        )
        assert left == 0 and chunks == 0


async def test_a_document_without_text_cannot_be_chatted_with(client, auth, chat_ai):
    from tests.pdfs import image_only_pdf

    h = auth()
    chat_ai("Trả lời [1].")
    await consent(client, h)
    doc = await new_doc(client, h, image_only_pdf())
    r = await client.post(f"/api/documents/{doc}/chat/conversations", headers=h)
    assert r.status_code == 422 and r.json()["detail"] == MSG["MSG-CHAT-NO-TEXT"]


def test_split_chunks_keeps_headings_and_pages():
    content = "# Chương 1\n\nMở đầu về học máy trong tài liệu này.\n\n---\n\n## Mục 1.1\n\nNội dung mục 1.1 đủ dài để thành một đoạn riêng."
    chunks = doc_chat.split_chunks(content, 400, page_count=2)
    assert [c.page_number for c in chunks] == [1, 2]
    assert [c.heading for c in chunks] == ["Chương 1", "Mục 1.1"]
    assert [c.position for c in chunks] == [1, 2]
    assert chunks[0].labelled().startswith("Chương 1\n")

    # Without a matching page count the passages carry no page number, only their heading.
    assert all(c.page_number is None for c in doc_chat.split_chunks(content, 400, page_count=9))
    assert doc_chat.split_chunks("", 400) == []


def test_long_paragraphs_are_split_and_stubs_merged():
    content = "## Đề mục\n\n" + ("từ " * 900)
    chunks = doc_chat.split_chunks(content, 100)
    assert len(chunks) > 1
    assert all(c.token_count <= 110 for c in chunks)
    assert chunks[0].text.startswith("## Đề mục")  # the heading alone is never a passage of its own
    assert [c.position for c in chunks] == list(range(1, len(chunks) + 1))


def test_vectors_round_trip_and_compare():
    vector = [0.123456789, -0.5, 0.0] + [0.1] * 3
    decoded = embeddings.decode(embeddings.encode(vector))
    assert len(decoded) == len(vector) and abs(decoded[0] - vector[0]) < 1e-6
    assert embeddings.cosine(decoded, decoded) == pytest.approx(1.0)
    assert embeddings.cosine([1.0, 0.0], [0.0, 1.0]) == 0.0
    assert embeddings.cosine([], [1.0]) == 0.0  # a stale index never wins the ranking
    assert embeddings.cosine([1.0, 0.0], [1.0]) == 0.0
    assert embeddings.decode("not json") == []


def test_titles_and_citations():
    assert doc_chat.title_from_question("  Học  máy là gì? ") == "Học máy là gì?"
    long = doc_chat.title_from_question("x" * 200)
    assert len(long) == doc_chat.MAX_TITLE and long.endswith("…")
    assert doc_chat.cited("Câu này [2] và câu kia [10][2].") == {2, 10}
    assert doc_chat.cited("Không có trích dẫn.") == set()


def _embeddings_reply(count: int, dims: int) -> httpx.Response:
    # Answered out of order on purpose: the client sorts by `index` before handing the vectors back.
    return httpx.Response(
        200,
        json={
            "data": [{"index": i, "embedding": [0.1] * dims} for i in reversed(range(count))],
            "usage": {"prompt_tokens": count},
        },
    )


async def test_embeddings_are_batched_and_retried(monkeypatch):
    dims = 3
    sizes: list[int] = []
    replies = [
        httpx.Response(500),
        _embeddings_reply(embeddings.BATCH, dims),
        _embeddings_reply(6, dims),
    ]

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        sizes.append(len(body["input"]))
        assert request.headers["Authorization"] == "Bearer sk-x"
        assert body["dimensions"] == dims
        return replies.pop(0)

    real = httpx.AsyncClient
    monkeypatch.setattr(
        embeddings.httpx, "AsyncClient", lambda **kw: real(transport=httpx.MockTransport(handler), **kw)
    )
    settings = get_settings().model_copy(update={"openai_api_key": "sk-x", "embedding_dimensions": dims})

    usage = Usage()
    vectors = await embeddings.embed(
        settings, [f"đoạn {i}" for i in range(embeddings.BATCH + 6)], purpose="t", usage=usage
    )
    assert len(vectors) == embeddings.BATCH + 6 and all(len(v) == dims for v in vectors)
    assert sizes == [embeddings.BATCH, embeddings.BATCH, 6]  # the 500 is retried once, then the rest
    assert usage.prompt_tokens == embeddings.BATCH + 6


async def test_embeddings_of_the_wrong_shape_fail(monkeypatch):
    real = httpx.AsyncClient
    monkeypatch.setattr(
        embeddings.httpx,
        "AsyncClient",
        lambda **kw: real(transport=httpx.MockTransport(lambda _: _embeddings_reply(1, 2)), **kw),
    )
    settings = get_settings().model_copy(update={"openai_api_key": "sk-x", "embedding_dimensions": 3})
    with pytest.raises(AIError):
        await embeddings.embed(settings, ["một đoạn"], purpose="t", usage=Usage())


async def test_a_question_uses_the_stronger_model(monkeypatch):
    """A question goes to openai_chat_model; summaries and notebooks stay on the cheaper default."""
    seen: list[dict] = []
    chunk = {
        "choices": [{"delta": {"content": "Có."}, "finish_reason": "stop"}],
        "usage": {"prompt_tokens": 9, "completion_tokens": 2},
    }

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(json.loads(request.content))
        return httpx.Response(200, text=f"data: {json.dumps(chunk)}\n\ndata: [DONE]\n\n")

    real = httpx.AsyncClient
    monkeypatch.setattr(
        openai_client.httpx, "AsyncClient", lambda **kw: real(transport=httpx.MockTransport(handler), **kw)
    )
    settings = get_settings().model_copy(
        update={"openai_api_key": "sk-x", "openai_model": "gpt-write", "openai_chat_model": "gpt-ask"}
    )

    usage = Usage()
    text = "".join([delta async for delta in doc_chat.answer(settings, [], usage)])
    assert text == "Có." and usage.prompt_tokens == 9
    assert seen[-1]["model"] == "gpt-ask" and seen[-1]["max_completion_tokens"] == doc_chat.MAX_ANSWER_TOKENS

    # A notebook names no model, so it keeps the default.
    async for _ in openai_client.chat_stream(settings, [], purpose="notebook", usage=Usage()):
        pass
    assert seen[-1]["model"] == "gpt-write"
