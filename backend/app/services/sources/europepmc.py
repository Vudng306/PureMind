"""The open research articles scripts/collect_catalog gathered from Europe PMC (data/catalog.json), CC BY."""

import json
from pathlib import Path

from app.services import doi as dois
from app.services.sources import CC_BY, Item, first_paragraph, parse_date

SOURCE = "europepmc"
NAME = "Europe PMC"
CATALOG = Path(__file__).resolve().parents[2] / "data" / "catalog.json"
# The catalog's topics, by their Vietnamese names, and the feed's.
TOPICS = {
    "Công nghệ và AI": ["technology"],
    "Sức khỏe": ["health"],
    "Tâm lý học": ["mind"],
    "Môi trường": ["environment"],
    "Giáo dục": ["education"],
    "Sinh học": ["science"],
    "Kinh tế và xã hội": ["economy", "society"],
    "Khoa học tự nhiên": ["science"],
}


def items(path: Path = CATALOG) -> list[Item]:
    if not path.exists():
        return []
    found = []
    for a in json.loads(path.read_text(encoding="utf-8")).get("articles", []):
        content = (a.get("content") or "").strip()
        if not content or not a.get("url") or not a.get("title"):
            continue
        doi = (a.get("doi") or "").lower() or None
        found.append(
            Item(
                source=SOURCE,
                # By its DOI when it has one, so the same paper from PLOS, or imported by DOI, is one.
                url=dois.url_of(doi) if doi else a["url"],
                title=a["title"],
                content=content,
                language=a.get("language") or "en",
                kind="research",
                license=CC_BY[0]
                if a.get("license", "").upper().startswith("CC BY")
                else a.get("license", "CC0"),
                license_url=a.get("license_url") or CC_BY[1],
                credit=a.get("authors") or NAME,
                topics=TOPICS.get(a.get("topic", ""), ["science"]),
                authors=a.get("authors") or "",
                summary=first_paragraph(a.get("abstract") or "") or first_paragraph(content),
                doi=doi,
                published_at=parse_date(a.get("published_at")),
            )
        )
    return found
