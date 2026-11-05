"""Our World in Data: articles that explain the world's big problems with data, all CC BY (their charts too)."""

import re
import xml.etree.ElementTree as ET

from bs4 import BeautifulSoup
from starlette.concurrency import run_in_threadpool

from app.services import web
from app.services.html_markdown import word_count
from app.services.sources import (
    ACCEPT_FEED,
    ATOM,
    CC_BY,
    Item,
    cut_before,
    fetch,
    first_paragraph,
    linked_data,
    log,
    markdown_of,
    parse_date,
    reason,
)

SOURCE = "owid"
NAME = "Our World in Data"
FEED = "https://ourworldindata.org/atom.xml"
MIN_WORDS = 300
# Where the article ends and the page's own notes (thanks, citation, licence) begin.
TAIL_SECTIONS = (
    "Acknowledgments",
    "Acknowledgements",
    "Cite this work",
    "Past versions",
    "Reuse this work freely",
)
# Their articles span every topic; the words of the title and summary tell which.
KEYWORDS = {
    "health": r"health|disease|vaccin|death|mortality|life expectancy|malaria|cancer|smok|obesity|child",
    "environment": r"climate|co2|carbon|emission|energy|forest|biodiversity|species|pollution|land use|wildlife",
    "economy": r"poverty|income|gdp|econom|trade|wage|inequality|prices|growth|work|labor",
    "education": r"school|education|literacy|learning",
    "society": r"war|democra|population|migration|rights|violence|conflict|women|gender",
    "technology": r"artificial intelligence|\bai\b|technolog|internet|computing|robot",
    "science": r"science|research|space",
}


def topics_of(text: str) -> list[str]:
    found = [topic for topic, words in KEYWORDS.items() if re.search(words, text, re.I)]
    return found[:2] or ["science"]


def parse_feed(body: bytes) -> list[tuple[str, str, str, str | None]]:
    """(url, title, summary, published) for each entry of the feed."""
    entries = []
    for entry in ET.fromstring(body).iter(f"{ATOM}entry"):
        link = next((a.get("href") for a in entry.iter(f"{ATOM}link")), None) or entry.findtext(f"{ATOM}id")
        title = (entry.findtext(f"{ATOM}title") or "").strip()
        if link and title:
            summary = " ".join(
                markdown_of(entry.findtext(f"{ATOM}summary") or "", drop=("img", "figure")).split()
            )
            published = entry.findtext(f"{ATOM}published") or entry.findtext(f"{ATOM}updated")
            entries.append((link, title, summary, published))
    return entries


def page_item(html: bytes, url: str, title: str, summary: str, published: str | None) -> Item | None:
    article = web.extract_article(html, url)
    content = cut_before(article.content, TAIL_SECTIONS)
    if word_count(content) < MIN_WORDS:
        return None
    image = BeautifulSoup(html, "html.parser").find("meta", property="og:image")
    authors = BeautifulSoup(html, "html.parser").find("meta", attrs={"name": "citation_author"})
    return Item(
        source=SOURCE,
        url=url,
        title=title,
        content=content,
        language="en",
        kind="report",
        license=CC_BY[0],
        license_url=CC_BY[1],
        credit=(authors.get("content") if authors else None) or NAME,
        topics=topics_of(f"{title} {summary}"),
        authors=(authors.get("content") if authors else "") or "",
        summary=summary or first_paragraph(content),
        image_url=image.get("content") if image else None,
        published_at=parse_date(published) or article.published_at,
    )


async def collect(contact: str, channels: dict | None = None) -> list[Item]:
    items = []
    for url, title, summary, published in parse_feed(await fetch(FEED, contact, ACCEPT_FEED)):
        try:
            html = await fetch(url, contact)
        except Exception as e:
            log.warning("Our World in Data %s: %s", url, reason(e))
            continue
        if item := await run_in_threadpool(page_item, html, url, title, summary, published):
            items.append(item)
    return items


async def from_link(url: str, contact: str, topics: list[str]) -> Item | None:
    html = await fetch(url, contact)
    soup = BeautifulSoup(html, "html.parser")

    def meta(prop: str) -> str:
        tag = soup.find("meta", property=prop) or soup.find("meta", attrs={"name": prop})
        return (tag.get("content") or "").strip() if tag else ""

    title = meta("og:title") or (soup.title.get_text(strip=True) if soup.title else "")
    published = linked_data(html).get("datePublished") or meta("article:published_time") or None
    item = await run_in_threadpool(page_item, html, url, title, meta("og:description"), published)
    if item and topics:
        item.topics = list(topics)
    return item
