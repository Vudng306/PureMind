"""Unified highlights: one row per passage, shown in the clean text and on the PDF (TC-01 … TC-12)."""

import asyncio
import uuid

import pymupdf
import pytest
from sqlalchemy import select, update

from app.core.config import get_settings
from app.db.session import SessionLocal
from app.models import Document, Highlight, HighlightMerge, Notebook, NotebookHighlight
from app.scripts import sync_highlights
from app.services import anchors, highlight_sync
from app.services.extraction import extract_pdf

REPEATED = "The same sentence appears in both of these paragraphs."
FIRST = f"Opening words of the first paragraph come here. {REPEATED} It then closes in its own way."
SECOND = f"Another paragraph starts differently from that one. {REPEATED} And it ends elsewhere too."
LONG_WORDS = (
    "Reading across lines keeps the passage whole when the words wrap at the margin of the page. " * 4
)
CARRIED = "This closing paragraph runs to the very bottom of the first page and its sentence goes on"
CARRIED_REST = "over the top of the next page where the reader finds the end of the thought."


def sample_pdf() -> bytes:
    doc = pymupdf.open()
    page = doc.new_page()
    y = page.insert_textbox((72, 72, 520, 150), FIRST, fontsize=11)
    assert y >= 0
    page.insert_textbox((72, 170, 520, 250), SECOND, fontsize=11)
    page.insert_textbox((72, 270, 520, 420), LONG_WORDS, fontsize=11)
    page.insert_textbox((72, 760, 520, 800), CARRIED, fontsize=11)
    second = doc.new_page()
    second.insert_textbox((72, 50, 520, 90), CARRIED_REST, fontsize=11)
    second.insert_textbox((72, 130, 520, 170), "A short closing line stands alone here.", fontsize=11)
    data = doc.tobytes()
    doc.close()
    return data


async def upload(client, h, data: bytes | None = None) -> dict:
    files = {"file": ("sample.pdf", data or sample_pdf(), "application/pdf")}
    r = await client.post("/api/documents/upload", headers=h, files=files)
    assert r.status_code == 201, r.text
    doc = (await client.get(f"/api/documents/{r.json()['id']}", headers=h)).json()
    assert doc["extraction_status"] == "done", doc
    return doc


def clean_spot(doc: dict, quote: str, nth: int = 0, color: str = "yellow") -> dict:
    blocks = anchors.text_blocks(doc["content_clean"])
    found = [(b, i) for b in blocks for i in range(len(b.text)) if b.text.startswith(quote, i)]
    block, start = found[nth]
    end = start + len(quote)
    return {
        "document_id": doc["id"],
        "block_id": block.id,
        "start_offset": start,
        "end_offset": end,
        "selected_text": quote,
        "prefix": block.text[max(0, start - 32) : start],
        "suffix": block.text[end : end + 32],
        "color": color,
    }


def pdf_spot(doc_id: str, data: bytes, quote: str, page: int = 1, nth: int = 0, color: str = "blue") -> dict:
    """A selection on a page: its rectangles, line by line, as the viewer sends them."""
    with pymupdf.open(stream=data, filetype="pdf") as pdf:
        p = pdf[page - 1]
        quads = p.search_for(quote, quads=False)
        area = p.rect
    # search_for gives one box per line; `nth` counts the passages for a quote on one line each.
    boxes = [quads[nth]] if len(quads) > nth and nth else quads
    rects = [
        {
            "x": round(b.x0 / area.width, 5),
            "y": round(b.y0 / area.height, 5),
            "w": round(b.width / area.width, 5),
            "h": round(b.height / area.height, 5),
        }
        for b in boxes
    ]
    return {
        "document_id": doc_id,
        "page_number": page,
        "rects": rects,
        "selected_text": quote,
        "color": color,
    }


async def create(client, h, body: dict, expect: int = 201) -> dict:
    r = await client.post("/api/highlights", headers=h, json=body)
    assert r.status_code == expect, r.text
    return r.json()


async def listed(client, h, doc_id: str) -> list[dict]:
    return (await client.get(f"/api/highlights?document_id={doc_id}", headers=h)).json()["items"]


def covers(place: list[dict], data: bytes, quote: str, page: int = 1) -> bool:
    with pymupdf.open(stream=data, filetype="pdf") as pdf:
        p = pdf[page - 1]
        wanted = p.search_for(quote)
        w, h = p.rect.width, p.rect.height
    rects = [r for part in place if part["page"] == page for r in part["rects"]]

    def inside(b) -> bool:
        cx, cy = (b.x0 + b.x1) / 2 / w, (b.y0 + b.y1) / 2 / h
        return any(r["x"] <= cx <= r["x"] + r["w"] and r["y"] <= cy <= r["y"] + r["h"] for r in rects)

    return bool(wanted) and all(inside(b) for b in wanted)


def spans_read(doc: dict, h: dict) -> str:
    blocks = {b.id: b for b in anchors.text_blocks(doc["content_clean"])}
    return "".join(blocks[s["block"]].words[s["start"] : s["end"]] for s in h["clean_anchor"])


async def test_tc01_pdf_highlight_shows_in_the_clean_text(client, auth):
    h = auth()
    data = sample_pdf()
    doc = await upload(client, h, data)
    made = await create(client, h, pdf_spot(doc["id"], data, "Opening words of the first paragraph"))
    assert made["sync_status"] == "synced"
    assert made["block_id"] is None and made["pdf_anchor"][0]["page"] == 1
    assert spans_read(doc, made) == anchors.squash("Opening words of the first paragraph")


async def test_tc02_clean_highlight_shows_on_the_pdf(client, auth):
    h = auth()
    data = sample_pdf()
    doc = await upload(client, h, data)
    quote = "Another paragraph starts differently"
    made = await create(client, h, clean_spot(doc, quote))
    assert made["sync_status"] == "synced"
    assert covers(made["pdf_anchor"], data, quote)
    assert made["rects"] is None  # where it was made stays as it was


async def test_tc03_same_passage_from_the_other_view_is_the_same_highlight(client, auth):
    h = auth()
    data = sample_pdf()
    doc = await upload(client, h, data)
    quote = "Opening words of the first paragraph"
    first = await create(client, h, clean_spot(doc, quote, color="green"))
    again = await create(client, h, pdf_spot(doc["id"], data, quote), expect=200)
    assert again["id"] == first["id"] and again["duplicate"] is True and again["color"] == "green"
    assert len(await listed(client, h, doc["id"])) == 1

    other_way = await create(client, h, pdf_spot(doc["id"], data, "Another paragraph starts"))
    back = await create(client, h, clean_spot(doc, "Another paragraph starts"), expect=200)
    assert back["id"] == other_way["id"]
    assert len(await listed(client, h, doc["id"])) == 2


async def test_two_requests_at_once_leave_one_highlight(client, auth):
    h = auth()
    data = sample_pdf()
    doc = await upload(client, h, data)
    quote = "Opening words of the first paragraph"
    answers = await asyncio.gather(
        client.post("/api/highlights", headers=h, json=clean_spot(doc, quote)),
        client.post("/api/highlights", headers=h, json=pdf_spot(doc["id"], data, quote)),
    )
    assert sorted(r.status_code for r in answers) == [200, 201]
    assert len({r.json()["id"] for r in answers}) == 1
    assert len(await listed(client, h, doc["id"])) == 1


async def test_tc04_tc05_tc06_edits_go_to_the_one_highlight(client, auth):
    h = auth()
    data = sample_pdf()
    doc = await upload(client, h, data)
    quote = "Opening words of the first paragraph"
    made = await create(client, h, pdf_spot(doc["id"], data, quote))
    assert (
        await client.patch(f"/api/highlights/{made['id']}", headers=h, json={"color": "pink"})
    ).status_code == 200
    assert (
        await client.put(f"/api/highlights/{made['id']}/note", headers=h, json={"content": "ghi chú"})
    ).status_code == 200
    seen = await create(client, h, clean_spot(doc, quote), expect=200)
    assert (seen["id"], seen["color"], seen["note"]) == (made["id"], "pink", "ghi chú")

    group = (await client.get(f"/api/notebook/documents/{doc['id']}", headers=h)).json()
    assert [x["id"] for x in group["highlights"]] == [made["id"]]  # one entry in the notebook

    assert (await client.delete(f"/api/highlights/{made['id']}", headers=h)).status_code == 204
    assert await listed(client, h, doc["id"]) == []
    gone = await client.get(f"/api/notebook/documents/{doc['id']}", headers=h)
    assert gone.status_code == 404 or gone.json()["highlights"] == []
    # Deleted twice (a retry): nothing to find, nothing broken.
    assert (await client.delete(f"/api/highlights/{made['id']}", headers=h)).status_code == 404


async def test_a_note_written_on_an_existing_passage_is_not_lost(client, auth):
    h = auth()
    data = sample_pdf()
    doc = await upload(client, h, data)
    quote = "Opening words of the first paragraph"
    made = await create(client, h, {**clean_spot(doc, quote), "note": "ghi chú đầu"})
    again = await create(client, h, {**pdf_spot(doc["id"], data, quote), "note": "ghi chú sau"}, expect=200)
    assert again["id"] == made["id"] and again["note"] == "ghi chú đầu\n\nghi chú sau"


async def test_tc07_the_same_words_in_two_places_stay_two_highlights(client, auth):
    h = auth()
    data = sample_pdf()
    doc = await upload(client, h, data)
    one = await create(client, h, clean_spot(doc, REPEATED, 0))
    two = await create(client, h, clean_spot(doc, REPEATED, 1))
    assert one["id"] != two["id"]
    assert one["canonical_start"] != two["canonical_start"]
    assert one["pdf_anchor"] != two["pdf_anchor"]

    # From the PDF: each selection finds its own one, by where it is on the page.
    with pymupdf.open(stream=data, filetype="pdf") as pdf:
        hits = pdf[0].search_for("The same sentence appears")
    assert len(hits) == 2
    for number, known in enumerate((one, two)):
        spot = pdf_spot(doc["id"], data, "The same sentence appears", nth=number)
        with pymupdf.open(stream=data, filetype="pdf") as pdf:
            area = pdf[0].rect
        b = hits[number]
        spot["rects"] = [
            {
                "x": b.x0 / area.width,
                "y": b.y0 / area.height,
                "w": b.width / area.width,
                "h": b.height / area.height,
            }
        ]
        made = await create(client, h, spot)
        assert made["canonical_start"] == known["canonical_start"]  # its own place, a part of that sentence
        assert made["id"] != known["id"] and known["id"] in made["overlaps"]


async def test_fr02_an_overlapping_selection_is_a_highlight_of_its_own(client, auth):
    h = auth()
    doc = await upload(client, h)
    whole = await create(client, h, {**clean_spot(doc, "Opening words of the first paragraph"), "note": "n"})
    part = await create(client, h, clean_spot(doc, "words of the first"))
    assert part["id"] != whole["id"] and part["overlaps"] == [whole["id"]]
    across = await create(client, h, clean_spot(doc, "first paragraph come here"))
    assert set(across["overlaps"]) == {whole["id"], part["id"]}
    rows = {x["id"]: x for x in await listed(client, h, doc["id"])}
    assert len(rows) == 3 and rows[whole["id"]]["note"] == "n"
    assert rows[whole["id"]]["selected_text"] == "Opening words of the first paragraph"  # untouched


async def test_tc08_a_passage_over_lines_and_pages_gets_every_place(client, auth):
    h = auth()
    data = sample_pdf()
    doc = await upload(client, h, data)
    many_lines = LONG_WORDS.strip()[:200]
    made = await create(client, h, clean_spot(doc, many_lines))
    assert made["sync_status"] == "synced" and len(made["pdf_anchor"]) == 1
    assert len(made["pdf_anchor"][0]["rects"]) >= 2  # one per line

    joined = f"{CARRIED[-30:]} {CARRIED_REST[:30]}"
    assert joined in anchors.plain(doc["content_clean"]), "the extraction carries the sentence over"
    across = await create(client, h, clean_spot(doc, joined))
    assert across["sync_status"] == "synced"
    assert [p["page"] for p in across["pdf_anchor"]] == [1, 2]
    assert covers(across["pdf_anchor"], data, CARRIED[-30:], 1)
    assert covers(across["pdf_anchor"], data, CARRIED_REST[:30], 2)


async def test_tc09_a_highlight_comes_back_whole_for_its_owner_only(client, auth):
    h = auth()
    data = sample_pdf()
    doc = await upload(client, h, data)
    quote = "Opening words of the first paragraph"
    made = await create(client, h, pdf_spot(doc["id"], data, quote))
    assert [
        {k: x[k] for k in ("id", "clean_anchor", "pdf_anchor", "sync_status")}
        for x in await listed(client, h, doc["id"])
    ] == [{k: made[k] for k in ("id", "clean_anchor", "pdf_anchor", "sync_status")}]
    stranger = auth()
    assert (await client.get("/api/highlights", headers=stranger)).json()["items"] == []
    assert (
        await client.post("/api/highlights", headers=stranger, json=clean_spot(doc, quote))
    ).status_code == 404


def changed_pdf() -> bytes:
    """The sentences of the sample, in another order and with one of them gone."""
    doc = pymupdf.open()
    page = doc.new_page()
    page.insert_textbox((72, 72, 520, 150), SECOND, fontsize=11)
    page.insert_textbox(
        (72, 170, 520, 250), "A new opening stands where the old one was written.", fontsize=11
    )
    page.insert_textbox((72, 270, 520, 420), LONG_WORDS, fontsize=11)
    data = doc.tobytes()
    doc.close()
    return data


async def test_tc10_reading_the_file_again_loses_nothing(client, auth):
    h = auth()
    data = sample_pdf()
    doc = await upload(client, h, data)
    moved = await create(
        client, h, {**clean_spot(doc, "Another paragraph starts differently"), "note": "giữ"}
    )
    gone = await create(client, h, {**clean_spot(doc, "Opening words of the first paragraph"), "note": "còn"})
    on_pdf = await create(
        client, h, {**pdf_spot(doc["id"], data, "It then closes in its own way"), "note": "pdf"}
    )
    async with SessionLocal() as s:
        row = await s.get(Highlight, uuid.UUID(moved["id"]))
        stored = await s.get(Document, row.document_id)
        path = get_settings().upload_dir / stored.file_storage_path
    path.write_bytes(changed_pdf())

    r = await client.post(f"/api/documents/{doc['id']}/reprocess", headers=h)
    assert r.status_code == 202, r.text
    after = (await client.get(f"/api/documents/{doc['id']}", headers=h)).json()
    assert after["reprocess_state"] == "done" and after["content_version"] != doc["content_version"]

    rows = {x["id"]: x for x in await listed(client, h, doc["id"])}
    assert len(rows) == 3 and {x["note"] for x in rows.values()} == {"giữ", "còn", "pdf"}
    assert rows[moved["id"]]["sync_status"] == "synced"
    assert spans_read(after, rows[moved["id"]]) == anchors.squash("Another paragraph starts differently")
    assert rows[gone["id"]]["sync_status"] == "unsynced" and rows[gone["id"]]["clean_anchor"] is None
    assert rows[gone["id"]]["anchor_status"] == "unresolved"
    assert rows[on_pdf["id"]]["sync_status"] == "unsynced"  # its words are not in the new text


async def test_tc12_what_cannot_be_placed_is_kept_and_says_so(client, auth):
    h = auth()
    data = sample_pdf()
    doc = await upload(client, h, data)
    body = {
        "document_id": doc["id"],
        "page_number": 1,
        "rects": [{"x": 0.1, "y": 0.1, "w": 0.3, "h": 0.02}],
        "selected_text": "Words the clean text has never held",
        "color": "yellow",
    }
    made = await create(client, h, body)
    assert made["sync_status"] == "unsynced" and made["clean_anchor"] is None
    assert made["canonical_start"] is None
    assert made["pdf_anchor"] == [{"page": 1, "rects": body["rects"]}]

    # The same words as a real passage, but selected somewhere else on the page: not moved onto it.
    far = {**body, "selected_text": "Opening words of the first paragraph"}
    far["rects"] = [{"x": 0.1, "y": 0.8, "w": 0.3, "h": 0.02}]
    stray = await create(client, h, far)
    assert stray["clean_anchor"] is None and stray["sync_status"] == "unsynced"

    # Text of the clean view not found on the PDF stays in the clean view.
    async with SessionLocal() as s:
        await s.execute(
            update(Document)
            .where(Document.id == uuid.UUID(doc["id"]))
            .values(content_clean=doc["content_clean"] + "\n\nA paragraph the file does not contain at all.")
        )
        await s.commit()
    fresh = (await client.get(f"/api/documents/{doc['id']}", headers=h)).json()
    only_clean = await create(client, h, clean_spot(fresh, "A paragraph the file does not contain"))
    assert only_clean["sync_status"] == "unsynced" and only_clean["pdf_anchor"] is None
    assert spans_read(fresh, only_clean) == anchors.squash("A paragraph the file does not contain")


async def legacy(doc_id: str, user_id, **values) -> uuid.UUID:
    row = Highlight(user_id=user_id, document_id=uuid.UUID(doc_id), **values)
    async with SessionLocal() as s:
        s.add(row)
        await s.commit()
        return row.id


async def owner_of(doc_id: str) -> uuid.UUID:
    async with SessionLocal() as s:
        return (await s.get(Document, uuid.UUID(doc_id))).user_id


@pytest.fixture
def only_this_document(monkeypatch):
    """The script goes over every document; here only those of the test at hand."""

    def limit(doc_id: str):
        original = sync_highlights.select

        def narrowed(*args, **kw):
            stmt = original(*args, **kw)
            if args and args[0] is Highlight.document_id:
                return stmt.where(Highlight.document_id == uuid.UUID(doc_id))
            return stmt

        monkeypatch.setattr(sync_highlights, "select", narrowed)

    return limit


async def test_tc11_existing_duplicates_are_joined_without_losing_anything(client, auth, only_this_document):
    h = auth()
    data = sample_pdf()
    doc = await upload(client, h, data)
    only_this_document(doc["id"])
    user = await owner_of(doc["id"])
    quote = "Opening words of the first paragraph"
    clean = clean_spot(doc, quote)
    rects = pdf_spot(doc["id"], data, quote)["rects"]
    older = await legacy(
        doc["id"], user, block_id=clean["block_id"], start_offset=clean["start_offset"],
        end_offset=clean["end_offset"], selected_text=quote, color="yellow", note="từ văn bản sạch",
    )  # fmt: skip
    newer = await legacy(
        doc["id"], user, rects=rects, page_number=1, selected_text=quote, color="yellow", note="từ PDF",
    )  # fmt: skip
    # Same words elsewhere, and a pair in different colors: neither may be joined.
    twice_a = clean_spot(doc, REPEATED, 0)
    twice_b = clean_spot(doc, REPEATED, 1)
    a = await legacy(doc["id"], user, block_id=twice_a["block_id"], start_offset=twice_a["start_offset"],
                     end_offset=twice_a["end_offset"], selected_text=REPEATED, color="green")  # fmt: skip
    b = await legacy(doc["id"], user, block_id=twice_b["block_id"], start_offset=twice_b["start_offset"],
                     end_offset=twice_b["end_offset"], selected_text=REPEATED, color="green")  # fmt: skip
    colored = clean_spot(doc, "Another paragraph starts differently")
    c = await legacy(doc["id"], user, block_id=colored["block_id"], start_offset=colored["start_offset"],
                     end_offset=colored["end_offset"], selected_text=colored["selected_text"], color="pink")  # fmt: skip
    d = await legacy(doc["id"], user, rects=pdf_spot(doc["id"], data, colored["selected_text"])["rects"],
                     page_number=1, selected_text=colored["selected_text"], color="blue", note="giữ riêng")  # fmt: skip
    async with SessionLocal() as s:
        nb = Notebook(user_id=user, title="Sổ")
        s.add(nb)
        await s.flush()
        s.add(NotebookHighlight(notebook_id=nb.id, highlight_id=newer, position=1))
        await s.commit()
        notebook_id = nb.id

    report = await sync_highlights.run(apply=False)  # report only: nothing moves
    assert report["would_merge"] == [{"kept": str(older)[:8], "merged": str(newer)[:8]}]
    assert report["left_for_review"] == [{"highlights": [str(c)[:8], str(d)[:8]], "why": "different colors"}]
    assert len(await listed(client, h, doc["id"])) == 6
    assert all(x["canonical_start"] is None for x in await listed(client, h, doc["id"]))

    edited = {x["id"]: x["updated_at"] for x in await listed(client, h, doc["id"])}
    await sync_highlights.run(apply=True)
    rows = {uuid.UUID(x["id"]): x for x in await listed(client, h, doc["id"])}
    assert rows[a]["updated_at"] == edited[str(a)]  # being placed is not an edit
    assert set(rows) == {older, a, b, c, d}
    assert rows[older]["note"] == "từ văn bản sạch\n\ntừ PDF" and rows[older]["color"] == "yellow"
    assert rows[a]["canonical_start"] != rows[b]["canonical_start"]
    assert rows[c]["sync_status"] == "synced" and rows[d]["sync_status"] == "ambiguous"  # first come keeps it
    assert rows[d]["note"] == "giữ riêng" and rows[d]["color"] == "blue"
    async with SessionLocal() as s:
        link = (
            (await s.scalars(select(NotebookHighlight).where(NotebookHighlight.notebook_id == notebook_id)))
            .unique()
            .one()
        )
        assert link.highlight_id == older and link.position == 1
        log = (await s.scalars(select(HighlightMerge).where(HighlightMerge.kept_highlight_id == older))).one()
        assert log.merged_row["id"] == str(newer) and log.merged_row["note"] == "từ PDF"
        assert log.notebook_links == [{"notebook_id": str(notebook_id), "position": 1}]

    again = await sync_highlights.run(apply=True)  # a second run has nothing left to join
    assert again["merged"] == []
    assert len(await listed(client, h, doc["id"])) == 5


def test_placing_needs_no_guess_about_a_scanned_page():
    """A page read by OCR has a box but no characters: known page, no lines to mark."""
    ix = highlight_sync.TextIndex("Some words read from a scan.", [["x", [[1, 0, 0, 1, 1]]]], None)
    view = anchors.Highlighted(ix.blocks[0].id, "words read", 1, None, None, False, 5)
    where = highlight_sync.place(ix, view)
    assert where.start is not None and where.pdf is None and where.sync == "synced"  # no PDF to go to


def test_extraction_sample_is_what_the_tests_expect():
    import tempfile
    from pathlib import Path

    with tempfile.TemporaryDirectory() as d:
        path = Path(d) / "s.pdf"
        path.write_bytes(sample_pdf())
        result = extract_pdf(path, "s")
    assert result.source_map and REPEATED in result.content
