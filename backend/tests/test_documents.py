import io
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
    r = await client.patch(f"/api/documents/{doc['id']}", headers=h, json={"last_read_page": 2, "title": " Mới "})
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

    bad = await client.put("/api/account/avatar", headers=h, files={"file": ("x.png", b"GIF89a....", "image/png")})
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
    assert "|ML|Machine learning|AI|" in content.replace(" ", "").replace("Machinelearning", "Machine learning")

    big = tmp_path / "big.pdf"
    big.write_bytes(text_pdf(100))
    start = time.monotonic()
    result = extract_pdf(big, "big")
    assert result.page_count == 100
    assert time.monotonic() - start < 15  # NFR-PERF-06
