"""OpenAlex: open reports, books and book chapters under CC BY, from a short list of publishers (a DOI prefix
each). OpenAlex lists them with their keywords; the text comes from the publisher's page, or from the PDF when
that is all there is.
"""

import json
import tempfile
from pathlib import Path
from urllib.parse import urlencode

from starlette.concurrency import run_in_threadpool

from app.services import doi as dois
from app.services import extraction, web
from app.services.html_markdown import word_count
from app.services.sources import (
    ACCEPT_JSON,
    CC_BY,
    Item,
    cut_before,
    doi_in,
    fetch,
    fetch_page,
    log,
    parse_date,
    reason,
)

SOURCE = "openalex"
NAME = "OpenAlex"
API = "https://api.openalex.org/works"
SINCE = "2023-01-01"
# The publishers read, by DOI prefix, and the feed's topics for what each puts out. Others can be added as
# channels; the ones tried and left out either block downloads (Asian Development Bank) or have no text on
# the page (ILO, the EU's Joint Research Centre, Open Book Publishers).
PUBLISHERS = {
    "10.1596": ["economy", "society"],  # World Bank
    "10.5772": ["science", "technology"],  # IntechOpen
}
# Of these, the ones whose "books" are reports.
REPORTERS = {"10.1596", "10.22617", "10.54394", "10.2760"}
TYPES = "report|book|book-chapter"
FIELDS = (
    "id,doi,title,type,publication_date,language,authorships,keywords,locations,"
    "abstract_inverted_index,primary_location"
)
MIN_WORDS, MAX_WORDS = 800, 60_000
MAX_PDF_PAGES = 150
# The back matter of a long text, and what a repository's page lists after a work: on a page with no text but
# these lists, nothing is left, and the work is not taken.
TAIL_SECTIONS = ("References", "Bibliography", "Notes", "Endnotes", "Related items", "Users also downloaded")


def search_url(prefix: str, rows: int, contact: str) -> str:
    """The newest works of a publisher that OpenAlex lists as CC BY."""
    params = {
        "filter": (
            f"doi_starts_with:{prefix},type:{TYPES},primary_location.license:cc-by,"
            f"from_publication_date:{SINCE},language:en"
        ),
        "sort": "publication_date:desc",
        "select": FIELDS,
        "per-page": rows,
        "mailto": contact.removeprefix("mailto:"),
    }
    return f"{API}?{urlencode(params)}"


def abstract_of(work: dict) -> str:
    """OpenAlex gives an abstract as word -> positions; this puts the words back in order."""
    index = work.get("abstract_inverted_index") or {}
    words = sorted((pos, word) for word, positions in index.items() for pos in positions)
    return " ".join(word for _, word in words)


def parse(body: bytes) -> list[dict]:
    return [w for w in json.loads(body).get("results", []) if w.get("doi") and w.get("title")]


def sources_of(work: dict) -> list[str]:
    """Where its text may be read, the CC BY locations first: the PDF if there is one, else the page."""
    urls: list[str] = []
    for location in work.get("locations") or []:
        if location.get("license") != "cc-by":
            continue
        for url in (location.get("landing_page_url"), location.get("pdf_url")):
            if url and url not in urls and url.startswith("http"):
                urls.append(url)
    return urls


def pdf_markdown(body: bytes, title: str) -> str:
    """The text of a PDF as Markdown; empty for a scan, a locked file or a very long one."""
    with tempfile.TemporaryDirectory() as folder:
        path = Path(folder) / "work.pdf"
        path.write_bytes(body)
        try:
            result = extraction.extract_pdf(path, title)
        except extraction.ExtractionError:
            return ""
    if result.ocr_pages or (result.page_count or 0) > MAX_PDF_PAGES:
        return ""
    return result.content.replace(extraction.PAGE_SEPARATOR, "\n\n")


async def text_of(work: dict, contact: str) -> str:
    for url in sources_of(work):
        try:
            page = await fetch_page(url, contact)
            if web.is_pdf(page):
                content = await run_in_threadpool(pdf_markdown, page.body, work["title"])
            else:
                article = await run_in_threadpool(web.extract_article, page.body, page.url)
                content = article.content
        except Exception as e:
            log.warning("OpenAlex %s: %s", url, reason(e))
            continue
        content = cut_before(content, TAIL_SECTIONS)
        if MIN_WORDS <= word_count(content) <= MAX_WORDS:
            return content
    return ""


def kind_of(work: dict) -> str:
    return "report" if work["type"] == "report" else "book"


def item_of(work: dict, topics: list[str], content: str) -> Item:
    people = [a["author"]["display_name"] for a in work.get("authorships") or [] if a.get("author")]
    names = ", ".join(people[:3]) + (" et al." if len(people) > 3 else "")
    source = ((work.get("primary_location") or {}).get("source") or {}).get("display_name") or ""
    doi = dois.DOI.search(work["doi"])
    return Item(
        source=SOURCE,
        url=work["doi"],
        title=" ".join(work["title"].split()),
        content=content,
        language="en",
        kind="report"
        if work["doi"].removeprefix("https://doi.org/").split("/")[0] in REPORTERS
        else kind_of(work),
        license=CC_BY[0],
        license_url=CC_BY[1],
        credit=" · ".join(part for part in (names, source) if part) or NAME,
        topics=list(topics),
        authors=names,
        summary=abstract_of(work)[:600],
        tags=[k["display_name"] for k in (work.get("keywords") or [])[:6] if k.get("display_name")],
        doi=doi.group(0).lower() if doi else None,
        published_at=parse_date(work.get("publication_date")),
    )


async def collect(
    contact: str, publishers: dict[str, list[str]] = PUBLISHERS, per_publisher: int = 2
) -> list[Item]:
    found: dict[str, Item] = {}
    for prefix, topics in publishers.items():
        try:
            works = parse(await fetch(search_url(prefix, per_publisher * 5, contact), contact, ACCEPT_JSON))
        except Exception as e:
            log.warning("OpenAlex %s: %s", prefix, reason(e))
            continue
        kept = 0
        for work in works:
            if kept >= per_publisher:
                break
            if work["doi"] in found:
                found[work["doi"]].topics = sorted({*found[work["doi"]].topics, *topics})
                kept += 1
                continue
            content = await text_of(work, contact)
            if not content:
                continue
            kept += 1
            found[work["doi"]] = item_of(work, topics, content)
    return list(found.values())


async def from_link(url: str, contact: str, topics: list[str]) -> Item | None:
    """A DOI link (doi.org/10.…) of a report, book or chapter that OpenAlex lists as CC BY."""
    doi = doi_in(url)
    if not doi:
        return None
    params = {
        "filter": f"doi:https://doi.org/{doi},primary_location.license:cc-by",
        "select": FIELDS,
        "mailto": contact.removeprefix("mailto:"),
    }
    works = [
        w
        for w in parse(await fetch(f"{API}?{urlencode(params)}", contact, ACCEPT_JSON))
        if w["type"] in TYPES.split("|")
    ]
    if not works:
        return None
    content = await text_of(works[0], contact)
    return item_of(works[0], topics or ["society"], content) if content else None
