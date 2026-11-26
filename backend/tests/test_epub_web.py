import io
import json
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
    r = await client.post(
        "/api/documents/upload", headers=h, files={"file": ("sach.epub", make_epub(), "application/epub+zip")}
    )
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
        "/api/documents/upload",
        headers=auth(),
        files={"file": ("fake.epub", make_epub(first_entry_ok=False), "application/epub+zip")},
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
        ("127.0.0.1", False),
        ("10.0.0.1", False),
        ("172.16.5.4", False),
        ("192.168.1.1", False),
        ("169.254.169.254", False),
        ("0.0.0.0", False),
        ("100.64.0.1", False),
        ("224.0.0.1", False),
        ("::1", False),
        ("fe80::1", False),
        ("fc00::1", False),
        ("::ffff:127.0.0.1", False),
        ("93.184.216.34", True),
        ("2606:4700:4700::1111", True),
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


# The same page with a whole article's worth of text: what "save a link" keeps.
FULL = ARTICLE.replace(
    b"</article>",
    b"".join(
        b"<p>Doan %d: doc cham giup nguoi hoc ghi nho lau hon va hieu sau hon nhung gi da doc trong ngay.</p>"
        % n
        for n in range(20)
    )
    + b"</article>",
)


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
    fake_web.routes["blog.example.com/posts/1"] = httpx.Response(
        200, headers={"content-type": "text/html; charset=utf-8"}, content=FULL
    )
    h = auth()

    r = await client.post(
        "/api/documents/save-url", headers=h, json={"url": "https://blog.example.com/posts/1"}
    )
    assert r.status_code == 201, r.text
    doc = r.json()
    assert doc["extraction_status"] == "done" and doc["word_count"] >= web.MIN_ARTICLE_WORDS
    assert doc["title"] == "Vi sao can doc cham"
    assert doc["file_type"] == "web" and doc["source_type"] == "manual"
    md = doc["content_clean"]
    assert "## Mo dau\n" in md and "¶" not in md
    assert "[nghien cuu nay](https://example.org/study)" in md
    assert "Bai lien quan" not in md and "Copyright" not in md and "Home" not in md

    # connected to the vetted IP, with the original Host header (no second DNS lookup)
    req = fake_web.requests[0]
    assert req.url.host == "93.184.216.34" and req.headers["host"] == "blog.example.com"

    again = await client.post(
        "/api/documents/save-url", headers=h, json={"url": "https://blog.example.com/posts/1"}
    )
    assert again.status_code == 200 and again.json()["id"] == doc["id"]
    assert len(fake_web.requests) == 1

    other_user = await client.post(
        "/api/documents/save-url", headers=auth(), json={"url": "https://blog.example.com/posts/1"}
    )
    assert other_user.status_code == 201 and other_user.json()["id"] != doc["id"]


async def test_save_online_pdf(client, auth, fake_web):
    fake_web.dns["files.example.com"] = ["93.184.216.34"]
    fake_web.routes["files.example.com/papers/attention.pdf"] = httpx.Response(
        200, headers={"content-type": "application/pdf"}, content=text_pdf(2)
    )
    h = auth()
    r = await client.post(
        "/api/documents/save-url", headers=h, json={"url": "https://files.example.com/papers/attention.pdf"}
    )
    assert r.status_code == 201, r.text
    doc = r.json()
    assert doc["file_type"] == "pdf" and doc["page_count"] == 2 and doc["extraction_status"] == "done"
    assert (await client.get(f"/api/documents/{doc['id']}/file", headers=h)).status_code == 200


@pytest.mark.parametrize(
    "url",
    [
        "ftp://example.com/a",
        "javascript:alert(1)",
        "http://user:pw@example.com/",
        "not a url",
        "https://" + "a" * 2050,
    ],
)
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
    fake_web.routes["short.example.com/x"] = httpx.Response(
        302, headers={"location": "http://127.0.0.1:8000/api/healthz"}
    )
    r = await client.post(
        "/api/documents/save-url", headers=auth(), json={"url": "http://short.example.com/x"}
    )
    assert r.status_code == 422 and r.json()["detail"] == "Không thể lưu đường link này."
    assert len(fake_web.requests) == 1


async def test_too_many_redirects_and_http_errors(client, auth, fake_web):
    fake_web.dns["loop.example.com"] = ["93.184.216.34"]
    fake_web.routes["loop.example.com/a"] = httpx.Response(301, headers={"location": "/a"})
    r = await client.post(
        "/api/documents/save-url", headers=auth(), json={"url": "http://loop.example.com/a"}
    )
    assert r.status_code == 422 and r.json()["detail"].startswith("Không truy cập được")
    assert len(fake_web.requests) == web.MAX_REDIRECTS + 1

    r = await client.post(
        "/api/documents/save-url", headers=auth(), json={"url": "http://loop.example.com/missing"}
    )
    assert r.status_code == 422 and r.json()["detail"].startswith("Không truy cập được")

    r = await client.post(
        "/api/documents/save-url", headers=auth(), json={"url": "http://nxdomain.example.com/"}
    )
    assert r.status_code == 422 and r.json()["detail"].startswith("Không truy cập được")


async def test_response_size_limit(client, auth, fake_web, monkeypatch):
    monkeypatch.setattr(web, "MAX_BYTES", 1000)
    fake_web.dns["big.example.com"] = ["93.184.216.34"]
    fake_web.routes["big.example.com/"] = httpx.Response(
        200, headers={"content-type": "text/html"}, content=b"<p>" + b"x" * 5000
    )
    r = await client.post("/api/documents/save-url", headers=auth(), json={"url": "http://big.example.com/"})
    assert r.status_code == 422


def test_nested_lists_are_kept():
    from bs4 import BeautifulSoup

    from app.services.html_markdown import html_to_markdown

    soup = BeautifulSoup("<ul><li>Một<ul><li>Một-a</li></ul></li><li>Hai</li></ul>", "html.parser")
    assert html_to_markdown(soup) == "- Một\n  - Một-a\n- Hai"


def test_article_inside_negative_wrapper_is_kept():
    # vnexpress.net wraps the whole story in <div class="sidebar-1">, next to a real sidebar.
    story = "".join(
        f"<p>Đoạn {i}: AI đang thay đổi cách doanh nghiệp xây dựng phần mềm, từng bước một.</p>"
        for i in range(6)
    )
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
    r = await client.post(
        "/api/documents/save-url", headers=auth(), json={"url": "https://wiki.example.org/wiki/A"}
    )
    assert r.status_code == 422 and "không cho phép PureMind" in r.json()["detail"]
    # a contact is sent so such sites can tell who is fetching (defaults to the app's URL)
    assert fake_web.requests[0].headers["user-agent"].endswith("PureMindReader/1.0 (+http://localhost:3000)")


def test_user_agent_contact_is_sanitized():
    assert web.user_agent("").endswith("PureMindReader/1.0")
    assert web.user_agent(" ops@example.com ").endswith("(+ops@example.com)")
    assert web.user_agent("a)\r\nX-Evil: 1").endswith("(+aX-Evil: 1)")


def test_hidden_blocks_and_related_links_are_dropped():
    story = "".join(
        f"<p>Đoạn {i}: nội dung chính của bài viết, đủ dài để được tính là văn xuôi.</p>" for i in range(5)
    )
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


def test_article_cut_into_pieces_is_put_back_together():
    # arXiv's LaTeXML gives every paragraph its own <div>, and wired.com puts advertisements between
    # sibling chunks of the story: the best-scoring block is one piece, the article is its parent.
    pieces = "".join(
        f'<div class="ltx_para"><p>Đoạn {i}: mô hình ngôn ngữ được huấn luyện trên dữ liệu lớn.</p></div>'
        f'<div class="ad-slot"><a href="https://ads.example.com/{i}">Quảng cáo</a></div>'
        for i in range(8)
    )
    html = f"""<html><head><title>Bài dài</title></head><body>
    <nav><a href="/1">Mục một</a> <a href="/2">Mục hai</a> <a href="/3">Mục ba</a></nav>
    <div class="ltx_page"><div class="ltx_article">{pieces}</div></div></body></html>""".encode()

    content = web.extract_article(html, "https://arxiv.example.org/html/1").content
    assert "Đoạn 0" in content and "Đoạn 7" in content
    assert "Mục một" not in content


def test_article_body_named_like_navigation_is_kept():
    # 24h.com.vn calls its article body "cate-24h-foot-arti-deta-info": a name is a hint, the text is
    # evidence, so a block holding most of the page's prose is the article whatever it is called.
    story = "".join(
        f"<p>Đoạn {i}: nội dung chính của bài viết, đủ dài để được tính là văn xuôi thật.</p>"
        for i in range(8)
    )
    html = f"""<html><head><title>Bài</title></head><body>
    <div class="cate-24h-foot-arti-deta-info">{story}</div>
    <div class="menu-nav"><p>Chuyên mục thể thao, giải trí và kinh doanh của trang tin.</p></div>
    </body></html>""".encode()

    content = web.extract_article(html, "https://news.example.com/a").content
    assert "Đoạn 0" in content and "Đoạn 7" in content
    assert "Chuyên mục thể thao" not in content


def test_formula_source_is_not_repeated_after_the_formula():
    # MathML carries the formula twice: the rendered markup and the TeX source in <annotation>.
    story = "".join(f"<p>Đoạn {i}: phần mở đầu của bài báo khoa học này khá dài dòng.</p>" for i in range(5))
    html = f"""<html><head><title>Bài</title></head><body><article>{story}
    <p>Ta có <math><mi>E</mi><mo>=</mo><mi>m</mi><msup><mi>c</mi><mn>2</mn></msup>
    <annotation encoding="application/x-tex">E=mc^{{2}}</annotation></math> là công thức nổi tiếng.</p>
    </article></body></html>""".encode()

    content = web.extract_article(html, "https://arxiv.example.org/html/2").content
    assert "E=mc^{2}" not in content and "x-tex" not in content


def test_article_streamed_inside_a_hidden_block_is_found():
    # React streams server-rendered content as <div hidden id="S:1"> and a script moves it into place;
    # other sites animate a display:none wrapper into view. Neither is hidden from the reader.
    story = "".join(
        f"<p>Đoạn {i}: nội dung chính của bài viết, đủ dài để được tính là văn xuôi thật.</p>"
        for i in range(12)
    )
    html = f"""<html><head><title>Bài</title></head><body>
    <div id="root"></div>
    <div hidden id="S:1"><article>{story}</article></div></body></html>""".encode()

    content = web.extract_article(html, "https://spa.example.com/a").content
    assert "Đoạn 0" in content and "Đoạn 11" in content


def test_pruning_never_throws_the_whole_article_away():
    # lesswrong.com wraps the post in <div class="commentOnSelection">, so the name-based pruning
    # deletes the article and keeps nothing. Losing everything means the guess was wrong.
    story = "".join(
        f"<p>Đoạn {i}: nội dung chính của bài viết, đủ dài để được tính là văn xuôi thật.</p>"
        for i in range(12)
    )
    html = f"""<html><head><title>Bài</title></head><body>
    <div class="commentOnSelection">{story}</div></body></html>""".encode()

    content = web.extract_article(html, "https://forum.example.com/posts/1").content
    assert "Đoạn 0" in content and "Đoạn 11" in content


def test_citation_list_and_navigation_boxes_are_dropped():
    # On Wikipedia the reference list is longer than the article itself.
    story = "".join(f"<p>Đoạn {i}: nội dung bách khoa toàn thư về chủ đề này.</p>" for i in range(6))
    refs = "".join(
        f'<li>Nguồn {i}: <a href="https://example.org/{i}">một cuốn sách rất dày về đề tài này</a>, '
        f"nhà xuất bản, năm 2020, trang {i}.</li>"
        for i in range(30)
    )
    html = f"""<html><head><title>Bài</title></head><body>
    <div class="mw-parser-output">{story}
    <div class="reflist"><ol class="references">{refs}</ol></div>
    <div class="navbox"><p>Xem thêm các bài viết cùng chủ đề trong hộp điều hướng này.</p></div>
    <div class="noprint"><p>Trang này được sửa đổi lần cuối vào ngày 1 tháng 1 năm 2026.</p></div>
    </div></body></html>""".encode()

    content = web.extract_article(html, "https://vi.wikipedia.org/wiki/A").content
    assert "Đoạn 5" in content
    assert "Nguồn 0" not in content and "hộp điều hướng" not in content and "sửa đổi lần cuối" not in content


def test_table_of_contents_dots_are_collapsed():
    from bs4 import BeautifulSoup

    from app.services.html_markdown import html_to_markdown

    soup = BeautifulSoup("<p>Chương một . . . . . . . . . . . . . . 12</p>", "html.parser")
    assert html_to_markdown(soup) == "Chương một … 12"


def test_falls_back_to_the_article_body_the_page_publishes():
    # A page whose markup hides the story from the scoring still describes itself in schema.org data.
    body = " ".join(f"Câu số {i} của bài viết." for i in range(80))
    ld = json.dumps({"@graph": [{"@type": "NewsArticle", "articleBody": body}]})
    html = f"""<html><head><title>Bài</title>
    <script type="application/ld+json">{ld}</script></head>
    <body><div id="root"></div></body></html>""".encode()

    article = web.extract_article(html, "https://news.example.com/a")
    assert "Câu số 0" in article.content and "Câu số 79" in article.content
    assert article.word_count > 150


def test_relative_upload_dir_is_anchored_to_backend(monkeypatch):
    from app.core.config import BACKEND_DIR, Settings

    monkeypatch.chdir(BACKEND_DIR.parent)
    assert Settings(upload_dir="uploads").upload_dir == BACKEND_DIR / "uploads"


def test_images_become_markdown_with_absolute_urls():
    """FR-RDR-05: an illustration is part of the article, so clean text carries it, not a hole."""
    from bs4 import BeautifulSoup

    from app.services.html_markdown import absolutize_images, html_to_markdown

    html = """<article>
    <p>Mở đầu.</p>
    <figure><img src="/i/a.jpg" alt="Biểu đồ doanh thu"><figcaption>Nguồn: VnExpress</figcaption></figure>
    <p><img data-src="https://cdn.x/b.png" alt="lazy"></p>
    <p><img srcset="https://cdn.x/s.jpg 320w, https://cdn.x/l.jpg 1200w" alt="rộng"></p>
    <p><img src="https://t.co/px.gif" width="1" height="1" alt=""></p>
    <p><img src="data:image/gif;base64,R0lGOD" alt="nhúng"></p>
    </article>"""
    root = BeautifulSoup(html, "html.parser").find("article")
    absolutize_images(root, "https://vnexpress.net/bai/123.html")
    blocks = html_to_markdown(root).split("\n\n")

    # Relative source resolved against the article URL, and the image is its own block.
    assert blocks[:3] == [
        "Mở đầu.",
        "![Biểu đồ doanh thu](https://vnexpress.net/i/a.jpg)",
        "Nguồn: VnExpress",
    ]
    assert "![lazy](https://cdn.x/b.png)" in blocks  # the real address hides in data-src
    assert "![rộng](https://cdn.x/l.jpg)" in blocks  # the widest srcset candidate
    # A tracking pixel and an inline data: URI are not illustrations.
    assert not any("t.co" in b or "data:" in b for b in blocks)


def test_image_without_a_loadable_url_keeps_its_alt_text():
    """EPUB images live inside the container, so the spot is marked and the alt text kept."""
    from bs4 import BeautifulSoup

    from app.services.html_markdown import html_to_markdown

    soup = BeautifulSoup('<p><img src="../images/fig1.png" alt="Sơ đồ kiến trúc"></p>', "html.parser")
    assert html_to_markdown(soup) == "*[Hình ảnh: Sơ đồ kiến trúc]*"


def test_image_wrapped_in_a_link_stays_an_image():
    """Wikipedia links each image to its file page; the wrapper must not leak into the text."""
    from bs4 import BeautifulSoup

    from app.services.html_markdown import absolutize_images, html_to_markdown

    html = '<div><p><a href="https://vi.wikipedia.org/wiki/T%E1%BA%ADp_tin:A.jpg">'
    html += '<img src="//upload.wikimedia.org/a.jpg" alt="Robot Kismet"></a></p><p>Đoạn sau.</p></div>'
    root = BeautifulSoup(html, "html.parser").find("div")
    absolutize_images(root, "https://vi.wikipedia.org/wiki/AI")

    # Protocol-relative source resolved to https, and no stray "](...)" left behind.
    assert html_to_markdown(root).split("\n\n") == [
        "![Robot Kismet](https://upload.wikimedia.org/a.jpg)",
        "Đoạn sau.",
    ]


@pytest.mark.parametrize(
    ("given", "expected"),
    [
        # What Railway, Render and Heroku publish.
        (
            "postgresql://u:p@host.railway.internal:5432/railway",
            "postgresql+asyncpg://u:p@host.railway.internal:5432/railway",
        ),
        ("postgres://u:p@host:5432/db", "postgresql+asyncpg://u:p@host:5432/db"),
        # asyncpg configures TLS itself and rejects the libpq parameters.
        ("postgresql://u:p@host:5432/db?sslmode=require", "postgresql+asyncpg://u:p@host:5432/db"),
        # An URL that already names the driver is left alone.
        ("postgresql+asyncpg://u:p@host:5432/db", "postgresql+asyncpg://u:p@host:5432/db"),
    ],
)
def test_managed_database_urls_are_normalised(given, expected):
    from app.core.config import Settings

    assert Settings(database_url=given).database_url == expected


# A subscriber's page as a publisher serves it to everyone else: an abstract, then a long list of references.
REFERENCES = b"".join(
    b"<p>Author, A. A study of sleep and memory, number %d. Journal 12, 100-110.</p>" % n for n in range(60)
)
PAYWALLED = (
    b"<html><head><title>The memory function of sleep</title>"
    b'<script type="application/ld+json">{"@type": "WebPage", "mainEntity": {"@type": "ScholarlyArticle",'
    b' "isAccessibleForFree": false, "hasPart": {"@type": "WebPageElement", "isAccessibleForFree": false}}}</script>'
    b"</head><body><article><p>Abstract. Sleep helps memory.</p><p>This is a preview of subscription content.</p>"
    b'<section class="references">' + REFERENCES + b"</section></article></body></html>"
)


def test_a_page_that_says_it_is_for_subscribers_is_known():
    assert web.extract_article(PAYWALLED, "https://journal.example.com/a").paywalled is True
    # Springer Nature says it in a meta tag of its own.
    meta = ARTICLE.replace(b"<head>", b'<head><meta name="access" content="No">')
    assert web.extract_article(meta, "https://journal.example.com/a").paywalled is True
    assert web.extract_article(ARTICLE, "https://blog.example.com/a").paywalled is False
    free = PAYWALLED.replace(b"false", b"true")
    assert web.extract_article(free, "https://journal.example.com/a").paywalled is False
    # A script that is not JSON is passed over.
    broken = ARTICLE.replace(b"<head>", b'<head><script type="application/ld+json">{not json</script>')
    assert web.extract_article(broken, "https://blog.example.com/a").paywalled is False


async def test_save_url_does_not_keep_a_preview_as_the_document(client, auth, fake_web):
    fake_web.dns["journal.example.com"] = ["93.184.216.34"]
    fake_web.routes["journal.example.com/articles/closed"] = httpx.Response(
        200, headers={"content-type": "text/html"}, content=PAYWALLED
    )
    h = auth()
    r = await client.post(
        "/api/documents/save-url", headers=h, json={"url": "https://journal.example.com/articles/closed"}
    )
    assert r.status_code == 422, r.text
    assert "xem trước" in r.json()["detail"] and "PDF" in r.json()["detail"]
    assert (await client.get("/api/documents", headers=h)).json() == []


@pytest.mark.parametrize(
    "body",
    [
        ARTICLE,  # a teaser: three short paragraphs
        b"<html><head><title>Shell</title></head><body><div id='root'></div></body></html>",  # filled in by a script
        b"<html><body><ul>"
        + b"<li><a href='/a'>Bai viet</a></li>" * 40
        + b"</ul></body></html>",  # a page of links
    ],
)
async def test_save_url_does_not_keep_a_page_that_is_not_a_whole_article(client, auth, fake_web, body):
    fake_web.dns["blog.example.com"] = ["93.184.216.34"]
    fake_web.routes["blog.example.com/posts/short"] = httpx.Response(
        200, headers={"content-type": "text/html; charset=utf-8"}, content=body
    )
    h = auth()
    r = await client.post(
        "/api/documents/save-url", headers=h, json={"url": "https://blog.example.com/posts/short"}
    )
    assert r.status_code == 422, r.text
    assert "quá ít nội dung" in r.json()["detail"] and "PDF" in r.json()["detail"]
    # Nothing is kept, not even a document marked as failed.
    assert (await client.get("/api/documents", headers=h)).json() == []


async def test_save_url_keeps_a_page_right_at_the_length_of_an_article(client, auth, fake_web):
    def page(words: int) -> bytes:
        return b"<html><head><title>T</title></head><body><article><p>%s</p></article></body></html>" % (
            b"tu " * words
        )

    fake_web.dns["blog.example.com"] = ["93.184.216.34"]
    for name, words in (("under", web.MIN_ARTICLE_WORDS - 1), ("at", web.MIN_ARTICLE_WORDS)):
        fake_web.routes[f"blog.example.com/{name}"] = httpx.Response(
            200, headers={"content-type": "text/html"}, content=page(words)
        )
    h = auth()
    under = await client.post(
        "/api/documents/save-url", headers=h, json={"url": "https://blog.example.com/under"}
    )
    assert under.status_code == 422, under.text
    at = await client.post("/api/documents/save-url", headers=h, json={"url": "https://blog.example.com/at"})
    assert at.status_code == 201, at.text
    assert at.json()["word_count"] == web.MIN_ARTICLE_WORDS


@pytest.mark.parametrize(
    "status,headers",
    [
        (420, {}),  # what IEEE Xplore's filter answers a client it takes for a program
        (418, {}),
        # A check that people pass by running a script: the page comes with 200 or 202 and says so in a header.
        (202, {"x-amzn-waf-action": "challenge"}),
        (200, {"X-Amzn-Waf-Action": "Captcha"}),
        (200, {"cf-mitigated": "challenge"}),
    ],
)
async def test_a_bot_check_is_a_refusal_not_a_page_to_keep(client, auth, fake_web, status, headers):
    fake_web.dns["papers.example.org"] = ["93.184.216.34"]
    # Even with an article's worth of words on it, what a bot check sends is not the document.
    fake_web.routes["papers.example.org/document/1"] = httpx.Response(
        status, headers={"content-type": "text/html", **headers}, content=FULL
    )
    h = auth()
    r = await client.post(
        "/api/documents/save-url", headers=h, json={"url": "https://papers.example.org/document/1"}
    )
    assert r.status_code == 422, r.text
    assert "không cho phép PureMind" in r.json()["detail"] and "PDF" in r.json()["detail"]
    assert (await client.get("/api/documents", headers=h)).json() == []
    assert len(fake_web.requests) == 1  # one visit: no second try to get past the check


def _record(body_words: int, pages: bytes = b"") -> bytes:
    """A scholarly record's page, as an index (IDEAS/RePEc) shows one: Google Scholar tags, a whole title that
    og:title cuts short, an abstract and the site's own notes."""
    prose = b" ".join(b"word%d" % n for n in range(body_words))
    return (
        b"<html><head><title>Trust in AI-driven decision-making: a systematic literature review</title>"
        b'<meta name="citation_title" content="Trust in AI-driven decision-making: a systematic literature review">'
        b'<meta property="og:title" content="Trust in AI-driven decision-making: a">'
        + pages
        + b"</head><body>"
        b"<div id='content'><h2>Abstract</h2><p>" + prose + b"</p>"
        b"<h2>Download full text from publisher</h2><p>As the access to this document is restricted, you may"
        b" want to search for a different version of it.</p></div></body></html>"
    )


SPAN = b'<meta name="citation_firstpage" content="2179"><meta name="citation_lastpage" content="2229">'


def test_an_index_record_is_a_preview_not_the_work():
    # 600 words for a 51-page paper: an abstract and the index's notes.
    record = web.extract_article(_record(600, SPAN), "https://ideas.repec.org/a/x.html")
    assert record.word_count >= web.MIN_ARTICLE_WORDS and record.paywalled is True
    assert record.title == "Trust in AI-driven decision-making: a systematic literature review"
    # No page range: a scholarly work's full text still runs past a thousand words.
    assert web.extract_article(_record(600), "https://ideas.repec.org/a/x.html").paywalled is True
    # The full text on the publisher's own page is the work.
    assert web.extract_article(_record(9000, SPAN), "https://journal.example.com/a").paywalled is False
    assert web.extract_article(_record(1500), "https://journal.example.com/a").paywalled is False
    # A page with no scholarly tags is judged as an article, by its length alone.
    plain = _record(600).replace(b'name="citation_title"', b'name="x_title"')
    assert web.extract_article(plain, "https://blog.example.com/a").paywalled is False


async def test_save_url_does_not_keep_an_index_record_as_the_document(client, auth, fake_web):
    fake_web.dns["ideas.repec.org"] = ["93.184.216.34"]
    fake_web.routes["ideas.repec.org/a/x.html"] = httpx.Response(
        200, headers={"content-type": "text/html"}, content=_record(600, SPAN)
    )
    h = auth()
    r = await client.post(
        "/api/documents/save-url", headers=h, json={"url": "https://ideas.repec.org/a/x.html"}
    )
    assert r.status_code == 422, r.text
    assert "xem trước" in r.json()["detail"]
    assert (await client.get("/api/documents", headers=h)).json() == []
