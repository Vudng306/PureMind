"""Clean Reader GĐ4: reading a document's file again (UC-04) — the text in use is kept until a new one is
whole, the highlights are checked against it and kept either way, and asking twice starts it once."""

import uuid
from datetime import timedelta

import pytest
from sqlalchemy import select, update

from app.api.routes import documents
from app.db.session import SessionLocal
from app.models import Document, Highlight, utcnow
from app.services import anchors
from app.services.extraction import reader_blocks
from tests.pdfs import text_pdf
from tests.test_documents import upload

LONG = "the method converges in every case we tried"
SHORT = "the model"


def body(*paragraphs: str) -> str:
    return "\n\n".join(paragraphs)


OLD = body(
    "# Results",
    f"In short, {LONG}, which we did not expect at first.",
    f"Here {SHORT} is fast. Later {SHORT} is slow. Then {SHORT} is fine.",
    "A paragraph the new reading leaves out entirely, about calibration.",
)
NEW = body(
    "# Results",
    "A new paragraph read from the page this time.",
    f"In short — {LONG}, which we did not expect at first.",  # its block changed: the passage moved
    f"Here {SHORT} is quick. Later {SHORT} is slow. Then {SHORT} is fine.",
)


@pytest.fixture
def extract(monkeypatch):
    """Read every file as `next` says: a text, or the code of an error. Counts the readings."""
    state = {"next": NEW, "calls": 0}

    async def fake(doc, settings, ai):
        state["calls"] += 1
        if not state["next"].startswith("#"):
            return state["next"]
        aside = {"classifier": "rules-1", "blocks": []}
        return documents.Extracted(state["next"], [], aside, [], "T", None, 1)

    monkeypatch.setattr(documents, "extract_file", fake)
    return state


async def doc_with(client, h, content: str) -> str:
    doc = (await upload(client, h, text_pdf(1))).json()
    async with SessionLocal() as s:
        await s.execute(
            update(Document).where(Document.id == uuid.UUID(doc["id"])).values(content_clean=content)
        )
        await s.commit()
    return doc["id"]


def spot(content: str, quote: str, nth: int = 0) -> dict:
    """A highlight on the nth place of `quote`, as the reader sends it: block id, offsets, words around."""
    blocks = zip(anchors.text_blocks(content), reader_blocks(content), strict=True)
    texts = [(b.id, anchors.plain(raw)) for b, raw in blocks]
    found = [(i, text, at) for i, text in texts for at in range(len(text)) if text.startswith(quote, at)]
    block_id, text, start = found[nth]
    end = start + len(quote)
    return {
        "block_id": block_id,
        "start_offset": start,
        "end_offset": end,
        "selected_text": quote,
        "prefix": text[max(0, start - 32) : start],
        "suffix": text[end : end + 32],
        "color": "yellow",
    }


async def highlight(client, h, doc: str, **kw) -> str:
    r = await client.post("/api/highlights", headers=h, json={"document_id": doc, **kw})
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def get(client, h, doc: str) -> dict:
    return (await client.get(f"/api/documents/{doc}", headers=h)).json()


async def test_reprocess_checks_every_highlight_and_keeps_them(client, auth, extract):
    h = auth()
    doc = await doc_with(client, h, OLD)
    moved = await highlight(client, h, doc, **spot(OLD, LONG))
    gone = await highlight(client, h, doc, **spot(OLD, "about calibration"))
    # "the model" is in three places; its own block changed and the words around it were not kept.
    short = await highlight(client, h, doc, **{**spot(OLD, SHORT), "prefix": None, "suffix": None})
    on_pdf = await highlight(
        client,
        h,
        doc,
        selected_text="on the page",
        color="blue",
        page_number=1,
        rects=[{"x": 0.1, "y": 0.1, "w": 0.2, "h": 0.02}],
    )
    before = await get(client, h, doc)

    r = await client.post(f"/api/documents/{doc}/reprocess", headers=h)
    assert r.status_code == 202, r.text
    after = await get(client, h, doc)
    assert after["reprocess_state"] == "done"
    assert after["content_clean"] == NEW and after["content_version"] != before["content_version"]
    report = after["reprocess_report"]
    assert report["from_version"] == before["content_version"]
    assert report["to_version"] == after["content_version"]
    assert report["anchors"] == {"mapped": 2, "ambiguous": 1, "unresolved": 1}

    listed = (await client.get(f"/api/highlights?document_id={doc}", headers=h)).json()["items"]
    rows = {x["id"]: x for x in listed}
    assert len(rows) == 4  # CR-NFR-05: none is lost
    assert rows[moved]["anchor_status"] == "mapped"
    assert rows[moved]["content_version"] == after["content_version"]  # checked against the new text
    assert rows[gone]["anchor_status"] == "unresolved"
    assert rows[gone]["content_version"] == before["content_version"]  # still the text it was made on
    assert rows[short]["anchor_status"] == "ambiguous"
    assert rows[on_pdf]["anchor_status"] == "mapped"  # the file has not changed


async def test_failed_reprocess_keeps_the_text_in_use(client, auth, extract):
    h = auth()
    doc = await doc_with(client, h, OLD)
    hl = await highlight(client, h, doc, **spot(OLD, LONG))
    extract["next"] = "MSG-99"
    assert (await client.post(f"/api/documents/{doc}/reprocess", headers=h)).status_code == 202
    after = await get(client, h, doc)
    assert after["reprocess_state"] == "failed" and after["reprocess_report"]["error"] == "MSG-99"
    assert after["extraction_status"] == "done" and after["content_clean"] == OLD  # TC-14
    async with SessionLocal() as s:
        assert (await s.get(Highlight, uuid.UUID(hl))).anchor_status is None  # nothing was checked


async def _set(doc: str, **values) -> None:
    async with SessionLocal() as s:
        await s.execute(update(Document).where(Document.id == uuid.UUID(doc)).values(**values))
        await s.commit()


async def test_reprocess_asked_twice_runs_once(client, auth, extract):
    h = auth()
    doc = await doc_with(client, h, OLD)
    extract["calls"] = 0  # the upload read it once
    await _set(doc, reprocess_state="running", reprocess_started_at=utcnow())  # one is running
    r = await client.post(f"/api/documents/{doc}/reprocess", headers=h)
    assert r.status_code == 202 and r.json()["reprocess_state"] == "running"
    assert extract["calls"] == 0 and r.json()["content_clean"] == OLD  # TC-20: no second reading

    await _set(doc, reprocess_started_at=utcnow() - timedelta(hours=1))  # cut off by a restart
    assert (await client.post(f"/api/documents/{doc}/reprocess", headers=h)).status_code == 202
    assert extract["calls"] == 1


async def test_read_position_in_a_block_gone_falls_back(client, auth, extract):
    h = auth()
    doc = await doc_with(client, h, OLD)
    place = {"block_id": spot(OLD, "about calibration")["block_id"], "offset": 0.5}
    r = await client.patch(f"/api/documents/{doc}", headers=h, json={"read_position": place})
    assert r.status_code == 200, r.text
    await client.post(f"/api/documents/{doc}/reprocess", headers=h)
    after = await get(client, h, doc)
    assert after["read_position"] is None and after["reprocess_report"]["read_position"] == place

    place = {"block_id": spot(OLD, "Results")["block_id"], "offset": 0.2}  # the same heading in both
    await client.patch(f"/api/documents/{doc}", headers=h, json={"read_position": place})
    await client.post(f"/api/documents/{doc}/reprocess", headers=h)
    after = await get(client, h, doc)
    assert after["read_position"] == place and "read_position" not in after["reprocess_report"]


async def test_reprocess_needs_the_file(client, auth, extract):
    h = auth()
    doc = await doc_with(client, h, OLD)
    extract["calls"] = 0  # the upload read it once
    await _set(doc, file_storage_path=None)
    assert (await client.post(f"/api/documents/{doc}/reprocess", headers=h)).status_code == 409
    assert extract["calls"] == 0
    async with SessionLocal() as s:
        state = await s.scalar(select(Document.reprocess_state).where(Document.id == uuid.UUID(doc)))
        assert state is None


def test_anchor_rules():
    blocks = anchors.text_blocks(NEW)

    def hl(text: str, **kw) -> anchors.Highlighted:
        base = {"block_id": "bgone", "page": None, "prefix": None, "suffix": None, "on_pdf": False}
        return anchors.Highlighted(text=text, **{**base, **kw})

    assert anchors.status(blocks, hl(LONG)) == "mapped"  # long enough to be its own proof
    assert anchors.status(blocks, hl("THE METHOD   converges in")) == "mapped"  # spacing and case aside
    assert anchors.status(blocks, hl(SHORT)) == "ambiguous"
    assert anchors.status(blocks, hl(SHORT, prefix="is quick. Later ")) == "mapped"  # settled by context
    assert anchors.status(blocks, hl("calibration")) == "unresolved"
    assert anchors.status(blocks, hl("calibration", block_id=None, on_pdf=True)) == "mapped"
