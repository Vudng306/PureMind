"""Europe PMC: open research articles found by search, CC BY or CC0, with their full text from its XML.
The text keeps its tables and the captions of its figures; the pictures themselves and the supplements are left
out (the images cannot be fetched, and some are reproduced from elsewhere under their own terms). An article
that leans on them more than on its words is not taken."""

import json
import re
from datetime import UTC, datetime
from urllib.parse import urlencode
from xml.etree import ElementTree

from bs4 import BeautifulSoup

from app.services import doi as dois
from app.services.html_markdown import word_count
from app.services.sources import (
    ACCEPT_JSON,
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

SOURCE = "europepmc"
NAME = "Europe PMC"
API = "https://www.ebi.ac.uk/europepmc/webservices/rest"
SINCE = "2023-01-01"
MIN_WORDS = 600
CC0 = ("CC0 1.0", "https://creativecommons.org/publicdomain/zero/1.0/")
# Searches, and the feed's topics for what each finds.
QUERIES = {
    "loneliness social isolation": ["mind", "society"],
    "social media wellbeing": ["technology", "mind"],
    "migration integration": ["society"],
    "marriage family relationships": ["family", "society"],
    "work stress burnout": ["economy", "mind"],
    "urban neighbourhood community": ["society", "environment"],
    "public health": ["health"],
    "psychology cognition": ["mind"],
    "climate change biodiversity": ["environment"],
    "education learning": ["education"],
    "health economics": ["economy", "society"],
    "bioethics philosophy": ["philosophy"],
    "health law policy": ["law", "society"],
    "parenting child development": ["family"],
    "history of medicine": ["history"],
    "music art therapy": ["arts", "culture"],
    "sport exercise": ["sports", "health"],
}
EXCLUDED_TITLES = re.compile(
    r"^(correction\b|erratum\b|retraction\b|retracted\b|expression of concern\b)", re.I
)
DROPPED = {"supplementary-material", "disp-formula", "ref-list"}
FIGURES = {"fig", "table-wrap"}
# The titles of the paper's apparatus around its text.
BACK_MATTER = re.compile(
    r"^(?:\d+\.?\s*)?(?:references?|bibliography|acknowledge?ments?|abbreviations|funding(?: \w+)?|disclosures?"
    r"|declarations?|suppl\w+ (?:materials?|information|data)|supporting information"
    r"|data (?:availability|sharing)(?: statement)?|availability of data\b.*"
    r"|(?:credit )?author\w*['’]? contributions?(?: statement)?"
    r"|(?:declaration of )?(?:conflicts? of interests?|competing interests?)(?: statement)?"
    r"|(?:ethics|ethical) (?:approval|statement)\b.*|consent for publication|informed consent statement"
    r"|institutional review board statement|publisher['’]?s note|generative ai statement)[.:]?$",
    re.I,
)
# More figures and tables than this, or more than this many per thousand words, and the words alone do not carry it.
MAX_VISUALS = 6
MAX_PER_1000_WORDS = 2.0
MAX_TABLE_CELLS = 120
MAX_CAPTION = 500
MAX_HEADING = 4


def search_url(query: str, rows: int) -> str:
    params = {
        "query": f"({query}) AND OPEN_ACCESS:Y AND IN_EPMC:Y AND (LICENSE:cc-by OR LICENSE:cc0)"
        f" AND FIRST_PDATE:[{SINCE} TO 2100-12-31]",
        "format": "json",
        "resultType": "core",
        "pageSize": rows,
    }
    return f"{API}/search?{urlencode(params)}"


def parse_search(body: bytes) -> list[dict]:
    return [
        w
        for w in json.loads(body).get("resultList", {}).get("result", [])
        if re.fullmatch(r"PMC\d+", w.get("pmcid") or "") and not EXCLUDED_TITLES.match(w.get("title") or "")
    ]


def licence_of(root: ElementTree.Element) -> tuple[str, str] | None:
    """CC BY or CC0, from the article's own permissions; None for any other licence."""
    for node in root.iterfind(".//permissions/license"):
        for each in node.iter():
            for link in [*each.attrib.values(), (each.text or "").strip()]:
                if re.match(r"https?://creativecommons\.org/publicdomain/zero/", link):
                    return CC0
                if re.match(r"https?://creativecommons\.org/licenses/by/", link):
                    return CC_BY
    return None


def words_of(node: ElementTree.Element) -> str:
    """The text of a node on one line, leaving out the figures, tables and supplements inside it."""

    def walk(n: ElementTree.Element) -> str:
        parts = [n.text or ""]
        for child in n:
            if child.tag not in DROPPED | FIGURES:
                parts.append(walk(child))
            parts.append(child.tail or "")
        return "".join(parts)

    return " ".join(walk(node).split())


def caption_of(node: ElementTree.Element) -> str:
    """The label, title and text of a caption ('Figure 1. Title. What it shows'), cut at a word."""
    label = words_of(node.find("label")) if node.find("label") is not None else ""
    caption = node.find("caption")
    text = " ".join(words_of(c) for c in caption if c.tag in ("title", "p")) if caption is not None else ""
    text = f"{label}. {text}" if label and text and not label.endswith(".") else f"{label} {text}".strip()
    return text if len(text) <= MAX_CAPTION else text[:MAX_CAPTION].rsplit(" ", 1)[0] + "…"


def table_of(node: ElementTree.Element) -> str:
    """A table as Markdown; empty when it is a picture of one, or too big to read in a column of text."""
    table = node.find(".//table")
    if table is None:
        return ""
    rows = list(table.iter("tr"))
    cells = sum(len(list(r)) for r in rows)
    if not rows or cells > MAX_TABLE_CELLS:
        return ""
    return markdown_of(ElementTree.tostring(table, encoding="unicode"))


def figure_blocks(node: ElementTree.Element) -> list[str]:
    caption = caption_of(node)
    if node.tag == "fig":
        return [f"> {caption}"] if caption else []
    table = table_of(node)
    return [b for b in (f"> **{caption}**" if caption else "", table) if b]


def count_visuals(body: ElementTree.Element) -> int:
    return sum(1 for n in body.iter() if n.tag in FIGURES)


def without_empty_headings(blocks: list[str]) -> list[str]:
    """Drops a heading with nothing under it: at the end, or followed by a heading that is not its own subsection."""
    kept: list[str] = []
    for block in reversed(blocks):
        level = len(block) - len(block.lstrip("#")) if block.startswith("#") else 0
        if level:
            after = kept[-1] if kept else ""
            next_level = len(after) - len(after.lstrip("#")) if after.startswith("#") else 0
            if not after or (next_level and next_level <= level):
                continue
        kept.append(block)
    return kept[::-1]


def body_markdown(root: ElementTree.Element) -> str:
    """The text with a heading per section as deep as the section is, its tables in place, and a quote with each
    figure's caption. The paper's apparatus (references, funding, contributions…) and sections left with nothing to
    read under their title are not kept."""
    body = root.find("body")
    if body is None:
        return ""
    blocks: list[str] = []

    def walk(parent: ElementTree.Element, depth: int = 0) -> None:
        for node in parent:
            if node.tag in DROPPED:
                continue
            if node.tag in FIGURES:
                blocks.extend(figure_blocks(node))
            elif node.tag == "title":
                if text := words_of(node):
                    blocks.append(f"{'#' * min(max(depth, 1) + 1, MAX_HEADING)} {text}")
            elif node.tag == "p":
                if text := words_of(node):
                    blocks.append(text)
                for inner in node.iter():
                    if inner.tag in FIGURES:
                        blocks.extend(figure_blocks(inner))
            else:
                title = node.find("title")
                if title is None or not BACK_MATTER.match(words_of(title)):
                    walk(node, depth + (node.tag == "sec"))

    walk(body)
    return "\n\n".join(without_empty_headings(blocks))


def leans_on_visuals(body: ElementTree.Element | None, words: int) -> bool:
    """Whether the article has too many figures and tables for its words: its results are in them, not in the text."""
    if body is None:
        return False
    count = count_visuals(body)
    return count > MAX_VISUALS or count / max(words, 1) * 1000 > MAX_PER_1000_WORDS


def published_of(work: dict) -> datetime | None:
    """When it came out. A coming print issue's date lies ahead, while the article is online since it was indexed."""
    first = parse_date(work.get("firstPublicationDate"))
    if first and first > datetime.now(UTC):
        return parse_date(work.get("firstIndexDate")) or datetime.now(UTC)
    return first


def item_of(work: dict, xml: bytes, topics: list[str]) -> Item | None:
    """The article as the feed keeps it, or None when it is not CC BY / CC0 or too short to read."""
    root = ElementTree.fromstring(xml)
    licence = licence_of(root)
    content = body_markdown(root)
    words = word_count(content)
    if licence is None or words < MIN_WORDS or leans_on_visuals(root.find("body"), words):
        return None
    doi = (work.get("doi") or "").lower() or None
    abstract = BeautifulSoup(work.get("abstractText") or "", "html.parser").get_text(" ", strip=True)
    authors = work.get("authorString") or ""
    journal = ((work.get("journalInfo") or {}).get("journal") or {}).get("title") or NAME
    return Item(
        source=SOURCE,
        # By its DOI when it has one, so the same paper from PLOS, or imported by DOI, is one.
        url=dois.url_of(doi) if doi else f"https://europepmc.org/article/PMC/{work['pmcid']}",
        title=" ".join(BeautifulSoup(work["title"], "html.parser").get_text(" ").split()).rstrip("."),
        content=content,
        language="en",
        kind="research",
        license=licence[0],
        license_url=licence[1],
        credit=f"{authors} · {journal}" if authors else journal,
        topics=list(topics),
        authors=authors[:1000],
        summary=plain(abstract, 600) or first_paragraph(content),
        tags=((work.get("keywordList") or {}).get("keyword") or [])[:8],
        doi=doi,
        published_at=published_of(work),
    )


async def _item(work: dict, contact: str, topics: list[str]) -> Item | None:
    xml = await fetch(f"{API}/{work['pmcid']}/fullTextXML", contact, "application/xml")
    return item_of(work, xml, topics)


async def collect(contact: str, queries: dict[str, list[str]] = QUERIES, per_query: int = 5) -> list[Item]:
    found: dict[str, Item] = {}
    for query, topics in queries.items():
        try:
            works = parse_search(await fetch(search_url(query, per_query * 2), contact, ACCEPT_JSON))
        except Exception as e:
            log.warning("Europe PMC %s: %s", query, reason(e))
            continue
        kept = 0
        for work in works:
            if kept >= per_query:
                break
            try:
                item = await _item(work, contact, topics)
            except Exception as e:
                log.warning("Europe PMC %s: %s", work["pmcid"], reason(e))
                continue
            if item is None:
                continue
            kept += 1
            if item.url in found:
                found[item.url].topics = sorted({*found[item.url].topics, *topics})
            else:
                found[item.url] = item
    return list(found.values())


async def from_link(url: str, contact: str, topics: list[str]) -> Item | None:
    """europepmc.org/article/PMC/PMC123…, europepmc.org/articles/PMC123…, or the DOI of an article in it."""
    pmcid = re.search(r"PMC\d+", url, re.I)
    doi = None if pmcid else re.search(r"10\.\d{4,9}/[^\s?#&]+", url)
    if pmcid:
        query = f"PMCID:{pmcid.group(0).upper()}"
    elif doi:
        query = f'DOI:"{doi.group(0)}"'
    else:
        return None
    params = {"query": query, "format": "json", "resultType": "core", "pageSize": 1}
    works = parse_search(await fetch(f"{API}/search?{urlencode(params)}", contact, ACCEPT_JSON))
    return await _item(works[0], contact, topics or ["science"]) if works else None
