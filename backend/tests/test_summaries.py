import json
import uuid

import httpx
import pytest
from sqlalchemy import func, select

from app.core.config import get_settings
from app.core.messages import MSG
from app.db.session import SessionLocal
from app.models import Summary
from app.services import openai_client, summarizer
from app.services.openai_client import AIError, Completion, Usage
from tests.pdfs import image_only_pdf, text_pdf

GOOD = {
    "key_points": ["Ý một.", "Ý hai.", "Ý ba.", "Ý ba."],
    "concepts": [{"term": "Học máy", "explanation": "Máy học từ dữ liệu."}, {"term": " ", "explanation": "x"}],
    "conclusion": "Kết luận ngắn.",
    "keywords": ["học máy", "Học Máy", "dữ liệu", "mô hình", "tổng quát hóa", "nhiễu"],
}


class FakeAI:
    """Stands in for the OpenAI call; answers are consumed in order (an Exception is raised)."""

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
    from app.api.routes import summaries

    summaries._running.clear()

    def install(*answers) -> FakeAI:
        fake = FakeAI(*answers)
        monkeypatch.setattr(summarizer, "chat", fake)
        return fake

    return install


async def new_doc(client, headers, pdf: bytes | None = None) -> str:
    r = await client.post(
        "/api/documents/upload", headers=headers, files={"file": ("bai.pdf", pdf or text_pdf(2), "application/pdf")}
    )
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def consent(client, headers):
    r = await client.patch("/api/account", headers=headers, json={"reading_preferences": {"ai_consent": True}})
    assert r.status_code == 200, r.text


async def test_summary_create_view_regenerate(client, auth, ai):
    h = auth()
    doc = await new_doc(client, h)
    fake = ai(GOOD)

    # Nothing is sent before the user agrees (NFR-PRV).
    r = await client.post(f"/api/documents/{doc}/summary", headers=h)
    assert r.status_code == 403 and not fake.calls
    await consent(client, h)

    r = await client.get(f"/api/documents/{doc}/summary", headers=h)
    assert r.status_code == 404 and r.json()["detail"] == MSG["MSG-33"]

    r = await client.post(f"/api/documents/{doc}/summary", headers=h)
    assert r.status_code == 201, r.text
    s = r.json()
    assert s["key_points"] == ["Ý một.", "Ý hai.", "Ý ba.", "Ý ba."]
    assert s["concepts"] == [{"term": "Học máy", "explanation": "Máy học từ dữ liệu."}]  # blank term dropped
    assert s["keywords"] == ["học máy", "dữ liệu", "mô hình", "tổng quát hóa", "nhiễu"]  # case-insensitive dedupe
    assert s["ai_model"] == "gpt-test" and s["language"] in ("vi", "en")
    assert fake.calls[0]["json_schema"]["strict"] is True
    user_msg = fake.calls[0]["messages"][1]["content"]
    assert "<document>" in user_msg and "Title:" in user_msg

    r = await client.get(f"/api/documents/{doc}/summary", headers=h)
    assert r.status_code == 200 and r.json()["conclusion"] == "Kết luận ngắn."
    assert (await client.get("/api/account", headers=h)).json()["ai_quota_remaining"] == 19

    # Regenerating replaces the summary; the language can be chosen.
    ai({**GOOD, "conclusion": "Short conclusion."})
    r = await client.post(f"/api/documents/{doc}/summary", headers=h, json={"language": "en"})
    assert r.status_code == 201 and r.json()["language"] == "en"
    assert (await client.get(f"/api/documents/{doc}/summary", headers=h)).json()["conclusion"] == "Short conclusion."
    async with SessionLocal() as session:
        rows = await session.scalar(select(func.count()).select_from(Summary).where(Summary.document_id == uuid.UUID(doc)))
        assert rows == 1
        tokens = await session.scalar(select(Summary.prompt_tokens).where(Summary.document_id == uuid.UUID(doc)))
        assert tokens == 100

    # Deleting the document deletes its summary.
    assert (await client.delete(f"/api/documents/{doc}", headers=h)).status_code == 204
    async with SessionLocal() as session:
        assert await session.scalar(select(func.count()).select_from(Summary).where(Summary.document_id == uuid.UUID(doc))) == 0


async def test_invalid_answer_is_retried_once(client, auth, ai):
    h = auth()
    await consent(client, h)
    doc = await new_doc(client, h)

    fake = ai("not json", GOOD)
    r = await client.post(f"/api/documents/{doc}/summary", headers=h)
    assert r.status_code == 201 and len(fake.calls) == 2

    # Two bad answers (too few key points): 502, nothing saved, no quota used.
    doc2 = await new_doc(client, h)
    fake = ai({**GOOD, "key_points": ["chỉ một ý"]})
    r = await client.post(f"/api/documents/{doc2}/summary", headers=h)
    assert r.status_code == 502 and r.json()["detail"] == MSG["MSG-26"] and len(fake.calls) == 2
    assert (await client.get(f"/api/documents/{doc2}/summary", headers=h)).status_code == 404
    assert (await client.get("/api/account", headers=h)).json()["ai_quota_remaining"] == 19


async def test_ai_failure_and_limits(client, auth, ai, monkeypatch):
    h = auth()
    await consent(client, h)
    doc = await new_doc(client, h)

    ai(AIError("timeout"))
    r = await client.post(f"/api/documents/{doc}/summary", headers=h)
    assert r.status_code == 502 and r.json()["detail"] == MSG["MSG-26"]

    # No text to summarise: 422 MSG-15 without calling the AI.
    scan = await new_doc(client, h, image_only_pdf())
    fake = ai(GOOD)
    r = await client.post(f"/api/documents/{scan}/summary", headers=h)
    assert r.status_code == 422 and r.json()["detail"] == MSG["MSG-15"] and not fake.calls

    # Daily quota (MSG-25).
    monkeypatch.setattr(get_settings(), "ai_daily_quota", 1)
    assert (await client.post(f"/api/documents/{doc}/summary", headers=h)).status_code == 201
    r = await client.post(f"/api/documents/{doc}/summary", headers=h)
    assert r.status_code == 429 and r.json()["detail"] == MSG["MSG-25"]
    assert (await client.get("/api/account", headers=h)).json()["ai_quota_remaining"] == 0

    # Other users cannot see or create it.
    other = auth()
    await consent(client, other)
    assert (await client.get(f"/api/documents/{doc}/summary", headers=other)).status_code == 404
    assert (await client.post(f"/api/documents/{doc}/summary", headers=other)).status_code == 404

    # Without a key the feature reports that it is not configured.
    monkeypatch.setattr(get_settings(), "openai_api_key", "")
    assert (await client.post(f"/api/documents/{doc}/summary", headers=other)).status_code == 404
    other_doc = await new_doc(client, other)
    assert (await client.post(f"/api/documents/{other_doc}/summary", headers=other)).status_code == 503


async def test_long_documents_are_summarised_in_parts(monkeypatch):
    settings = get_settings().model_copy(update={"summary_single_request_tokens": 300, "summary_chunk_tokens": 200})
    fake = FakeAI("- ghi chú phần", GOOD)
    fake.answers = ["- ghi chú phần"] * 3 + [GOOD]
    monkeypatch.setattr(summarizer, "chat", fake)
    text = "\n\n".join(["# Chương 1", "a " * 250, "# Chương 2", "b " * 250, "c " * 250])

    content, usage = await summarizer.summarize(settings, "Sách", text, "vi")
    purposes = [c["purpose"] for c in fake.calls]
    assert purposes == ["summary_part"] * 3 + ["summary"]
    assert "notes that summarise consecutive parts" in fake.calls[-1]["messages"][1]["content"]
    assert usage.prompt_tokens == 400 and content.conclusion == "Kết luận ngắn."


def test_helpers():
    assert summarizer.detect_language("Học máy là một lĩnh vực của trí tuệ nhân tạo.") == "vi"
    assert summarizer.detect_language("Machine learning is a field of artificial intelligence.") == "en"

    parts = summarizer.split_parts("# A\n\n" + "x" * 50 + "\n\n---\n\n# B\n\n" + "y" * 700, 100)
    # A heading stays with the start of its section even when that section has to be cut.
    assert parts[0].startswith("# A") and "# B\n\nyyy" in parts[0] and all(len(p) <= 300 for p in parts)
    assert "---" not in "".join(parts) and "".join(parts).count("y") == 700

    with pytest.raises(ValueError):
        summarizer.parse_summary("[]")
    many = summarizer.parse_summary(json.dumps({**GOOD, "key_points": [f"ý {i}" for i in range(14)]}))
    assert len(many.key_points) == 10


async def test_openai_client_retries_server_errors(monkeypatch):
    seen: list[dict] = []
    replies = [httpx.Response(500), httpx.Response(200, json={
        "choices": [{"message": {"content": "{}"}, "finish_reason": "stop"}],
        "usage": {"prompt_tokens": 7, "completion_tokens": 3},
    })]

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append({"auth": request.headers["Authorization"], "body": json.loads(request.content)})
        return replies.pop(0)

    real = httpx.AsyncClient
    monkeypatch.setattr(openai_client.httpx, "AsyncClient", lambda **kw: real(transport=httpx.MockTransport(handler), **kw))
    settings = get_settings().model_copy(update={"openai_api_key": "sk-x", "openai_model": "gpt-test"})

    res = await openai_client.chat(settings, [{"role": "user", "content": "hi"}], purpose="t", json_schema={"name": "x"})
    assert res.text == "{}" and res.usage.prompt_tokens == 7 and len(seen) == 2
    assert seen[0]["auth"] == "Bearer sk-x" and seen[0]["body"]["model"] == "gpt-test"
    assert seen[0]["body"]["response_format"]["type"] == "json_schema"

    # Client errors are not retried.
    replies[:] = [httpx.Response(400), httpx.Response(200)]
    seen.clear()
    with pytest.raises(AIError):
        await openai_client.chat(settings, [], purpose="t")
    assert len(seen) == 1


async def test_summaries_are_searchable(client, auth, ai):
    h = auth()
    await consent(client, h)
    doc = await new_doc(client, h)
    ai(GOOD)
    assert (await client.post(f"/api/documents/{doc}/summary", headers=h)).status_code == 201

    r = await client.get("/api/search", headers=h, params={"q": "luận ngắn", "types": "summary"})
    assert r.status_code == 200, r.text
    group = r.json()["summaries"]
    assert group["total"] == 1
    assert group["items"][0]["kind"] == "summary" and group["items"][0]["document_id"] == doc
    assert r.json()["documents"]["total"] == 0  # only the requested type

    # Summaries have no category, and other users never see them.
    r = await client.get("/api/search", headers=h, params={"q": "luận ngắn", "category": "concept"})
    assert r.json()["summaries"]["total"] == 0
    r = await client.get("/api/search", headers=auth(), params={"q": "luận ngắn"})
    assert r.json()["summaries"]["total"] == 0
