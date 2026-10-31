"""PLOS: peer-reviewed research, all CC BY. For each topic, the most read articles of the last three years."""

import json
from urllib.parse import urlencode

from starlette.concurrency import run_in_threadpool

from app.services import doi as dois
from app.services import web
from app.services.html_markdown import word_count
from app.services.sources import ACCEPT_JSON, CC_BY, Item, cut_before, fetch, log, parse_date

SOURCE = "plos"
NAME = "PLOS"
API = "https://api.plos.org/search"
# PLOS subject areas (their first level) for the feed's topics.
SUBJECTS = {
    "health": "Medicine and health sciences",
    "mind": "Psychology",
    "environment": "Ecology and environmental sciences",
    "technology": "Computer and information sciences",
    "science": "Physical sciences",
    "society": "Social sciences",
    "economy": "Economics",
    "education": "Education",
}
FIELDS = "id,title_display,journal,author_display,publication_date,abstract"
# The paper's apparatus after its discussion.
TAIL_SECTIONS = ("Supporting information", "Acknowledgments", "References", "Author contributions")


def search_url(subject: str, rows: int) -> str:
    query = (
        f'subject:"{subject}" AND doc_type:full AND article_type:"Research Article"'
        " AND publication_date:[NOW-3YEARS TO NOW]"
    )
    params = {"q": query, "fl": FIELDS, "sort": "counter_total_all desc", "rows": rows, "wt": "json"}
    return f"{API}?{urlencode(params)}"


def parse(body: bytes) -> list[dict]:
    return [d for d in json.loads(body)["response"]["docs"] if d.get("id") and d.get("title_display")]


def item_of(doc: dict, topic: str, content: str) -> Item:
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
        title=" ".join(doc["title_display"].split()),
        content=content,
        language="en",
        kind="research",
        license=CC_BY[0],
        license_url=CC_BY[1],
        credit=f"{names} · {journal}" if names else journal,
        topics=[topic],
        authors=names,
        summary=abstract[:600],
        doi=doc["id"].lower(),
        published_at=parse_date(doc.get("publication_date")),
    )


async def collect(contact: str, per_topic: int = 6) -> list[Item]:
    found: dict[str, Item] = {}
    for topic, subject in SUBJECTS.items():
        try:
            docs = parse(await fetch(search_url(subject, per_topic), contact, ACCEPT_JSON))
        except Exception as e:
            log.warning("PLOS %s: %s", subject, e)
            continue
        for doc in docs:
            url = dois.url_of(doc["id"])
            if url in found:
                found[url].topics = sorted({*found[url].topics, topic})
                continue
            content = ""
            try:
                # doi.org leads to the article's page on the journal.
                page = await web.fetch_url(url, contact)
                article = await run_in_threadpool(web.extract_article, page.body, page.url)
                content = cut_before(article.content, TAIL_SECTIONS)
            except Exception as e:
                log.warning("PLOS %s: %s", doc["id"], e)
            found[url] = item_of(doc, topic, content)
    return list(found.values())
