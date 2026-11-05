"""eLife Insights: short pieces in which researchers explain a new eLife paper to readers outside the field,
CC BY like everything eLife publishes. Each article's licence is checked all the same."""

import json
import re
from urllib.parse import urlencode

from bs4 import BeautifulSoup

from app.services.html_markdown import word_count
from app.services.sources import (
    CC_BY,
    Item,
    fetch,
    first_paragraph,
    log,
    markdown_of,
    parse_date,
    plain,
    reason,
)

SOURCE = "elife"
NAME = "eLife"
API = "https://api.elifesciences.org"
LICENSE = "CC-BY-4.0"
# The API answers only in its own media types (plain JSON is refused).
ACCEPT_SEARCH = "application/vnd.elife.search+json"
ACCEPT_ARTICLE = "application/vnd.elife.article-vor+json"
MIN_WORDS = 300
# eLife's subjects that the feed's readers follow, and the feed's topics for each.
SUBJECTS = {
    "neuroscience": ["mind", "science"],
    "medicine": ["health"],
    "epidemiology-global-health": ["health", "society"],
    "ecology": ["environment", "science"],
}
SINCE = "2023-01-01"


def search_url(subject: str, rows: int) -> str:
    params = [
        ("type[]", "insight"),
        ("subject[]", subject),
        ("start-date", SINCE),
        ("sort", "date"),
        ("order", "desc"),
        ("per-page", rows),
    ]
    return f"{API}/search?{urlencode(params)}"


def parse_search(body: bytes) -> list[str]:
    """The ids of the Insights a search found."""
    return [i["id"] for i in json.loads(body).get("items", []) if i.get("type") == "insight" and i.get("id")]


def _html(blocks: list[dict]) -> str:
    """eLife's content blocks as HTML: the prose, headings and lists; figures and boxes are left out."""
    parts = []
    for block in blocks:
        kind = block.get("type")
        if kind == "paragraph":
            parts.append(f"<p>{block.get('text', '')}</p>")
        elif kind == "section":
            if (title := block.get("title")) and title != "Main text":
                parts.append(f"<h2>{title}</h2>")
            parts.append(_html(block.get("content", [])))
        elif kind == "list":
            tag = "ol" if block.get("prefix") == "number" else "ul"
            items = "".join(
                f"<li>{x if isinstance(x, str) else _html(x)}</li>" for x in block.get("items", [])
            )
            parts.append(f"<{tag}>{items}</{tag}>")
        elif kind == "quote":
            parts.append(f"<blockquote>{_html(block.get('text', []))}</blockquote>")
    return "".join(parts)


def body_markdown(blocks: list[dict]) -> str:
    soup = BeautifulSoup(_html(blocks), "html.parser")
    # Links to the paper's own references and figures lead nowhere once the text is out of the page.
    for link in soup.select('a[href^="#"]'):
        link.unwrap()
    return markdown_of(str(soup))


def text_of(html: str) -> str:
    return " ".join(BeautifulSoup(html or "", "html.parser").get_text(" ").split())


def item_of(article: dict, subjects: dict[str, list[str]] = SUBJECTS) -> Item | None:
    """The Insight as the feed keeps it, or None when it is not CC BY or too short to read on its own."""
    if (article.get("copyright") or {}).get("license") != LICENSE:
        return None
    content = body_markdown(article.get("body") or [])
    if word_count(content) < MIN_WORDS:
        return None
    topics = sorted({t for s in article.get("subjects") or [] for t in subjects.get(s.get("id"), [])})
    authors = text_of(article.get("authorLine", ""))
    return Item(
        source=SOURCE,
        url=f"https://elifesciences.org/articles/{article['id']}",
        title=text_of(article["title"]),
        content=content,
        language="en",
        kind="explainer",
        license=CC_BY[0],
        license_url=CC_BY[1],
        credit=f"{authors} · {NAME}" if authors else NAME,
        topics=topics or ["science"],
        authors=authors,
        summary=plain(text_of(article.get("impactStatement", "")), 600) or first_paragraph(content),
        tags=[text_of(k) for k in article.get("keywords") or []][:8],
        doi=(article.get("doi") or "").lower() or None,
        published_at=parse_date(article.get("published")),
    )


async def collect(
    contact: str, subjects: dict[str, list[str]] = SUBJECTS, per_subject: int = 8
) -> list[Item]:
    found: list[Item] = []
    seen: set[str] = set()
    for subject in subjects:
        try:
            ids = parse_search(await fetch(search_url(subject, per_subject), contact, ACCEPT_SEARCH))
        except Exception as e:
            log.warning("eLife %s: %s", subject, reason(e))
            continue
        for id_ in ids:
            if id_ in seen:  # an Insight in two subjects; its topics come from all of them already
                continue
            seen.add(id_)
            try:
                item = item_of(
                    json.loads(await fetch(f"{API}/articles/{id_}", contact, ACCEPT_ARTICLE)), subjects
                )
            except Exception as e:
                log.warning("eLife %s: %s", id_, reason(e))
                continue
            if item:
                found.append(item)
    return found


async def from_link(url: str, contact: str, topics: list[str]) -> Item | None:
    """elifesciences.org/articles/<id>: an Insight or any other eLife article."""
    found = re.search(r"elifesciences\.org/articles/(\d+)", url)
    if not found:
        return None
    item = item_of(json.loads(await fetch(f"{API}/articles/{found.group(1)}", contact, ACCEPT_ARTICLE)))
    if item and topics:
        item.topics = list(topics)
    return item
