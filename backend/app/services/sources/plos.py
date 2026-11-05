"""PLOS: peer-reviewed research and essays, all CC BY. For each subject, the most read articles published since 2023."""

import json
from urllib.parse import urlencode

from bs4 import BeautifulSoup
from starlette.concurrency import run_in_threadpool

from app.services import doi as dois
from app.services import web
from app.services.html_markdown import word_count
from app.services.sources import (
    ACCEPT_JSON,
    CC_BY,
    Item,
    cut_before,
    doi_in,
    fetch,
    fetch_page,
    first_paragraph,
    log,
    markdown_of,
    parse_date,
    reason,
)

SOURCE = "plos"
NAME = "PLOS"
API = "https://api.plos.org/search"
# PLOS subject areas, and the feed's topics for each.
SUBJECTS = {
    "Medicine and health sciences": ["health"],
    "Psychology": ["mind"],
    "Ecology and environmental sciences": ["environment"],
    "Social sciences": ["society"],
    "Economics": ["economy"],
    "Education": ["education"],
    "People and places": ["society", "culture"],
}
SINCE = "2023-01-01T00:00:00Z"
FIELDS = "id,title_display,journal,author_display,publication_date,abstract,article_type,subject"
# The article types that are essays (opinion, a view on a field) rather than a study.
ESSAYS = ("Essay", "Perspective")
MAX_TAGS = 6
# The paper's apparatus after its discussion.
TAIL_SECTIONS = ("Supporting information", "Acknowledgments", "References", "Author contributions")
# Inside the article: its block of citation, dates and licence, what surrounds a figure's caption, and formulas
# (pictures, which cannot be fetched).
FURNITURE = (
    ".articleinfo",
    ".ref-tooltip",
    ".img-box",
    ".figure-inline-download",
    ".caption_target",
    ".caption_object",
    ".equation",
)


def search_url(subject: str, rows: int, essays: bool = False) -> str:
    types = " OR ".join(f'"{t}"' for t in ESSAYS) if essays else '"Research Article"'
    query = (
        f'subject:"{subject}" AND doc_type:full AND article_type:({types})'
        f" AND publication_date:[{SINCE} TO NOW]"
    )
    params = {"q": query, "fl": FIELDS, "sort": "counter_total_all desc", "rows": rows, "wt": "json"}
    return f"{API}?{urlencode(params)}"


def parse(body: bytes) -> list[dict]:
    return [d for d in json.loads(body)["response"]["docs"] if d.get("id") and d.get("title_display")]


def tags_of(doc: dict) -> list[str]:
    """The subjects the paper is filed under, each by its most specific name (…/Sleep/Sleep deprivation)."""
    names: list[str] = []
    for path in doc.get("subject") or []:
        name = path.rstrip("/").rsplit("/", 1)[-1].strip().lower()
        if name and name not in names:
            names.append(name)
    return names[:MAX_TAGS]


def item_of(doc: dict, topics: list[str], content: str) -> Item:
    abstract = " ".join(" ".join(doc.get("abstract") or []).split())
    authors = doc.get("author_display") or []
    names = ", ".join(authors[:3]) + (" et al." if len(authors) > 3 else "")
    journal = doc.get("journal") or NAME
    # The page sometimes yields less than its own abstract (a cookie wall): then the abstract is the text.
    if word_count(content) < word_count(abstract):
        content = abstract
    return Item(
        source=SOURCE,
        url=dois.url_of(doc["id"]),
        title=" ".join(BeautifulSoup(doc["title_display"], "html.parser").get_text().split()),
        content=content,
        language="en",
        kind="essay" if doc.get("article_type") in ESSAYS else "research",
        license=CC_BY[0],
        license_url=CC_BY[1],
        credit=f"{names} · {journal}" if names else journal,
        topics=list(topics),
        authors=names,
        summary=abstract[:600] or first_paragraph(content),
        tags=tags_of(doc),
        doi=doc["id"].lower(),
        published_at=parse_date(doc.get("publication_date")),
    )


def article_markdown(body: bytes, url: str) -> str:
    """The article's own markup as Markdown. Extraction is for a page of unknown shape, and on these it can settle
    on one section and lose the opening; it remains for a page that is not the usual one."""
    node = BeautifulSoup(body, "html.parser").select_one("#artText")
    return markdown_of(str(node), drop=FURNITURE) if node else web.extract_article(body, url).content


async def page_text(url: str, contact: str) -> str:
    try:
        # doi.org leads to the article's page on the journal.
        page = await fetch_page(url, contact)
        content = await run_in_threadpool(article_markdown, page.body, page.url)
        return cut_before(content, TAIL_SECTIONS)
    except Exception as e:
        log.warning("PLOS %s: %s", url, reason(e))
        return ""


async def collect(
    contact: str, subjects: dict[str, list[str]] = SUBJECTS, per_topic: int = 6, essays: int = 1
) -> list[Item]:
    found: dict[str, Item] = {}
    for subject, topics in subjects.items():
        docs: list[dict] = []
        for rows, are_essays in ((per_topic, False), (essays, True)):
            try:
                docs += parse(await fetch(search_url(subject, rows, are_essays), contact, ACCEPT_JSON))
            except Exception as e:
                log.warning("PLOS %s: %s", subject, reason(e))
        for doc in docs:
            url = dois.url_of(doc["id"])
            if url in found:
                found[url].topics = sorted({*found[url].topics, *topics})
                continue
            found[url] = item_of(doc, topics, await page_text(url, contact))
    return list(found.values())


async def from_link(url: str, contact: str, topics: list[str]) -> Item | None:
    """journals.plos.org/…/article?id=10.1371/… or doi.org/10.1371/…"""
    doi = doi_in(url)
    if not doi or not doi.startswith("10.1371/"):
        return None
    params = {"q": f'id:"{doi}"', "fl": FIELDS, "rows": 1, "wt": "json"}
    docs = parse(await fetch(f"{API}?{urlencode(params)}", contact, ACCEPT_JSON))
    if not docs:
        return None
    return item_of(docs[0], topics or ["science"], await page_text(dois.url_of(docs[0]["id"]), contact))
