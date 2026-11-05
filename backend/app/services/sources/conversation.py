"""The Conversation: explainers by researchers, written for everyone.

CC BY-ND: the text is republished as written, with the author's name and position and a link back. The
photos are not theirs to license (agencies such as Getty), so every image goes, the tracking pixel with them.
"""

import xml.etree.ElementTree as ET

from starlette.concurrency import run_in_threadpool

from app.services import web
from app.services.html_markdown import word_count
from app.services.sources import (
    ACCEPT_FEED,
    ATOM,
    CC_BY_ND,
    Item,
    fetch,
    first_paragraph,
    linked_data,
    log,
    markdown_of,
    parse_date,
    reason,
)

SOURCE = "conversation"
NAME = "The Conversation"
# Section and topic feeds, and the feed's topics.
FEEDS = {
    "us/technology": ["science", "technology"],  # their "Science + Tech" section
    "us/health": ["health"],
    "us/environment": ["environment"],
    "us/education": ["education"],
    "us/business": ["economy"],
    "us/arts": ["arts", "culture"],
    "us/politics": ["law", "society"],
    "uk/business": ["economy"],
    "au/health": ["health"],
    "topics/psychology-28": ["mind"],
    "topics/mental-health-343": ["mind", "health"],
    "topics/history-180": ["history"],
    "topics/philosophy-234": ["philosophy"],
    "topics/law-78": ["law"],
    "topics/parenting-811": ["family"],
    "topics/travel-472": ["travel"],
    "topics/food-260": ["travel"],
    "topics/sport-480": ["sports"],
    "topics/sports-4768": ["sports"],
    # People and how society is changing.
    "topics/loneliness-2663": ["mind", "society"],
    "topics/social-isolation-13785": ["mind", "society"],
    "topics/happiness-75": ["mind"],
    "topics/friendship-3944": ["mind", "society"],
    "topics/social-psychology-11125": ["mind", "society"],
    "topics/social-norms-4849": ["society", "culture"],
    "topics/social-change-19930": ["society"],
    "topics/sociology-400": ["society"],
    "topics/inequality-829": ["society", "economy"],
    "topics/poverty-717": ["society", "economy"],
    "topics/migration-412": ["society"],
    "topics/gender-583": ["society"],
    "topics/demography-375": ["society"],
    "topics/ageing-36": ["society", "health"],
    "topics/youth-1596": ["society", "education"],
    "topics/generations-1777": ["society", "family"],
    "topics/millennials-14647": ["society", "family"],
    "topics/marriage-483": ["family", "society"],
    "topics/divorce-1895": ["family"],
    "topics/dating-10412": ["family", "culture"],
    "topics/online-dating-2338": ["family", "technology"],
    # Culture and everyday life.
    "topics/subcultures-13563": ["culture"],
    "topics/internet-culture-24503": ["culture", "technology"],
    "topics/culture-wars-8532": ["culture", "society"],
    "topics/social-media-109": ["technology", "society"],
    "topics/privacy-111": ["technology", "law"],
    "topics/digital-privacy-3209": ["technology", "law"],
    "topics/consumer-behaviour-4257": ["economy", "culture"],
    # Work, money and cities.
    "topics/work-life-balance-7644": ["economy", "society"],
    "topics/work-culture-14175": ["economy", "society"],
    "topics/workplace-2524": ["economy", "society"],
    "topics/employment-700": ["economy"],
    "topics/automation-4443": ["technology", "economy"],
    "topics/cities-40": ["society", "environment"],
    "topics/urbanisation-1": ["society", "environment"],
    "topics/urban-planning-1404": ["society", "environment"],
    "topics/public-space-10653": ["society"],
}
MIN_WORDS = 300


def parse(body: bytes, topics: list[str]) -> list[Item]:
    items = []
    for entry in ET.fromstring(body).iter(f"{ATOM}entry"):
        link = next(
            (a.get("href") for a in entry.iter(f"{ATOM}link") if a.get("rel", "alternate") == "alternate"),
            None,
        )
        html = entry.findtext(f"{ATOM}content") or ""
        title = (entry.findtext(f"{ATOM}title") or "").strip()
        if not link or not title or not html:
            continue
        content = markdown_of(html, drop=("img", "figure", "picture"))
        if word_count(content) < MIN_WORDS:
            continue
        # "Jane Doe, Professor of Ecology, University of X": the name, then the position the licence asks to keep.
        bylines = [n.strip() for a in entry.iter(f"{ATOM}author") if (n := a.findtext(f"{ATOM}name"))]
        summary = (entry.findtext(f"{ATOM}summary") or "").strip()
        items.append(
            Item(
                source=SOURCE,
                url=link,
                title=title,
                content=content,
                language="en",
                kind="explainer",
                license=CC_BY_ND[0],
                license_url=CC_BY_ND[1],
                credit="; ".join(bylines) or NAME,
                topics=list(topics),
                authors=", ".join(b.split(",")[0] for b in bylines),
                summary=markdown_of(summary).replace("\n\n", " ") if summary else first_paragraph(content),
                published_at=parse_date(
                    entry.findtext(f"{ATOM}published") or entry.findtext(f"{ATOM}updated")
                ),
            )
        )
    return items


async def collect(contact: str, feeds: dict[str, list[str]] = FEEDS) -> list[Item]:
    found: dict[str, Item] = {}
    for section, topics in feeds.items():
        try:
            body = await fetch(f"https://theconversation.com/{section}/articles.atom", contact, ACCEPT_FEED)
        except Exception as e:
            log.warning("The Conversation %s: %s", section, reason(e))
            continue
        for item in parse(body, topics):
            # An article in two sections is one article with both topics.
            if item.url in found:
                found[item.url].topics = sorted({*found[item.url].topics, *item.topics})
            else:
                found[item.url] = item
    return list(found.values())


def page_item(html: bytes, url: str, topics: list[str]) -> Item | None:
    """One article from its page, for an address an admin gives: the text as the page has it, images out."""
    article = web.extract_article(html, url)
    content = "\n\n".join(b for b in article.content.split("\n\n") if not b.startswith("!["))
    if word_count(content) < MIN_WORDS:
        return None
    data = linked_data(html)
    names = [a.get("name", "").strip() for a in data.get("author", []) if isinstance(a, dict)]
    names = [n for n in names if n]
    return Item(
        source=SOURCE,
        url=url,
        title=(data.get("headline") or article.title).strip(),
        content=content,
        language="en",
        kind="explainer",
        license=CC_BY_ND[0],
        license_url=CC_BY_ND[1],
        credit="; ".join(names) or NAME,
        topics=list(topics),
        authors=", ".join(names),
        summary=(data.get("description") or "").strip() or first_paragraph(content),
        published_at=parse_date(data.get("datePublished")) or article.published_at,
    )


async def from_link(url: str, contact: str, topics: list[str]) -> Item | None:
    html = await fetch(url, contact)
    return await run_in_threadpool(page_item, html, url, topics or ["society"])
