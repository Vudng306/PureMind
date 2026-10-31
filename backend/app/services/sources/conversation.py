"""The Conversation: explainers by researchers, written for everyone.

CC BY-ND: the text is republished as written, with the author's name and position and a link back. The
photos are not theirs to license (agencies such as Getty), so every image goes, the tracking pixel with them.
"""

import xml.etree.ElementTree as ET

from app.services.html_markdown import word_count
from app.services.sources import (
    ACCEPT_FEED,
    ATOM,
    CC_BY_ND,
    Item,
    fetch,
    first_paragraph,
    log,
    markdown_of,
    parse_date,
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


async def collect(contact: str) -> list[Item]:
    found: dict[str, Item] = {}
    for section, topics in FEEDS.items():
        try:
            body = await fetch(f"https://theconversation.com/{section}/articles.atom", contact, ACCEPT_FEED)
        except Exception as e:
            log.warning("The Conversation %s: %s", section, e)
            continue
        for item in parse(body, topics):
            # An article in two sections is one article with both topics.
            if item.url in found:
                found[item.url].topics = sorted({*found[item.url].topics, *item.topics})
            else:
                found[item.url] = item
    return list(found.values())
