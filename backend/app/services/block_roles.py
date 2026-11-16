"""What a block of an extracted PDF is, when it is not the text to read (Clean Reader, SRS PM-CR-SRS-001 §3,
TSD §4.2): authors, affiliations, publisher lines and keywords (metadata); references, acknowledgements,
funding, declarations, contents and appendices (supplementary); running headers, page numbers, stamps and
rules (furniture).

`classify` works on the blocks of each page in reading order and gives a type, a confidence and a reason to
those it recognises; extraction moves a block out of the reading flow into the document's side store when
its confidence reaches AUTO_HIDE, and never deletes one. A block no rule is sure about stays in the text
(R3): every rule here is narrow on purpose.
"""

import re
import unicodedata
from typing import Protocol

CLASSIFIER = "rules-1"
AUTO_HIDE = 0.8  # proposed; to be tuned on the benchmark (TSD §4.3)

GROUPS = {
    "metadata": {"AUTHORS", "AFFILIATIONS", "KEYWORDS", "PUBLISHER_INFO", "BIOGRAPHY", "FRONT_MATTER"},
    "supplementary": {
        "REFERENCES", "ACKNOWLEDGEMENTS", "FUNDING", "CONFLICT_OF_INTEREST", "AUTHOR_CONTRIBUTIONS",
        "DATA_AVAILABILITY", "DECLARATION", "TABLE_OF_CONTENTS", "APPENDIX",
    },
    "furniture": {"RUNNING_HEADER", "RUNNING_FOOTER", "PAGE_NUMBER", "WATERMARK", "DECORATION"},
}  # fmt: skip
GROUP_OF = {t: g for g, types in GROUPS.items() for t in types}


class Block(Protocol):
    """extraction._Item, as far as the rules here read it."""

    bbox: tuple[float, float, float, float]
    text: str
    kind: str
    size: float
    role: str | None
    confidence: float
    reason: str


def mark(item: Block, role: str, confidence: float, reason: str) -> None:
    """Give a block a type, unless an earlier, more specific rule already did."""
    if item.role is None:
        item.role, item.confidence, item.reason = role, confidence, reason


def plain(text: str) -> str:
    """The words of a block without its Markdown."""
    text = re.sub(r"^#{1,6}\s+", "", text.strip())
    text = text.replace("**", "").replace("\\*", "*")
    return re.sub(r"\s+", " ", text).strip()


BOLD_ONLY = re.compile(r"^\*\*[^*]+\*\*$")
NUMBER = re.compile(r"^(?:\d{1,2}(?:\.\d{1,2})*\.?|[IVX]{1,4}\.|[A-Z]\.)\s+")


def heading(item: Block) -> tuple[int, str] | None:
    """(level, words) of a heading: a Markdown one, or a short paragraph set wholly in bold (level 7)."""
    if item.kind != "text":
        return None
    text = item.text.strip()
    if m := re.match(r"^(#{1,6})\s+(.*)$", text):
        return len(m.group(1)), plain(m.group(2))
    if BOLD_ONLY.match(text) and len(text) <= 120:
        return 7, plain(text)
    return None


def _name(words: str) -> str:
    """A heading's words for matching: no section number, no closing colon, lower case, no ligature ("ﬂ")."""
    words = unicodedata.normalize("NFKC", words).replace("’", "'")
    return NUMBER.sub("", words).strip().rstrip(".:").strip().lower()


# --- supplementary parts, found by their heading ---------------------------------------------------------

SUPPLEMENTARY = [
    ("REFERENCES", r"references?( cited)?|bibliography|literature cited|works cited|(danh mục )?tài liệu tham khảo"),
    ("ACKNOWLEDGEMENTS", r"acknowledge?ments?|lời c[ảá]m ơn"),
    ("FUNDING", r"funding( information| sources?| statement)?|financial support"),
    ("CONFLICT_OF_INTEREST",
     r"(declaration of )?(competing|conflicts?( of)?) interests?( statement)?|conflicts? of interest( statement)?"),
    ("AUTHOR_CONTRIBUTIONS", r"credit authorship contribution statement|authors?'? contributions?"),
    ("DATA_AVAILABILITY", r"(data|code|data and code) availability( statement)?|availability of data.*"),
    ("DECLARATION",
     r"ethics (approval|statement)|ethical (approval|statement|considerations)|ethics approval and consent.*"
     r"|informed consent( statement)?|institutional review board statement|publisher's note"
     r"|(generative ai|ai use) (statement|disclosure)|declaration of generative ai.*"),
    ("APPENDIX", r"(appendix|appendices|phụ lục)\b.*|supplementary (data|materials?|information)"),
]  # fmt: skip
SUPPLEMENTARY_RE = [(t, re.compile(p)) for t, p in SUPPLEMENTARY]
# A paragraph that opens with the part's name: "Acknowledgements. We thank…", "Funding: …" (MDPI, IEEE).
INLINE_PART = re.compile(
    r"^\**(acknowledge?ments?|funding|conflicts? of interest|competing interests?|data availability( statement)?"
    r"|author contributions?)\**\s*[.:—–]",
    re.I,
)
INLINE_TYPE = {
    "ack": "ACKNOWLEDGEMENTS", "fun": "FUNDING", "con": "CONFLICT_OF_INTEREST", "com": "CONFLICT_OF_INTEREST",
    "dat": "DATA_AVAILABILITY", "aut": "AUTHOR_CONTRIBUTIONS",
}  # fmt: skip
# The thanks a paper gives without a heading, just before its references.
THANKS = re.compile(
    r"^(the authors? (would like to |wish to )?(thank|acknowledge|express|are grateful|gratefully)"
    r"|we (would like to )?(thank|acknowledge|are grateful|gratefully)"
    r"|this (work|research|study|project) (was|is|has been) (partly |partially )?(supported|funded|financed))",
    re.I,
)


# An entry of a reference list: "Ater, T. (2017).", "[12] …", or the end of one carried over ("gov.au/…").
REFERENCE_ENTRY = re.compile(
    r"^(\[\d{1,3}\]\s|\d{1,3}\.\s+[A-ZÀ-Ỹ][^\s,]+,\s"
    r"|[A-ZÀ-Ỹ][^()]{1,150}\((19|20)\d\d[a-z]?(, [^)]{1,30})?\)"
    r"|(https?://|www\.|doi:)|[a-z][\w-]*(\.[a-z]{2,})+/\S)"
)


def supplementary(words: str) -> str | None:
    name = _name(words)
    return next((t for t, p in SUPPLEMENTARY_RE if p.fullmatch(name)), None)


# --- the first page of a paper ------------------------------------------------------------------------------

ABSTRACT = re.compile(r"^(\**\s*)?(abstract|a b s t r a c t|tóm tắt|summary)\b", re.I)
INTRODUCTION = re.compile(r"(introduction|background|giới thiệu|mở đầu|đặt vấn đề)")
PUBLISHER = re.compile(
    r"contents lists available|journal homepage|sciencedirect|www\.elsevier|a r t i c l e\s+i n f o"
    r"|article (info|history)|^received:?\s|received \d{1,2} \w+ \d{4}|^accepted:?\s|available online"
    r"|^published( online)?:?\s|^editor( name)?:|handling editor|^preprint\b|under review|©|\(c\) \d{4}"
    r"|creative commons|open access article|licensed under|all rights reserved|published by|^https?://doi\.org/\S+$"
    r"|^doi:|^issn\b|^citation:|^cite this|web of conferences \d",
    re.I,
)
KEYWORDS = re.compile(r"^\**\s*(keywords?|key words|index terms|từ khóa|từ khoá)\b", re.I)
AFFILIATION = re.compile(
    r"universit|institut|department|faculty|school of|college|laborator|cent(er|re)\b|hospital|academy"
    r"|\b(inc|ltd|gmbh|corp)\b|trường|viện|đại học",
    re.I,
)
CONTACT = re.compile(
    r"corresponding author|correspondence to|e-?mail\s*(address(es)?)?\s*:|\S+@\S+\.\w{2,}"
    r"|contributed equally|equal contribution|share (first|senior|last) authorship",
    re.I,
)
# The labels of a journal's sidebar on the first page (Frontiers): "EDITED BY", "*CORRESPONDENCE", "CITATION"…
SIDEBAR = re.compile(
    r"^\*?(open access|edited by|reviewed by|correspondence|citation|copyright|received|accepted|published"
    r"|specialty section|academic editor)$",
    re.I,
)
EDITORS = re.compile(r"^(edited|reviewed) by$|^academic editor$", re.I)
# Labels over one paragraph of their own in the sidebar: how to cite the paper, its licence, its keywords.
CITED = re.compile(r"^(citation|copyright|keywords?|key words)$", re.I)
# "1Columbia University", "a Institute of…", "¹ The University of Tokyo": a note mark, then the place.
MARKED = re.compile(r"^[\d¹²³⁴⁵⁶⁷⁸⁹⁰a-f*†‡§]{1,2}\s?[A-ZÀ-Ỹ]")
REPOSITORY = re.compile(
    r"white rose research online|eprints|deposited via|takedown|this is a repository copy|repository"
    r"|version: (published|accepted)|please notify us|downloaded from|\breuse\b",
    re.I,
)


def _author_like(text: str) -> bool:
    """A line of names: mostly capitalised words, commas or "and" between them, no sentence."""
    words = [w for w in re.findall(r"[^\W\d_][\w'’.-]*", text) if len(w) > 1]
    if not words or len(text) > 600 or re.search(r"[a-z]{3,}[.!?]\s+[A-Z]", text):
        return False
    names = sum(1 for w in words if w[0].isupper() or w in ("and", "và"))
    marked = re.search(r"[,*†‡¹²³⁴⁵⁶⁷⁸⁹⁰]| and | và ", text)  # between names, or their notes
    return names / len(words) >= 0.8 and bool(marked or len(words) <= 4)


def _metadata_type(text: str) -> tuple[str, float] | None:
    t = plain(text)
    if KEYWORDS.match(t):
        return "KEYWORDS", 0.95
    if SIDEBAR.match(t):
        return "PUBLISHER_INFO", 0.95
    if len(t) <= 400 and PUBLISHER.search(t):
        return "PUBLISHER_INFO", 0.9
    if len(t) <= 600 and MARKED.match(t) and AFFILIATION.search(t):  # "1Columbia University…", maybe an email
        return "AFFILIATIONS", 0.9
    if len(t) <= 600 and CONTACT.search(t) and len(t.split()) <= 40:
        return "AUTHORS", 0.9
    if (
        len(t) <= 600
        and AFFILIATION.search(t)
        and (MARKED.match(t) or not re.search(r"[a-z]{4,}\. [A-Z]", t))
    ):
        return "AFFILIATIONS", 0.85
    return None


def _title(items: list[Block], body_size: float) -> int | None:
    """Where the title is: of the runs of blocks in about the largest type, the one with the most words (a
    journal's name over a paper can be set a little larger than its title)."""
    sizes = [i.size if i.kind == "text" else 0 for i in items]
    if not sizes or max(sizes) < body_size * 1.15:
        return None
    top = max(sizes)
    runs: list[list[int]] = []
    for n, size in enumerate(sizes):
        if size >= top * 0.9:
            if runs and runs[-1][-1] == n - 1 and abs(sizes[runs[-1][-1]] - size) < 0.5:
                runs[-1].append(n)
            else:
                runs.append([n])
    best = max(runs, key=lambda r: sum(len(items[n].text) for n in r))
    return best[0]


def _title_run(items: list[Block], at: int | None) -> list[int]:
    """The blocks of a title that starts at `at`: it and those after it in the same type size."""
    if at is None:
        return []
    run = [at]
    while run[-1] + 1 < len(items) and abs(items[run[-1] + 1].size - items[at].size) < 0.5:
        run.append(run[-1] + 1)
    return run


def _paper_front(pages: list[list[Block]], heights: list[float], body_size: float) -> str | None:
    """Authors, affiliations and the journal's lines around the title of a paper. Returns the title."""
    first = next((n for n, items in enumerate(pages) if any(i.kind == "text" for i in items)), None)
    if first is None:
        return None
    # A repository's cover sheet (White Rose, eprints…) is a page of its own before the paper.
    words = " ".join(plain(i.text) for i in pages[first])
    if len(REPOSITORY.findall(words)) >= 2 and len(pages) > first + 1:
        for item in pages[first]:
            mark(item, "PUBLISHER_INFO", 0.9, "repository cover sheet")
        first = next((n for n in range(first + 1, len(pages)) if pages[n]), first)
    items, height = pages[first], heights[first]

    end = len(items)  # the first section heading (Introduction): metadata comes before it
    abstract = None
    for n, item in enumerate(items):
        h = heading(item)
        t = plain(item.text)
        if abstract is None and ABSTRACT.match(t) and len(t) < 3000:
            abstract = n
        if h and n > 0 and (re.match(r"^(1|I)\.?\s+[^\W\d_]", h[1]) or INTRODUCTION.fullmatch(_name(h[1]))):
            end = n
            break
    head = abstract if abstract is not None else (end if end < len(items) else None)
    title_at = _title(items[: head if head is not None else len(items)], body_size)
    run = _title_run(items, title_at)
    title = " ".join(plain(items[n].text) for n in run) or None

    if head is not None:
        # The names under "EDITED BY", "REVIEWED BY": the journal's, not the paper's. Only those in the
        # sidebar's column — the reading order may put the paper's own authors between them.
        label: Block | None = None
        for item in items[:end]:
            t = plain(item.text)
            if item.kind != "text":
                continue
            if SIDEBAR.match(t) or CITED.match(t):
                label = item if EDITORS.match(t) or CITED.match(t) else None
            elif label is not None and abs(item.bbox[0] - label.bbox[0]) < 12 and heading(item) is None:
                if CITED.match(name := plain(label.text)) and len(t) <= 800:
                    kind = "KEYWORDS" if name.lower().startswith("key") else "PUBLISHER_INFO"
                    mark(item, kind, 0.9, f"under “{name}” in the journal's sidebar")
                    label = None  # one paragraph
                elif len(t) <= 300 and (AFFILIATION.search(t) or _author_like(t)):
                    mark(item, "PUBLISHER_INFO", 0.9, "an editor or reviewer of the journal")
                else:
                    label = None
        for n, item in enumerate(items[:head]):
            if n in run:
                continue  # the title, maybe over several blocks
            typed = _metadata_type(item.text)
            if title_at is not None and n < title_at:
                # Over the title: the journal's banner, its logo, the issue.
                mark(item, *(typed or ("PUBLISHER_INFO", 0.85)), "above the title")
            elif typed:
                mark(item, *typed, "between the title and the abstract")
            elif item.kind == "text" and _author_like(plain(item.text)):
                mark(item, "AUTHORS", 0.85, "names under the title")
        for item in items[head:end]:  # the abstract stays; the article's info box around it does not
            if (typed := _metadata_type(item.text)) and typed[0] != "AFFILIATIONS":
                mark(item, *typed, "beside the abstract")

    # Notes at the foot of the first page: affiliations, the preprint line, contact details.
    for item in items:
        if item.kind != "text" or item.size >= body_size * 0.95 or item.bbox[1] < height * 0.55:
            continue
        t = plain(item.text)
        if typed := _metadata_type(t):
            mark(item, *typed, "note at the foot of the first page")
        elif MARKED.match(t) and AFFILIATION.search(t):
            mark(item, "AFFILIATIONS", 0.85, "note at the foot of the first page")
    # Without an abstract or a first section after it, the large type is only a heading (a chapter's): no title.
    return title if head is not None else None


# --- the front matter of a report or thesis ---------------------------------------------------------------

FRONT_PARTS = [
    ("DECLARATION", r"lời cam đoan|declaration( of (originality|authorship))?|statement of (originality|authorship)"),
    ("ACKNOWLEDGEMENTS", r"lời c[ảá]m ơn|acknowledge?ments?"),
    ("TABLE_OF_CONTENTS", r"mục lục|(table of )?contents|danh (mục|sách)\b.*|list of (figures|tables|abbreviations|symbols)\b.*"),
    (None, r"tóm tắt|abstract|summary|lời nói đầu|preface|foreword"),  # read: they stay in the text
]  # fmt: skip
FRONT_RE = [(t, re.compile(p)) for t, p in FRONT_PARTS]
BODY_START = re.compile(
    r"(lời )?mở đầu|chương (1|i)\b.*|chapter (1|one|i)\b.*|introduction|giới thiệu|đặt vấn đề"
)
COVER = [
    ("PUBLISHER_INFO", re.compile(r"trường|đại học|bộ giáo dục|khoa\b|ngành|chuyên ngành|universit|faculty|department|school of|hà nội|tp\.? hcm|\b20\d\d\b", re.I)),
    ("AUTHORS", re.compile(r"sinh viên|học viên|svth|gvhd|giảng viên|giáo viên|hướng dẫn|mssv|mã sinh viên|lớp\b|supervisor|student|advisor|^(ths|ts|pgs|gs)\.", re.I)),
]  # fmt: skip


def _front_part(words: str) -> tuple[bool, str | None]:
    name = _name(words)
    for t, p in FRONT_RE:
        if p.fullmatch(name):
            return True, t
    return False, None


def _report_front(pages: list[list[Block]], body_size: float) -> str | None:
    """A report's cover, declaration, thanks and contents, on the pages before its first chapter. Returns the
    title, or None when the document does not look like a report."""
    seen_front, start = False, None
    for n, items in enumerate(pages):
        for item in items:
            if not (h := heading(item)):
                continue
            if not seen_front and _front_part(h[1])[0] and _front_part(h[1])[1]:
                seen_front = True
            elif seen_front and BODY_START.fullmatch(_name(h[1])):
                start = n
                break
        if start is not None:
            break
    if start is None or start == 0 or start > len(pages) * 0.3 + 3:
        return None

    title_page = next((n for n in range(start) if any(i.kind == "text" for i in pages[n])), None)
    run = (
        _title_run(pages[title_page], _title(pages[title_page], body_size)) if title_page is not None else []
    )
    title = " ".join(plain(pages[title_page][k].text) for k in run) or None
    part: str | None = "cover"
    for n in range(start):
        for k, item in enumerate(pages[n]):
            if (h := heading(item)) and _front_part(h[1])[0]:
                part = _front_part(h[1])[1]
            if part == "cover":
                if n == title_page and k in run:
                    continue  # the title stays in the text
                t = plain(item.text)
                kind = next((c for c, p in COVER if p.search(t)), None)
                if (
                    kind is None
                    and item.kind == "text"
                    and t.isupper()
                    and len(t.split()) >= 2
                    and _author_like(t.title())
                ):
                    kind = "AUTHORS"
                mark(item, kind or "FRONT_MATTER", 0.9 if kind else 0.85, "cover page")
            elif part is not None:
                mark(item, part, 0.9, "front matter")
    return title


# --- everywhere -----------------------------------------------------------------------------------------------

DECORATION = re.compile(r"[-–—_=~*•·.\s]*(?:o0o|oOo|0o0)?[-–—_=~*•·.\s]*")


def classify(pages: list[list[Block]], heights: list[float], body_size: float) -> str | None:
    """Type the blocks of a document, page by page in reading order. Returns the title it found, if any."""
    for items in pages:
        for item in items:
            t = plain(item.text)
            if item.kind == "text" and len(t) >= 3 and DECORATION.fullmatch(t):
                mark(item, "DECORATION", 0.95, "a rule of dashes or dots")

    title = _report_front(pages, body_size)
    if title is None:
        title = _paper_front(pages, heights, body_size)

    flat = [item for items in pages for item in items]
    part: tuple[str, int] | None = None  # (type, heading level)
    references: int | None = None  # the heading level of the reference list, once it has started
    for n, item in enumerate(flat):
        if item.role is not None:
            continue  # typed already (front matter, the first page's metadata)
        if h := heading(item):
            level, words = h
            kind = supplementary(words)
            if kind == "REFERENCES" and n < len(flat) * 0.4:
                kind = None  # a "References" heading early on is not the list at the end
            if kind:
                part = (kind, level)
                if kind == "REFERENCES":
                    references = level
                mark(item, kind, 0.9, f"heading “{words}”")
                if kind == "REFERENCES":  # thanks given without a heading, just before the references
                    k = n - 1
                    while (
                        k >= 0
                        and flat[k].role is None
                        and not heading(flat[k])
                        and THANKS.match(plain(flat[k].text))
                    ):
                        funded = re.search(r"fund|grant|financ|support", flat[k].text, re.I)
                        mark(
                            flat[k],
                            "FUNDING" if funded else "ACKNOWLEDGEMENTS",
                            0.85,
                            "thanks before the references",
                        )
                        k -= 1
                continue
            if part and level <= part[1]:
                part = None  # the next section of the same rank: the part is over
        if (
            part
            and part[0] != "REFERENCES"
            and references is not None
            and item.kind == "text"
            and REFERENCE_ENTRY.match(plain(item.text))
        ):
            # Two columns: the list goes on after the parts set beside it (Frontiers puts the authors'
            # contributions and the notes in the right column, between two halves of the references).
            part = ("REFERENCES", references)
        if part:
            mark(item, part[0], 0.95 if part[0] == "REFERENCES" else 0.9, "in the part it is under")
        elif item.kind == "text" and (m := INLINE_PART.match(plain(item.text))):
            mark(item, INLINE_TYPE[m.group(1).lower()[:3]], 0.9, f"opens with “{m.group(1)}”")
    return title
