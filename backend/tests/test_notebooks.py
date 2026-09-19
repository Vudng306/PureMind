import json
import uuid
from datetime import timedelta

import httpx
import pytest
from sqlalchemy import update

from app.core.config import get_settings
from app.core.messages import MSG
from app.db.session import SessionLocal
from app.models import Notebook, utcnow
from app.services import notebook_writer, openai_client
from app.services.openai_client import AIError, Usage
from tests.test_highlights import create, new_doc

NOTEBOOK = "# Học máy cơ bản\n\n## Tổng quan\nMô hình học từ dữ liệu [1].\n\n## Câu hỏi ôn tập\n1. Vì sao? [2]"


class FakeStream:
    """Stands in for the streamed OpenAI call: yields the answer in pieces (an Exception is raised)."""

    def __init__(self, answer):
        self.answer = answer
        self.calls: list[list[dict]] = []

    async def __call__(self, settings, messages, *, purpose, usage: Usage, max_tokens=4000):
        self.calls.append(messages)
        if isinstance(self.answer, Exception):
            raise self.answer
        for i in range(0, len(self.answer), 10):
            yield self.answer[i:i + 10]
        usage.add(Usage(50, 30))


@pytest.fixture
def ai(monkeypatch):
    settings = get_settings()
    monkeypatch.setattr(settings, "openai_api_key", "sk-test")
    monkeypatch.setattr(settings, "openai_model", "gpt-test")
    from app.api.routes import notebooks

    notebooks._running.clear()

    def install(answer=NOTEBOOK) -> FakeStream:
        fake = FakeStream(answer)
        monkeypatch.setattr(notebook_writer, "chat_stream", fake)
        return fake

    return install


async def consent(client, headers):
    r = await client.patch("/api/account", headers=headers, json={"reading_preferences": {"ai_consent": True}})
    assert r.status_code == 200, r.text


async def highlights(client, h, doc, n=2, **kw) -> list[str]:
    ids = []
    for i in range(n):
        r = await create(client, h, doc, block_id=f"b{i}", selected_text=f"đoạn {i} về mô hình", **kw)
        assert r.status_code == 201, r.text
        ids.append(r.json()["id"])
    return ids


def events(text: str) -> list[tuple[str, dict]]:
    out = []
    for block in text.strip().split("\n\n"):
        lines = dict(line.split(": ", 1) for line in block.splitlines())
        out.append((lines["event"], json.loads(lines["data"])))
    return out


async def test_generate_edit_save_delete(client, auth, ai):
    h = auth()
    doc = await new_doc(client, h)
    ids = await highlights(client, h, doc, category="concept")
    await client.put(f"/api/highlights/{ids[1]}/note", headers=h, json={"content": "ghi chú riêng"})
    fake = ai()

    r = await client.post("/api/notebooks/generate", headers=h, json={"highlight_ids": ids})
    assert r.status_code == 403 and not fake.calls  # NFR-PRV
    await consent(client, h)

    assert (await client.get("/api/notebooks", headers=h)).json() == []
    r = await client.post("/api/notebooks/generate", headers=h, json={"highlight_ids": ids})
    assert r.status_code == 201, r.text
    nb = r.json()
    assert nb["status"] == "draft" and nb["title"] == "Học máy cơ bản" and nb["content"] == NOTEBOOK
    assert nb["ai_model"] == "gpt-test"
    assert [(s["position"], s["highlight"]["id"]) for s in nb["sources"]] == [(1, ids[0]), (2, ids[1])]
    assert nb["sources"][0]["document_title"] and nb["sources"][0]["file_type"] == "pdf"
    system, user = (m["content"] for m in fake.calls[0])
    assert "Thuật ngữ" in system and "Câu hỏi ôn tập" not in system  # glossary for concepts, no questions
    assert "[1] from" in user and "marked as concept" in user and "Reader's note: ghi chú riêng" in user
    assert (await client.get("/api/account", headers=h)).json()["ai_quota_remaining"] == 19

    listed = (await client.get("/api/notebooks", headers=h)).json()
    assert [(n["id"], n["status"], n["source_count"]) for n in listed] == [(nb["id"], "draft", 2)]
    assert (await client.get(f"/api/notebooks/{nb['id']}", headers=h)).json()["content"] == NOTEBOOK

    # Edit and save (FR-NB-03/04).
    r = await client.patch(
        f"/api/notebooks/{nb['id']}", headers=h, json={"title": "  Ôn tập  ", "content": "Mới [1]", "status": "saved"}
    )
    assert r.status_code == 200 and r.json()["title"] == "Ôn tập" and r.json()["status"] == "saved"
    r = await client.patch(f"/api/notebooks/{nb['id']}", headers=h, json={"content": "x" * 200_001})
    assert r.status_code == 422 and r.json()["detail"] == MSG["MSG-29"]
    r = await client.patch(f"/api/notebooks/{nb['id']}", headers=h, json={"title": " "})
    assert r.status_code == 422

    # Sources: removing one keeps the others' numbers; a new one gets a number never used.
    extra = (await highlights(client, h, doc, 1))[0]
    r = await client.patch(f"/api/notebooks/{nb['id']}", headers=h, json={"highlight_ids": [ids[1], extra]})
    assert [(s["position"], s["highlight"]["id"]) for s in r.json()["sources"]] == [(2, ids[1]), (3, extra)]

    # Other users see nothing.
    other = auth()
    assert (await client.get(f"/api/notebooks/{nb['id']}", headers=other)).status_code == 404
    assert (await client.patch(f"/api/notebooks/{nb['id']}", headers=other, json={"title": "a"})).status_code == 404
    assert (await client.get("/api/notebooks", headers=other)).json() == []

    # Deleting a notebook leaves its highlights alone.
    assert (await client.delete(f"/api/notebooks/{nb['id']}", headers=h)).status_code == 204
    assert (await client.get(f"/api/notebooks/{nb['id']}", headers=h)).status_code == 404
    assert (await client.get(f"/api/highlights?document_id={doc}", headers=h)).json()["total"] == 3


async def test_versions(client, auth, ai, monkeypatch):
    """FR-NB-03 step 5: every "Lưu" keeps a snapshot; autosaves and unchanged saves do not."""
    h = auth()
    doc = await new_doc(client, h)
    ids = await highlights(client, h, doc)
    ai()
    await consent(client, h)
    nb = (await client.post("/api/notebooks/generate", headers=h, json={"highlight_ids": ids})).json()
    url = f"/api/notebooks/{nb['id']}"
    assert (await client.get(f"{url}/versions", headers=h)).json() == []  # a draft has no history

    await client.patch(url, headers=h, json={"status": "saved"})
    await client.patch(url, headers=h, json={"content": "Tự lưu [1]"})  # autosave
    await client.patch(url, headers=h, json={"title": "Bản 2", "content": "Bản hai [1]", "status": "saved"})
    await client.patch(url, headers=h, json={"status": "saved"})  # nothing changed
    listed = (await client.get(f"{url}/versions", headers=h)).json()
    assert [(v["title"], v["chars"]) for v in listed] == [("Bản 2", 11), ("Học máy cơ bản", len(NOTEBOOK))]

    first = (await client.get(f"{url}/versions/{listed[1]['id']}", headers=h)).json()
    assert first["content"] == NOTEBOOK and first["title"] == "Học máy cơ bản"
    assert (await client.get(f"{url}/versions/{uuid.uuid4()}", headers=h)).status_code == 404

    # Other users cannot list or read them, not even through their own notebook.
    other = auth()
    assert (await client.get(f"{url}/versions", headers=other)).status_code == 404
    assert (await client.get(f"{url}/versions/{listed[0]['id']}", headers=other)).status_code == 404

    # Only the newest few are kept.
    from app.api.routes import notebooks

    monkeypatch.setattr(notebooks, "MAX_NOTEBOOK_VERSIONS", 3)
    for i in range(3):
        await client.patch(url, headers=h, json={"content": f"v{i}", "status": "saved"})
    listed = (await client.get(f"{url}/versions", headers=h)).json()
    assert [v["chars"] for v in listed] == [2, 2, 2]

    # Deleting the notebook removes its history.
    assert (await client.delete(url, headers=h)).status_code == 204
    async with SessionLocal() as session:
        from sqlalchemy import func, select

        from app.models import NotebookVersion

        assert await session.scalar(select(func.count()).select_from(NotebookVersion)) == 0


async def test_generate_validation(client, auth, ai, monkeypatch):
    h = auth()
    await consent(client, h)
    doc = await new_doc(client, h)
    ids = await highlights(client, h, doc, 1)
    fake = ai()

    r = await client.post("/api/notebooks/generate", headers=h, json={"highlight_ids": []})
    assert r.status_code == 422 and r.json()["detail"] == MSG["MSG-27"]
    many = [str(uuid.uuid4()) for _ in range(101)]
    r = await client.post("/api/notebooks/generate", headers=h, json={"highlight_ids": many})
    assert r.status_code == 422 and r.json()["detail"] == MSG["MSG-28"]

    # Someone else's highlight is "not found".
    other = auth()
    await consent(client, other)
    r = await client.post("/api/notebooks/generate", headers=other, json={"highlight_ids": ids})
    assert r.status_code == 404 and not fake.calls

    # A given title wins over the heading; duplicates are ignored.
    r = await client.post(
        "/api/notebooks/generate", headers=h, json={"highlight_ids": ids + ids, "title": "Tên riêng", "language": "en"}
    )
    assert r.status_code == 201 and r.json()["title"] == "Tên riêng" and len(r.json()["sources"]) == 1
    assert "Write in English" in fake.calls[-1][0]["content"]

    ai(AIError("down"))
    r = await client.post("/api/notebooks/generate", headers=h, json={"highlight_ids": ids})
    assert r.status_code == 502 and r.json()["detail"] == MSG["MSG-26"]
    assert len((await client.get("/api/notebooks", headers=h)).json()) == 1  # nothing saved
    assert (await client.get("/api/account", headers=h)).json()["ai_quota_remaining"] == 19  # no quota used

    monkeypatch.setattr(get_settings(), "ai_daily_quota", 1)
    r = await client.post("/api/notebooks/generate", headers=h, json={"highlight_ids": ids})
    assert r.status_code == 429 and r.json()["detail"] == MSG["MSG-25"]


async def test_generate_streams(client, auth, ai):
    h = auth()
    await consent(client, h)
    doc = await new_doc(client, h)
    ids = await highlights(client, h, doc)
    ai()
    stream = {**h, "Accept": "text/event-stream"}

    r = await client.post("/api/notebooks/generate", headers=stream, json={"highlight_ids": ids})
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/event-stream")
    got = events(r.text)
    assert {e for e, _ in got[:-1]} == {"delta"} and "".join(d["text"] for _, d in got[:-1]) == NOTEBOOK
    kind, nb = got[-1]
    assert kind == "done" and nb["status"] == "draft" and len(nb["sources"]) == 2
    assert (await client.get(f"/api/notebooks/{nb['id']}", headers=h)).status_code == 200

    # A failure is reported as an event; nothing is saved and no quota is used.
    ai(AIError("down"))
    r = await client.post("/api/notebooks/generate", headers=stream, json={"highlight_ids": ids})
    assert events(r.text) == [("error", {"detail": MSG["MSG-26"]})]
    assert len((await client.get("/api/notebooks", headers=h)).json()) == 1
    assert (await client.get("/api/account", headers=h)).json()["ai_quota_remaining"] == 19

    # Validation still answers with a normal JSON error before any streaming.
    r = await client.post("/api/notebooks/generate", headers=stream, json={"highlight_ids": []})
    assert r.status_code == 422 and r.json()["detail"] == MSG["MSG-27"]


async def test_deleted_sources_and_old_drafts(client, auth, ai):
    h = auth()
    await consent(client, h)
    doc = await new_doc(client, h)
    ids = await highlights(client, h, doc)
    ai()
    nb = (await client.post("/api/notebooks/generate", headers=h, json={"highlight_ids": ids})).json()
    saved = (await client.post("/api/notebooks/generate", headers=h, json={"highlight_ids": ids[:1]})).json()
    await client.patch(f"/api/notebooks/{saved['id']}", headers=h, json={"status": "saved"})

    # FR-HL-03: the notebooks citing a highlight can be listed before it is deleted.
    using = (await client.get(f"/api/notebooks?highlight_id={ids[0]}", headers=h)).json()
    assert {n["id"] for n in using} == {nb["id"], saved["id"]}
    assert (await client.delete(f"/api/highlights/{ids[0]}", headers=h)).status_code == 204
    left = (await client.get(f"/api/notebooks/{nb['id']}", headers=h)).json()
    assert [s["position"] for s in left["sources"]] == [2] and left["content"] == NOTEBOOK

    # Deleting the document keeps saved notebooks (their sources are gone).
    assert (await client.delete(f"/api/documents/{doc}", headers=h)).status_code == 204
    kept = (await client.get(f"/api/notebooks/{saved['id']}", headers=h)).json()
    assert kept["sources"] == [] and kept["status"] == "saved"

    # DR-03: drafts not opened or edited for 30 days are removed; saved notebooks stay.
    old = utcnow() - timedelta(days=31)
    async with SessionLocal() as session:
        await session.execute(update(Notebook).values(opened_at=old, updated_at=old))
        await session.commit()
    listed = (await client.get("/api/notebooks", headers=h)).json()
    assert [n["id"] for n in listed] == [saved["id"]]


async def test_notebooks_are_searchable(client, auth, ai):
    h = auth()
    await consent(client, h)
    doc = await new_doc(client, h)
    ai()
    ids = await highlights(client, h, doc, 1)
    nb = (await client.post("/api/notebooks/generate", headers=h, json={"highlight_ids": ids})).json()

    r = await client.get("/api/search", headers=h, params={"q": "cơ bản", "types": "notebook"})
    assert r.status_code == 200, r.text
    hit = r.json()["notebooks"]["items"][0]
    assert hit["kind"] == "notebook" and hit["id"] == nb["id"] and hit["document_id"] is None
    assert hit["document_title"] == "Học máy cơ bản"
    assert (await client.get("/api/search", headers=auth(), params={"q": "cơ bản"})).json()["notebooks"]["total"] == 0


async def test_openai_stream(monkeypatch):
    def sse(*chunks) -> bytes:
        return "".join(f"data: {json.dumps(c)}\n\n" for c in chunks).encode() + b"data: [DONE]\n\n"

    body = sse(
        {"choices": [{"delta": {"role": "assistant"}}]},
        {"choices": [{"delta": {"content": "Xin "}}]},
        {"choices": [{"delta": {"content": "chào"}, "finish_reason": "stop"}]},
        {"choices": [], "usage": {"prompt_tokens": 9, "completion_tokens": 2}},
    )
    replies = [httpx.Response(503), httpx.Response(200, content=body)]
    seen: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(json.loads(request.content))
        return replies.pop(0)

    real = httpx.AsyncClient
    monkeypatch.setattr(openai_client.httpx, "AsyncClient", lambda **kw: real(transport=httpx.MockTransport(handler), **kw))
    settings = get_settings().model_copy(update={"openai_api_key": "sk-x", "openai_model": "gpt-test"})

    usage = Usage()
    text = "".join([d async for d in openai_client.chat_stream(settings, [], purpose="t", usage=usage)])
    assert text == "Xin chào" and usage.prompt_tokens == 9 and len(seen) == 2
    assert seen[0]["stream"] is True and seen[0]["stream_options"] == {"include_usage": True}

    # A cut-off answer is an error.
    replies[:] = [httpx.Response(200, content=sse({"choices": [{"delta": {"content": "a"}, "finish_reason": "length"}]}))]
    with pytest.raises(AIError):
        _ = [d async for d in openai_client.chat_stream(settings, [], purpose="t", usage=Usage())]


def test_writer_helpers():
    assert notebook_writer.clean_output("```markdown\n# A\nb\n```") == "# A\nb"
    assert notebook_writer.title_from("intro\n# **Tiêu đề** #\n## x") == "Tiêu đề"
    assert notebook_writer.title_from("không có") is None
    assert notebook_writer.cited("a [1] b [12][3] [x]") == {1, 12, 3}
    prompt = notebook_writer.user_prompt(
        [notebook_writer.Source(text="a\n  b", category="question", note="n" * 3000, document_title="T", page=4)]
    )
    assert '[1] from "T", page 4 — marked as question' in prompt and "Text: a b" in prompt
    assert "n" * 2000 + "…" in prompt and "n" * 2001 not in prompt
