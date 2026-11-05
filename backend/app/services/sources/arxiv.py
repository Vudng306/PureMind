"""arXiv: preprints, not peer reviewed. Only the papers whose authors chose CC BY or CC0 are taken, from the
last weeks of each subject; their text is the paper's own HTML page on arxiv.org.
"""

import asyncio
import re
from datetime import UTC, datetime, timedelta
from urllib.parse import urlencode
from xml.etree import ElementTree

from starlette.concurrency import run_in_threadpool

from app.services import doi as dois
from app.services import web
from app.services.html_markdown import word_count
from app.services.sources import (
    ACCEPT_FEED,
    CC_BY,
    Item,
    cut_before,
    fetch,
    fetch_page,
    log,
    parse_date,
    reason,
)

SOURCE = "arxiv"
NAME = "arXiv"
OAI = "https://export.arxiv.org/oai2"
OAI_NS = "{http://www.openarchives.org/OAI/2.0/}"
ARXIV_NS = "{http://arxiv.org/OAI/arXiv/}"
CC0 = ("CC0 1.0", "https://creativecommons.org/publicdomain/zero/1.0/")
# The licences an author can give a paper that let anyone reuse it with credit.
LICENSES = {
    "http://creativecommons.org/licenses/by/4.0/": CC_BY,
    "http://creativecommons.org/publicdomain/zero/1.0/": CC0,
}
# arXiv's sets, and the feed's topics for each.
SETS = {
    "cs:cs:CY": ["technology", "society"],
    "cs:cs:SI": ["technology", "society"],
    "cs:cs:HC": ["technology", "mind"],
    "econ": ["economy"],
    "q-fin": ["economy"],
}
SINCE_DAYS = 10  # records changed in the last days: a new paper, or an old one revised
RECENT_DAYS = 120  # of those, the papers first sent in the last months
MIN_WORDS, MAX_WORDS = 1500, 20_000
MAX_PAGES = 3
PAUSE = 3.0  # arXiv asks for a pause between requests
TAIL_SECTIONS = ("References", "Bibliography", "Acknowledgments", "Acknowledgements", "Appendix")
# What a category says in words, for the tag.
CATEGORY_NAMES = {
    "cs.ai": "artificial intelligence",
    "cs.lg": "machine learning",
    "stat.ml": "machine learning",
    "cs.cl": "natural language processing",
    "cs.cv": "computer vision",
    "cs.cy": "computers and society",
    "cs.hc": "human-computer interaction",
    "cs.ro": "robotics",
    "cs.cr": "security",
    "cs.ir": "information retrieval",
    "cs.se": "software engineering",
    "econ.gn": "general economics",
    "econ.em": "econometrics",
    "econ.th": "economic theory",
    "q-bio.nc": "neuroscience",
    "q-bio.pe": "populations and evolution",
    "physics.soc-ph": "physics and society",
    "physics.ed-ph": "physics education",
}
ID = re.compile(r"arxiv\.org/(?:abs|html|pdf)/((?:\d{4}\.\d{4,5})|(?:[a-z-]+(?:\.[A-Za-z]{2})?/\d{7}))", re.I)


def tags_of(categories: str) -> list[str]:
    """The categories the paper is filed under, in words; the ones without a name here are left out."""
    names = (
        CATEGORY_NAMES.get(c) or ("astrophysics" if c.startswith("astro-ph") else "")
        for c in categories.lower().split()
    )
    return [n for n in names if n]


def from_abstract(markdown: str) -> str:
    """The paper without its front matter (authors' addresses, the publisher's template): from its abstract."""
    blocks = markdown.split("\n\n")
    for i, block in enumerate(blocks[:25]):
        if block.startswith("#") and "abstract" in block.lower():
            return "\n\n".join(blocks[i:])
    return markdown


def _text(node: ElementTree.Element, tag: str) -> str:
    found = node.find(f"{ARXIV_NS}{tag}")
    return " ".join((found.text or "").split()) if found is not None else ""


def parse(body: bytes) -> tuple[list[dict], str | None]:
    """The records of an OAI-PMH answer, and the token for the next page of them."""
    root = ElementTree.fromstring(body)
    records = []
    for record in root.iter(f"{OAI_NS}record"):
        meta = record.find(f"{OAI_NS}metadata/{ARXIV_NS}arXiv")
        if meta is None:
            continue  # a deleted record
        names = []
        for author in meta.iterfind(f"{ARXIV_NS}authors/{ARXIV_NS}author"):
            name = f"{_text(author, 'forenames')} {_text(author, 'keyname')}".strip()
            if name:
                names.append(name)
        records.append(
            {
                "id": _text(meta, "id"),
                "created": _text(meta, "created"),
                "title": _text(meta, "title"),
                "authors": names,
                "categories": _text(meta, "categories"),
                "abstract": _text(meta, "abstract"),
                "license": _text(meta, "license"),
                "doi": _text(meta, "doi").split(" ")[0].lower() or None,
            }
        )
    token = root.find(f"{OAI_NS}ListRecords/{OAI_NS}resumptionToken")
    return records, ((token.text or "").strip() or None) if token is not None else None


def published_of(record: dict) -> datetime | None:
    created = parse_date(record["created"])
    return min(created, datetime.now(UTC)) if created else None


def item_of(record: dict, topics: list[str], content: str) -> Item:
    licence = LICENSES[record["license"]]
    names = ", ".join(record["authors"][:3]) + (" et al." if len(record["authors"]) > 3 else "")
    return Item(
        source=SOURCE,
        url=f"https://arxiv.org/abs/{record['id']}",
        title=record["title"],
        content=content,
        language="en",
        kind="research",
        license=licence[0],
        license_url=licence[1],
        credit=f"{names} · arXiv:{record['id']} (preprint, not peer reviewed)",
        topics=list(topics),
        authors=names,
        summary=record["abstract"][:600],
        tags=tags_of(record["categories"]),
        doi=record["doi"] if record["doi"] and dois.DOI.fullmatch(record["doi"]) else None,
        published_at=published_of(record),
    )


async def page_text(arxiv_id: str, contact: str) -> str:
    """The paper's own HTML page, without its references; empty when it has none or is too short or long."""
    try:
        page = await fetch_page(f"https://arxiv.org/html/{arxiv_id}", contact)
        article = await run_in_threadpool(web.extract_article, page.body, page.url)
    except Exception as e:
        log.warning("arXiv %s: %s", arxiv_id, reason(e))
        return ""
    content = from_abstract(cut_before(article.content, TAIL_SECTIONS))
    return content if MIN_WORDS <= word_count(content) <= MAX_WORDS else ""


async def listing(contact: str, set_spec: str, since: str) -> list[dict]:
    params = {"verb": "ListRecords", "metadataPrefix": "arXiv", "set": set_spec, "from": since}
    records: list[dict] = []
    for _ in range(MAX_PAGES):
        found, token = parse(await fetch(f"{OAI}?{urlencode(params)}", contact, ACCEPT_FEED))
        records += found
        if not token:
            break
        params = {"verb": "ListRecords", "resumptionToken": token}
        await asyncio.sleep(PAUSE)
    return records


def usable(record: dict, earliest: datetime) -> bool:
    created = published_of(record)
    return bool(
        record["license"] in LICENSES
        and record["id"]
        and record["title"]
        and record["abstract"]
        and created
        and created >= earliest
    )


async def collect(contact: str, sets: dict[str, list[str]] = SETS, per_set: int = 4) -> list[Item]:
    now = datetime.now(UTC)
    since = (now - timedelta(days=SINCE_DAYS)).strftime("%Y-%m-%d")
    earliest = max(now - timedelta(days=RECENT_DAYS), datetime(2023, 1, 1, tzinfo=UTC))
    found: dict[str, Item] = {}
    for set_spec, topics in sets.items():
        try:
            records = await listing(contact, set_spec, since)
        except Exception as e:
            log.warning("arXiv %s: %s", set_spec, reason(e))
            continue
        fresh = sorted((r for r in records if usable(r, earliest)), key=lambda r: r["created"], reverse=True)
        kept = 0
        for record in fresh:
            if kept >= per_set:
                break
            url = f"https://arxiv.org/abs/{record['id']}"
            if url in found:
                found[url].topics = sorted({*found[url].topics, *topics})
                kept += 1
                continue
            content = await page_text(record["id"], contact)
            if not content:
                continue
            kept += 1
            found[url] = item_of(record, topics, content)
        await asyncio.sleep(PAUSE)
    return list(found.values())


async def from_link(url: str, contact: str, topics: list[str]) -> Item | None:
    """arxiv.org/abs/…, arxiv.org/html/… or arxiv.org/pdf/…: only when the paper's licence allows reuse."""
    found = ID.search(url)
    if not found:
        return None
    params = {
        "verb": "GetRecord",
        "identifier": f"oai:arXiv.org:{found.group(1)}",
        "metadataPrefix": "arXiv",
    }
    records, _ = parse(await fetch(f"{OAI}?{urlencode(params)}", contact, ACCEPT_FEED))
    if not records or records[0]["license"] not in LICENSES:
        return None
    content = await page_text(records[0]["id"], contact)
    if not content:
        return None
    return item_of(records[0], topics or ["technology"], content)
