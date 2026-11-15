import httpx
import pytest

from app.services import doi, web
from tests.pdfs import text_pdf
from tests.test_epub_web import FULL


class FakeDoi:
    """doi.org and the pages behind it, as the link fetcher sees them."""

    def __init__(self, monkeypatch):
        self.pages: dict[str, httpx.Response] = {}
        self.requests: list[httpx.Request] = []

        async def resolve(host, port):
            return ["93.184.216.34"]

        def handler(request: httpx.Request) -> httpx.Response:
            self.requests.append(request)
            key = f"{request.headers['host']}{request.url.raw_path.decode()}"
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


async def test_adding_by_doi_is_gone_but_a_doi_link_saves_like_any_link(client, auth, fake_doi):
    """Import and lookup by DOI were removed: a doi.org address is an ordinary link, and the document keeps it."""
    h = auth()
    r = await client.post("/api/documents/import-doi", headers=h, json={"doi": "10.1038/nature14539"})
    assert r.status_code in (404, 405)
    r = await client.get("/api/documents/doi-lookup", headers=h, params={"doi": "10.1038/nature14539"})
    assert r.status_code in (404, 405, 422)  # no such route: the path reads as a document id

    fake_doi.pages["doi.org/10.1038/nature14539"] = httpx.Response(
        200, headers={"content-type": "text/html; charset=utf-8"}, content=FULL
    )
    r = await client.post(
        "/api/documents/save-url", headers=h, json={"url": "https://doi.org/10.1038/nature14539"}
    )
    assert r.status_code == 201, r.text
    assert r.json()["url"] == "https://doi.org/10.1038/nature14539" and r.json()["citation"] is None


async def test_a_citation_keeps_the_doi_it_was_saved_with(client, auth):
    """There is no DOI field any more, but a DOI stored earlier is still checked and kept when sent back."""
    h = auth()
    doc = (
        await client.post(
            "/api/documents/upload", headers=h, files={"file": ("a.pdf", text_pdf(1), "application/pdf")}
        )
    ).json()
    citation = {
        "type": "article",
        "authors": [{"family": "Nguyễn", "given": "Văn A"}],
        "pages": " 1 - 9 ",
        "doi": "doi:10.1038/NATURE14539",
    }
    r = await client.patch(f"/api/documents/{doc['id']}", headers=h, json={"citation": citation})
    assert r.status_code == 200, r.text
    assert r.json()["citation"]["doi"] == "10.1038/nature14539" and r.json()["citation"]["pages"] == "1 - 9"
    for bad in ({"doi": "nope"}, {"year": 99}, {"type": "blog"}, {"authors": [{"family": ""}]}):
        r = await client.patch(f"/api/documents/{doc['id']}", headers=h, json={"citation": bad})
        assert r.status_code == 422, bad
