"""Research papers to discover: collections chosen ahead of time, and a search of arXiv.

Every paper is on arXiv; one saved from its doi.org link counts as the user's copy. The collections come from data/papers.json, built from arXiv's own metadata.
"""

import asyncio
import json
import re
import time
import xml.etree.ElementTree as ET
from dataclasses import asdict, dataclass
from functools import cache
from pathlib import Path
from urllib.parse import urlencode

from app.services import web

DATA = Path(__file__).resolve().parent.parent / "data" / "papers.json"
API = "https://export.arxiv.org/api/query"
ATOM = "application/atom+xml"
NS = {
    "a": "http://www.w3.org/2005/Atom",
    "x": "http://arxiv.org/schemas/atom",
    "o": "http://a9.com/-/spec/opensearch/1.1/",
}
# The fields a search can be narrowed to: arXiv category codes, one each, as arXiv files papers.
CATEGORIES = (
    "cs.AI",
    "cs.LG",
    "cs.CL",
    "cs.CV",
    "cs.RO",
    "cs.CR",
    "stat.ML",
    "quant-ph",
    "econ.EM",
    "q-bio.NC",
)
PAGE_SIZE = 20
MAX_PAGES = 5
MAX_QUERY = 200
MAX_TERMS = 8
MAX_AUTHORS = 10
# arXiv asks for one request every three seconds; a search asked again within the hour is answered from memory.
SPACING_SECONDS = 3.0
CACHE_SECONDS = 3600
CACHE_SIZE = 256


class SearchUnavailable(Exception):  # MSG-PAPERS-UNAVAILABLE
    pass


@dataclass
class Paper:
    arxiv_id: str
    doi: str
    title: str
    authors: list[str]
    author_count: int
    year: int | None
    abstract: str
    category: str


@cache
def collections() -> list[dict]:
    """`[{"id": "language", "papers": [paper, …]}, …]`, in the order the page shows them."""
    return json.loads(DATA.read_text(encoding="utf-8"))


def doi_of(arxiv_id: str) -> str:
    """The DOI arXiv registered for every paper, lower-cased like doi.parse leaves it."""
    return f"10.48550/arxiv.{arxiv_id}".lower()


def terms(query: str) -> list[str]:
    """The words of a query, as arXiv's search syntax can take them: no quotes, brackets or operators."""
    words = re.findall(r"[\w.+-]+", query[:MAX_QUERY])
    return [w for w in words if w.upper() not in ("AND", "OR", "ANDNOT")][:MAX_TERMS]


def search_query(query: str, category: str | None) -> str:
    parts = [f"all:{w}" for w in terms(query)]
    if category:
        parts.append(f"cat:{category}")
    return " AND ".join(parts)


def _text(node: ET.Element | None) -> str:
    return " ".join((node.text or "").split()) if node is not None else ""


def parse_feed(body: bytes) -> tuple[list[Paper], int]:
    """The papers of an arXiv Atom feed, and how many the search found in all."""
    try:
        root = ET.fromstring(body)
    except ET.ParseError as e:
        raise SearchUnavailable from e
    papers = []
    for entry in root.findall("a:entry", NS):
        link = _text(entry.find("a:id", NS))
        if "/abs/" not in link:  # arXiv reports a bad query as an entry with no paper
            continue
        arxiv_id = re.sub(r"v\d+$", "", link.split("/abs/", 1)[1])
        authors = [_text(a.find("a:name", NS)) for a in entry.findall("a:author", NS)]
        published = _text(entry.find("a:published", NS))
        category = entry.find("x:primary_category", NS)
        papers.append(
            Paper(
                arxiv_id=arxiv_id,
                doi=doi_of(arxiv_id),
                title=_text(entry.find("a:title", NS))[:500],
                authors=authors[:MAX_AUTHORS],
                author_count=len(authors),
                year=int(published[:4]) if published[:4].isdigit() else None,
                abstract=_text(entry.find("a:summary", NS)),
                category=category.get("term", "") if category is not None else "",
            )
        )
    try:
        total = int(_text(root.find("o:totalResults", NS)) or len(papers))
    except ValueError:
        total = len(papers)
    return papers, total


_cache: dict[tuple, tuple[float, list[dict], int]] = {}
_lock = asyncio.Lock()
_last_request = 0.0


async def search(query: str, category: str | None, page: int, contact: str = "") -> tuple[list[dict], int]:
    """The papers arXiv finds for `query` (most relevant first), PAGE_SIZE at a time, and their total."""
    global _last_request
    key = (" ".join(terms(query)).lower(), category, page)
    if (hit := _cache.get(key)) and time.monotonic() - hit[0] < CACHE_SECONDS:
        return hit[1], hit[2]
    params = {
        "search_query": search_query(query, category),
        "start": page * PAGE_SIZE,
        "max_results": PAGE_SIZE,
        "sortBy": "relevance",
    }
    async with _lock:  # one request at a time, spaced as arXiv asks
        wait = _last_request + SPACING_SECONDS - time.monotonic()
        if wait > 0:
            await asyncio.sleep(wait)
        try:
            fetched = await web.fetch_url(f"{API}?{urlencode(params)}", contact, accept=ATOM)
        except (web.InvalidUrl, web.BlockedAddress, web.FetchFailed) as e:
            raise SearchUnavailable from e
        finally:
            _last_request = time.monotonic()
    papers, total = parse_feed(fetched.body)
    found = [asdict(p) for p in papers]
    if len(_cache) >= CACHE_SIZE:
        _cache.pop(next(iter(_cache)))
    _cache[key] = (time.monotonic(), found, total)
    return found, total


def clear_cache() -> None:
    global _last_request
    _cache.clear()
    _last_request = 0.0
