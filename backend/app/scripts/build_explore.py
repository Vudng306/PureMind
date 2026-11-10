"""Write Explore's catalog from Cẩm nang sống thông minh: every entry of the book, at the commit
data/hlb-picks.json pins, sorted into six topic groups by chapter.

    python -m app.scripts.build_explore

It replaces data/catalog.json and empties data/catalog-picks.json, the short reads the old catalog put first.
Each entry keeps the address the feed's article has, so an admin who hides the article hides it here too. The
picked entries (hlb-picks.json) carry their feed title as `headline`, and Explore leads with them. Reads the
book from GitHub, 36 files, as a sync does; makes no OpenAI call.
"""

import asyncio
import hashlib
import json
import sys

from app.api.routes.catalog import CATALOG, PICKS
from app.models import utcnow
from app.services import crawler
from app.services.sources import hlb, plain

# Explore's topics, each a set of the book's chapters, in the order the page lists them.
GROUPS = {
    "Sức khỏe và an toàn": (1, 2, 13, 16, 20, 24, 27, 28, 34, 35),
    "Tâm lý và năng suất": (3, 4, 22, 29),
    "Tiền bạc và công việc": (5, 6, 7, 12, 15, 19),
    "Pháp luật và quyền lợi": (8, 9, 11, 14, 26, 36),
    "Gia đình và đời sống": (10, 17, 18, 21, 25, 30, 33),
    "Học tập và phát triển": (23, 31, 32),
}
GROUP_OF = {chapter: name for name, chapters in GROUPS.items() for chapter in chapters}


def entry_of(entry: hlb.Entry, path: str, pin: hlb.Pin, headlines: dict[str, str]) -> dict | None:
    item = hlb.entry_item(entry, path, pin)
    if item is None:
        return None
    grade = entry.fields.get("Mức bằng chứng", "").strip()[:1].upper()
    found = {
        "id": hashlib.sha1(f"{hlb.SOURCE}:{entry.id}".encode()).hexdigest()[:20],
        "url": item.url,
        "title": entry.title,
        "topic": GROUP_OF.get(entry.chapter, "Gia đình và đời sống"),
        "kind": "explainer",
        "language": "vi",
        "source": hlb.NAME,
        "authors": item.authors,
        "published_at": pin.date.date().isoformat(),
        "doi": "",
        "content": item.content,
        "description": plain(entry.fields["Nói dễ hiểu"], 400),
        "license": item.license,
        "license_url": item.license_url,
        "attribution_url": item.url,
        "content_note": "",
        "chapter": entry.chapter,
        "chapter_title": entry.chapter_title,
        "ref": f"{entry.chapter}.{entry.number}",
        "grade": grade if grade in {"A", "B", "C"} else "",
    }
    if entry.id in headlines:
        found["headline"] = headlines[entry.id]
    return found


async def build() -> None:
    pin = hlb.read_pin()
    briefs = hlb.read_briefs()
    headlines = {entry_id: brief.title for entry_id, brief in briefs.items() if brief.title}
    found = [
        e
        for entry, path in await hlb.entries(pin, crawler.contact())
        if (e := entry_of(entry, path, pin, headlines))
    ]
    # The picks first, in the order the picks file lists them; then the book's own order.
    order = list(headlines)
    found.sort(key=lambda a: order.index(e) if (e := hlb.entry_id_in(a["url"])) in order else len(order))
    ids = [a["id"] for a in found]
    assert len(ids) == len(set(ids)), "two entries share an id"
    CATALOG.write_text(
        json.dumps(
            {"updated_at": utcnow().isoformat(), "commit": pin.commit, "articles": found},
            ensure_ascii=False,
            indent=1,
        ),
        encoding="utf-8",
    )
    PICKS.write_text("[]\n", encoding="utf-8")
    counts = {name: sum(a["topic"] == name for a in found) for name in GROUPS}
    print(f"{len(found)} entries @ {pin.commit[:7]}, {len(headlines)} with a headline: {counts}")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    asyncio.run(build())
