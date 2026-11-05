"""Where the feed's articles come from: one module per source, each turning what the source publishes
into `Item`s that services/articles stores. Only openly licensed text is taken, with the credit the
licence asks for; images are kept only where they share the text's licence.
"""

import asyncio
import json
import logging
import re
from dataclasses import dataclass, field
from datetime import UTC, datetime
from urllib.parse import unquote

from bs4 import BeautifulSoup

from app.services import doi as dois
from app.services import web
from app.services.html_markdown import clean_soup, html_to_markdown

log = logging.getLogger(__name__)

CC_BY = ("CC BY 4.0", "https://creativecommons.org/licenses/by/4.0/")
CC_BY_ND = ("CC BY-ND 4.0", "https://creativecommons.org/licenses/by-nd/4.0/")
CC_BY_SA = ("CC BY-SA 4.0", "https://creativecommons.org/licenses/by-sa/4.0/")
ATOM = "{http://www.w3.org/2005/Atom}"
ACCEPT_FEED = "application/atom+xml,application/xml;q=0.9,*/*;q=0.5"
ACCEPT_JSON = "application/json"


@dataclass
class Item:
    source: str
    url: str
    title: str
    content: str  # Markdown, as the reader shows it
    language: str
    kind: str  # one of models.KINDS
    license: str
    license_url: str
    credit: str
    topics: list[str]
    authors: str = ""
    summary: str = ""
    # The source's own labels (keywords, fields of study), kept as tags.
    tags: list[str] = field(default_factory=list)
    image_url: str | None = None
    doi: str | None = None
    published_at: datetime | None = field(default=None)
    # A guide's: the address of the stored article it was written from.
    based_on: str | None = None


async def fetch_page(url: str, contact: str, accept: str = web.ACCEPT_PAGE) -> web.FetchResult:
    """The page at `url`, through the same guarded client as saving a link. A busy source or a dropped
    connection gets a second try; a page that is not there does not."""
    for attempt in range(3):
        try:
            return await web.fetch_url(url, contact, accept)
        except web.FetchFailed as e:
            passing = isinstance(e, web.FetchRefused) or e.__cause__ is not None
            if attempt == 2 or not passing:
                raise
            await asyncio.sleep(2 * (attempt + 1))
    raise AssertionError  # unreachable


async def fetch(url: str, contact: str, accept: str = web.ACCEPT_PAGE) -> bytes:
    return (await fetch_page(url, contact, accept)).body


def reason(e: Exception) -> str:
    """What went wrong, for the run's record: a timeout has no message of its own."""
    cause = e.__cause__ or e
    return str(e) or str(cause) or type(cause).__name__


def markdown_of(html: str | bytes, *, drop: tuple[str, ...] = ()) -> str:
    """The Markdown of an HTML fragment, without the elements matching the CSS selectors in `drop`."""
    soup = BeautifulSoup(html, "html.parser")
    for selector in drop:
        for tag in soup.select(selector):
            tag.decompose()
    clean_soup(soup)
    return html_to_markdown(soup)


def plain(markdown: str, limit: int = 600) -> str:
    """Markdown as the card shows it: the words of links and emphasis, on one line, cut at a word."""
    text = re.sub(r"!?\[([^\]]*)\]\([^)]*\)", r"\1", markdown)
    text = " ".join(re.sub(r"\*+|`", "", text).split())
    return text if len(text) <= limit else text[:limit].rsplit(" ", 1)[0] + "…"


def first_paragraph(markdown: str, limit: int = 400) -> str:
    """The first paragraph of prose (not a heading, list or figure), for the card."""
    for block in markdown.split("\n\n"):
        text = block.strip()
        if text and not text.startswith(("#", "!", ">", "|", "- ", "* ", "```")) and len(text.split()) > 12:
            return plain(text, limit)
    return ""


def cut_before(markdown: str, sections: tuple[str, ...]) -> str:
    """The text up to the first heading named in `sections`: the notes and references after the prose."""
    blocks = markdown.split("\n\n")
    for i, block in enumerate(blocks):
        if block.startswith("#") and block.lstrip("# ").strip() in sections:
            return "\n\n".join(blocks[:i]).rstrip()
    return markdown


def parse_date(raw: str | None) -> datetime | None:
    if not raw:
        return None
    try:
        parsed = datetime.fromisoformat(raw.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)  # a bare date is taken as UTC


def linked_data(html: bytes | str) -> dict:
    """The page's schema.org article (JSON-LD): headline, authors, dates. Empty when it has none."""
    soup = BeautifulSoup(html, "html.parser")
    for script in soup.find_all("script", type="application/ld+json"):
        try:
            data = json.loads(script.string or "")
        except ValueError:
            continue
        for node in data if isinstance(data, list) else data.get("@graph", [data]):
            if isinstance(node, dict) and "Article" in str(node.get("@type", "")):
                authors = node.get("author") or []
                return {**node, "author": authors if isinstance(authors, list) else [authors]}
    return {}


def doi_in(url: str) -> str | None:
    """The DOI in an article's address (doi.org/…, …/article?id=10.…, …/articles/10.…), lowercased."""
    found = dois.DOI.search(unquote(url))
    return re.split(r"[?&#]", found.group(0))[0].rstrip(".,;)/").lower() if found else None
