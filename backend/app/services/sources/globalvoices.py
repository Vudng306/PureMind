"""Global Voices: reports and essays by citizen journalists from around the world, on society, culture and
people's lives. CC BY 3.0 (its attribution policy): the text is kept as written with the author's name and a link
back. The photos have their own credits, so the images go.
"""

import xml.etree.ElementTree as ET
from email.utils import parsedate_to_datetime

from starlette.concurrency import run_in_threadpool

from app.services import web
from app.services.html_markdown import word_count
from app.services.sources import (
    ACCEPT_FEED,
    Item,
    fetch,
    first_paragraph,
    linked_data,
    log,
    markdown_of,
    parse_date,
    plain,
    reason,
)

SOURCE = "globalvoices"
NAME = "Global Voices"
CC_BY_3 = ("CC BY 3.0", "https://creativecommons.org/licenses/by/3.0/")
CONTENT = "{http://purl.org/rss/1.0/modules/content/}encoded"
CREATOR = "{http://purl.org/dc/elements/1.1/}creator"
# The site's topic feeds, and the feed's topics for each.
FEEDS = {
    "-/topics/arts-culture": ["culture", "arts"],
    "-/topics/women-gender": ["society", "family"],
    "-/topics/youth": ["society", "education"],
    "-/topics/migration-immigration": ["society"],
    "-/topics/ethnicity-race": ["society", "culture"],
    "-/topics/labor": ["economy", "society"],
    "-/topics/economics-business": ["economy"],
    "-/topics/education": ["education"],
    "-/topics/health": ["health", "society"],
    "-/topics/technology": ["technology", "society"],
    "-/topics/food": ["culture", "travel"],
    "-/topics/religion": ["culture", "society"],
    "-/topics/lgbt": ["society"],
    "-/topics/indigenous": ["culture", "history"],
}
MIN_WORDS = 300
# What a post is filed under that says nothing about its subject.
NOT_TAGS = {"english", "weblog", "ideas", "feature", "citizen media", "global voices", "uncategorized"}
# The page furniture inside a post: pictures with their captions, and the "originally published" line.
DROP = ("img", "figure", "picture", ".wp-caption", ".originally-published", "script")


def date_of(raw: str | None):
    if not raw:
        return None
    try:
        return parsedate_to_datetime(raw.strip())
    except (TypeError, ValueError):
        return parse_date(raw)


def tags_of(categories: list[str]) -> list[str]:
    return [c for c in categories if c.strip().lower() not in NOT_TAGS]


def parse(body: bytes, topics: list[str]) -> list[Item]:
    items = []
    for entry in ET.fromstring(body).iter("item"):
        link = (entry.findtext("link") or "").strip()
        title = " ".join((entry.findtext("title") or "").split())
        html = entry.findtext(CONTENT) or ""
        if not link or not title or not html:
            continue
        content = markdown_of(html, drop=DROP)
        if word_count(content) < MIN_WORDS:
            continue
        author = " ".join((entry.findtext(CREATOR) or "").split())
        summary = plain(markdown_of(entry.findtext("description") or ""), 600)
        items.append(
            Item(
                source=SOURCE,
                url=link,
                title=title,
                content=content,
                language="en",
                kind="explainer",
                license=CC_BY_3[0],
                license_url=CC_BY_3[1],
                credit=f"{author} · {NAME}" if author else NAME,
                topics=list(topics),
                authors=author,
                summary=summary or first_paragraph(content),
                tags=tags_of([c.text or "" for c in entry.iter("category")]),
                published_at=date_of(entry.findtext("pubDate")),
            )
        )
    return items


async def collect(contact: str, feeds: dict[str, list[str]] = FEEDS) -> list[Item]:
    found: dict[str, Item] = {}
    for section, topics in feeds.items():
        try:
            body = await fetch(f"https://globalvoices.org/{section}/feed/", contact, ACCEPT_FEED)
        except Exception as e:
            log.warning("Global Voices %s: %s", section, reason(e))
            continue
        for item in parse(body, topics):
            # A post in two sections is one post with both topics, and the tags of both.
            if item.url in found:
                kept = found[item.url]
                kept.topics = sorted({*kept.topics, *item.topics})
                kept.tags = list(dict.fromkeys([*kept.tags, *item.tags]))
            else:
                found[item.url] = item
    return list(found.values())


def page_item(html: bytes, url: str, topics: list[str]) -> Item | None:
    """One post from its page, for an address an admin gives: the text as the page has it, images out."""
    article = web.extract_article(html, url)
    content = "\n\n".join(b for b in article.content.split("\n\n") if not b.startswith("!["))
    if word_count(content) < MIN_WORDS:
        return None
    data = linked_data(html)
    author = data.get("author")
    name = (author.get("name") if isinstance(author, dict) else "") or ""
    return Item(
        source=SOURCE,
        url=url,
        title=(data.get("headline") or article.title).strip(),
        content=content,
        language="en",
        kind="explainer",
        license=CC_BY_3[0],
        license_url=CC_BY_3[1],
        credit=f"{name} · {NAME}" if name else NAME,
        topics=list(topics),
        authors=name,
        summary=(data.get("description") or "").strip() or first_paragraph(content),
        published_at=parse_date(data.get("datePublished")) or article.published_at,
    )


async def from_link(url: str, contact: str, topics: list[str]) -> Item | None:
    html = await fetch(url, contact)
    return await run_in_threadpool(page_item, html, url, topics or ["society"])
