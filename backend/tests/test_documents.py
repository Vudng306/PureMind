import io
import re
import uuid
from unittest.mock import AsyncMock, patch

from PIL import Image

from app.core.config import get_settings
from tests.pdfs import encrypted_pdf, image_only_pdf, text_pdf


def pdf_file(data: bytes, name: str = "giao-trinh.pdf"):
    return {"file": (name, data, "application/pdf")}


async def upload(client, headers, data: bytes, name: str = "giao-trinh.pdf"):
    return await client.post("/api/documents/upload", headers=headers, files=pdf_file(data, name))


async def test_upload_extracts_pdf(client, auth):
    h = auth()
    r = await upload(client, h, text_pdf(3, title="Nhập môn ML"))
    assert r.status_code == 201, r.text
    doc = r.json()
    assert doc["extraction_status"] == "done"
    assert doc["title"] == "Nhập môn ML"
    assert doc["page_count"] == 3
    assert doc["file_type"] == "pdf"
    assert "# Chapter 1" in doc["content_clean"]
    assert "---" in doc["content_clean"]
    assert doc["reading_minutes"] == 1


async def test_rejects_wrong_type_and_fake_extension(client, auth):
    h = auth()
    r = await client.post("/api/documents/upload", headers=h, files={"file": ("a.txt", b"hi", "text/plain")})
    assert r.status_code == 422 and r.json()["detail"] == "Chỉ hỗ trợ tệp PDF hoặc EPUB."
    r = await upload(client, h, b"MZ not really a pdf", "virus.pdf")
    assert r.status_code == 422


async def test_rejects_too_large(client, auth, monkeypatch):
    monkeypatch.setattr(get_settings(), "max_upload_bytes", 1000)
    r = await upload(client, auth(), text_pdf(1) + b"0" * 2000)
    assert r.status_code == 413 and "50 MB" in r.json()["detail"]


async def test_extraction_failures_keep_document(client, auth):
    h = auth()
    scan = (await upload(client, h, image_only_pdf(), "scan.pdf")).json()
    assert scan["extraction_status"] == "failed" and scan["extraction_error"] == "MSG-15"
    locked = (await upload(client, h, encrypted_pdf(), "locked.pdf")).json()
    assert locked["extraction_status"] == "failed" and locked["extraction_error"] == "MSG-14"

    listed = (await client.get("/api/documents", headers=h)).json()
    assert {d["id"] for d in listed} == {scan["id"], locked["id"]}
    assert "content_clean" not in listed[0]


async def test_filename_is_sanitized(client, auth):
    r = await upload(client, auth(), text_pdf(1), "../../etc/pa?ss.pdf")
    assert r.status_code == 201
    assert r.json()["original_filename"] == "pa_ss.pdf"


def test_sanitize_filename_unit():
    from app.services.storage import sanitize_filename

    assert sanitize_filename("../../etc/pa\x00ss.pdf") == "pass.pdf"
    assert sanitize_filename("C:\\Users\\x\\bài giảng.pdf") == "bài giảng.pdf"
    assert sanitize_filename("...") == "document"
    long = sanitize_filename("a" * 300 + ".pdf")
    assert len(long) == 200 and long.endswith(".pdf")


async def test_library_is_private_and_sorted(client, auth):
    alice, bob = auth(), auth()
    a1 = (await upload(client, alice, text_pdf(1), "b-doc.pdf")).json()
    a2 = (await upload(client, alice, text_pdf(1), "a-doc.pdf")).json()
    b1 = (await upload(client, bob, text_pdf(1))).json()

    alice_docs = (await client.get("/api/documents", headers=alice)).json()
    assert [d["id"] for d in alice_docs] == [a2["id"], a1["id"]]
    by_title = (await client.get("/api/documents?sort=title", headers=alice)).json()
    assert [d["title"] for d in by_title] == ["a-doc", "b-doc"]

    # NFR-SEC-04: every per-document endpoint returns 404 for another user's document
    for method, path, kw in [
        ("GET", f"/api/documents/{b1['id']}", {}),
        ("GET", f"/api/documents/{b1['id']}/file", {}),
        ("PATCH", f"/api/documents/{b1['id']}", {"json": {"title": "x"}}),
        ("DELETE", f"/api/documents/{b1['id']}", {}),
        ("POST", f"/api/documents/{b1['id']}/retry-extraction", {}),
    ]:
        r = await client.request(method, path, headers=alice, **kw)
        assert r.status_code == 404, (method, path)


async def test_file_download_supports_range(client, auth):
    h = auth()
    data = text_pdf(2)
    doc = (await upload(client, h, data)).json()
    full = await client.get(f"/api/documents/{doc['id']}/file", headers=h)
    assert full.status_code == 200 and full.content == data
    assert full.headers["content-type"] == "application/pdf"
    part = await client.get(f"/api/documents/{doc['id']}/file", headers={**h, "Range": "bytes=0-9"})
    assert part.status_code == 206 and part.content == data[:10]


async def test_update_and_delete_document(client, auth):
    h = auth()
    doc = (await upload(client, h, text_pdf(3))).json()
    r = await client.patch(
        f"/api/documents/{doc['id']}", headers=h, json={"last_read_page": 2, "title": " Mới "}
    )
    assert r.status_code == 200 and r.json()["last_read_page"] == 2 and r.json()["title"] == "Mới"
    r = await client.patch(f"/api/documents/{doc['id']}", headers=h, json={"last_read_page": 9})
    assert r.status_code == 422
    # F-16: rename (whitespace collapsed, blank refused) and mark read / unread.
    r = await client.patch(f"/api/documents/{doc['id']}", headers=h, json={"title": "Giáo  trình\n học máy"})
    assert r.status_code == 200 and r.json()["title"] == "Giáo trình học máy"
    r = await client.patch(f"/api/documents/{doc['id']}", headers=h, json={"title": "   "})
    assert r.status_code == 422
    r = await client.patch(f"/api/documents/{doc['id']}", headers=h, json={"title": "x" * 501})
    assert r.status_code == 422
    r = await client.patch(f"/api/documents/{doc['id']}", headers=h, json={"is_read": True})
    assert r.json()["is_read"] is True
    r = await client.patch(f"/api/documents/{doc['id']}", headers=h, json={"is_read": False})
    assert r.json()["is_read"] is False and r.json()["title"] == "Giáo trình học máy"

    path = get_settings().upload_dir.resolve() / (await _storage_path(doc["id"]))
    assert path.is_file()
    assert (await client.delete(f"/api/documents/{doc['id']}", headers=h)).status_code == 204
    assert not path.exists()
    assert (await client.get(f"/api/documents/{doc['id']}", headers=h)).status_code == 404


async def _storage_path(document_id: str) -> str:
    from app.db.session import SessionLocal
    from app.models import Document

    async with SessionLocal() as s:
        return (await s.get(Document, uuid.UUID(document_id))).file_storage_path


def _png(size=(600, 400)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", size, (200, 100, 50)).save(buf, format="PNG")
    return buf.getvalue()


async def test_avatar_upload_resize_and_delete(client, auth):
    h = auth()
    r = await client.put("/api/account/avatar", headers=h, files={"file": ("me.png", _png(), "image/png")})
    assert r.status_code == 200 and r.json()["avatar_url"].startswith("/api/account/avatar")
    img = await client.get("/api/account/avatar", headers=h)
    assert img.status_code == 200
    assert max(Image.open(io.BytesIO(img.content)).size) == 256

    bad = await client.put(
        "/api/account/avatar", headers=h, files={"file": ("x.png", b"GIF89a....", "image/png")}
    )
    assert bad.status_code == 422
    assert (await client.delete("/api/account/avatar", headers=h)).json()["avatar_url"] is None


async def test_delete_account_removes_data_files_and_supabase_user(client, auth):
    uid = uuid.uuid4()
    h = auth(uid)
    doc = (await upload(client, h, text_pdf(1))).json()
    file_path = get_settings().upload_dir.resolve() / (await _storage_path(doc["id"]))

    with patch("app.api.routes.account.delete_auth_user", new=AsyncMock()) as admin_delete:
        r = await client.delete("/api/account", headers=h)
    assert r.status_code == 204
    admin_delete.assert_awaited_once()
    assert admin_delete.await_args.args[1] == uid
    assert not file_path.exists()

    from app.db.session import SessionLocal
    from app.models import Document, User

    async with SessionLocal() as s:
        assert await s.get(User, uid) is None
        assert await s.get(Document, uuid.UUID(doc["id"])) is None


async def test_delete_account_keeps_data_when_supabase_fails(client, auth):
    from app.services.supabase_admin import SupabaseAdminError

    h = auth()
    doc = (await upload(client, h, text_pdf(1))).json()
    with patch("app.api.routes.account.delete_auth_user", new=AsyncMock(side_effect=SupabaseAdminError)):
        r = await client.delete("/api/account", headers=h)
    assert r.status_code == 502
    assert (await client.get(f"/api/documents/{doc['id']}", headers=h)).status_code == 200


def test_extract_pdf_tables_and_speed(tmp_path):
    import time

    from app.services.extraction import extract_pdf
    from tests.pdfs import table_pdf

    t = tmp_path / "t.pdf"
    t.write_bytes(table_pdf())
    content = extract_pdf(t, "t").content
    assert "|ML|Machine learning|AI|" in content.replace(" ", "").replace(
        "Machinelearning", "Machine learning"
    )

    big = tmp_path / "big.pdf"
    big.write_bytes(text_pdf(100))
    start = time.monotonic()
    result = extract_pdf(big, "big")
    assert result.page_count == 100
    assert time.monotonic() - start < 15  # NFR-PERF-06


async def test_pdf_images_in_clean_text(client, auth):
    from app.services import storage
    from tests.pdfs import image_pdf, scanned_pdf

    h, other = auth(), auth()
    doc = (await upload(client, h, image_pdf())).json()
    assert doc["extraction_status"] == "done", doc
    content = doc["content_clean"]
    # Only the figure: the icon is too small, the logo is on every page and the gradient is decoration.
    names = re.findall(r"^!\[\]\(pm-image:([0-9a-f]{16}\.webp)\)$", content, re.M)
    assert len(names) == 1
    assert content.index("Text before the figure, page 1") < content.index("pm-image:")
    assert content.index("pm-image:") < content.index("Text after the figure, page 1")
    folder = storage.resolve(get_settings(), storage.images_path(uuid.UUID(doc["id"])))
    assert [p.name for p in folder.iterdir()] == names

    url = f"/api/documents/{doc['id']}/images/{names[0]}"
    r = await client.get(url, headers=h)
    assert r.status_code == 200 and r.headers["content-type"] == "image/webp"
    assert Image.open(io.BytesIO(r.content)).size == (400, 300)
    assert (await client.get(url, headers=other)).status_code == 404  # NFR-SEC-04
    for bad in ("..%2F..%2Fsecret.webp", "0123456789abcdef.png", "ffffffffffffffff.webp"):
        assert (await client.get(f"/api/documents/{doc['id']}/images/{bad}", headers=h)).status_code == 404

    assert (await client.delete(f"/api/documents/{doc['id']}", headers=h)).status_code == 204
    assert not folder.exists()

    # A scan is still "no text" (MSG-15), and leaves no images behind.
    scan = (await upload(client, h, scanned_pdf(), "scan.pdf")).json()
    assert scan["extraction_status"] == "failed" and scan["extraction_error"] == "MSG-15"
    assert not storage.resolve(get_settings(), storage.images_path(uuid.UUID(scan["id"]))).exists()


def test_images_are_left_out_of_ai_text():
    from app.services.doc_chat import split_chunks
    from app.services.extraction import PAGE_SEPARATOR
    from app.services.html_markdown import strip_images

    text = "Intro\n\n![](pm-image:0123456789abcdef.webp)\n\nMore ![inline](x) text"
    assert strip_images(text) == "Intro\n\nMore ![inline](x) text"
    # A page holding only a figure still counts, so later passages keep their page numbers.
    content = PAGE_SEPARATOR.join(["Page one.", "![](pm-image:0123456789abcdef.webp)", "Page three."])
    chunks = split_chunks(content, 400, page_count=3)
    assert [(c.page_number, c.text) for c in chunks] == [(1, "Page one."), (3, "Page three.")]


async def test_pdf_layout_in_clean_text(client, auth):
    from app.services import storage
    from tests.pdfs import paper_pdf

    h = auth()
    doc = (await upload(client, h, paper_pdf())).json()
    assert doc["extraction_status"] == "done", doc
    content = doc["content_clean"]
    # Running header and page numbers are gone; the section number becomes a heading.
    assert "Journal of Tests" not in content and "arXiv" not in content
    assert not re.search(r"^\d+$", content, re.M)
    assert "## 1 Introduction" in content
    # Each column is read to its end before the next one starts, then the footnote.
    first_page = content.split("\n\n---\n\n")[0]
    assert first_page.index("Left column opens page 1") < first_page.index("Right column follows on page 1")
    assert first_page.rindex("Left column") < first_page.index("Right column")
    assert first_page.index("Right column") < first_page.index(r"\* These authors contributed equally.")
    assert "Corresponding author" not in content and "@example.com" not in content
    assert "1Test University." in content and "Correspondence" not in content
    # The two masked strips of the table are one picture, and it is not blank.
    names = re.findall(r"pm-image:([0-9a-f]{16}\.webp)", content)
    assert len(names) == 1
    path = storage.resolve(get_settings(), f"{storage.images_path(doc['id'])}/{names[0]}")
    with Image.open(path) as img:
        assert img.size == (300, 300) and img.convert("L").getextrema() == (0, 255)


def test_symbol_font_and_bold_runs():
    from app.services.extraction import _Line, _markdown_runs, _symbol_text

    assert _symbol_text("75 m, v, ' = 6.9", False) == "75 μm, σv, φ' = 6.9°"
    assert _symbol_text("a M n", True) == "α M ν"  # a Symbol font's own letters; look-alike capitals stay
    assert _symbol_text("", False) == ""  # a dingbat with no meaning in text is left out
    # Two bold lines keep the space between them ("volume change behaviour", not "changebehaviour").
    lines = [
        _Line([("volume change ", True)], 16, (0, 0, 1, 1)),
        _Line([("behaviour", True)], 16, (0, 1, 1, 2)),
    ]
    assert _markdown_runs(lines) == "**volume change behaviour**"
    hyphen = [
        _Line([("water-", False)], 10, (0, 0, 1, 1)),
        _Line([("saturated clay", False)], 10, (0, 1, 1, 2)),
    ]
    assert _markdown_runs(hyphen) == "water-saturated clay"

    from app.services.extraction import _span_text

    def span(text, flags=0):
        return {"text": text, "font": "Times", "flags": flags}

    assert _span_text(span("3", 1)) == "³"  # cm³
    assert _span_text(span("1,*", 1)) == "¹,*"  # an author's affiliation and note marks
    assert _span_text(span("see", 1)) == "see"  # raised words stay words
    assert _span_text(span("3")) == "3"


def test_tables_drawn_with_rules_only(tmp_path):
    from app.services.extraction import extract_pdf
    from tests.pdfs import ruled_table_pdf

    path = tmp_path / "t.pdf"
    path.write_bytes(ruled_table_pdf())
    content = extract_pdf(path, "t").content
    assert "| Liquid limit [%] | Plastic limit [%] | Density |" in content
    assert "| 96 | 59 | 2.886 |" in content
    # Rows alike ("Case 1", "Case 2") have no header; the items of a list in a cell stay on their own lines.
    assert "|  |  |" in content
    assert "| Case 1 | 1. Consolidation (32 kPa to 1612 kPa)<br>2. Swelling (1612 kPa to 32 kPa) |" in content
    assert "| Case 2 | 1. Osmotic consolidation |" in content
    assert content.rstrip().endswith("paragraph of the paper.")
    assert "Creative Commons" not in content  # the publisher's licence line at the foot of the page


def test_vector_chart_is_one_picture(tmp_path):
    from app.services.extraction import extract_pdf
    from tests.pdfs import chart_pdf

    path, images = tmp_path / "c.pdf", tmp_path / "img"
    path.write_bytes(chart_pdf())
    content = extract_pdf(path, "c", images).content
    lines = [ln for ln in content.split("\n") if ln.strip()]
    pictures = [i for i, ln in enumerate(lines) if ln.startswith("![](pm-image:")]
    assert len(pictures) == 1
    assert len(list(images.glob("*.webp"))) == 1
    # In place: after the text above it, before its caption; its axis text is in the picture only.
    assert "chart of the water content" in lines[pictures[0] - 1]
    assert lines[pictures[0] + 1].startswith("Fig. 1.")
    assert "Suction" not in content and "Water content" not in content
    # A table with rules is still a table, its text as written (not HTML-escaped).
    assert "| Clay <5 µm | 2.7 |" in content
    assert "&lt;" not in content


def test_grid_markdown_rejects_what_is_not_a_table():
    from app.services.extraction import _grid_markdown

    class Grid:
        def __init__(self, rows):
            self.rows = rows

        def extract(self):
            return self.rows

    assert _grid_markdown(Grid([["A", "B"], ["1", "2"], ["1", "2"]])) == "| A | B |\n|---|---|\n| 1 | 2 |"
    assert _grid_markdown(Grid([["a|b", "x\ny"], ["1", "2"]])).startswith("| a\\|b | x y |")
    assert _grid_markdown(Grid([["only one row", "x"]])) is None
    assert _grid_markdown(Grid([["", "", "x"], ["", "", ""], ["y", "", ""]])) is None  # gridlines
    stacked = "\n".join(f"{n}. x" for n in range(1, 8))
    assert _grid_markdown(Grid([[stacked, "a"], ["b", "c"]])) is None  # a column of stacked labels


def test_paragraph_cut_by_a_page_break_is_whole():
    from app.services.extraction import _carried_over

    pages = [
        ["Intro.", "Testing of"],
        ["partially saturated soils is old.", "Next one."],
        ["\\* a table note", "| a \\| b | c || b |"],
        ["lower case after a table stays."],
        ["A hyphen-", "ated word ends", "with no carry"],
        ["Capital starts a new paragraph."],
    ]
    sources = [[[[n, k]] for k in range(len(p))] for n, p in enumerate(pages, 1)]
    merged = _carried_over([list(p) for p in pages], sources)
    assert merged[0] == ["Intro.", "Testing of partially saturated soils is old."]
    # The paragraph carried over keeps the boxes of both its parts.
    assert sources[0] == [[[1, 0]], [[1, 1], [2, 0]]] and sources[1] == [[[2, 1]]]
    assert len(sources) == len(merged)
    assert _carried_over(pages) == [
        ["Intro.", "Testing of partially saturated soils is old."],
        ["Next one."],
        ["\\* a table note", "| a \\| b | c || b |"],
        ["lower case after a table stays."],
        ["A hyphen-", "ated word ends", "with no carry"],
        ["Capital starts a new paragraph."],
    ]


def test_booktabs_table_rows_split_by_spacing(tmp_path):
    from app.services.extraction import extract_pdf
    from tests.pdfs import booktabs_table_pdf

    path = tmp_path / "b.pdf"
    path.write_bytes(booktabs_table_pdf())
    content = extract_pdf(path, "b").content
    assert "| Definition | Failure | Explanation |" in content
    # Each row whole, its two-line cells joined, and one row per definition.
    for n in (1, 12):
        row = (
            f"| Definition {n} of general intelligence, source {n}. | Not Feasible "
            f"| Why definition {n} fails, in two lines of text. |"
        )
        assert row in content
    assert content.count("| Not Feasible |") == 12
    assert content.index("| Definition |") < content.index("Table 1.") < content.index("Body text under")


def test_chart_past_the_page_edge_keeps_column_order(tmp_path):
    from app.services.extraction import extract_pdf
    from tests.pdfs import overhanging_chart_pdf

    path, images = tmp_path / "o.pdf", tmp_path / "img"
    path.write_bytes(overhanging_chart_pdf())
    content = extract_pdf(path, "o", images).content
    assert content.rindex("Left column text") < content.index("Right column text")
    assert content.index("Right column text") < content.index("pm-image:") < content.index("Fig. 1.")


async def test_table_picture_is_read_by_ocr(client, auth, monkeypatch):
    from sqlalchemy import select

    from app.core.config import get_settings
    from app.db.session import SessionLocal
    from app.models import Document
    from app.services import openai_client, storage
    from app.services.doc_chat import split_chunks
    from app.services.extraction import block_key, reader_keys
    from tests.pdfs import image_table_pdf

    settings = get_settings()
    monkeypatch.setattr(settings, "openai_api_key", "sk-test")
    sent = []

    table = "| Parameter | Value |\n|---|---|\n| λ | 0.12 |\n| κ \\| s | 0.03 |"

    note = "A bar chart of settlement (mm) against time (days) for Case 1 and Case 2."

    async def chat(settings, messages, **kwargs):
        sent.append((messages, kwargs))
        if kwargs["purpose"] == "figure_notes":
            return openai_client.Completion(f" {note}\n", openai_client.Usage())
        return openai_client.Completion(f"```markdown\n{table}\n```", openai_client.Usage())

    monkeypatch.setattr(openai_client, "chat", chat)
    h = auth()
    doc = (await upload(client, h, image_table_pdf())).json()
    assert doc["extraction_status"] == "done", doc
    content = doc["content_clean"]
    # Only the picture by the "Table" caption is sent (read twice, the readings agreeing), and it becomes
    # the table (fence dropped, "\|" kept).
    assert [kw["purpose"] for _, kw in sent] == ["table_ocr", "table_ocr", "figure_notes"]
    image = sent[0][0][0]["content"][1]["image_url"]["url"]
    assert image.startswith("data:image/jpeg;base64,")
    assert table in content
    assert content.index("Table 3.") < content.index("| Parameter |") < content.index("Text between")
    # The figure stays a picture; the table's picture is no longer stored.
    names = re.findall(r"pm-image:([0-9a-f]{16}\.webp)", content)
    assert len(names) == 1 and content.index("pm-image:") < content.index("Fig. 2.")
    folder = storage.resolve(get_settings(), storage.images_path(uuid.UUID(doc["id"])))
    assert [p.name for p in folder.iterdir()] == names
    # The table read from the picture keeps the picture's place on the PDF.
    url = f"/api/documents/{doc['id']}/source-map"
    boxes = dict((await client.get(url, headers=h)).json())
    assert set(boxes) == set(reader_keys(content))
    assert [b[0] for b in boxes[block_key(table)]] == [1]
    assert all(0 <= v <= 1 for b in boxes[block_key(table)] for v in b[1:])
    assert (await client.get(url, headers=auth())).status_code == 404
    # After the response, the figure left is described once for the AI, with its caption as context; the
    # AI's passages carry the description where the image was.
    prompt = sent[2][0][0]["content"][0]["text"]
    assert "English" in prompt and "Fig. 2. A figure, not a table." in prompt
    async with SessionLocal() as s:
        notes = await s.scalar(select(Document.figure_notes).where(Document.id == uuid.UUID(doc["id"])))
    assert notes == {names[0]: note}
    chunks = split_chunks(content, 400, 1, notes)
    assert f"[Figure: {note}]" in chunks[0].text and "pm-image" not in chunks[0].text


async def test_figure_notes_skip_decoration_and_failures(monkeypatch):
    from app.core.config import get_settings
    from app.services import figure_notes, openai_client

    settings = get_settings()
    monkeypatch.setattr(settings, "openai_api_key", "sk-test")
    doc_id = uuid.uuid4()
    content = "Text.\n\n![](pm-image:0123456789abcdef.webp)\n\n![](pm-image:fedcba9876543210.webp)"
    assert figure_notes.figure_names(content + "\n\n![](pm-image:0123456789abcdef.webp)") == [
        "0123456789abcdef.webp",
        "fedcba9876543210.webp",
    ]
    # The images are not stored: nothing is sent, nothing is described.
    calls = AsyncMock(return_value=openai_client.Completion("SKIP", openai_client.Usage()))
    monkeypatch.setattr(openai_client, "chat", calls)
    assert await figure_notes.describe_figures(settings, doc_id, content) == {}
    assert calls.await_count == 0

    async def load(*args):
        return "data:image/jpeg;base64,AA=="

    monkeypatch.setattr(figure_notes.chat_image, "load", load)
    answers = [openai_client.Completion("SKIP.", openai_client.Usage()), openai_client.AIError("HTTP 500")]
    monkeypatch.setattr(openai_client, "chat", AsyncMock(side_effect=answers))
    assert await figure_notes.describe_figures(settings, doc_id, content) == {}
    monkeypatch.setattr(settings, "openai_api_key", "")
    assert await figure_notes.describe_figures(settings, doc_id, content) == {}


async def test_scanned_pages_are_read_by_ocr(client, auth, monkeypatch):
    from app.services import openai_client, page_ocr
    from app.services.extraction import block_key, scanned_pages
    from tests.pdfs import mixed_scan_pdf, scanned_pdf, text_pdf

    settings = get_settings()
    monkeypatch.setattr(settings, "openai_api_key", "sk-test")
    page = "# 2. Method\n\nThe scanned paragraph, as read.\n\n---\n\n| a | b |\n|---|---|\n| 1 | 2 |"
    sent = []

    async def chat(settings, messages, **kwargs):
        sent.append(kwargs["purpose"])
        image = messages[0]["content"][1]["image_url"]["url"]
        assert image.startswith("data:image/jpeg;base64,")
        blank = len(sent) > 1  # the second scan is an empty page
        return openai_client.Completion(
            "BLANK_PAGE" if blank else f"```markdown\n{page}\n```", openai_client.Usage()
        )

    monkeypatch.setattr(openai_client, "chat", chat)
    monkeypatch.setattr(page_ocr, "CONCURRENCY", 1)  # pages read in order, so the answers match them
    h = auth()
    first = (await upload(client, h, mixed_scan_pdf(), "scan.pdf")).json()
    # A scan is read after the response, while the library shows it as being processed.
    assert first["extraction_status"] == "pending"
    doc = (await client.get(f"/api/documents/{first['id']}", headers=h)).json()
    assert doc["extraction_status"] == "done", doc
    assert sent == ["page_ocr", "page_ocr"]
    content = doc["content_clean"]
    assert content.index("Typed first page") < content.index("# 2. Method") < content.index("| 1 | 2 |")
    assert "pm-ocr" not in content and "```" not in content
    # Two page breaks for three pages (the blank one stays a page, empty); the rule on the page is gone.
    assert content.split("\n").count("---") == 2 and "The scanned paragraph, as read." in content
    source = dict((await client.get(f"/api/documents/{doc['id']}/source-map", headers=h)).json())
    assert source[block_key("# 2. Method")] == [[2, 0, 0, 1, 1]]
    assert source[block_key("Typed first page of the report.")][0][0] == 1

    # A scan the model cannot read is still "no text" (MSG-15).
    monkeypatch.setattr(openai_client, "chat", AsyncMock(side_effect=openai_client.AIError("HTTP 500")))
    failed = (await upload(client, h, scanned_pdf(), "unread.pdf")).json()
    failed = (await client.get(f"/api/documents/{failed['id']}", headers=h)).json()
    assert failed["extraction_status"] == "failed" and failed["extraction_error"] == "MSG-15"

    for data, pages in ((mixed_scan_pdf(), [2, 3]), (text_pdf(2), []), (b"not a pdf", [])):
        path = get_settings().upload_dir / "probe.pdf"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        assert scanned_pages(path) == pages


def test_ocr_page_is_cleaned_up():
    from app.services.page_ocr import _markdown

    raw = "```markdown\n#  3  Numerical  Simulation\n\n![](./images/p2_fig.jpg)\n\nFig. 4. Caption.\n\n***\n\nText.\n```"
    assert _markdown(raw) == "# 3 Numerical Simulation\n\nFig. 4. Caption.\n\nText."
    assert _markdown(" BLANK_PAGE. ") is None and _markdown("") is None


def test_figure_notes_stand_in_for_images_in_ai_text():
    from app.services.html_markdown import strip_images

    text = "Intro\n\n![](pm-image:0123456789abcdef.webp)\n\n![](pm-image:fedcba9876543210.webp)\n\n![w](https://x/y.png)"
    notes = {"0123456789abcdef.webp": "A line chart."}
    assert strip_images(text, notes) == "Intro\n\n[Figure: A line chart.]\n\n"
    assert strip_images(text) == "Intro\n\n"


def test_vector_chart_data_is_read_from_its_drawing(tmp_path):
    from app.services.extraction import extract_pdf
    from tests.pdfs import CHART_LINE, CHART_LOG, CHART_MARKERS, chart_pdf, data_chart_pdf

    path, images = tmp_path / "c.pdf", tmp_path / "img"
    path.write_bytes(data_chart_pdf())
    result = extract_pdf(path, "c", images)
    [(name, chart)] = result.charts.items()
    assert f"![](pm-image:{name})" in result.content and "Case 1" not in result.content
    linear, log = chart["panels"]
    # The values plotted, exactly, each series named by the legend beside its colour; the faint grey
    # backdrop and the legend's own samples are not data.
    assert linear["title"] == "(a) Linear"
    assert linear["x"] == {"title": "Distance (m)", "scale": "linear"}
    assert linear["y"] == {"title": "Height (m)", "scale": "linear"}
    assert [(s["name"], s["color"]) for s in linear["series"]] == [
        ("Case 1", "#ff0000"),
        ("Case 2", "#0000ff"),
    ]
    assert linear["series"][0]["points"] == [list(p) for p in CHART_MARKERS]
    assert linear["series"][1]["points"] == [[x, round(y, 3)] for x, y in CHART_LINE]
    # Panel (b) shares the row of x labels (set a shade higher, still after (a)), but its numbers start
    # over on a log scale; its "+" markers are two strokes each, where a tick mark is one.
    assert log["title"] == "(b) Log" and log["x"] == {"title": "Time (s)", "scale": "log"}
    assert [s["points"] for s in log["series"]] == [[list(p) for p in CHART_LOG]]
    # A chart with numbers on one axis only has nothing to read values against; without pictures, no data.
    path.write_bytes(chart_pdf())
    assert extract_pdf(path, "c", images).charts == {}
    path.write_bytes(data_chart_pdf())
    assert extract_pdf(path, "c").charts == {}


def test_chart_data_stands_in_for_its_image_in_ai_text():
    from app.api.routes.chat import _digest
    from app.services.chart_data import _plain, chart_text
    from app.services.html_markdown import strip_images

    # Math italic letters in a title are the letters; other symbols stay.
    assert _plain("a) Hysteresis in 𝑒-𝑤-SC, ρd (g/cm³)") == "a) Hysteresis in e-w-SC, ρd (g/cm³)"

    many = [[i, i * 2] for i in range(100)]
    chart = {
        "panels": [
            {
                "title": "",
                "x": {"title": "Suction (kPa)", "scale": "log"},
                "y": {"title": "", "scale": "linear"},
                "series": [{"name": "", "color": "#000000", "points": many}],
            }
        ]
    }
    text = chart_text(chart)
    # Every paragraph says what its numbers are; a long series is thinned, its ends kept.
    assert text.startswith(
        "[Chart data read from the PDF drawing — panel 1; x = Suction (kPa) (log scale); y = y;"
    )
    assert "series 1, 30 of 100 points]" in text
    assert text.count("(") - 2 == 30 and "(0, 0)" in text and "(99, 198)" in text
    image = "![](pm-image:0123456789abcdef.webp)"
    notes, charts = {"0123456789abcdef.webp": "A curve."}, {"0123456789abcdef.webp": chart}
    assert strip_images(f"Intro\n\n{image}\n\nAfter", notes, charts) == (
        f"Intro\n\n[Figure: A curve.]\n\n{text}\n\nAfter"
    )
    assert strip_images(f"{image}\n\nAfter", None, charts) == f"{text}\n\nAfter"
    # The AI's passages are made again once a chart's data is known.
    assert _digest("Intro", notes) != _digest("Intro", notes, charts)


async def test_chart_data_endpoint(client, auth):
    from app.services.doc_chat import split_chunks
    from tests.pdfs import data_chart_pdf

    h = auth()
    doc = (await upload(client, h, data_chart_pdf())).json()
    assert doc["extraction_status"] == "done", doc
    url = f"/api/documents/{doc['id']}/charts"
    response = await client.get(url, headers=h)
    assert response.headers["cache-control"] == "private, no-cache"
    charts = response.json()
    [name] = charts
    assert f"pm-image:{name}" in doc["content_clean"] and len(charts[name]["panels"]) == 2
    chunks = split_chunks(doc["content_clean"], 400, 1, None, charts)
    assert "series Case 2] (0, 40) (10, 37)" in chunks[0].text and "pm-image" not in chunks[0].text
    assert (await client.get(url, headers=auth())).status_code == 404
    # A document without a vector chart has none.
    plain = (await upload(client, h, text_pdf(1), "plain.pdf")).json()
    assert (await client.get(f"/api/documents/{plain['id']}/charts", headers=h)).json() == {}


async def test_table_picture_stays_when_ocr_cannot_read_it(client, auth, monkeypatch):
    from app.core.config import get_settings
    from app.services import openai_client
    from tests.pdfs import image_table_pdf

    settings = get_settings()
    h = auth()
    calls = AsyncMock(return_value=openai_client.Completion("NOT_A_TABLE", openai_client.Usage()))
    monkeypatch.setattr(openai_client, "chat", calls)
    # Without an API key there is no OCR at all.
    monkeypatch.setattr(settings, "openai_api_key", "")
    content = (await upload(client, h, image_table_pdf())).json()["content_clean"]
    assert calls.await_count == 0 and len(re.findall(r"pm-image:", content)) == 2

    monkeypatch.setattr(settings, "openai_api_key", "sk-test")
    # Two readings that disagree on a number: neither is trusted.
    table = "| a \\| b | c || b |\n|---|---|\n| x | {} |"
    readings = [openai_client.Completion(table.format(n), openai_client.Usage()) for n in ("0.25", "1.14")]
    disagree = AsyncMock(side_effect=readings)
    for answer in (calls, AsyncMock(side_effect=openai_client.AIError("HTTP 500")), disagree):
        monkeypatch.setattr(openai_client, "chat", answer)
        doc = (await upload(client, h, image_table_pdf(), "again.pdf")).json()
        assert doc["extraction_status"] == "done"
        assert len(re.findall(r"pm-image:", doc["content_clean"])) == 2
        assert "|" not in doc["content_clean"]


def test_source_map_keys_follow_the_reader_blocks():
    from app.services.extraction import block_key, reader_keys

    assert block_key("Tiếng Việt 😀") == "81cd6bb3"  # the reader's id of this paragraph is "b81cd6bb3"
    text = "# Title\n\n- a\n- b\n> q\n> r\nline one\n  line two\n\n```\ncode\n```\n---\n| x | y |\n|---|---|"
    assert reader_keys(text) == [
        block_key("# Title"),
        block_key("- a\n- b"),
        block_key("> q\nr"),
        block_key("line one line two"),
        block_key("```code"),
        block_key("| x | y |\n|---|---|"),
    ]


def test_ocr_table_is_checked_and_evened_out():
    from app.services.table_ocr import _markdown_table

    # A section title across the table comes back short of cells; every row gets the same width.
    answer = "| Section |\n|---|\n| λ | Index | 2.01 |\n" r"| a \| b | c |"
    assert _markdown_table(answer) == (
        "| Section |  |  |\n|---|---|---|\n| λ | Index | 2.01 |\n" r"| a \| b | c |  |"
    )
    assert _markdown_table("NOT_A_TABLE") is None
    assert _markdown_table("| a \\| b | c || b |\n| x | y |") is None  # no separator: not a table


def test_numbered_equations_are_kept_as_pictures(tmp_path):
    from app.services.extraction import equation_count, extract_pdf
    from tests.pdfs import equation_pdf

    path = tmp_path / "eq.pdf"
    path.write_bytes(equation_pdf())
    result = extract_pdf(path, "eq", tmp_path / "img")
    content = result.content
    # Each equation left of a "(n)" is a picture of it, numbered; its text and its number are gone.
    assert sorted(result.equation_images.values()) == ["1", "2"]
    lines = content.split("\n\n")
    first, second = (lines.index(f"![](pm-image:{n})") for n in result.equation_images)
    assert lines[0].startswith("The phase relationships") and lines[3].startswith("where the total")
    assert {first, second} == {1, 2}
    assert "w = M/Ms" not in content and "(1)" not in content and "(2)" not in content
    # Running text beside a "(3)" and a year in brackets are not equations.
    assert "(3)" in content and "(2013)" in content and "these results were measured" in content
    assert equation_count(path) == 3
    # Without somewhere to keep pictures, the equations stay as their text.
    assert "w = M/Ms - 1" in extract_pdf(path, "eq").content


async def test_equations_are_read_as_latex(client, auth, monkeypatch):
    from app.core.config import get_settings
    from app.services import equation_ocr, openai_client
    from app.services.extraction import block_key, reader_keys
    from tests.pdfs import equation_pdf

    settings = get_settings()
    monkeypatch.setattr(settings, "openai_api_key", "sk-test")
    monkeypatch.setattr(equation_ocr, "CONCURRENCY", 1)  # equations read in order, so the answers match
    answers = iter(
        [
            r"$$w = \frac{M}{M_{\mathrm{s}}} - 1 \tag{1}$$",
            r"w=\frac{M}{M_s}-1",  # the same equation, written another way: the readings agree
            r"e = G_s \rho_w",
            r"e = G_s \rho_w - 1",  # two readings that disagree: the picture stays
        ]
    )
    sent = []

    async def chat(settings, messages, **kwargs):
        sent.append(kwargs["purpose"])
        if kwargs["purpose"] == "figure_notes":
            return openai_client.Completion("An equation.", openai_client.Usage())
        return openai_client.Completion(next(answers), openai_client.Usage())

    monkeypatch.setattr(openai_client, "chat", chat)
    h = auth()
    doc = (await upload(client, h, equation_pdf())).json()
    assert doc["extraction_status"] == "done", doc
    content = doc["content_clean"]
    assert sent[:4] == ["equation_ocr"] * 4
    line = r"$$w = \frac{M}{M_{\mathrm{s}}} - 1 \tag{1}$$"
    assert line in content.split("\n\n")
    assert len(re.findall(r"pm-image:", content)) == 1  # the second equation, still a picture
    boxes = dict((await client.get(f"/api/documents/{doc['id']}/source-map", headers=h)).json())
    assert set(boxes) == set(reader_keys(content))
    assert [b[0] for b in boxes[block_key(line)]] == [1]


def test_equation_readings_are_checked():
    from app.services.equation_ocr import _latex, _same, math_line

    assert _latex("```latex\n" r"\[ a = b \label{eq:1} \]" "\n```") == "a = b"
    assert _latex("NOT_AN_EQUATION") is None
    assert _latex(r"a = \frac{b}{c") is None  # braces that do not pair up
    assert _latex("a = } b {") is None
    assert _latex(r"a = \{ b") == r"a = \{ b"
    assert _latex("cost is $5") is None
    assert _same(r"\left( a \right) = \dfrac{1}{2}", r"(a)=\frac12")
    assert not _same("a = b + 1", "a = b - 1")
    assert math_line("a = b", "3") == r"$$a = b \tag{3}$$" and math_line("a") == "$$a$$"


def test_reader_keys_read_equation_lines():
    from app.services.extraction import block_key, reader_keys

    text = "the relationships:\n" r"$$w = 1 \tag{1}$$" "\n\nPrice $5 and $$ or $6.\n\n$$ $$"
    assert reader_keys(text) == [
        block_key("the relationships:"),
        block_key(r"$$w = 1 \tag{1}$$"),
        block_key("Price $5 and $$ or $6."),
        block_key("$$ $$"),
    ]


def test_scanned_page_equations_are_one_line():
    from app.services.page_ocr import _markdown

    text = "Text $5 and $6.\n\n$$\n" r"a = \frac{b}{c}" "\n" r"\tag{2}" "\n$$\n\n" r"\[ x^2 \]"
    text += "\n\n$$ open\n\nnever closed"
    assert _markdown(text) == (
        "Text $5 and $6.\n\n" r"$$a = \frac{b}{c} \tag{2}$$" "\n\n$$x^2$$\n\n$$ open\n\nnever closed"
    )
