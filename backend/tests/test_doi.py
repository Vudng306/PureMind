import json

import httpx
import pytest

from app.core.ratelimit import doi_limiter
from app.services import doi, web
from tests.pdfs import text_pdf
from tests.test_epub_web import ARTICLE

CSL = {
    "type": "article-journal",
    "title": "Deep <i>learning</i>",
    "author": [
        {"family": "LeCun", "given": "Yann"},
        {"family": "Bengio", "given": "Yoshua"},
        {"literal": "The Deep Learning Group"},
    ],
    "container-title": "Nature",
    "publisher": "Springer Science and Business Media LLC",
    "issued": {"date-parts": [[2015, 5, 27]]},
    "volume": "521",
    "issue": "7553",
    "page": "436-444",
    "DOI": "10.1038/NATURE14539",
}
CITATION = {
    "type": "article",
    "authors": [
        {"family": "LeCun", "given": "Yann"},
        {"family": "Bengio", "given": "Yoshua"},
        {"family": "The Deep Learning Group", "given": ""},
    ],
    "container": "Nature",
    "publisher": "Springer Science and Business Media LLC",
    "year": 2015,
    "volume": "521",
    "issue": "7553",
    "pages": "436-444",
    "doi": "10.1038/nature14539",
}


class FakeDoi:
    """doi.org and the publishers behind it: one address answers with the citation or with the page,
    depending on what the request accepts."""

    def __init__(self, monkeypatch):
        self.csl: dict[str, dict] = {}
        self.pages: dict[str, httpx.Response] = {}
        self.requests: list[httpx.Request] = []

        async def resolve(host, port):
            return ["93.184.216.34"]

        def handler(request: httpx.Request) -> httpx.Response:
            self.requests.append(request)
            key = f"{request.headers['host']}{request.url.raw_path.decode()}"
            if request.headers["accept"] == doi.CSL_JSON:
                if key in self.csl:
                    return httpx.Response(
                        200, headers={"content-type": doi.CSL_JSON}, content=json.dumps(self.csl[key])
                    )
                return httpx.Response(404)
            return self.pages.get(key, httpx.Response(404))

        monkeypatch.setattr(web, "resolve_host", resolve)
        monkeypatch.setattr(web, "make_transport", lambda: httpx.MockTransport(handler))


@pytest.fixture
def fake_doi(monkeypatch):
    return FakeDoi(monkeypatch)


@pytest.mark.parametrize(
    "raw",
    [
        "10.1038/nature14539",
        "  10.1038/NATURE14539  ",
        "doi:10.1038/nature14539",
        "DOI: 10.1038/nature14539",
        "https://doi.org/10.1038/nature14539",
        "http://dx.doi.org/10.1038/nature14539.",
    ],
)
def test_parse_accepts_what_people_paste(raw):
    assert doi.parse(raw) == "10.1038/nature14539"


@pytest.mark.parametrize(
    "raw", ["", "nature14539", "11.1038/x", "10.1038/", "10.1038/a b", "https://example.com/10.1/x"]
)
def test_parse_rejects_what_is_not_a_doi(raw):
    with pytest.raises(doi.InvalidDoi):
        doi.parse(raw)


def test_csl_becomes_a_citation():
    work = doi.from_csl(CSL, "10.1038/nature14539")
    assert work.title == "Deep learning" and work.citation == CITATION
    # Crossref's own API sends lists, DataCite a "published" date and a bare type.
    other = doi.from_csl(
        {
            "type": "posted-content",
            "title": ["A &amp; B"],
            "container-title": [],
            "published": {"date-parts": [[2024]]},
        },
        "10.48550/arxiv.1",
    )
    assert other.title == "A & B"
    assert (
        other.citation["type"] == "misc"
        and other.citation["year"] == 2024
        and other.citation["authors"] == []
    )


async def test_import_article_by_doi(client, auth, fake_doi):
    fake_doi.csl["doi.org/10.1038/nature14539"] = CSL
    fake_doi.pages["doi.org/10.1038/nature14539"] = httpx.Response(
        302, headers={"location": "https://www.nature.com/articles/nature14539"}
    )
    fake_doi.pages["www.nature.com/articles/nature14539"] = httpx.Response(
        200, headers={"content-type": "text/html; charset=utf-8"}, content=ARTICLE
    )
    h = auth()

    r = await client.post(
        "/api/documents/import-doi", headers=h, json={"doi": "https://doi.org/10.1038/NATURE14539"}
    )
    assert r.status_code == 201, r.text
    doc = r.json()
    assert doc["title"] == "Deep learning"  # the registered title, not the page's
    assert doc["citation"] == CITATION
    assert doc["url"] == "https://doi.org/10.1038/nature14539" and doc["file_type"] == "web"
    assert "Doc cham giup ghi nho lau hon" in doc["content_clean"]

    listed = (await client.get("/api/documents", headers=h)).json()
    assert listed[0]["citation"]["authors"][0] == {"family": "LeCun", "given": "Yann"}

    asked = len(fake_doi.requests)
    again = await client.post("/api/documents/import-doi", headers=h, json={"doi": "10.1038/nature14539"})
    assert again.status_code == 200 and again.json()["id"] == doc["id"]
    assert len(fake_doi.requests) == asked  # known already: nothing is fetched again


async def test_import_pdf_by_doi_keeps_the_registered_title(client, auth, fake_doi):
    fake_doi.csl["doi.org/10.1000/paper"] = {**CSL, "title": "Attention is all you need"}
    fake_doi.pages["doi.org/10.1000/paper"] = httpx.Response(
        200, headers={"content-type": "application/pdf"}, content=text_pdf(2, title="untitled-3.dvi")
    )
    h = auth()
    r = await client.post("/api/documents/import-doi", headers=h, json={"doi": "10.1000/paper"})
    assert r.status_code == 201, r.text
    doc = r.json()
    assert doc["file_type"] == "pdf" and doc["page_count"] == 2 and doc["extraction_status"] == "done"
    assert doc["title"] == "Attention is all you need"
    assert doc["citation"]["doi"] == "10.1000/paper"
    assert (await client.get(f"/api/documents/{doc['id']}/file", headers=h)).status_code == 200


async def test_arxiv_doi_fetches_the_paper_not_its_abstract_page(client, auth, fake_doi):
    assert doi.open_pdf_urls("10.48550/arxiv.1706.03762") == ["https://arxiv.org/pdf/1706.03762"]
    assert doi.open_pdf_urls("10.1038/nature14539") == []
    fake_doi.csl["doi.org/10.48550/arxiv.1706.03762"] = {**CSL, "title": "Attention Is All You Need"}
    fake_doi.pages["arxiv.org/pdf/1706.03762"] = httpx.Response(
        200, headers={"content-type": "application/pdf"}, content=text_pdf(3)
    )
    h = auth()
    r = await client.post("/api/documents/import-doi", headers=h, json={"doi": "10.48550/arXiv.1706.03762"})
    assert r.status_code == 201, r.text
    doc = r.json()
    assert doc["file_type"] == "pdf" and doc["page_count"] == 3
    assert doc["url"] == "https://doi.org/10.48550/arxiv.1706.03762"
    assert doc["original_filename"] == "1706.03762.pdf"


async def test_paywalled_work_keeps_its_abstract_or_is_not_saved(client, auth, fake_doi):
    abstract = "<jats:p>We show that reading slowly helps students remember what they read.</jats:p>"
    fake_doi.csl["doi.org/10.1000/closed"] = {**CSL, "abstract": abstract}
    fake_doi.csl["doi.org/10.1000/bare"] = CSL
    for key in ("doi.org/10.1000/closed", "doi.org/10.1000/bare"):
        fake_doi.pages[key] = httpx.Response(403)
    h = auth()

    r = await client.post("/api/documents/import-doi", headers=h, json={"doi": "10.1000/closed"})
    assert r.status_code == 201, r.text
    assert r.json()["content_clean"] == "We show that reading slowly helps students remember what they read."

    r = await client.post("/api/documents/import-doi", headers=h, json={"doi": "10.1000/bare"})
    assert r.status_code == 422 and "PDF" in r.json()["detail"]
    assert len((await client.get("/api/documents", headers=h)).json()) == 1


async def test_import_rejects_bad_and_unknown_dois(client, auth, fake_doi):
    h = auth()
    r = await client.post("/api/documents/import-doi", headers=h, json={"doi": "not a doi"})
    assert r.status_code == 422 and "10.1038" in r.json()["detail"]
    assert fake_doi.requests == []

    r = await client.post("/api/documents/import-doi", headers=h, json={"doi": "10.1000/unknown"})
    assert r.status_code == 422 and "Không tìm thấy" in r.json()["detail"]
    assert (await client.get("/api/documents/doi-lookup", params={"doi": "x"}, headers=h)).status_code == 422
    assert (await client.get("/api/documents/doi-lookup", params={"doi": "10.1/x"})).status_code == 401


async def test_lookup_fills_the_citation_of_an_uploaded_document(client, auth, fake_doi, monkeypatch):
    fake_doi.csl["doi.org/10.1038/nature14539"] = CSL
    h = auth()
    files = {"file": ("scan.pdf", text_pdf(1), "application/pdf")}
    doc = (await client.post("/api/documents/upload", headers=h, files=files)).json()
    assert doc["citation"] is None

    found = await client.get(
        "/api/documents/doi-lookup", params={"doi": "doi:10.1038/nature14539"}, headers=h
    )
    assert found.status_code == 200, found.text
    assert found.json() == {"title": "Deep learning", "citation": CITATION}

    citation = {
        **found.json()["citation"],
        "authors": [{"family": "Nguyễn", "given": "Văn A"}],
        "pages": " 1 - 9 ",
    }
    r = await client.patch(f"/api/documents/{doc['id']}", headers=h, json={"citation": citation})
    assert r.status_code == 200, r.text
    assert r.json()["citation"] == {**citation, "pages": "1 - 9"}
    assert r.json()["title"] == doc["title"]  # the title only changes when it is sent

    for bad in ({"doi": "nope"}, {"year": 99}, {"type": "blog"}, {"authors": [{"family": ""}]}):
        r = await client.patch(f"/api/documents/{doc['id']}", headers=h, json={"citation": bad})
        assert r.status_code == 422, bad

    monkeypatch.setattr(doi_limiter, "limit", 1)
    r = await client.get("/api/documents/doi-lookup", params={"doi": "10.1038/nature14539"}, headers=h)
    assert r.status_code == 429
