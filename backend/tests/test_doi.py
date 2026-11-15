import json

import httpx
import pytest

from app.core.ratelimit import doi_limiter
from app.services import doi, web
from tests.pdfs import text_pdf
from tests.test_epub_web import FULL

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


async def test_lookup_rejects_bad_and_unknown_dois(client, auth, fake_doi):
    h = auth()
    r = await client.get("/api/documents/doi-lookup", params={"doi": "not a doi"}, headers=h)
    assert r.status_code == 422 and "10.1038" in r.json()["detail"]
    assert fake_doi.requests == []

    r = await client.get("/api/documents/doi-lookup", params={"doi": "10.1000/unknown"}, headers=h)
    assert r.status_code == 422 and "Không tìm thấy" in r.json()["detail"]
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


async def test_adding_by_doi_is_gone_but_a_doi_link_saves_like_any_link(client, auth, fake_doi):
    """Import by DOI was removed: a doi.org address is an ordinary link, and the document keeps it."""
    h = auth()
    r = await client.post("/api/documents/import-doi", headers=h, json={"doi": "10.1038/nature14539"})
    assert r.status_code in (404, 405)

    fake_doi.pages["doi.org/10.1038/nature14539"] = httpx.Response(
        200, headers={"content-type": "text/html; charset=utf-8"}, content=FULL
    )
    r = await client.post(
        "/api/documents/save-url", headers=h, json={"url": "https://doi.org/10.1038/nature14539"}
    )
    assert r.status_code == 201, r.text
    assert r.json()["url"] == "https://doi.org/10.1038/nature14539" and r.json()["citation"] is None
