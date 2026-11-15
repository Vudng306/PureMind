from urllib.parse import parse_qs, urlparse

import httpx
import pytest

from app.services import papers
from tests.pdfs import text_pdf
from tests.test_doi import fake_doi  # noqa: F401  (fixture)

FEED = b"""<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/"
      xmlns:arxiv="http://arxiv.org/schemas/atom">
  <opensearch:totalResults>57</opensearch:totalResults>
  <entry>
    <id>http://arxiv.org/abs/1706.03762v7</id>
    <published>2017-06-12T17:57:34Z</published>
    <title>Attention Is All
      You Need</title>
    <summary>  The dominant sequence transduction models are based on recurrent networks.  </summary>
    <author><name>Ashish Vaswani</name></author>
    <author><name>Noam Shazeer</name></author>
    <arxiv:primary_category term="cs.CL" scheme="http://arxiv.org/schemas/atom"/>
  </entry>
  <entry>
    <id>http://arxiv.org/abs/quant-ph/9508027v2</id>
    <published>1995-08-30T00:00:00Z</published>
    <title>Polynomial-Time Algorithms for Prime Factorization</title>
    <summary>A digital computer is generally believed to be an efficient universal computing device.</summary>
    <author><name>Peter W. Shor</name></author>
    <arxiv:primary_category term="quant-ph" scheme="http://arxiv.org/schemas/atom"/>
  </entry>
</feed>"""


@pytest.fixture
def arxiv(fake_doi, monkeypatch):  # noqa: F811
    """arXiv's API behind the fake doi.org: every search answers FEED, or fails while `down` is set."""
    monkeypatch.setattr(papers, "SPACING_SECONDS", 0)
    papers.clear_cache()
    state = {"down": False, "queries": []}
    pages = fake_doi.pages

    class Feed(dict):
        def get(self, key, default=None):
            if key.startswith("export.arxiv.org/api/query"):
                state["queries"].append(parse_qs(urlparse("https://" + key).query))
                if state["down"]:
                    return httpx.Response(503)
                return httpx.Response(200, headers={"content-type": "application/atom+xml"}, content=FEED)
            return super().get(key, default)

    fake_doi.pages = Feed(pages)
    yield fake_doi, state
    papers.clear_cache()


def test_terms_keep_words_and_drop_search_syntax():
    assert papers.terms('graph "neural" (networks) AND OR ti:x') == ["graph", "neural", "networks", "ti", "x"]
    assert papers.search_query("deep learning", "cs.LG") == "all:deep AND all:learning AND cat:cs.LG"
    assert papers.doi_of("quant-ph/9508027") == "10.48550/arxiv.quant-ph/9508027"


def test_feed_becomes_papers():
    found, total = papers.parse_feed(FEED)
    assert total == 57
    assert found[0].title == "Attention Is All You Need"
    assert found[0].arxiv_id == "1706.03762" and found[0].doi == "10.48550/arxiv.1706.03762"
    assert found[0].authors == ["Ashish Vaswani", "Noam Shazeer"] and found[0].author_count == 2
    assert found[0].year == 2017 and found[0].category == "cs.CL"
    assert found[1].arxiv_id == "quant-ph/9508027"
    with pytest.raises(papers.SearchUnavailable):
        papers.parse_feed(b"Rate exceeded.")


def test_collections_are_arxiv_papers_with_their_metadata():
    groups = papers.collections()
    found = [p for g in groups for p in g["papers"]]
    assert len(found) >= 30 and len({p["doi"] for p in found}) == len(found)
    for p in found:
        assert p["doi"] == papers.doi_of(p["arxiv_id"]) and p["title"] and p["authors"] and p["abstract"]


async def test_collections_are_public_and_mark_the_users_copies(client, auth, arxiv):
    fake, _ = arxiv
    r = await client.get("/api/papers")
    assert r.status_code == 200
    first = r.json()[0]["papers"][0]
    assert first["arxiv_id"] == "1706.03762" and first["document_id"] is None

    fake.pages["doi.org/10.48550/arxiv.1706.03762"] = httpx.Response(
        200, headers={"content-type": "application/pdf"}, content=text_pdf(2)
    )
    h = auth()
    link = f"https://doi.org/{first['doi']}"
    doc = (await client.post("/api/documents/save-url", headers=h, json={"url": link})).json()

    mine = (await client.get("/api/papers", headers=h)).json()
    assert mine[0]["papers"][0]["document_id"] == doc["id"]
    assert all(p["document_id"] is None for g in mine for p in g["papers"][1:] if p["doi"] != first["doi"])
    # Someone else's library is not theirs.
    other = (await client.get("/api/papers", headers=auth())).json()
    assert other[0]["papers"][0]["document_id"] is None


async def test_search_asks_arxiv_once_and_marks_copies(client, auth, arxiv):
    _, state = arxiv
    h = auth()
    r = await client.get("/api/papers/search", headers=h, params={"q": "attention", "category": "cs.CL"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["total"] == 57 and body["page"] == 0 and body["has_more"] is False  # 2 of a page of 20
    assert [p["arxiv_id"] for p in body["papers"]] == ["1706.03762", "quant-ph/9508027"]
    assert state["queries"][0]["search_query"] == ["all:attention AND cat:cs.CL"]

    again = await client.get("/api/papers/search", headers=h, params={"q": "Attention", "category": "cs.CL"})
    assert again.json()["total"] == 57 and len(state["queries"]) == 1  # answered from memory


async def test_search_needs_an_account_and_a_known_field(client, auth, arxiv):
    _, state = arxiv
    assert (await client.get("/api/papers/search", params={"q": "x"})).status_code == 401
    r = await client.get("/api/papers/search", headers=auth(), params={"q": "x", "category": "cs.XX"})
    assert r.status_code == 422
    empty = await client.get("/api/papers/search", headers=auth(), params={"q": '"()"'})
    assert empty.json() == {"papers": [], "total": 0, "page": 0, "has_more": False}
    assert state["queries"] == []


async def test_search_says_when_arxiv_is_down(client, auth, arxiv):
    _, state = arxiv
    state["down"] = True
    r = await client.get("/api/papers/search", headers=auth(), params={"q": "diffusion"})
    assert r.status_code == 503 and "arXiv" in r.json()["detail"]
