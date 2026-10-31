"""What a DOI names: the work's title and how to cite it, asked of doi.org.

doi.org answers for every registration agency (Crossref for journals, DataCite for arXiv and Zenodo, …)
when asked for CSL JSON instead of the publisher's page, so one request covers them all.
"""

import html
import json
import re
from dataclasses import dataclass
from urllib.parse import quote, unquote

from app.services import web

CSL_JSON = "application/vnd.citationstyles.csl+json"
RESOLVER = "https://doi.org/"
# The prefix is "10." and a registrant number; the suffix is whatever the publisher made up.
DOI = re.compile(r"10\.\d{4,9}/\S+", re.I)
PREFIXES = re.compile(r"^(?:https?://(?:dx\.)?doi\.org/|doi:\s*)", re.I)
MAX_DOI = 300

TYPES = {
    "article": "article",
    "article-journal": "article",
    "journal-article": "article",
    "book": "book",
    "monograph": "book",
    "edited-book": "book",
    "reference-book": "book",
    "chapter": "chapter",
    "book-chapter": "chapter",
    "paper-conference": "conference",
    "proceedings-article": "conference",
    "thesis": "thesis",
    "dissertation": "thesis",
    "report": "report",
}


class InvalidDoi(Exception):  # MSG-DOI-INVALID
    pass


class DoiNotFound(Exception):  # MSG-DOI-NOTFOUND
    pass


@dataclass
class Work:
    doi: str
    title: str
    citation: dict
    abstract: str


def parse(raw: str) -> str:
    """The bare DOI in what the user pasted: "10.1000/x", "doi:10.1000/x" or a doi.org link."""
    value = unquote(PREFIXES.sub("", (raw or "").strip()))
    match = DOI.fullmatch(value)
    if not match or len(value) > MAX_DOI:
        raise InvalidDoi
    return value.rstrip(".,;").lower()  # DOIs are case-insensitive; punctuation comes along from a sentence


def url_of(doi: str) -> str:
    return RESOLVER + quote(doi, safe="/")


ARXIV = re.compile(r"10\.48550/arxiv\.(.+)")


def open_pdf_urls(doi: str) -> list[str]:
    """Where the work itself is free to fetch, when the DOI alone tells: an arXiv DOI leads to the
    abstract page, and the paper is one address away."""
    if match := ARXIV.fullmatch(doi):
        return ["https://arxiv.org/pdf/" + quote(match.group(1), safe="/")]
    return []


def _text(value) -> str:
    """A CSL string, which some agencies send as a one-item list and others decorate with markup."""
    if isinstance(value, list):
        value = value[0] if value else ""
    if not isinstance(value, str | int):
        return ""
    return " ".join(html.unescape(re.sub(r"<[^>]+>", "", str(value))).split())


def _year(data: dict) -> int | None:
    for key in ("issued", "published", "published-print", "published-online", "created"):
        try:
            year = int(data[key]["date-parts"][0][0])
        except (KeyError, IndexError, TypeError, ValueError):
            continue
        if 1000 <= year <= 2100:
            return year
    return None


def _authors(data: dict) -> list[dict]:
    authors = []
    for person in data.get("author") or data.get("editor") or []:
        if not isinstance(person, dict):
            continue
        family = _text(person.get("family")) or _text(person.get("literal")) or _text(person.get("name"))
        if family:
            authors.append({"family": family[:200], "given": _text(person.get("given"))[:200]})
    return authors[:100]


def from_csl(data: dict, doi: str) -> Work:
    citation = {
        "type": TYPES.get(_text(data.get("type")), "misc"),
        "authors": _authors(data),
        "container": _text(data.get("container-title"))[:500],
        "publisher": _text(data.get("publisher"))[:300],
        "year": _year(data),
        "volume": _text(data.get("volume"))[:50],
        "issue": _text(data.get("issue"))[:50],
        "pages": _text(data.get("page"))[:50],
        "doi": doi,
    }
    return Work(
        doi=doi, title=_text(data.get("title"))[:500], citation=citation, abstract=_text(data.get("abstract"))
    )


async def lookup(raw: str, contact: str = "") -> Work:
    doi = parse(raw)
    try:
        fetched = await web.fetch_url(url_of(doi), contact, accept=CSL_JSON)
        data = json.loads(fetched.body)
    except (web.InvalidUrl, web.BlockedAddress, web.FetchFailed, ValueError) as e:
        raise DoiNotFound from e
    if not isinstance(data, dict):
        raise DoiNotFound
    work = from_csl(data, doi)
    if not work.title:
        raise DoiNotFound
    return work
