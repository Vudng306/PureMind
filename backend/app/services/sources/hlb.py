"""Cẩm nang sống thông minh (quangpao/HowToLiveBetter): a Vietnamese handbook of everyday advice, each entry
with its cost, a plain summary, the benefit, the Vietnamese law, an evidence grade (A/B/C) and its sources.
CC BY 4.0, rewritten from eternity4719's 高性价比人生指南 under the same licence.

The repository is read at the commit `data/hlb-picks.json` pins, so a crawl brings the same text every time
and a new version only arrives when someone moves that pin and reads the changes. Only the picked entries
are collected; an admin can add any other entry by its link. Each entry becomes one article, under an
address without the commit, so a newer version updates it instead of adding a second copy.
"""

import json
import posixpath
import re
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from urllib.parse import unquote, urlsplit

from app.services.html_markdown import word_count
from app.services.sources import CC_BY, Item, fetch, log, plain, reason

SOURCE = "hlb"
NAME = "Cẩm nang sống thông minh"
REPO = "quangpao/HowToLiveBetter"
BRANCH = "vi"
REPO_URL = f"https://github.com/{REPO}"
RAW = "https://raw.githubusercontent.com/{repo}/{ref}/{path}"
PICKS = Path(__file__).resolve().parents[2] / "data" / "hlb-picks.json"
HOSTS = ("github.com", "raw.githubusercontent.com", "quangpao.github.io")
ACCEPT_TEXT = "text/plain,text/markdown;q=0.9,*/*;q=0.5"
MIN_WORDS = 80
CREDIT = (
    "quangpao, biên soạn lại từ 高性价比人生指南 của eternity4719 (CC BY 4.0) · "
    "PureMind đã tách mục và lược định dạng · bản ngày {date}"
)

# The fields every entry has, in the order they are shown. "Pháp luật Việt Nam" is left out where no law applies.
FIELDS = ("Chi phí", "Nói dễ hiểu", "Lợi ích", "Pháp luật Việt Nam", "Mức bằng chứng", "Nguồn", "Ghi chú")
# The feed's topics for each chapter, by its number.
CHAPTER_TOPICS = {
    1: ["health"],
    2: ["health"],
    3: ["mind", "health"],
    4: ["mind"],
    5: ["economy"],
    6: ["health", "economy"],
    7: ["economy", "society"],
    8: ["law"],
    9: ["law"],
    10: ["family"],
    11: ["technology", "law"],
    12: ["economy", "law"],
    13: ["health"],
    14: ["technology"],
    15: ["economy", "law"],
    16: ["health"],
    17: ["family", "health"],
    18: ["family", "economy"],
    19: ["economy", "law"],
    20: ["family", "health"],
    21: ["travel"],
    22: ["society"],
    23: ["education"],
    24: ["health"],
    25: ["family", "law"],
    26: ["technology", "law"],
    27: ["health", "family"],
    28: ["health"],
    29: ["mind"],
    30: ["education", "family"],
    31: ["education", "economy"],
    32: ["education", "travel"],
    33: ["health", "society"],
    34: ["health"],
    35: ["environment", "health"],
    36: ["law"],
}

_HEADING = re.compile(r"^### (\d+)\. (.+)$", re.M)
_CHAPTER = re.compile(r"^# (\d+)\. (.+)$", re.M)
_ANCHOR = re.compile(r'<a name="entry-([^"]+)"[^>]*></a>')
_FIELD = re.compile(r"^- (" + "|".join(map(re.escape, FIELDS)) + r"): ?(.*)$")
_COMMENT = re.compile(r"<!--.*?-->", re.S)
# A Markdown link, with an optional title ("refs:…" in this book): the target is group 1.
_LINK = re.compile(r'\]\(([^)\s]+)(?:\s+"[^"]*")?\)')
_ENTRY_ID = re.compile(r"entry-([a-z0-9-]+)")


@dataclass(frozen=True)
class Pin:
    commit: str
    date: datetime
    picks: dict[str, list[str]]  # entry id -> its topics


@dataclass(frozen=True)
class Entry:
    id: str
    chapter: int
    number: int
    title: str
    chapter_title: str
    fields: dict[str, str]


def read_pin(path: Path = PICKS) -> Pin:
    data = json.loads(path.read_text(encoding="utf-8"))
    return Pin(
        commit=data["commit"],
        date=datetime.fromisoformat(data["commit_date"]).replace(tzinfo=UTC),
        picks={p["entry"]: [p["topic"]] if p.get("topic") else [] for p in data["picks"]},
    )


@dataclass(frozen=True)
class Brief:
    """What the editor asks of an entry's short: a title to start from and the limits it has to say."""

    title: str
    must_keep: list[str]


def read_briefs(path: Path = PICKS) -> dict[str, Brief]:
    data = json.loads(path.read_text(encoding="utf-8"))
    return {
        p["entry"]: Brief(title=p.get("feed_title", ""), must_keep=list(p.get("must_keep", [])))
        for p in data["picks"]
    }


def page_url(path: str, entry_id: str | None = None) -> str:
    """Where a reader finds the entry on GitHub: on the branch, so the address outlives the commit."""
    return f"{REPO_URL}/blob/{BRANCH}/{path}" + (f"#entry-{entry_id}" if entry_id else "")


def _absolute(target: str, path: str) -> str:
    """A link of the book's, made to work outside it: relative files point at GitHub, a bare #anchor at its
    own chapter."""
    if re.match(r"[a-z]+:", target):
        return target
    file, _, anchor = target.partition("#")
    resolved = posixpath.normpath(posixpath.join(posixpath.dirname(path), file)) if file else path
    return f"{REPO_URL}/blob/{BRANCH}/{resolved}" + (f"#{anchor}" if anchor else "")


def clean(text: str, path: str) -> str:
    text = _COMMENT.sub("", text)
    text = _ANCHOR.sub("", text)
    return _LINK.sub(lambda m: f"]({_absolute(m.group(1), path)})", text).strip()


def parse_chapter(markdown: str, path: str) -> list[Entry]:
    """The entries of one chapter file, each with its fields, links made absolute."""
    head = _CHAPTER.search(markdown)
    chapter, chapter_title = (int(head.group(1)), head.group(2).strip()) if head else (0, "")
    headings = list(_HEADING.finditer(markdown))
    entries = []
    for i, heading in enumerate(headings):
        end = headings[i + 1].start() if i + 1 < len(headings) else len(markdown)
        # A chapter may close with its own section after the last entry.
        block = re.split(r"^## ", markdown[heading.end() : end], maxsplit=1, flags=re.M)[0]
        anchor = _ANCHOR.search(block)
        if not anchor:
            continue
        fields: dict[str, str] = {}
        last = None
        for line in _COMMENT.sub("", block).splitlines():
            if found := _FIELD.match(line):
                last = found.group(1)
                fields[last] = found.group(2)
            elif last and line.strip() and not _ANCHOR.fullmatch(line.strip()):
                fields[last] += "\n" + line.strip()
        entries.append(
            Entry(
                id=anchor.group(1),
                chapter=chapter,
                number=int(heading.group(1)),
                title=heading.group(2).strip(),
                chapter_title=chapter_title,
                fields={k: clean(v, path) for k, v in fields.items() if v.strip()},
            )
        )
    return entries


def content_of(entry: Entry, pin: Pin) -> str:
    parts = [f"**{name}:** {entry.fields[name]}" for name in FIELDS if name in entry.fields]
    sync = pin.date.strftime("%d/%m/%Y")
    parts += [
        "---",
        f"*Mục {entry.chapter}.{entry.number}, chương “{entry.chapter_title}” của [{NAME}]({REPO_URL}), "
        f"giấy phép [{CC_BY[0]}]({CC_BY[1]}), bản ngày {sync} (commit {pin.commit[:7]}). PureMind đã tách mục "
        "này khỏi chương và bỏ phần định dạng nội bộ; lời văn giữ nguyên. Nội dung để tham khảo, không thay "
        "lời khuyên của bác sĩ, luật sư hay người tư vấn tài chính; luật, mức phạt và giá có thể đã đổi.*",
    ]
    return "\n\n".join(parts)


def entry_item(entry: Entry, path: str, pin: Pin, topics: list[str] | None = None) -> Item | None:
    content = content_of(entry, pin)
    if word_count(content) < MIN_WORDS or "Nói dễ hiểu" not in entry.fields:
        return None
    grade = entry.fields.get("Mức bằng chứng", "").strip().split(" ")[0]
    return Item(
        source=SOURCE,
        url=page_url(path, entry.id),
        title=entry.title,
        content=content,
        language="vi",
        kind="explainer",
        license=CC_BY[0],
        license_url=CC_BY[1],
        credit=CREDIT.format(date=pin.date.strftime("%d/%m/%Y")),
        topics=topics or CHAPTER_TOPICS.get(entry.chapter, ["society"]),
        authors="quangpao",
        summary=plain(entry.fields["Nói dễ hiểu"], 400),
        # A chapter's short name, before its colon: the whole title is often too long for a tag.
        tags=[f"mức bằng chứng {grade.lower()}" if grade else "", entry.chapter_title.split(":")[0]],
        published_at=pin.date,
    )


async def _text(path: str, pin: Pin, contact: str) -> str:
    url = RAW.format(repo=REPO, ref=pin.commit, path=path)
    return (await fetch(url, contact, ACCEPT_TEXT)).decode("utf-8")


async def _files(pin: Pin, contact: str) -> dict[str, str]:
    """Each entry's chapter file, from the book's own index at the pinned commit."""
    index = json.loads(await _text("data/entries.json", pin, contact))
    return {e["id"]: e["file"] for e in index["entries"]}


async def _items(wanted: dict[str, list[str]], pin: Pin, contact: str) -> list[Item]:
    files = await _files(pin, contact)
    by_file: dict[str, list[str]] = {}
    for entry_id in wanted:
        if entry_id in files:
            by_file.setdefault(files[entry_id], []).append(entry_id)
        else:
            log.warning("%s: no entry %s at %s", NAME, entry_id, pin.commit[:7])
    items = []
    for path, ids in by_file.items():
        try:
            entries = parse_chapter(await _text(path, pin, contact), path)
        except Exception as e:
            log.warning("%s %s: %s", NAME, path, reason(e))
            continue
        for entry in entries:
            if entry.id in ids and (item := entry_item(entry, path, pin, wanted[entry.id])):
                items.append(item)
    return items


async def collect(contact: str, channels: dict | None = None) -> list[Item]:
    pin = read_pin()
    return await _items(pin.picks, pin, contact)


def entry_id_in(url: str) -> str | None:
    """The entry an address points to: GitHub's page or raw file, or the handbook's site, with #entry-…."""
    parts = urlsplit(url)
    if (parts.hostname or "").lower() not in HOSTS:
        return None
    found = _ENTRY_ID.search(unquote(parts.fragment))
    return found.group(1) if found else None


async def from_link(url: str, contact: str, topics: list[str]) -> Item | None:
    entry_id = entry_id_in(url)
    if not entry_id:
        return None
    pin = read_pin()
    items = await _items({entry_id: topics or pin.picks.get(entry_id, [])}, pin, contact)
    return items[0] if items else None
