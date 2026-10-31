"""Frontiers for Young Minds: scientists explain their field to young readers, and young reviewers check
that it is clear. CC BY. Crossref lists the journal's articles with their licence; the text is the page's. Its figures are
left out: some are reproduced from elsewhere under their own terms."""

import json
import re
from datetime import UTC, datetime
from urllib.parse import urlencode

from bs4 import BeautifulSoup
from starlette.concurrency import run_in_threadpool

from app.services import web
from app.services.html_markdown import word_count
from app.services.sources import ACCEPT_JSON, CC_BY, Item, cut_before, fetch, first_paragraph, log, plain

SOURCE = "frym"
NAME = "Frontiers for Young Minds"
CROSSREF = "https://api.crossref.org/journals/2296-6846/works"
PAGE = "https://kids.frontiersin.org/articles/{doi}"
MIN_WORDS = 300
# The journal's notes after the article.
TAIL_SECTIONS = (
    "Conflict of Interest",
    "Conflicts of Interest",
    "Acknowledgments",
    "Acknowledgements",
    "AI Tool Statement",
    "Funding",
    "References",
    "Original Source Article",
)
# The journal's sections, and the feed's topics for each.
SECTIONS = {
    "astronomy-and-physics": ["science"],
    "biodiversity": ["environment", "science"],
    "chemistry-and-materials": ["science"],
    "earth-sciences": ["environment", "science"],
    "engineering-and-technology": ["technology"],
    "human-health": ["health"],
    "mathematics-and-economics": ["science"],
    "neuroscience-and-psychology": ["mind", "science"],
}
SECTION = re.compile(r'href="/articles/([a-z-]+)"[^>]*data-event="fulltext-specialty"')


def works_url(rows: int, offset: int = 0) -> str:
    params = {
        "rows": rows,
        "offset": offset,
        "sort": "published",
        "order": "desc",
        "select": "DOI,title,license,author,published,abstract",
    }
    return f"{CROSSREF}?{urlencode(params)}"


def open_works(body: bytes) -> list[dict]:
    """The works whose licence is CC BY (not a narrower one)."""
    works = json.loads(body)["message"]["items"]
    return [
        w
        for w in works
        if w.get("DOI")
        and w.get("title")
        and any(
            re.search(r"creativecommons\.org/licenses/by/", lic.get("URL", ""))
            for lic in w.get("license", [])
        )
    ]


def names(work: dict) -> str:
    people = [" ".join(p for p in (a.get("given"), a.get("family")) if p) for a in work.get("author", [])]
    people = [p for p in people if p]
    return ", ".join(people[:3]) + (" et al." if len(people) > 3 else "")


def published(work: dict) -> datetime | None:
    parts = ((work.get("published") or {}).get("date-parts") or [[]])[0]
    return datetime(*[*parts, 1, 1][:3], tzinfo=UTC) if parts else None


def topics_of(html: str) -> list[str]:
    found = SECTION.search(html)
    return SECTIONS.get(found.group(1), ["science"]) if found else ["science"]


def page_item(html: bytes, url: str, work: dict) -> Item | None:
    article = web.extract_article(html, url)
    # The glossary's arrows lead back to where each word is used, on their page only.
    content = cut_before(article.content, TAIL_SECTIONS).replace("**↑** ", "")
    if word_count(content) < MIN_WORDS:
        return None
    page = html.decode("utf-8", "replace")
    abstract = " ".join(BeautifulSoup(work.get("abstract") or "", "html.parser").get_text(" ").split())
    authors = names(work)
    return Item(
        source=SOURCE,
        url=url,
        title=" ".join(work["title"][0].split()),
        content=content,
        language="en",
        kind="explainer",
        license=CC_BY[0],
        license_url=CC_BY[1],
        credit=f"{authors} · {NAME}" if authors else NAME,
        topics=topics_of(page),
        authors=authors,
        summary=plain(abstract, 600) or first_paragraph(content),
        doi=work["DOI"].lower(),
        published_at=published(work),
    )


async def collect(contact: str, limit: int = 60) -> list[Item]:
    try:
        works = open_works(await fetch(works_url(limit), contact, ACCEPT_JSON))
    except Exception as e:
        log.warning("Frontiers for Young Minds: %s", e)
        return []
    found = []
    for work in works:
        url = PAGE.format(doi=work["DOI"].lower())
        try:
            item = await run_in_threadpool(page_item, await fetch(url, contact), url, work)
        except Exception as e:
            log.warning("Frontiers for Young Minds %s: %s", work["DOI"], e)
            continue
        if item:
            found.append(item)
    return found
