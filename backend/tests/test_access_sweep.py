"""NFR-106 / AT-20: no route of the reader, the notes, the notebook or the AI lets one user read or change
another's documents, highlights, notes, AI results or conversations.

One user (A) has a document with each kind of thing on it; another (B), who has also agreed to the AI, tries
every route that takes one of A's ids. Each attempt must be refused as if the thing did not exist, say
nothing of what A wrote, and leave A's data as it was.
"""

import pytest

from tests.pdfs import text_pdf
from tests.test_chat import chat_ai, start  # noqa: F401  (chat_ai is a fixture)
from tests.test_highlights import create as create_highlight
from tests.test_reader_notebook import QUICK, ai  # noqa: F401  (ai is a fixture)
from tests.test_summaries import consent

SECRET_TITLE = "Nhật ký riêng của A"
SECRET_NOTE = "Ghi chú chỉ A được đọc"
SECRET_HL_NOTE = "Lời bình riêng trên highlight"


@pytest.fixture
async def owner(client, auth, ai, chat_ai):  # noqa: F811
    """A's document with a highlight (and its note), a free note, an AI result and a conversation."""
    h = auth()
    ai(QUICK)
    chat_ai("Trả lời [1].")
    doc, conv = await start(client, h, text_pdf(3))
    assert (
        await client.patch(f"/api/documents/{doc}", headers=h, json={"title": SECRET_TITLE})
    ).status_code == 200
    hl = await create_highlight(client, h, doc)
    assert hl.status_code == 201, hl.text
    hl = hl.json()["id"]
    assert (
        await client.put(f"/api/highlights/{hl}/note", headers=h, json={"content": SECRET_HL_NOTE})
    ).status_code == 200
    note = await client.post(f"/api/documents/{doc}/notes", headers=h, json={"body": SECRET_NOTE})
    assert note.status_code == 201, note.text
    artifact = await client.post(f"/api/documents/{doc}/ai/quick", headers=h)
    assert artifact.status_code == 201, artifact.text
    return {
        "h": h,
        "doc": doc,
        "conv": conv,
        "hl": hl,
        "note": note.json()["id"],
        "artifact": artifact.json()["id"],
    }


def attempts(a: dict) -> list[tuple[str, str, dict | None]]:
    doc, hl, note, conv = a["doc"], a["hl"], a["note"], a["conv"]
    d = f"/api/documents/{doc}"
    return [
        ("GET", d, None),
        ("PATCH", d, {"title": "Đổi tên", "read_fraction": 0.9}),
        ("DELETE", d, None),
        ("GET", f"{d}/file", None),
        ("GET", f"{d}/source-map", None),
        ("GET", f"{d}/charts", None),
        ("GET", f"{d}/images/p1.png", None),
        ("GET", f"{d}/usage", None),
        ("POST", f"{d}/retry-extraction", None),
        ("POST", f"{d}/reprocess", None),
        ("GET", f"{d}/aside", None),
        ("POST", f"{d}/extraction-reports", {"error_type": "other", "note": "Chen vào"}),
        ("GET", f"{d}/summary", None),
        ("POST", f"{d}/summary", None),
        ("GET", f"{d}/notes", None),
        ("POST", f"{d}/notes", {"body": "Chen vào"}),
        (
            "POST",
            f"{d}/notes/translation",
            {"quote": "A passage.", "translation": "Một đoạn.", "target": "vi"},
        ),
        ("GET", f"/api/notebook/documents/{doc}", None),
        ("GET", f"{d}/ai/quick", None),
        ("POST", f"{d}/ai/quick", None),
        ("GET", f"{d}/ai/analysis", None),
        ("POST", f"{d}/ai/analysis", None),
        ("GET", f"{d}/chat/conversations", None),
        ("POST", f"{d}/chat/conversations", None),
        ("GET", f"{d}/chat/conversations/{conv}", None),
        ("DELETE", f"{d}/chat/conversations/{conv}", None),
        ("POST", f"{d}/chat/conversations/{conv}/messages", {"content": "Tóm tắt giúp tôi"}),
        ("PATCH", f"/api/highlights/{hl}", {"color": "green"}),
        ("DELETE", f"/api/highlights/{hl}", None),
        ("PUT", f"/api/highlights/{hl}/note", {"content": "Ghi đè"}),
        ("DELETE", f"/api/highlights/{hl}/note", None),
        ("PATCH", f"/api/notes/{note}", {"body": "Ghi đè"}),
        ("DELETE", f"/api/notes/{note}", None),
        # Ids in the body rather than in the path.
        (
            "POST",
            "/api/highlights",
            {
                "document_id": doc,
                "block_id": "b3",
                "start_offset": 4,
                "end_offset": 20,
                "selected_text": "mô hình đoán đúng",
                "color": "yellow",
                "page_number": 1,
            },
        ),
        ("POST", "/api/notes/from-ai", {"source": "artifact", "source_id": a["artifact"], "part": "all"}),
    ]


async def test_another_user_reaches_nothing(client, auth, owner):
    a = owner
    b = auth()
    await consent(client, b)  # so it is the owner check that refuses, not the missing consent

    for method, path, body in attempts(a):
        r = await client.request(method, path, headers=b, json=body)
        assert r.status_code in (403, 404), f"{method} {path} -> {r.status_code} {r.text[:200]}"
        for secret in (SECRET_TITLE, SECRET_NOTE, SECRET_HL_NOTE):
            assert secret not in r.text, f"{method} {path} says what A wrote"

    # Browser-local data moved over by B cannot land on A's document either.
    r = await client.post(
        "/api/annotations/import",
        headers=b,
        json={"notes": {a["doc"]: "Chen vào"}, "progress": {a["doc"]: 0.9}},
    )
    assert r.status_code == 200 and r.json()["notes"] == 0

    # Nothing of A's shows in B's lists or search.
    for path in ("/api/documents", "/api/highlights", "/api/notebook/documents"):
        r = await client.get(path, headers=b)
        assert r.status_code == 200, f"{path} -> {r.status_code}"
        for secret in (SECRET_TITLE, SECRET_NOTE, SECRET_HL_NOTE):
            assert secret not in r.text, f"{path} lists what A wrote"
    for secret in (SECRET_TITLE, SECRET_NOTE, SECRET_HL_NOTE):  # the search repeats the query, so count
        found = (await client.get("/api/search", headers=b, params={"q": secret})).json()
        assert all(found[group]["total"] == 0 for group in ("documents", "highlights", "notes", "summaries"))

    # And A's things are all still there, unchanged.
    h, d = a["h"], f"/api/documents/{a['doc']}"
    doc = (await client.get(d, headers=h)).json()
    assert doc["title"] == SECRET_TITLE and not doc["read_fraction"]
    notes = (await client.get(f"{d}/notes", headers=h)).json()
    assert [n["body"] for n in notes] == [SECRET_NOTE]
    group = (await client.get(f"/api/notebook/documents/{a['doc']}", headers=h)).json()
    assert [x["note"] for x in group["highlights"]] == [SECRET_HL_NOTE]
    assert (await client.get(f"{d}/ai/quick", headers=h)).json()["id"] == a["artifact"]
    assert (await client.get(f"{d}/chat/conversations/{a['conv']}", headers=h)).status_code == 200
