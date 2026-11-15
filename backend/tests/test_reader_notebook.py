"""Notes, the notebook by document, the reader's AI sidebar and keeping AI output as notes."""

import json
import uuid

import pytest
from sqlalchemy import func, select, update

from app.core.config import get_settings
from app.core.messages import MSG
from app.db.session import SessionLocal
from app.models import AiArtifact, Document, Note
from app.services import reader_ai
from app.services.doc_chat import Chunk
from app.services.openai_client import AIError, Completion, Usage
from tests.pdfs import text_pdf
from tests.test_chat import ask, chat_ai, start  # noqa: F401  (chat_ai is a fixture)
from tests.test_summaries import consent, new_doc

QUICK = {
    "tldr": "Tài liệu giới thiệu <b>học máy</b>.",
    "tldr_sources": [1, 99],
    "takeaways": [
        {"text": "Học máy là một lĩnh vực nghiên cứu.", "sources": [3]},
        {"text": "Mỗi chương nhắc lại định nghĩa.", "sources": [2, 3, 0]},
        {"text": "Không có số liệu thực nghiệm.", "sources": []},
    ],
}
DEEP = {
    "document_type": "research",
    "context": [{"text": "Bối cảnh của tài liệu.", "sources": [1]}],
    "core": [{"text": "Phương pháp được mô tả.", "sources": [2]}],
    "findings": [{"text": "Kết quả chính.", "sources": [3]}],
    "limitations": [],
    "questions": ["Học máy áp dụng ở đâu?"],
}


def node(node_id: str, parent: str, label: str, sources: list[int] | None = None) -> dict:
    return {"id": node_id, "parent": parent, "label": label, "detail": "", "sources": sources or []}


MAP = {
    "nodes": [
        node("n1", "", "Học máy"),
        node("n2", "n1", "Định nghĩa", [1]),
        node("n3", "n1", "Ví dụ", [2]),
        node("n4", "n2", "Lĩnh vực nghiên cứu", [1]),
        node("n5", "n2", "Dữ liệu", [3]),
        node("n6", "n3", "Chương hai", [2]),
    ]
}


class FakeAI:
    """Stands in for the OpenAI call; answers are used in order (an Exception is raised)."""

    def __init__(self, *answers):
        self.answers = list(answers)
        self.calls: list[dict] = []

    async def __call__(self, settings, messages, *, purpose, json_schema=None, max_tokens=4000):
        self.calls.append({"purpose": purpose, "messages": messages, "json_schema": json_schema})
        answer = self.answers.pop(0) if len(self.answers) > 1 else self.answers[0]
        if isinstance(answer, Exception):
            raise answer
        text = answer if isinstance(answer, str) else json.dumps(answer, ensure_ascii=False)
        return Completion(text, Usage(100, 20))


@pytest.fixture
def ai(monkeypatch):
    settings = get_settings()
    monkeypatch.setattr(settings, "openai_api_key", "sk-test")
    monkeypatch.setattr(settings, "openai_model", "gpt-test")
    from app.api.routes import reader_ai as routes

    routes._running.clear()

    def install(*answers) -> FakeAI:
        fake = FakeAI(*answers)
        monkeypatch.setattr(reader_ai, "chat", fake)
        return fake

    return install


async def highlight(client, headers, doc: str, text: str, note: str = "") -> str:
    r = await client.post(
        "/api/highlights",
        headers=headers,
        json={
            "document_id": doc,
            "block_id": "b1",
            "start_offset": 0,
            "end_offset": len(text),
            "selected_text": text,
            "note": note,
        },
    )
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def add_note(client, headers, doc: str, body: str, **extra) -> dict:
    r = await client.post(f"/api/documents/{doc}/notes", headers=headers, json={"body": body, **extra})
    assert r.status_code in (200, 201), r.text
    return r.json()


# --- Notes ---------------------------------------------------------------------------------------------------


async def test_note_create_edit_delete(client, auth):
    h = auth()
    doc = await new_doc(client, h)

    client_id = str(uuid.uuid4())
    note = await add_note(client, h, doc, "Ôn lại chương 2", id=client_id)
    assert note["id"] == client_id and note["origin"] == "user" and note["provenance"] is None
    # The same note sent again (a retry) is not a second note.
    r = await client.post(f"/api/documents/{doc}/notes", headers=h, json={"id": client_id, "body": "x"})
    assert r.status_code == 200 and r.json()["body"] == "Ôn lại chương 2"
    await add_note(client, h, doc, "Ghi chú thứ hai")
    listed = (await client.get(f"/api/documents/{doc}/notes", headers=h)).json()
    assert [n["body"] for n in listed] == ["Ôn lại chương 2", "Ghi chú thứ hai"]

    r = await client.patch(f"/api/notes/{client_id}", headers=h, json={"body": "Đã sửa"})
    assert r.status_code == 200 and r.json()["body"] == "Đã sửa"
    assert (await client.patch(f"/api/notes/{client_id}", headers=h, json={"body": "   "})).status_code == 422
    assert (await client.post(f"/api/documents/{doc}/notes", headers=h, json={"body": ""})).status_code == 422

    assert (await client.delete(f"/api/notes/{client_id}", headers=h)).status_code == 204
    assert (await client.delete(f"/api/notes/{client_id}", headers=h)).status_code == 404
    assert len((await client.get(f"/api/documents/{doc}/notes", headers=h)).json()) == 1


async def test_notes_belong_to_their_owner(client, auth):
    h, other = auth(), auth()
    doc = await new_doc(client, h)
    note = await add_note(client, h, doc, "Riêng tư")
    await highlight(client, h, doc, "Machine learning")

    assert (await client.get(f"/api/documents/{doc}/notes", headers=other)).status_code == 404
    r = await client.post(f"/api/documents/{doc}/notes", headers=other, json={"body": "chen vào"})
    assert r.status_code == 404
    assert (
        await client.patch(f"/api/notes/{note['id']}", headers=other, json={"body": "x"})
    ).status_code == 404
    assert (await client.delete(f"/api/notes/{note['id']}", headers=other)).status_code == 404
    # Someone else's note id cannot be taken over either.
    mine = await new_doc(client, other)
    r = await client.post(f"/api/documents/{mine}/notes", headers=other, json={"id": note["id"], "body": "x"})
    assert r.status_code == 409

    assert (await client.get("/api/notebook/documents", headers=other)).json() == {"items": [], "total": 0}
    assert (await client.get(f"/api/notebook/documents/{doc}", headers=other)).status_code == 404
    assert (await client.get(f"/api/documents/{doc}/notes", headers=h)).json()[0]["body"] == "Riêng tư"


# --- The notebook by document -----------------------------------------------------------------------------


async def test_notebook_groups_one_document_with_exact_counts(client, auth):
    """AT-03: seven highlights and three notes on one document are one group, counted exactly."""
    h = auth()
    doc = await new_doc(client, h, text_pdf(3, title="Machine learning"))
    empty = await new_doc(client, h)  # no highlight, no note: not in the notebook

    assert (await client.get("/api/notebook/documents", headers=h)).json() == {"items": [], "total": 0}
    assert (await client.get(f"/api/notebook/documents/{doc}", headers=h)).status_code == 404

    # Two of the highlights carry a note; one more note is the document's own.
    for i in range(7):
        await highlight(client, h, doc, f"passage number {i}", "ý của tôi" if i < 2 else "")
    await add_note(client, h, doc, "Ghi chú tự do")

    body = (await client.get("/api/notebook/documents", headers=h)).json()
    assert body["total"] == 1 and len(body["items"]) == 1
    group = body["items"][0]
    assert (
        group["document_id"] == doc and group["title"] == "Machine learning" and group["file_type"] == "pdf"
    )
    assert (group["highlight_count"], group["note_count"], group["insight_count"]) == (7, 3, 0)
    assert empty not in [g["document_id"] for g in body["items"]]

    detail = (await client.get(f"/api/notebook/documents/{doc}", headers=h)).json()
    assert detail["group"] == group
    assert len(detail["highlights"]) == 7 and [n["body"] for n in detail["notes"]] == ["Ghi chú tự do"]
    # A highlight's note comes with its highlight, not as an item of its own.
    assert sum(1 for x in detail["highlights"] if x["note"]) == 2

    # A second document with one note gets a group of its own, first because it was worked on last.
    await add_note(client, h, empty, "Mới nhất")
    items = (await client.get("/api/notebook/documents", headers=h)).json()["items"]
    assert [g["document_id"] for g in items] == [empty, doc]


async def test_notebook_orders_highlights_as_in_the_document(client, auth):
    h = auth()
    doc = await new_doc(client, h, text_pdf(3))
    last = await highlight(client, h, doc, "field of study, page 3")
    first = await highlight(client, h, doc, "field of study, page 1")
    lost = await highlight(client, h, doc, "words that are not in the text")

    by_document = (await client.get(f"/api/notebook/documents/{doc}", headers=h)).json()["highlights"]
    assert [x["id"] for x in by_document] == [first, last, lost]
    newest = (await client.get(f"/api/notebook/documents/{doc}?sort=newest", headers=h)).json()
    assert {x["id"] for x in newest["highlights"]} == {first, last, lost}


async def test_notebook_search_and_sync_with_the_reader(client, auth):
    h = auth()
    doc = await new_doc(client, h, text_pdf(2, title="Machine learning"))
    other = await new_doc(client, h, text_pdf(2, title="Statistics"))
    hl = await highlight(client, h, doc, "gradient descent updates weights", "ask about regularisation")
    await highlight(client, h, other, "the mean of a sample")
    note = await add_note(client, h, doc, "review gradient descent before the exam")

    found = (await client.get("/api/notebook/documents?q=gradient", headers=h)).json()
    assert [(g["document_id"], g["match_count"]) for g in found["items"]] == [(doc, 2)]
    by_note = (await client.get("/api/notebook/documents?q=regularisation", headers=h)).json()["items"]
    assert [g["document_id"] for g in by_note] == [doc]
    by_title = (await client.get("/api/notebook/documents?q=statistics", headers=h)).json()["items"]
    assert [(g["document_id"], g["match_count"]) for g in by_title] == [(other, 0)]
    assert (await client.get("/api/notebook/documents?q=nothing-like-this", headers=h)).json()["total"] == 0

    # One record: what the reader deletes is gone from the notebook, and the last one takes the group away.
    assert (await client.delete(f"/api/highlights/{hl}", headers=h)).status_code == 204
    group = (await client.get(f"/api/notebook/documents/{doc}", headers=h)).json()["group"]
    assert (group["highlight_count"], group["note_count"]) == (0, 1)
    assert (await client.delete(f"/api/notes/{note['id']}", headers=h)).status_code == 204
    assert (await client.get(f"/api/notebook/documents/{doc}", headers=h)).status_code == 404

    # The global search finds a note by its text.
    await add_note(client, h, doc, "remember the bias variance tradeoff")
    notes = (await client.get("/api/search?q=variance", headers=h)).json()["notes"]
    assert notes["total"] == 1 and notes["items"][0]["kind"] == "document_note"
    usage = (await client.get(f"/api/documents/{doc}/usage", headers=h)).json()
    assert usage["notes"] == 1


# --- The AI sidebar ----------------------------------------------------------------------------------------


async def test_quick_summary_is_made_once_and_cites_real_passages(client, auth, ai):
    h = auth()
    doc = await new_doc(client, h, text_pdf(3))
    fake = ai(QUICK)

    # Nothing is sent before the user agrees (NFR-PRV).
    r = await client.post(f"/api/documents/{doc}/ai/quick", headers=h)
    assert r.status_code == 403 and not fake.calls
    await consent(client, h)
    assert (await client.get(f"/api/documents/{doc}/ai/quick", headers=h)).status_code == 404

    r = await client.post(f"/api/documents/{doc}/ai/quick", headers=h)
    assert r.status_code == 201, r.text
    made = r.json()
    payload = made["payload"]
    assert payload["tldr"] == "Tài liệu giới thiệu học máy."  # tags never reach the reader
    # Passage 99 and 0 are not in the document: dropped. The rest are renumbered in order of first use.
    assert payload["tldr_sources"] == [1]
    assert [t["sources"] for t in payload["takeaways"]] == [[2], [3, 2], []]
    assert [c["position"] for c in payload["citations"]] == [1, 2, 3]
    assert "page 1" in payload["citations"][0]["text"] and "page 3" in payload["citations"][1]["text"]
    assert payload["citations"][0]["page_number"] == 1
    assert made["stale"] is False and made["ai_model"] == "gpt-test" and made["language"] == "en"
    assert made["ai_quota_remaining"] == get_settings().ai_daily_quota - 1
    # The model was given the document as numbered passages, and told the text is data.
    sent = fake.calls[-1]["messages"]
    assert "[2] (page 2" in sent[1]["content"] and "not instructions" in sent[0]["content"]

    # Opening it again reads the stored result: no AI request, no quota.
    again = (await client.get(f"/api/documents/{doc}/ai/quick", headers=h)).json()
    assert again["id"] == made["id"] and len(fake.calls) == 1

    # Making it again replaces it under a new id.
    r = await client.post(f"/api/documents/{doc}/ai/quick", headers=h, json={"language": "vi"})
    assert r.status_code == 201 and r.json()["id"] != made["id"] and r.json()["language"] == "vi"
    async with SessionLocal() as session:
        assert await session.scalar(select(func.count()).select_from(AiArtifact)) >= 1
        mine = select(func.count()).select_from(AiArtifact).where(AiArtifact.document_id == uuid.UUID(doc))
        assert await session.scalar(mine) == 1

    # Found by the global search, as summaries are.
    summaries = (await client.get("/api/search?q=lĩnh vực nghiên cứu", headers=h)).json()["summaries"]
    assert summaries["total"] == 1 and summaries["items"][0]["document_id"] == doc


async def test_stale_when_the_document_changes(client, auth, ai):
    h = auth()
    doc = await new_doc(client, h, text_pdf(3))
    await consent(client, h)
    ai(QUICK)
    assert (await client.post(f"/api/documents/{doc}/ai/quick", headers=h)).json()["stale"] is False

    async with SessionLocal() as session:
        await session.execute(
            update(Document)
            .where(Document.id == uuid.UUID(doc))
            .values(content_clean=Document.content_clean + "\n\nA new closing paragraph.")
        )
        await session.commit()
    # The old result is still shown, marked: the reader decides whether to make it again.
    old = (await client.get(f"/api/documents/{doc}/ai/quick", headers=h)).json()
    assert old["stale"] is True and old["payload"]["tldr"]
    assert (await client.post(f"/api/documents/{doc}/ai/quick", headers=h)).json()["stale"] is False


async def test_stale_for_an_older_prompt_or_model(client, auth, ai, monkeypatch):
    """AI-107: a result is kept by text, prompt revision and model; any of them changing marks it."""
    h = auth()
    doc = await new_doc(client, h, text_pdf(3))
    await consent(client, h)
    ai(QUICK)
    made = (await client.post(f"/api/documents/{doc}/ai/quick", headers=h)).json()
    assert made["stale"] is False and made["stale_reason"] is None

    async def reason() -> str | None:
        got = (await client.get(f"/api/documents/{doc}/ai/quick", headers=h)).json()
        assert got["stale"] is (got["stale_reason"] is not None)
        return got["stale_reason"]

    async def set_revision(n: int):
        async with SessionLocal() as session:
            await session.execute(update(AiArtifact).values(prompt_revision=n))
            await session.commit()

    await set_revision(reader_ai.PROMPT_REVISION - 1)
    assert await reason() == "prompt"
    await set_revision(reader_ai.PROMPT_REVISION)
    monkeypatch.setattr(get_settings(), "openai_model", "gpt-newer")
    assert await reason() == "model"
    # Another text says the most, so it is the reason given.
    async with SessionLocal() as session:
        await session.execute(
            update(Document).where(Document.id == uuid.UUID(doc)).values(content_clean="Another text.")
        )
        await session.commit()
    assert await reason() == "content"


async def test_the_model_is_told_what_the_text_leaves_out(client, auth, ai):
    """TSD 6.1: pages that could not be read are named in the prompt, so a gap is not taken for an absence."""
    h = auth()
    doc = await new_doc(client, h, text_pdf(3))
    await consent(client, h)
    fake = ai(QUICK)
    assert (await client.post(f"/api/documents/{doc}/ai/quick", headers=h)).status_code == 201
    assert "Note on this text" not in fake.calls[-1]["messages"][1]["content"]

    async with SessionLocal() as session:
        await session.execute(
            update(Document)
            .where(Document.id == uuid.UUID(doc))
            .values(extraction_issues=[{"code": "scanned_pages", "count": 1, "pages": [2]}])
        )
        await session.commit()
    assert (await client.post(f"/api/documents/{doc}/ai/quick", headers=h)).status_code == 201
    sent = fake.calls[-1]["messages"][1]["content"]
    assert "1 scanned page(s) (page 2) could not be read" in sent


async def test_failed_or_ungrounded_answers_store_nothing(client, auth, ai):
    h = auth()
    doc = await new_doc(client, h, text_pdf(3))
    await consent(client, h)

    # No point rests on a passage of the document: asked once more, then refused.
    ungrounded = {
        **QUICK,
        "tldr_sources": [50],
        "takeaways": [{**t, "sources": []} for t in QUICK["takeaways"]],
    }
    fake = ai(ungrounded)
    r = await client.post(f"/api/documents/{doc}/ai/quick", headers=h)
    assert r.status_code == 502 and r.json()["detail"] == MSG["MSG-26"] and len(fake.calls) == 2

    ai(AIError("down"))
    assert (await client.post(f"/api/documents/{doc}/ai/deep", headers=h)).status_code == 502
    assert (await client.get(f"/api/documents/{doc}/ai/quick", headers=h)).status_code == 404

    # An invalid answer followed by a valid one is fine.
    fake = ai("not json", DEEP)
    r = await client.post(f"/api/documents/{doc}/ai/deep", headers=h)
    assert r.status_code == 201 and len(fake.calls) == 2
    # The failures before cost nothing: this is the day's first request.
    assert r.json()["ai_quota_remaining"] == get_settings().ai_daily_quota - 1
    deep = r.json()["payload"]
    assert deep["document_type"] == "research" and deep["limitations"] == []
    assert deep["questions"] == ["Học máy áp dụng ở đâu?"]

    assert (await client.post(f"/api/documents/{doc}/ai/poem", headers=h)).status_code == 422


async def test_ai_gates(client, auth, ai, monkeypatch):
    h, other = auth(), auth()
    doc = await new_doc(client, h, text_pdf(3))
    await consent(client, h)
    await consent(client, other)
    fake = ai(QUICK)

    # Someone else's document looks like a missing one.
    assert (await client.post(f"/api/documents/{doc}/ai/quick", headers=other)).status_code == 404
    assert (await client.get(f"/api/documents/{doc}/ai/quick", headers=other)).status_code == 404

    monkeypatch.setattr(get_settings(), "ai_daily_quota", 0)
    r = await client.post(f"/api/documents/{doc}/ai/quick", headers=h)
    assert r.status_code == 429 and r.json()["detail"] == MSG["MSG-25"]
    monkeypatch.setattr(get_settings(), "ai_daily_quota", 20)

    monkeypatch.setattr(get_settings(), "openai_api_key", "")
    assert (await client.post(f"/api/documents/{doc}/ai/quick", headers=h)).status_code == 503
    assert not fake.calls

    # A document without text cannot be summarised.
    async with SessionLocal() as session:
        await session.execute(update(Document).where(Document.id == uuid.UUID(doc)).values(content_clean=""))
        await session.commit()
    monkeypatch.setattr(get_settings(), "openai_api_key", "sk-test")
    r = await client.post(f"/api/documents/{doc}/ai/quick", headers=h)
    assert r.status_code == 422 and r.json()["detail"] == MSG["MSG-15"] and not fake.calls


async def test_long_document_is_condensed_with_passage_numbers(client, auth, ai, monkeypatch):
    h = auth()
    doc = await new_doc(client, h, text_pdf(3))
    await consent(client, h)
    settings = get_settings()
    monkeypatch.setattr(settings, "summary_single_request_tokens", 10)
    monkeypatch.setattr(settings, "summary_chunk_tokens", 20)
    fake = ai(
        "- Machine learning is a field of study [1]", "- More of the same [2]", "- And again [3]", QUICK
    )

    r = await client.post(f"/api/documents/{doc}/ai/quick", headers=h)
    assert r.status_code == 201, r.text
    purposes = [c["purpose"] for c in fake.calls]
    assert purposes.count("reader_part") >= 2 and purposes[-1] == "reader_quick"
    assert "notes on consecutive parts" in fake.calls[-1]["messages"][1]["content"]


def chunks(n: int) -> list[Chunk]:
    return [Chunk(i, i, f"Section {i}", f"Text of passage {i}.", 5) for i in range(1, n + 1)]


def test_mind_map_becomes_one_bounded_tree():
    raw = {
        "nodes": [
            *MAP["nodes"],
            node("n7", "nowhere", "Mồ côi"),  # unknown parent
            node("a", "b", "Vòng"),  # a cycle that never reaches the root
            node("b", "a", "Lặp"),
            node("n2", "n1", "Trùng id"),  # an id used twice: the first one wins
            node("n8", "n6", "<script>alert(1)</script>Chi tiết", [9, 3]),
            node("n9", "n8", "Quá sâu"),  # depth 4
            node("n10", "n1", "   "),  # no label
        ]
    }
    tree = reader_ai.parse_mindmap(json.dumps(raw), chunks(3))
    ids = [n["id"] for n in tree["nodes"]]
    assert ids == ["n1", "n2", "n3", "n4", "n5", "n6", "n8"]  # breadth first, parents before children
    by_id = {n["id"]: n for n in tree["nodes"]}
    assert by_id["n1"]["parent"] is None and by_id["n1"]["depth"] == 0 and by_id["n8"]["depth"] == 3
    assert by_id["n8"]["label"] == "alert(1)Chi tiết" and by_id["n2"]["label"] == "Định nghĩa"
    assert all(n["parent"] in by_id for n in tree["nodes"][1:])
    # Sources are renumbered in order of first use and point at real passages only.
    assert by_id["n2"]["sources"] == [1] and by_id["n3"]["sources"] == [2] and by_id["n8"]["sources"] == [3]
    assert [c["text"] for c in tree["citations"]] == [f"Text of passage {i}." for i in (1, 2, 3)]

    two_roots = {"nodes": [*MAP["nodes"], node("r2", "", "Gốc thứ hai")]}
    with pytest.raises(ValueError):
        reader_ai.parse_mindmap(json.dumps(two_roots), chunks(3))
    with pytest.raises(ValueError):  # a root with one branch is not a map
        reader_ai.parse_mindmap(json.dumps({"nodes": MAP["nodes"][:2]}), chunks(3))

    wide = {"nodes": [node("n1", "", "Gốc"), *(node(f"c{i}", "n1", f"Nhánh {i}", [1]) for i in range(60))]}
    assert len(reader_ai.parse_mindmap(json.dumps(wide), chunks(3))["nodes"]) == reader_ai.MAX_MAP_NODES


# --- Save to notes -----------------------------------------------------------------------------------------


async def save(client, headers, source: str, source_id: str, part: str = "all"):
    return await client.post(
        "/api/notes/from-ai", headers=headers, json={"source": source, "source_id": source_id, "part": part}
    )


async def test_ai_output_reaches_the_notebook_only_when_saved(client, auth, ai):
    h, other = auth(), auth()
    doc = await new_doc(client, h, text_pdf(3))
    await consent(client, h)
    ai(QUICK)
    quick = (await client.post(f"/api/documents/{doc}/ai/quick", headers=h)).json()

    # Making a summary puts nothing in the notebook.
    assert (await client.get(f"/api/documents/{doc}/notes", headers=h)).json() == []
    assert (await client.get("/api/notebook/documents", headers=h)).json()["total"] == 0

    r = await save(client, h, "artifact", quick["id"], "takeaway:1")
    assert r.status_code == 201, r.text
    note = r.json()
    assert note["origin"] == "ai_saved" and note["body"] == "Mỗi chương nhắc lại định nghĩa. [3][2]"
    prov = note["provenance"]
    assert (prov["source"], prov["source_id"], prov["part"], prov["model"]) == (
        "quick",
        quick["id"],
        "takeaway:1",
        "gpt-test",
    )
    assert [c["position"] for c in prov["citations"]] == [2, 3] and "page 3" in prov["citations"][0]["text"]

    # A double click gives the same note, not two (AT-19).
    again = await save(client, h, "artifact", quick["id"], "takeaway:1")
    assert again.status_code == 200 and again.json()["id"] == note["id"]
    async with SessionLocal() as session:
        assert (
            await session.scalar(
                select(func.count())
                .select_from(Note)
                .where(Note.origin == "ai_saved", Note.document_id == uuid.UUID(doc))
            )
            == 1
        )

    whole = (await save(client, h, "artifact", quick["id"])).json()
    assert whole["body"].startswith("Tài liệu giới thiệu học máy. [1]\n\n- Học máy là một lĩnh vực")

    # It is in the notebook as an insight, apart from the reader's own notes.
    group = (await client.get("/api/notebook/documents", headers=h)).json()["items"][0]
    assert (group["highlight_count"], group["note_count"], group["insight_count"]) == (0, 0, 2)

    # Editing keeps where it came from; a regenerated summary does not change the saved note.
    r = await client.patch(f"/api/notes/{note['id']}", headers=h, json={"body": "Viết lại theo ý tôi"})
    assert r.json()["origin"] == "ai_saved" and r.json()["provenance"]["source"] == "quick"
    await client.post(f"/api/documents/{doc}/ai/quick", headers=h)
    kept = (await client.get(f"/api/documents/{doc}/notes", headers=h)).json()
    assert next(n["body"] for n in kept) == "Viết lại theo ý tôi" and len(kept) == 2
    assert (
        await save(client, h, "artifact", quick["id"], "tldr")
    ).status_code == 404  # the old result is gone

    # The text is read from the stored result: no such piece, no note; not the owner, no note.
    new = (await client.get(f"/api/documents/{doc}/ai/quick", headers=h)).json()
    assert (await save(client, h, "artifact", new["id"], "takeaway:9")).status_code == 422
    assert (await save(client, h, "artifact", new["id"], "node:n1")).status_code == 422
    assert (await save(client, other, "artifact", new["id"], "tldr")).status_code == 404
    r = await client.post(
        "/api/notes/from-ai",
        headers=h,
        json={"source": "artifact", "source_id": new["id"], "part": "tldr", "body": "injected"},
    )
    assert r.status_code == 201 and r.json()["body"] == "Tài liệu giới thiệu học máy. [1]"


async def test_save_deep_summary_and_mind_map_node(client, auth, ai):
    h = auth()
    doc = await new_doc(client, h, text_pdf(3))
    await consent(client, h)
    ai(DEEP)
    deep = (await client.post(f"/api/documents/{doc}/ai/deep", headers=h)).json()
    whole = (await save(client, h, "artifact", deep["id"])).json()["body"]
    assert (
        whole.split("\n\n")[1] == "Methodology\n- Phương pháp được mô tả. [2]"
    )  # research: a method section
    assert "Limitations" not in whole and whole.endswith("- Học máy áp dụng ở đâu?")
    question = (await save(client, h, "artifact", deep["id"], "question:0")).json()
    assert question["body"] == "Học máy áp dụng ở đâu?" and question["provenance"]["citations"] == []

    ai(MAP)
    r = await client.post(f"/api/documents/{doc}/ai/mindmap", headers=h)
    assert r.status_code == 201, r.text
    mindmap = r.json()
    saved = (await save(client, h, "artifact", mindmap["id"], "node:n2")).json()
    assert saved["body"] == "Học máy › Định nghĩa [1]\n- Lĩnh vực nghiên cứu [1]\n- Dữ liệu [3]"
    assert [c["position"] for c in saved["provenance"]["citations"]] == [1, 3]
    assert saved["provenance"]["source"] == "mindmap"
    assert (await save(client, h, "artifact", mindmap["id"], "node:zz")).status_code == 422


async def test_save_chat_answer(client, auth, chat_ai):  # noqa: F811
    h, other = auth(), auth()
    chat_ai("Tài liệu nói về học máy [2] và có ví dụ [3].")
    doc, conv = await start(client, h, text_pdf(3))
    turn = (await ask(client, h, doc, conv, "Tài liệu này nói về gì?")).json()

    assert (await save(client, h, "chat", turn["question"]["id"])).status_code == 404  # only answers
    assert (await save(client, other, "chat", turn["answer"]["id"])).status_code == 404
    r = await save(client, h, "chat", turn["answer"]["id"])
    assert r.status_code == 201, r.text
    note = r.json()
    assert note["document_id"] == doc and note["body"] == "Tài liệu nói về học máy [2] và có ví dụ [3]."
    assert note["provenance"]["source"] == "chat" and note["provenance"]["model"] == "gpt-ask-test"
    assert [c["position"] for c in note["provenance"]["citations"]] == [2, 3]
    assert (await save(client, h, "chat", turn["answer"]["id"])).json()["id"] == note["id"]

    # Deleting the conversation leaves the note, with the passages it cited.
    await client.delete(f"/api/documents/{doc}/chat/conversations/{conv}", headers=h)
    kept = (await client.get(f"/api/documents/{doc}/notes", headers=h)).json()
    assert len(kept) == 1 and len(kept[0]["provenance"]["citations"]) == 2
