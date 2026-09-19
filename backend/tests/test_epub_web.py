import io
import zipfile

import httpx
import pytest

from app.services import web
from tests.pdfs import text_pdf

CONTAINER = """<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>"""

OPF = """<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Sách Thử Nghiệm</dc:title></metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="c1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="text/ch2.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine><itemref idref="nav"/><itemref idref="c1"/><itemref idref="c2"/></spine>
</package>"""

CH1 = """<html><head><style>p{color:red}</style></head><body>
<h1>Chương 1: Khởi đầu</h1>
<p>Học máy là một lĩnh vực của <strong>trí tuệ nhân tạo</strong>, giúp máy tính học từ dữ liệu.</p>
<ul><li>Học có giám sát</li><li>Học không giám sát</li></ul>
<script>alert(1)</script>
</body></html>"""

CH2 = "<html><body><p>ngắn</p></body></html>"


def make_epub(first_entry_ok: bool = True, **overrides) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        if first_entry_ok:
            z.writestr(zipfile.ZipInfo("mimetype"), "application/epub+zip", compress_type=zipfile.ZIP_STORED)
        files = {
            "META-INF/container.xml": CONTAINER,
            "OEBPS/content.opf": OPF,
            "OEBPS/nav.xhtml": "<html><body><nav><a href='x'>Mục lục dài dài dài dài dài dài dài dài dài dài</a></nav></body></html>",
            "OEBPS/text/ch1.xhtml": CH1,
            "OEBPS/text/ch2.xhtml": CH2,
            **overrides,
        }
        for name, data in files.items():
            z.writestr(name, data, compress_type=zipfile.ZIP_DEFLATED)
    return buf.getvalue()


async def test_upload_epub_extracts_chapters(client, auth):
    h = auth()
    r = await client.post("/api/documents/upload", headers=h, files={"file": ("sach.epub", make_epub(), "application/epub+zip")})
    assert r.status_code == 201, r.text
    doc = r.json()
    assert doc["extraction_status"] == "done"
    assert doc["file_type"] == "epub"
    assert doc["title"] == "Sách Thử Nghiệm"
    assert doc["page_count"] is None
    md = doc["content_clean"]
    assert md.startswith("# Chương 1: Khởi đầu")
    assert "**trí tuệ nhân tạo**" in md
    assert "- Học có giám sát" in md
    assert "alert" not in md and "Mục lục" not in md and "ngắn" not in md

    f = await client.get(f"/api/documents/{doc['id']}/file", headers=h)
    assert f.headers["content-type"] == "application/epub+zip"


async def test_epub_signature_is_checked(client, auth):
    r = await client.post(
        "/api/documents/upload", headers=auth(), files={"file": ("fake.epub", make_epub(first_entry_ok=False), "application/epub+zip")}
    )
    assert r.status_code == 422


async def test_rate_limit_uploads(client, auth, monkeypatch):
    from app.core.ratelimit import upload_limiter

    monkeypatch.setattr(upload_limiter, "limit", 2)
    h = auth()
    files = lambda: {"file": ("a.pdf", text_pdf(1), "application/pdf")}  # noqa: E731
    assert (await client.post("/api/documents/upload", headers=h, files=files())).status_code == 201
    assert (await client.post("/api/documents/upload", headers=h, files=files())).status_code == 201
    r = await client.post("/api/documents/upload", headers=h, files=files())
    assert r.status_code == 429
    # other users are unaffected
    assert (await client.post("/api/documents/upload", headers=auth(), files=files())).status_code == 201


# ------------------------------------------------------------------ SSRF / save link

@pytest.mark.parametrize(
    "ip,public",
    [
        ("127.0.0.1", False), ("10.0.0.1", False), ("172.16.5.4", False), ("192.168.1.1", False),
        ("169.254.169.254", False), ("0.0.0.0", False), ("100.64.0.1", False), ("224.0.0.1", False),
        ("::1", False), ("fe80::1", False), ("fc00::1", False), ("::ffff:127.0.0.1", False),
        ("93.184.216.34", True), ("2606:4700:4700::1111", True),
    ],
)
def test_is_public_ip(ip, public):
    assert web.is_public_ip(ip) is public


ARTICLE = b"""<html><head>
<title>Fallback title</title>
<meta property="og:title" content="Vi sao can doc cham">
<meta property="article:published_time" content="2026-09-01T08:00:00Z">
</head><body>
<header><nav><a href="/">Home</a><a href="/a">A</a></nav></header>
<div class="sidebar related"><p>Bai lien quan rat hay, doc them nhieu bai khac nua nhe ban oi.</p></div>
<article class="post-content">
  <h2>Mo dau<a class="headerlink" href="#mo-dau">&para;</a></h2>
  <p>Doc cham giup ghi nho lau hon, vi nao bo co thoi gian ket noi y tuong moi voi kien thuc cu.</p>
  <p>Nhieu nghien cuu cho thay, khi ghi chu trong luc doc, nguoi hoc hieu sau hon va nho lau hon.</p>
  <p>Xem them tai <a href="https://example.org/study">nghien cuu nay</a>, rat de doc va de hieu.</p>
</article>
<footer class="footer"><p>Copyright 2026, moi quyen duoc bao luu boi tac gia va nha xuat ban.</p></footer>
</body></html>"""


class FakeWeb:
    """Replaces DNS and the network transport for fetch_url."""

    def __init__(self, monkeypatch):
        self.dns: dict[str, list[str]] = {}
        self.routes: dict[str, httpx.Response] = {}
        self.requests: list[httpx.Request] = []

        async def resolve(host, port):
            if host not in self.dns:
                raise web.FetchFailed
            return self.dns[host]

        def handler(request: httpx.Request) -> httpx.Response:
            self.requests.append(request)
            key = f"{request.headers['host']}{request.url.raw_path.decode()}"
            return self.routes.get(key, httpx.Response(404))

        monkeypatch.setattr(web, "resolve_host", resolve)
        monkeypatch.setattr(web, "make_transport", lambda: httpx.MockTransport(handler))


@pytest.fixture
def fake_web(monkeypatch):
    return FakeWeb(monkeypatch)


async def test_save_article(client, auth, fake_web):
    fake_web.dns["blog.example.com"] = ["93.184.216.34"]
    fake_web.routes["blog.example.com/posts/1"] = httpx.Response(200, headers={"content-type": "text/html; charset=utf-8"}, content=ARTICLE)
    h = auth()

    r = await client.post("/api/documents/save-url", headers=h, json={"url": "https://blog.example.com/posts/1"})
    assert r.status_code == 201, r.text
    doc = r.json()
    assert doc["title"] == "Vi sao can doc cham"
    assert doc["file_type"] == "web" and doc["source_type"] == "manual"
    md = doc["content_clean"]
    assert "## Mo dau\n" in md and "¶" not in md
    assert "[nghien cuu nay](https://example.org/study)" in md
    assert "Bai lien quan" not in md and "Copyright" not in md and "Home" not in md

    # connected to the vetted IP, with the original Host header (no second DNS lookup)
    req = fake_web.requests[0]
    assert req.url.host == "93.184.216.34" and req.headers["host"] == "blog.example.com"

    again = await client.post("/api/documents/save-url", headers=h, json={"url": "https://blog.example.com/posts/1"})
    assert again.status_code == 200 and again.json()["id"] == doc["id"]
    assert len(fake_web.requests) == 1

    other_user = await client.post("/api/documents/save-url", headers=auth(), json={"url": "https://blog.example.com/posts/1"})
    assert other_user.status_code == 201 and other_user.json()["id"] != doc["id"]


async def test_save_online_pdf(client, auth, fake_web):
    fake_web.dns["files.example.com"] = ["93.184.216.34"]
    fake_web.routes["files.example.com/papers/attention.pdf"] = httpx.Response(200, headers={"content-type": "application/pdf"}, content=text_pdf(2))
    h = auth()
    r = await client.post("/api/documents/save-url", headers=h, json={"url": "https://files.example.com/papers/attention.pdf"})
    assert r.status_code == 201, r.text
    doc = r.json()
    assert doc["file_type"] == "pdf" and doc["page_count"] == 2 and doc["extraction_status"] == "done"
    assert (await client.get(f"/api/documents/{doc['id']}/file", headers=h)).status_code == 200


@pytest.mark.parametrize("url", ["ftp://example.com/a", "javascript:alert(1)", "http://user:pw@example.com/", "not a url", "https://" + "a" * 2050])
async def test_save_url_invalid(client, auth, url):
    r = await client.post("/api/documents/save-url", headers=auth(), json={"url": url})
    assert r.status_code == 422
    assert r.json()["detail"].startswith("Đường link không hợp lệ")


@pytest.mark.parametrize(
    "url,dns",
    [
        ("http://127.0.0.1/", {}),
        ("http://169.254.169.254/latest/meta-data/", {}),
        ("http://10.0.0.1/", {}),
        ("http://[::1]:8000/", {}),
        ("http://internal.example.com/", {"internal.example.com": ["10.1.2.3"]}),
        ("http://mixed.example.com/", {"mixed.example.com": ["93.184.216.34", "192.168.0.10"]}),
    ],
)
async def test_save_url_blocks_internal_addresses(client, auth, fake_web, url, dns):
    fake_web.dns.update(dns)
    r = await client.post("/api/documents/save-url", headers=auth(), json={"url": url})
    assert r.status_code == 422
    assert r.json()["detail"] == "Không thể lưu đường link này."
    assert fake_web.requests == []


async def test_redirect_to_internal_address_is_blocked(client, auth, fake_web):
    fake_web.dns["short.example.com"] = ["93.184.216.34"]
    fake_web.routes["short.example.com/x"] = httpx.Response(302, headers={"location": "http://127.0.0.1:8000/api/healthz"})
    r = await client.post("/api/documents/save-url", headers=auth(), json={"url": "http://short.example.com/x"})
    assert r.status_code == 422 and r.json()["detail"] == "Không thể lưu đường link này."
    assert len(fake_web.requests) == 1


async def test_too_many_redirects_and_http_errors(client, auth, fake_web):
    fake_web.dns["loop.example.com"] = ["93.184.216.34"]
    fake_web.routes["loop.example.com/a"] = httpx.Response(301, headers={"location": "/a"})
    r = await client.post("/api/documents/save-url", headers=auth(), json={"url": "http://loop.example.com/a"})
    assert r.status_code == 422 and r.json()["detail"].startswith("Không truy cập được")
    assert len(fake_web.requests) == web.MAX_REDIRECTS + 1

    r = await client.post("/api/documents/save-url", headers=auth(), json={"url": "http://loop.example.com/missing"})
    assert r.status_code == 422 and r.json()["detail"].startswith("Không truy cập được")

    r = await client.post("/api/documents/save-url", headers=auth(), json={"url": "http://nxdomain.example.com/"})
    assert r.status_code == 422 and r.json()["detail"].startswith("Không truy cập được")


async def test_response_size_limit(client, auth, fake_web, monkeypatch):
    monkeypatch.setattr(web, "MAX_BYTES", 1000)
    fake_web.dns["big.example.com"] = ["93.184.216.34"]
    fake_web.routes["big.example.com/"] = httpx.Response(200, headers={"content-type": "text/html"}, content=b"<p>" + b"x" * 5000)
    r = await client.post("/api/documents/save-url", headers=auth(), json={"url": "http://big.example.com/"})
    assert r.status_code == 422


def test_nested_lists_are_kept():
    from bs4 import BeautifulSoup

    from app.services.html_markdown import html_to_markdown

    soup = BeautifulSoup("<ul><li>Một<ul><li>Một-a</li></ul></li><li>Hai</li></ul>", "html.parser")
    assert html_to_markdown(soup) == "- Một\n  - Một-a\n- Hai"


def test_article_inside_negative_wrapper_is_kept():
    # vnexpress.net wraps the whole story in <div class="sidebar-1">, next to a real sidebar.
    story = "".join(f"<p>Đoạn {i}: AI đang thay đổi cách doanh nghiệp xây dựng phần mềm, từng bước một.</p>" for i in range(6))
    html = f"""<html><head><title>Tiêu đề bài</title></head><body><!-- end header -->
    <div class="sidebar-1"><article class="fck_detail"><h1>Tiêu đề bài</h1>{story}</article></div>
    <div class="sidebar-2"><p>Tin nổi bật trong ngày hôm nay, đọc thêm ngay tại đây nhé.</p></div>
    <!-- END CONTENT --></body></html>""".encode()

    article = web.extract_article(html, "https://news.example.com/a")
    assert "Đoạn 0: AI" in article.content and "Đoạn 5: AI" in article.content
    assert "Tin nổi bật" not in article.content
    assert "END CONTENT" not in article.content and "end header" not in article.content
    assert not article.content.startswith("#")  # the <h1> repeating the title is dropped


async def test_refusing_site_gets_a_specific_message(client, auth, fake_web):
    fake_web.dns["wiki.example.org"] = ["93.184.216.34"]
    fake_web.routes["wiki.example.org/wiki/A"] = httpx.Response(403, text="Please respect our robot policy")
    r = await client.post("/api/documents/save-url", headers=auth(), json={"url": "https://wiki.example.org/wiki/A"})
    assert r.status_code == 422 and "không cho phép PureMind" in r.json()["detail"]
    # a contact is sent so such sites can tell who is fetching (defaults to the app's URL)
    assert fake_web.requests[0].headers["user-agent"].endswith("PureMindReader/1.0 (+http://localhost:3000)")


def test_user_agent_contact_is_sanitized():
    assert web.user_agent("").endswith("PureMindReader/1.0")
    assert web.user_agent(" ops@example.com ").endswith("(+ops@example.com)")
    assert web.user_agent("a)\r\nX-Evil: 1").endswith("(+aX-Evil: 1)")


def test_hidden_blocks_and_related_links_are_dropped():
    story = "".join(f"<p>Đoạn {i}: nội dung chính của bài viết, đủ dài để được tính là văn xuôi.</p>" for i in range(5))
    html = f"""<html><head><title>Bài</title></head><body><article>{story}
    <p>Theo <a href="https://example.org/src">nguồn này</a>, kết quả đã được kiểm chứng kỹ lưỡng.</p>
    <div class="box-more"><a href="https://news.example.com/1">Tin khác một</a> <a href="https://news.example.com/2">Tin khác hai</a></div>
    <div class="list_link"><ul><li data-id="7">Tin khác không có link, gắn link bằng script</li></ul></div>
    <ul class="list-news hidden"><li><a href="https://news.example.com/3">Tin ẩn</a></li></ul>
    <p style="display: none">Đoạn bị ẩn bằng CSS, người đọc không nhìn thấy nó.</p>
    </article></body></html>""".encode()

    content = web.extract_article(html, "https://news.example.com/a").content
    assert "Đoạn 4" in content and "[nguồn này](https://example.org/src)" in content
    assert "Tin khác" not in content and "Tin ẩn" not in content and "bị ẩn" not in content


def test_relative_upload_dir_is_anchored_to_backend(monkeypatch):
    from app.core.config import BACKEND_DIR, Settings

    monkeypatch.chdir(BACKEND_DIR.parent)
    assert Settings(upload_dir="uploads").upload_dir == BACKEND_DIR / "uploads"
