"""PDF content extraction with PyMuPDF (SRS FR-DOC-02, CON-04).

Embedded raster images are saved next to the document as WebP and referenced in the text as
`![](pm-image:<name>.webp)`, which the reader loads through the ownership-checked images route.
"""

import hashlib
import io
import itertools
import re
import statistics
from collections import defaultdict
from dataclasses import dataclass, field
from itertools import pairwise
from pathlib import Path
from typing import NamedTuple

import pymupdf
from PIL import Image, ImageFilter, ImageStat

from app.services import chart_data, math_glyphs

PAGE_SEPARATOR = "\n\n---\n\n"
BOLD_FLAG = 1 << 4
# Text flags plus image blocks (TEXTFLAGS_TEXT leaves images out).
DICT_FLAGS = pymupdf.TEXTFLAGS_DICT

MIN_IMAGE_SIDE = 64  # px; smaller ones are icons, bullets and rules
REPEATED_ON_PAGES = 3  # an image on this many pages is a logo or a background
MAX_IMAGES = 200
MAX_IMAGE_BYTES = 40 * 1024 * 1024  # written per document
MAX_IMAGE_EDGE = 1600
# Mean edge strength (0-255) below which an image is a flat fill, a gradient or a transparency mask rather
# than a figure: measured decorations score under 4, charts and diagrams over 12.
MIN_DETAIL = 5
IMAGE_NAME = re.compile(r"^[0-9a-f]{16}\.webp$")


class ExtractionError(Exception):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code  # MSG-13 | MSG-14 | MSG-15


@dataclass
class ExtractionResult:
    title: str | None
    content: str
    page_count: int | None
    word_count: int
    # Saved images that are tables (a picture by a "Table N" caption), for table_ocr to turn into text.
    table_images: list[str] = field(default_factory=list)
    # Saved pictures of numbered display equations -> their number, for equation_ocr to turn into LaTeX.
    equation_images: dict[str, str] = field(default_factory=dict)
    # Saved pictures of vector charts -> their data, read from the drawing (see Document.chart_data).
    charts: dict[str, dict] = field(default_factory=dict)
    # [[block key, [[page, x, y, w, h], …]], …]: where each block is on the PDF (see Document.source_map).
    source_map: list = field(default_factory=list)
    # Pages that are scans (a picture of the page, no text to read), numbered from 1: each one stands in the
    # content as its OCR_MARK line until page_ocr reads it.
    ocr_pages: list[int] = field(default_factory=list)


def _digest(block: dict) -> str:
    # The mask is part of the picture: tables are often a blank image drawn through different masks.
    return hashlib.sha1(block["image"] + (block.get("mask") or b"")).hexdigest()[:16]


def _open_image(block: dict) -> Image.Image:
    """The image as it looks on the page: one with a soft mask (transparency drawn from another image) is laid
    over white, since the base image alone is often a flat fill and the mask carries the actual content."""
    img = Image.open(io.BytesIO(block["image"]))
    if not block.get("mask"):
        return img
    with Image.open(io.BytesIO(block["mask"])) as mask:
        alpha = mask.convert("L").resize(img.size)
    white = Image.new("RGB", img.size, "white")
    return Image.composite(img.convert("RGB"), white, alpha)


@dataclass
class ImageSink:
    """Saves the images worth keeping and names them; `pages` says on how many pages each one appears."""

    directory: Path | None
    pages: dict[str, set[int]] = field(default_factory=lambda: defaultdict(set))
    written: dict[str, str | None] = field(default_factory=dict)  # digest -> file name, None if rejected
    total_bytes: int = 0
    equations: dict[str, str] = field(default_factory=dict)  # file name -> the equation's number
    charts: dict[str, dict] = field(default_factory=dict)  # file name -> the chart's data (chart_data)

    def note(self, block: dict, page_number: int) -> None:
        if self.directory is not None and block.get("image"):
            self.pages[_digest(block)].add(page_number)

    def markdown(self, block: dict) -> str | None:
        """The Markdown line for an image block, or None when it is left out."""
        data = block.get("image")
        if self.directory is None or not data:
            return None
        digest = _digest(block)
        if digest not in self.written:
            self.written[digest] = self._save(block, digest)
        name = self.written[digest]
        return f"![](pm-image:{name})" if name else None

    def rendered(self, page: "pymupdf.Page", rect: "pymupdf.Rect", dpi: int | None = None) -> str | None:
        """The Markdown line for a part of the page drawn as a picture (a chart made of vector paths)."""
        if self.directory is None or self._full():
            return None
        try:
            pix = page.get_pixmap(clip=rect, dpi=dpi or FIGURE_DPI, alpha=False)
            img = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
        except Exception:
            return None
        digest = hashlib.sha1(pix.samples).hexdigest()[:16]
        if digest not in self.written:
            self.written[digest] = self._write(img, digest)
        name = self.written[digest]
        return f"![](pm-image:{name})" if name else None

    def _full(self) -> bool:
        kept = sum(1 for n in self.written.values() if n)
        return kept >= MAX_IMAGES or self.total_bytes >= MAX_IMAGE_BYTES

    def _save(self, block: dict, digest: str) -> str | None:
        if min(block.get("width", 0), block.get("height", 0)) < MIN_IMAGE_SIDE:
            return None
        if len(self.pages[digest]) >= REPEATED_ON_PAGES or self._full():
            return None
        try:
            with _open_image(block) as img:
                if _detail(img) < MIN_DETAIL:
                    return None
                return self._write(img, digest)
        except Exception:  # an image Pillow cannot read is left out, not the whole document
            return None

    def _write(self, img: Image.Image, digest: str) -> str | None:
        try:
            img = img.convert("RGBA" if img.mode in ("RGBA", "LA", "P") else "RGB")
            img.thumbnail((MAX_IMAGE_EDGE, MAX_IMAGE_EDGE))
            out = io.BytesIO()
            img.save(out, "WEBP", quality=80)
        except Exception:
            return None
        name = f"{digest}.webp"
        self.directory.mkdir(parents=True, exist_ok=True)
        (self.directory / name).write_bytes(out.getvalue())
        self.total_bytes += out.tell()
        return name


def _detail(img: Image.Image) -> float:
    gray = img.convert("L")
    gray.thumbnail((256, 256))
    if min(gray.size) < 8:
        return 0.0
    # The edge filter sees the image border as an edge; leave it out.
    edges = gray.filter(ImageFilter.FIND_EDGES).crop((2, 2, gray.width - 2, gray.height - 2))
    return ImageStat.Stat(edges).mean[0]


def _heading_prefix(size: float, body: float) -> str:
    if body <= 0:
        return ""
    ratio = size / body
    if ratio >= 1.8:
        return "# "
    if ratio >= 1.45:
        return "## "
    if ratio >= 1.2:
        return "### "
    return ""


# Adobe's Symbol font puts Greek letters and math signs on ASCII codes; PDFs carry them either as those codes
# or shifted into the private use area (U+F0xx), which no other font can show. Capitals that look Latin
# stay Latin, so "M" is still found by a search for M.
SYMBOL_CHARS = dict(
    zip(
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz",
        "ABXΔEΦΓHIϑKΛMNOΠΘPΣTYςΩΞΨZαβχδεφγηιϕκλμνοπθρστυϖωξψζ",
        strict=True,
    )
)
SYMBOL_CHARS.update(
    {
        "\x22": "∀", "\x24": "∃", "\x27": "∋", "\x2a": "∗", "\x2d": "−", "\x40": "≅", "\x5e": "⊥",
        "\xa2": "′", "\xa3": "≤", "\xa5": "∞", "\xac": "←", "\xad": "↑", "\xae": "→", "\xaf": "↓",
        "\xb0": "°", "\xb1": "±", "\xb2": "″", "\xb3": "≥", "\xb4": "×", "\xb6": "∂", "\xb7": "•",
        "\xb8": "÷", "\xb9": "≠", "\xba": "≡", "\xbb": "≈", "\xbc": "…", "\xc6": "∅", "\xce": "∈",
        "\xd1": "∇", "\xd6": "√", "\xe5": "∑", "\xf2": "∫",
    }
)  # fmt: skip


def _symbol_text(text: str, symbol_font: bool) -> str:
    out = []
    for ch in text:
        code = ord(ch)
        if 0xF020 <= code <= 0xF0FF:  # a Symbol (or dingbat) glyph shifted into the private use area
            ch = chr(code - 0xF000)
            mapped = SYMBOL_CHARS.get(ch)
            if mapped:
                out.append(mapped)
            elif symbol_font and ch.isascii() and ch.isprintable():
                out.append(ch)
        elif symbol_font:
            out.append(SYMBOL_CHARS.get(ch, ch))
        else:
            out.append(ch)
    return "".join(out)


SUPERSCRIPT_FLAG = 1
SUPERSCRIPTS = str.maketrans("0123456789+-−=()ni", "⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁻⁼⁽⁾ⁿⁱ")
# What else a raised run may hold and still be read as a superscript: "1,*" after an author's name.
SUPERSCRIPT_OK = set("0123456789+-−=()ni,* ")


def _span_text(span: dict) -> str:
    text = _symbol_text(span["text"], "symbol" in span["font"].lower())
    # A raised run of digits and signs is an exponent, a charge or a note mark: cm³, Na⁺, Hiraga¹.
    if span["flags"] & SUPERSCRIPT_FLAG and text.strip() and set(text) <= SUPERSCRIPT_OK:
        return text.translate(SUPERSCRIPTS)
    return text


@dataclass
class _Line:
    runs: list[tuple[str, bool]]  # (text, bold)
    size: float  # the size most of its characters are set in
    bbox: tuple[float, float, float, float]
    spans: list[tuple[float, float]] = field(default_factory=list)  # x0, x1 of each run
    baseline: float | None = None  # where the letters sit: a tall math glyph stretches the box, not this

    @property
    def middle(self) -> float:
        """The height of the line's text on the page."""
        if self.baseline is None:
            return (self.bbox[1] + self.bbox[3]) / 2
        return self.baseline - self.size * 0.3

    @property
    def text(self) -> str:
        return "".join(t for t, _ in self.runs)


@dataclass
class _Item:
    """A paragraph, heading, table or image on a page, placed by its box."""

    bbox: tuple[float, float, float, float]
    text: str
    # "text" | "table" | "image" | "equation" | "note" (a footnote, read at the end of its page) | "ocr"
    kind: str = "text"


CAPTION = re.compile(r"^\**\s*(Fig\.|Figure|Table|Tab\.|Hình|Bảng)\s*\d", re.I)
NUMBERED_HEADING = re.compile(r"^(\d{1,2}(?:\.\d{1,2}){0,3})\.?\s*([^\W\d_].*)$")
NAMED_HEADINGS = {
    "abstract", "introduction", "background", "related work", "method", "methods", "methodology",
    "materials and methods", "results", "discussion", "results and discussion", "conclusion", "conclusions",
    "acknowledgement", "acknowledgements", "acknowledgment", "acknowledgments", "references", "bibliography",
    "appendix", "tóm tắt", "mở đầu", "giới thiệu", "kết luận", "tài liệu tham khảo", "lời cảm ơn",
}  # fmt: skip
MAX_HEADING_CHARS = 120


def _lines(block: dict) -> list[_Line]:
    lines = []
    for line in block["lines"]:
        if abs(line["dir"][1]) > 0.1:  # rotated text: a margin stamp ("arXiv:… 27 Feb 2026"), an axis label
            continue
        runs: list[tuple[str, bool]] = []
        spans: list[tuple[float, float]] = []
        weights: dict[float, int] = defaultdict(int)
        prev_x1: float | None = None
        for span in line["spans"]:
            text = _span_text(span)
            if not text:
                continue
            # Some PDFs place words side by side without a space character between them.
            gap = span["bbox"][0] - prev_x1 if prev_x1 is not None else 0
            if (
                runs
                and gap > span["size"] * 0.2
                and not runs[-1][0].endswith(" ")
                and not text.startswith(" ")
            ):
                text = " " + text
            prev_x1 = span["bbox"][2]
            runs.append((text, bool(span["flags"] & BOLD_FLAG)))
            spans.append((span["bbox"][0], span["bbox"][2]))
            if text.strip():
                weights[round(span["size"], 1)] += len(text.strip())
        if weights:
            size = max(weights, key=lambda k: weights[k])
            origins = [
                s["origin"][1] for s in line["spans"] if s["text"].strip() and round(s["size"], 1) == size
            ]
            baseline = statistics.median(origins) if origins else None
            lines.append(_Line(runs, size, tuple(line["bbox"]), spans, baseline))
    return lines


def _paragraphs(lines: list[_Line]) -> list[list[_Line]]:
    """Split a block where the type size changes or a caption starts: PyMuPDF often puts a figure caption and
    the body text under it, or a title and its authors, in one block."""
    groups: list[list[_Line]] = []
    for line in lines:
        if groups:
            prev = groups[-1][-1]
            # A gap of about a line's height: the end of a table cell or of a paragraph, not a line break.
            gap = line.bbox[1] - prev.bbox[3]
            if (
                abs(line.size - prev.size) <= 0.6
                and gap < max(line.size, prev.size) * 0.9
                and not CAPTION.match(line.text.strip())
            ):
                groups[-1].append(line)
                continue
        groups.append([line])
    return groups


def _markdown_runs(lines: list[_Line]) -> str:
    """The lines joined into one paragraph, bold kept as **…** around whole runs (not around each span)."""
    runs: list[list] = []  # [text, bold]
    for i, line in enumerate(lines):
        for n, (text, bold) in enumerate(line.runs):
            if n == 0 and i > 0:
                before = runs[-1][0].rstrip() if runs else ""
                # "water-" + "saturated": the hyphen stays, the line break does not become a space.
                joiner = "" if before.endswith("-") and text.lstrip()[:1].islower() else " "
                text = joiner + text.lstrip()
            if runs and (runs[-1][1] == bold or not text.strip()):
                runs[-1][0] += text
            elif runs and not runs[-1][0].strip():
                runs[-1] = [runs[-1][0] + text, bold]
            else:
                runs.append([text, bold])
    out = []
    for text, bold in runs:
        core = text.strip()
        if bold and core:
            lead = text[: len(text) - len(text.lstrip())]
            trail = text[len(text.rstrip()) :]
            out.append(f"{lead}**{core}**{trail}")
        else:
            out.append(text)
    return re.sub(r"[ \t]+", " ", "".join(out)).strip()


def _heading(lines: list[_Line], text: str, body_size: float) -> str | None:
    """A Markdown heading for the paragraph, or None when it is body text."""
    plain = re.sub(r"\s+", " ", text.replace("**", "")).strip()
    size = max(line.size for line in lines)
    if prefix := _heading_prefix(size, body_size):
        return prefix + plain
    if len(lines) > 2 or len(plain) > MAX_HEADING_CHARS:
        return None
    bold = all(b for line in lines for t, b in line.runs if t.strip())
    if not (bold or size >= body_size * 1.1):
        return None
    if m := NUMBERED_HEADING.match(plain):  # "2.1 Experimental methods"
        number, title = m.groups()
        if title.endswith(".") or not title[0].isupper():
            return None
        return ("## " if "." not in number else "### ") + f"{number} {title}"
    if plain.rstrip(".:").lower() in NAMED_HEADINGS:
        return "## " + plain.rstrip(".:")
    return None


def _inside(bbox, rects) -> bool:
    x0, y0, x1, y1 = bbox
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    return any(r.x0 <= cx <= r.x1 and r.y0 <= cy <= r.y1 for r in rects)


EQUATION_NUMBER = re.compile(r"^\((\d{1,3}[a-z]?)\)$")  # "(3)", "(12b)"; "(2013)" is a year
EQUATION_DPI = 300  # a subscript must stay legible
EQUATION_REACH = 1.6  # type sizes over or under its number: the rows of a stacked fraction
EQUATION_WIDTH = 0.7  # of the page: how far left of its number an equation can start (not the other column)
EQUATION_LINE = 80  # characters; a longer line is running text
# A mathematical character: an operator or relation, a Greek letter, or one of the italic letters of
# Unicode's mathematical alphabets that Word and LaTeX set variables in.
MATH = re.compile(r"[=<>≤≥≈≠∝±∓×÷∙·√∑∏∫∂∇∞\u0370-\u03ff\U0001d400-\U0001d7ff]")
PROSE = re.compile(r"(?:\b[a-z]{3,}\b[^\w\n]+){3}[a-z]{3,}")  # four words of running text


@dataclass
class _Number:
    line: _Line
    tag: str


def _tight(line: _Line) -> tuple[float, float]:
    """The top and bottom of a line's letters: a math font's box is several lines tall."""
    base = line.baseline if line.baseline is not None else line.bbox[3] - line.size * 0.25
    return base - line.size, base + line.size * 0.35


def _bold(line: _Line) -> bool:
    return any(bold for text, bold in line.runs if text.strip())


def _equations(
    lines: list[_Line], taken: list["pymupdf.Rect"], area: "pymupdf.Rect"
) -> list[tuple["pymupdf.Rect", _Number, list[_Line]]]:
    """Display equations with their number: the lines of mathematics left of a "(n)" at the end of a column,
    and the box that holds them, half way to the text over and under them."""
    free = [ln for ln in lines if not _inside(ln.bbox, taken)]
    numbers = [
        _Number(ln, m.group(1))
        for ln in free
        if (m := EQUATION_NUMBER.match(ln.text.strip())) and not _bold(ln)
    ]
    if not numbers:
        return []
    groups: dict[int, list[_Line]] = defaultdict(list)
    for ln in free:
        text = ln.text.strip()
        if not text or len(text) > EQUATION_LINE or PROSE.search(text) or _bold(ln):
            continue  # running text, or a bold heading, beside an equation is not part of it
        if any(ln is n.line for n in numbers):
            continue
        near = [
            n
            for n in numbers
            if ln.bbox[2] <= n.line.bbox[0] + 1
            and ln.bbox[0] >= n.line.bbox[2] - area.width * EQUATION_WIDTH
            and abs(ln.middle - n.line.middle) <= EQUATION_REACH * n.line.size
        ]
        if near:  # the number it belongs to is the nearest one to its right
            groups[id(min(near, key=lambda n: n.line.bbox[0] - ln.bbox[2]))].append(ln)
    found = []
    for number in numbers:
        group = groups.get(id(number), [])
        if not group or not MATH.search(" ".join(ln.text for ln in group)):
            continue
        x0, x1 = min(ln.bbox[0] for ln in group), max(ln.bbox[2] for ln in group)
        top, bottom = min(_tight(ln)[0] for ln in group), max(_tight(ln)[1] for ln in group)
        y0, y1 = top - number.line.size * 1.5, bottom + number.line.size * 1.5
        for other in free:
            if other in group or other.bbox[2] <= x0 or other.bbox[0] >= x1:
                continue
            o_top, o_bottom = _tight(other)
            if o_bottom <= top:
                y0 = max(y0, (o_bottom + top) / 2)
            elif o_top >= bottom:
                y1 = min(y1, (bottom + o_top) / 2)
        y0 = max(y0, min(ln.bbox[1] for ln in group))
        y1 = min(y1, max(ln.bbox[3] for ln in group))
        rect = pymupdf.Rect(x0 - 2, y0, x1 + 2, y1) & area
        if not rect.is_empty and not any(rect.intersects(r) for r in taken):
            found.append((rect, number, group))
    return found


def _page_items(page: "pymupdf.Page", body_size: float, images: ImageSink) -> list[_Item]:
    items: list[_Item] = []

    data = page.get_text("dict", flags=DICT_FLAGS)
    # Word's subscripts come out as glyph numbers (boxes in the reader): their letters, for everything below.
    math_fixes = math_glyphs.repair(data["blocks"])
    blocks = _stack_images(data["blocks"])
    block_lines = {id(b): _lines(b) for b in blocks if b["type"] == 0}
    page_lines = [line for lines in block_lines.values() for line in lines]

    ruled: list[tuple[pymupdf.Rect, str]] = []
    grids: list[tuple[pymupdf.Rect, str]] = []
    figures: list[pymupdf.Rect] = []
    # find_tables' default "lines" strategy needs ruling lines; skipping pages without vector drawings
    # avoids its (expensive) character analysis on plain text pages (NFR-PERF-06).
    if len(page.get_cdrawings()) >= 2:
        drawings = page.get_drawings()
        # A captioned table is read from its rules and its text: find_tables often takes the caption, or
        # the text over the table, for its header, and merges two tables near each other into one grid.
        ruled = _ruled_tables(page_lines, drawings)
        taken = [rect for rect, _ in ruled]
        pictures = [pymupdf.Rect(b["bbox"]) for b in blocks if b["type"] == 1]
        figures = _vector_figures(page, drawings, _page_labels(blocks, page), body_size, taken, pictures)
        # find_tables is the slow part of a page; it only runs while there are rules left to read.
        rest = [d for d in drawings if not _inside(tuple(d["rect"]), taken + figures)]
        try:
            found = list(page.find_tables().tables) if len(rest) >= 2 else []
        except Exception:  # table detection is best effort
            found = []
        for t in found:
            rect = pymupdf.Rect(t.bbox)
            # A chart's gridlines read as a table are part of the chart.
            if any(rect.intersects(r) for r in taken + figures):
                continue
            if md := _grid_markdown(t):
                # find_tables reads the page's characters again, as the PDF gives them.
                for before, after in sorted(set(math_fixes), key=lambda f: -len(f[0])):
                    md = md.replace(before, after)
                grids.append((rect, md))
    table_rects = [rect for rect, _ in ruled + grids]
    for rect, md in ruled + grids:
        items.append(_Item(tuple(rect), md, "table"))
    for rect in figures:
        if line := images.rendered(page, rect):
            items.append(_Item(tuple(rect), line, "image"))
            # A chart drawn as paths keeps its data points; read them while the drawing is at hand.
            if chart := chart_data.digitize(blocks, drawings, rect):
                images.charts[IMAGE_LINE.match(line).group(1)] = chart
    # The text of a chart (ticks, axis titles, a legend) is in its picture.
    table_rects += figures

    # A numbered display equation is kept as a picture of it, which equation_ocr turns into LaTeX: its text
    # layer (math fonts, stretched delimiters, stacked fractions) does not read back as the equation.
    in_equations: set[int] = set()
    for rect, number, group in _equations(page_lines, table_rects, page.rect):
        if line := images.rendered(page, rect, EQUATION_DPI):
            images.equations[IMAGE_LINE.match(line).group(1)] = number.tag
            items.append(_Item(tuple(rect), line, "equation"))
            in_equations.update(id(x) for x in [number.line, *group])

    for block in blocks:
        if block["type"] == 1:
            if _inside(block["bbox"], figures):
                continue  # a picture placed inside a chart is in the chart's picture
            if line := images.markdown(block):
                items.append(_Item(tuple(block["bbox"]), line, "image"))
            continue
        # Line by line: a table's last row and the paragraph under it can share a block.
        lines = [
            line
            for line in block_lines[id(block)]
            if not _inside(line.bbox, table_rects) and id(line) not in in_equations
        ]
        for group in _paragraphs(lines):
            text = _markdown_runs(group)
            if not text:
                continue
            bbox = (
                min(line.bbox[0] for line in group),
                min(line.bbox[1] for line in group),
                max(line.bbox[2] for line in group),
                max(line.bbox[3] for line in group),
            )
            size = max(line.size for line in group)
            text = CONTACT_SENTENCE.sub("", text).strip()
            if not text:
                continue
            if BOILERPLATE.search(text) and (
                bbox[1] > page.rect.height * 0.8 or bbox[3] < page.rect.height * 0.1
            ):
                continue  # the publisher's copyright and licence line at the foot of a page is not the text
            if FOOTNOTE.match(text) and size < body_size * 0.95 and bbox[1] > page.rect.height * 0.6:
                if CONTACT.search(text):
                    continue  # "* Corresponding author: name@…": contact details, not part of the paper
                # "* Equal contribution" would otherwise sit between the two columns' text; the
                # escape keeps the mark from being read as a list bullet.
                items.append(_Item(bbox, re.sub(r"^\*", r"\\*", text), "note"))
                continue
            items.append(_Item(bbox, _heading(group, text, body_size) or text))
    return items


TABLE_CAPTION = re.compile(r"^\**\s*(Table|Tab\.|Bảng)\s*\d", re.I)
RULE_THICKNESS = 2.0  # points; thicker is a filled box, not a rule
CAPTION_TO_RULE = 30.0  # the table's first rule sits this close under (or its last over) its caption
# Between two rules of one table: a booktabs table's body, all its rows, sits between two rules.
MAX_ROW_HEIGHT = 600.0
ROW_GAP = 0.15  # of the type size: the extra blank space that parts two rows without a rule between them
COLUMN_GAP = 6.0  # blank space between two columns of a table without vertical rules
MAX_COLUMNS = 8


def _horizontal_rules(drawings: list[dict]) -> list[tuple[float, float, float]]:
    """(y, x0, x1) of each horizontal rule, with the pieces a rule is often drawn in joined up."""
    pieces = []
    for drawing in drawings:
        for item in drawing["items"]:
            if item[0] == "l" and abs(item[1].y - item[2].y) <= 1:
                pieces.append((item[1].y, min(item[1].x, item[2].x), max(item[1].x, item[2].x)))
            elif item[0] == "re" and item[1].height <= RULE_THICKNESS and item[1].width > 0:
                r = item[1]
                pieces.append(((r.y0 + r.y1) / 2, r.x0, r.x1))
    rules: list[list[float]] = []
    for y, x0, x1 in sorted(pieces, key=lambda r: (round(r[0]), r[1])):
        last = rules[-1] if rules else None
        if last and abs(last[0] - y) <= 1.5 and x0 <= last[2] + 2:
            last[2] = max(last[2], x1)
        else:
            rules.append([y, x0, x1])
    return [(y, x0, x1) for y, x0, x1 in rules if x1 - x0 >= 60]


def _ruled_tables(lines: list[_Line], drawings: list[dict]) -> list[tuple["pymupdf.Rect", str]]:
    """Tables drawn with horizontal rules only (the usual style in papers), which find_tables misses.

    Only a table with a caption ("Table 1.") next to its first or last rule is rebuilt: rows are the bands
    between rules, columns the blank gaps between the text.
    """
    captions = [line for line in lines if TABLE_CAPTION.match(line.text.strip())]
    if not captions:
        return []
    rules = _horizontal_rules(drawings)
    found = []
    for caption in captions:
        cx0, cy0, cx1, cy1 = caption.bbox
        middle, width = (cx0 + cx1) / 2, cx1 - cx0
        # Rules under the caption's middle and at least most of its width (an underline in a cell is not one).
        near = [r for r in rules if r[1] - 3 <= middle <= r[2] + 3 and r[2] - r[1] >= width * 0.6]
        below = [r for r in near if cy1 - 2 <= r[0] <= cy1 + CAPTION_TO_RULE]
        above = [r for r in near if cy0 - CAPTION_TO_RULE <= r[0] <= cy0 + 2]
        for start, step in ((below, 1), (above, -1)):
            if not start:
                continue
            first = max(start, key=lambda r: r[2] - r[1])  # the table's own rule, not an underline in it
            group = [first]
            ordered = sorted(rules, key=lambda r: r[0] * step)
            for rule in ordered[ordered.index(first) + 1 :]:
                same = abs(rule[1] - first[1]) <= 4 and abs(rule[2] - first[2]) <= 4
                top, bottom = sorted((rule[0], group[-1][0]))
                # Another table's caption between two rules: the rules past it are that table's.
                if same and any(top < (c.bbox[1] + c.bbox[3]) / 2 < bottom for c in captions):
                    break
                if same and bottom - top <= MAX_ROW_HEIGHT:
                    group.append(rule)
                elif same:
                    break
            if len(group) < 2:
                continue
            ys = sorted(r[0] for r in group)
            rect = pymupdf.Rect(first[1] - 2, ys[0] - 1, first[2] + 2, ys[-1] + 1)
            if any(rect.intersects(f[0]) for f in found):
                break
            md = _table_markdown(lines, rect, ys)
            if md:
                found.append((rect, md))
            break
    return found


CELL_ITEM = re.compile(r"^(?:\d{1,2}[.)]|[•\-–])\s")


def _cell_markdown(lines: list[_Line]) -> str:
    """A cell's lines joined up, except that each item of a list in the cell starts on a line of its own."""
    items: list[list[_Line]] = []
    for line in lines:
        if not items or CELL_ITEM.match(line.text.strip()):
            items.append([line])
        else:
            items[-1].append(line)
    return "<br>".join(_markdown_runs(item).replace("|", "\\|") for item in items)


def _spaced_rows(band: list[_Line]) -> list[list[_Line]]:
    """A band of rows with cells of several lines and no rules between them (the body of a booktabs table),
    split where the space across the whole width is clearly wider than between the lines of a cell (which can
    overlap, a negative space). Evenly spaced lines give one group: whether they are rows or one row's lines
    is not told by spacing."""
    groups: list[list[_Line]] = []
    gaps: list[float] = []
    bottom = 0.0
    for line in sorted(band, key=lambda ln: ln.bbox[1]):
        # Lines side by side (the cells of one row) start one group.
        if groups and abs(line.bbox[1] - groups[-1][-1].bbox[1]) <= 1:
            groups[-1].append(line)
        else:
            if groups:
                gaps.append(line.bbox[1] - bottom)
            groups.append([line])
        bottom = line.bbox[3] if len(groups) == 1 and len(groups[0]) == 1 else max(bottom, line.bbox[3])
    if not gaps:
        return [band]
    size = statistics.median(line.size for line in band)
    step = min(gaps) + max(1.5, size * ROW_GAP)
    rows = [groups[0]]
    for gap, group in zip(gaps, groups[1:], strict=True):
        if gap >= step:
            rows.append(group)
        else:
            rows[-1].extend(group)
    return rows


def _table_markdown(lines: list[_Line], rect: "pymupdf.Rect", ys: list[float]) -> str | None:
    inside = [line for line in lines if _inside(line.bbox, [rect]) and line.text.strip()]
    if not inside:
        return None
    # A band holding lines as wide as the table is running text: the rules were not a table's.
    if sum(1 for line in inside if line.bbox[2] - line.bbox[0] >= rect.width * 0.92) >= 2:
        return None

    # Columns: the horizontal stretches covered by text, separated by blank gaps.
    covered: list[list[float]] = []
    for x0, x1 in sorted(
        (x0, x1)
        for line in inside
        for (x0, x1), (t, _) in zip(line.spans, line.runs, strict=True)
        if t.strip()
    ):
        if covered and x0 <= covered[-1][1] + COLUMN_GAP:
            covered[-1][1] = max(covered[-1][1], x1)
        else:
            covered.append([x0, x1])
    if not 2 <= len(covered) <= MAX_COLUMNS:
        return None
    bounds = [(a[1] + b[0]) / 2 for a, b in pairwise(covered)]

    def column(x0: float, x1: float) -> int:
        return sum(1 for b in bounds if (x0 + x1) / 2 > b)

    def cells(band: list[_Line]) -> list[str]:
        parts: list[list[_Line]] = [[] for _ in covered]
        for line in sorted(band, key=lambda ln: (round(ln.middle), ln.bbox[0])):
            by_column: dict[int, list] = defaultdict(list)
            for box, run in zip(line.spans, line.runs, strict=True):
                by_column[column(*box)].append((box, run))
            for n, pieces in by_column.items():
                parts[n].append(
                    _Line([r for _, r in pieces], line.size, line.bbox, [b for b, _ in pieces], line.baseline)
                )
        return [_cell_markdown(p) for p in parts]

    rows = []
    for top, bottom in pairwise(ys):
        band = [line for line in inside if top <= line.middle <= bottom]
        if not band:
            continue
        # A band of one-line cells side by side (several data rows between two rules) is split into
        # rows; a band with a cell of several lines stays one row. The first band is the header.
        heights: dict[int, list[_Line]] = defaultdict(list)
        for line in band:
            heights[round(line.middle / 2)].append(line)  # 2-point bins
        sub = [heights[k] for k in sorted(heights)]
        spaced = _spaced_rows(band) if rows else []
        if len(spaced) > 1 and all(len({column(*line.bbox[::2]) for line in s}) >= 2 for s in spaced):
            rows.extend(cells(s) for s in spaced)
        elif rows and len(sub) > 1 and all(len({column(*line.bbox[::2]) for line in s}) >= 2 for s in sub):
            rows.extend(cells(s) for s in sub)
        else:
            rows.append(cells(band))
    if len(rows) < 2:
        return None
    # "Case 1", "Case 2", …: the first row is a row like the others, not a header.
    headerless = _running_key(rows[0][0]) != "" and _running_key(rows[0][0]) == _running_key(rows[1][0])
    header = [""] * len(covered) if headerless else rows.pop(0)
    lines_md = ["| " + " | ".join(header) + " |", "|" + "---|" * len(covered)]
    lines_md += ["| " + " | ".join(row) + " |" for row in rows]
    return "\n".join(lines_md)


FIGURE_CAPTION = re.compile(r"^\**\s*(Fig\.|Figure|Hình)\s*\d", re.I)
FIGURE_JOIN = 8.0  # points; drawings this close together belong to one figure
FIGURE_LABEL_REACH = 14.0  # an axis label or legend this close to a figure is part of it
FIGURE_CAPTION_REACH = 40.0
FIGURE_MIN_SIDE = 40.0
FIGURE_MIN_PATHS = 20  # a chart is many paths; a rule, a box or an underline is a few
FIGURE_DPI = 150
SHORT_LABEL = 25  # characters; a tick label or an axis title, not a line of running text
PARAGRAPH_LINE = 45  # characters; a line this long is running text
TEXT_BOX_CHARS = 60  # running text inside a frame, beyond which the frame is a text box


def _grown(rect: "pymupdf.Rect", by: float) -> "pymupdf.Rect":
    return pymupdf.Rect(rect.x0 - by, rect.y0 - by, rect.x1 + by, rect.y1 + by)


def _curvy(drawing: dict) -> bool:
    """Whether a drawing has a curve or a slanted line: a plot, where a table has only straight rules."""
    for item in drawing["items"]:
        if item[0] in ("c", "qu"):
            return True
        if item[0] == "l" and abs(item[1].x - item[2].x) > 1 and abs(item[1].y - item[2].y) > 1:
            return True
    return False


def _clusters(boxes: list[tuple["pymupdf.Rect", int, bool]]) -> list[list]:
    """Drawings grouped by nearness: [rect, paths, curvy] per group."""
    groups: list[list] = []
    for rect, paths, curvy in sorted(boxes, key=lambda b: (b[0].y0, b[0].x0)):
        near = [g for g in groups if _grown(g[0], FIGURE_JOIN).intersects(rect)]
        merged = [pymupdf.Rect(rect), paths, curvy]
        for g in near:
            merged = [merged[0] | g[0], merged[1] + g[1], merged[2] or g[2]]
            groups.remove(g)
        groups.append(merged)
    # Joining two groups can bring a third into reach.
    changed = True
    while changed:
        changed = False
        for a, b in itertools.combinations(groups, 2):
            if _grown(a[0], FIGURE_JOIN).intersects(b[0]):
                a[0], a[1], a[2] = a[0] | b[0], a[1] + b[1], a[2] or b[2]
                groups.remove(b)
                changed = True
                break
    return groups


class _Label(NamedTuple):
    box: "pymupdf.Rect"
    text: str
    size: float
    in_paragraph: bool  # its block has lines of running text


def _page_labels(blocks: list[dict], page: "pymupdf.Page") -> list[_Label]:
    """Every line of text on the page, rotated ones too, outside the top and bottom margins."""
    out = []
    for block in blocks:
        if block["type"] != 0:
            continue
        lines = [ln for ln in block["lines"] if ln["spans"]]
        texts = ["".join(s["text"] for s in ln["spans"]).strip() for ln in lines]
        in_paragraph = sum(1 for t in texts if len(t) > PARAGRAPH_LINE) >= 2
        for line, text in zip(lines, texts, strict=True):
            box = pymupdf.Rect(line["bbox"])
            if text and page.rect.height * 0.06 < (box.y0 + box.y1) / 2 < page.rect.height * 0.94:
                out.append(_Label(box, text, max(s["size"] for s in line["spans"]), in_paragraph))
    return out


def _trimmed(region: "pymupdf.Rect", box: "pymupdf.Rect") -> "pymupdf.Rect":
    """The region cut back on the side that frees it of `box` at the least loss."""
    cuts = [
        (region.x1 - box.x0, pymupdf.Rect(region.x0, region.y0, box.x0 - 1, region.y1)),
        (box.x1 - region.x0, pymupdf.Rect(box.x1 + 1, region.y0, region.x1, region.y1)),
        (region.y1 - box.y0, pymupdf.Rect(region.x0, region.y0, region.x1, box.y0 - 1)),
        (box.y1 - region.y0, pymupdf.Rect(region.x0, box.y1 + 1, region.x1, region.y1)),
    ]
    loss, cut = min(cuts, key=lambda c: c[0])
    side = region.width if cut.height == region.height else region.height
    return cut if 0 < loss < side * 0.3 else region


def _vector_figures(
    page: "pymupdf.Page",
    drawings: list[dict],
    labels: list[_Label],
    body_size: float,
    taken: list["pymupdf.Rect"],
    pictures: list["pymupdf.Rect"],
) -> list["pymupdf.Rect"]:
    """Charts and diagrams drawn as vector paths rather than stored as pictures: their boxes, taken with
    the axis labels and legends around them, so that each can be shown as one picture.

    `pictures`: the boxes of the page's embedded images, which can be part of such a figure."""
    page_area = page.rect.width * page.rect.height
    boxes = []
    for d in drawings:
        rect = pymupdf.Rect(d["rect"])
        if rect.width * rect.height > page_area * 0.8 or _inside(tuple(rect), taken):
            continue  # a page background, or a table's rules
        boxes.append((rect, len(d["items"]), _curvy(d)))

    captions = [lab.box for lab in labels if FIGURE_CAPTION.match(lab.text)]
    running = [lab for lab in labels if lab.in_paragraph and lab.size >= body_size * 0.95]
    figures = []
    for rect, paths, curvy in _clusters(boxes):
        if max(rect.width, rect.height) < FIGURE_MIN_SIDE or any(rect.intersects(t) for t in taken):
            continue
        # Only a plot or a drawing by a caption can turn out a figure; the rest need no labels.
        by_caption = _grown(rect, FIGURE_CAPTION_REACH * 2)
        if not (curvy and paths >= FIGURE_MIN_PATHS) and not any(by_caption.intersects(c) for c in captions):
            continue
        region = pymupdf.Rect(rect)
        # Take in the labels around the drawing: each one taken can bring the next into reach.
        pending = [lab for lab in labels if not FIGURE_CAPTION.match(lab.text)]
        grew = True
        while grew:
            grew = False
            reach = _grown(region, FIGURE_LABEL_REACH)
            for lab in list(pending):
                # Small type (ticks, legends, panel captions), or a short line that is not a paragraph's last.
                label_like = lab.size < body_size * 0.95 or (
                    len(lab.text) <= SHORT_LABEL and not lab.in_paragraph
                )
                if _inside(tuple(lab.box), [rect]) or (label_like and reach.intersects(lab.box)):
                    region |= lab.box
                    pending.remove(lab)
                    grew = True
        # Running text and captions next to the drawing stay out of its picture.
        for box in [lab.box for lab in pending] + captions:
            if region.intersects(box) and not _inside(tuple(box), [rect]):
                region = _trimmed(region, box)
        if region.width < FIGURE_MIN_SIDE or region.height < FIGURE_MIN_SIDE:
            continue  # a rule or a thin box, even with its labels
        if sum(len(lab.text) for lab in running if _inside(tuple(lab.box), [rect])) > TEXT_BOX_CHARS:
            continue  # a framed box of running text (a sidebar, a definition) is text, not a picture
        near_caption = any(
            c.x0 < region.x1
            and c.x1 > region.x0
            and (
                region.y1 - 5 <= c.y0 <= region.y1 + FIGURE_CAPTION_REACH
                or region.y0 - FIGURE_CAPTION_REACH <= c.y1 <= region.y0 + 5
            )
            for c in captions
        )
        # A plot has curves or slanted lines; straight rules alone are a table unless a caption says figure.
        if near_caption or (curvy and paths >= FIGURE_MIN_PATHS):
            figures.append(region)
    # A figure made of several parts (boxes, a legend, a picture behind them) is one picture: all that lies
    # between its caption and the running text above.
    for c in captions:
        parts = [r for r in figures if r.y1 <= c.y0 + 5 and r.x0 < c.x1 and r.x1 > c.x0]
        # Up to the running text, or the caption of the figure before, over this caption.
        # A line of text outside every part (a one-line paragraph, a heading) is running text too.
        text = [
            lab.box
            for lab in labels
            if lab.size >= body_size * 0.95
            and (len(lab.text) > SHORT_LABEL or lab.size > body_size * 1.1)
            and not _inside(tuple(lab.box), figures)
        ]
        above = [
            box.y1
            for box in [lab.box for lab in running] + text + captions
            if box.y1 <= c.y0 and box.x0 < c.x1 and box.x1 > c.x0 and box is not c
        ]
        top = max(above, default=page.rect.height * 0.06)
        parts = [r for r in parts if r.y0 >= top - 2]
        if not parts:
            continue
        band = pymupdf.Rect(min(c.x0, *(r.x0 for r in parts)), top, max(c.x1, *(r.x1 for r in parts)), c.y0)
        region = pymupdf.Rect(parts[0])
        inner = [b[0] for b in boxes] + pictures + [lab.box for lab in labels if lab.box not in captions]
        for r in parts[1:] + [r for r in inner if band.contains(r)]:
            region |= r
        figures = [r for r in figures if not any(r is part for part in parts)] + [region]
    # Labels can join two figures' regions (the panels of one figure); one picture then shows both.
    merged: list[pymupdf.Rect] = []
    for r in sorted(figures, key=lambda r: (r.y0, r.x0)):
        for i, m in enumerate(merged):
            if m.intersects(r):
                merged[i] = m | r
                break
        else:
            merged.append(pymupdf.Rect(r))
    # Paths drawn past the page's edge (clipped away when shown) would widen the page's text extent and
    # upset the column split in _reading_order.
    clipped = [m & page.rect for m in merged]
    return [m for m in clipped if not m.is_empty]


def _grid_cell(text: str | None) -> str:
    if not text:
        return ""
    lines = [ln.strip() for ln in text.split("\n") if ln.strip()]
    items: list[str] = []
    for line in lines:
        if not items or CELL_ITEM.match(line):
            items.append(line)
        else:
            items[-1] = f"{items[-1][:-1]}{line}" if items[-1].endswith("-") else f"{items[-1]} {line}"
    return "<br>".join(items).replace("|", "\\|")


def _grid_markdown(table) -> str | None:
    """A table find_tables read, or None when what it read is not a table (a chart's gridlines, a frame)."""
    try:
        rows = [[_grid_cell(c) for c in row] for row in table.extract()]
    except Exception:
        return None
    kept: list[list[str]] = []
    for row in rows:
        if any(row) and (not kept or row != kept[-1]):  # a merged cell comes back once per row it spans
            kept.append(row)
    if len(kept) < 2 or len(kept[0]) < 2:
        return None
    cells = [c for row in kept for c in row]
    if sum(1 for c in cells if not c) > len(cells) * 0.5:
        return None  # mostly empty: gridlines, not cells
    if any(c.count("<br>") >= 6 for c in cells):
        return None  # a column of stacked numbers is an axis
    width = max(len(row) for row in kept)
    kept = [row + [""] * (width - len(row)) for row in kept]
    out = ["| " + " | ".join(kept[0]) + " |", "|" + "---|" * width]
    out += ["| " + " | ".join(row) + " |" for row in kept[1:]]
    return "\n".join(out)


BOILERPLATE = re.compile(
    r"^©|\(c\) \d{4}|Creative Commons|open access article|all rights reserved|licensed under", re.I
)
CONTACT = re.compile(r"corresponding author|correspondence to|e-?mail\s*:|\S+@\S+\.\w{2,}", re.I)
# "Correspondence to: Name <name@…>." inside the affiliations paragraph.
CONTACT_SENTENCE = re.compile(r"\s*Correspon-?\s?dence to:[^<\n]{0,200}<[^>\s]+@[^>\s]+>\.?", re.I)
FOOTNOTE = re.compile(r"^(?:\*(?!\*)|[†‡§])")  # "* Corresponding author", not "**bold**"
STACK_GAP = 2.0  # points between two image strips that are one picture on the page


def _stack_images(blocks: list[dict]) -> list[dict]:
    """Join image strips drawn edge to edge in one column into one image: a table or a figure is often
    stored as several horizontal slices, which would show as separate pictures with gaps between them."""
    out: list[dict] = []
    for block in blocks:
        prev = out[-1] if out else None
        if (
            prev is not None
            and prev["type"] == 1
            and block["type"] == 1
            and prev.get("image")
            and block.get("image")
            and abs(prev["bbox"][0] - block["bbox"][0]) <= STACK_GAP
            and abs(prev["bbox"][2] - block["bbox"][2]) <= STACK_GAP
            and 0 <= block["bbox"][1] - prev["bbox"][3] <= STACK_GAP
        ):
            try:
                out[-1] = _joined(prev, block)
                continue
            except Exception:  # a strip Pillow cannot read stays on its own
                pass
        out.append(block)
    return out


def _joined(top: dict, bottom: dict) -> dict:
    with _open_image(top) as a, _open_image(bottom) as b:
        a, b = a.convert("RGB"), b.convert("RGB")
        width = max(a.width, b.width)
        if b.width != width:
            b = b.resize((width, round(b.height * width / b.width)))
        if a.width != width:
            a = a.resize((width, round(a.height * width / a.width)))
        joined = Image.new("RGB", (width, a.height + b.height), "white")
        joined.paste(a, (0, 0))
        joined.paste(b, (0, a.height))
    buffer = io.BytesIO()
    joined.save(buffer, "PNG")
    return {
        **top,
        "bbox": (top["bbox"][0], top["bbox"][1], max(top["bbox"][2], bottom["bbox"][2]), bottom["bbox"][3]),
        "image": buffer.getvalue(),
        "mask": None,
        "width": joined.width,
        "height": joined.height,
    }


def _reading_order(items: list[_Item]) -> list[_Item]:
    """Top to bottom, but a two-column page is read one column at a time.

    What spans both columns (a title, an abstract, a wide figure) cuts the page into bands; inside a band the
    left column is read before the right one. On a one-column page nearly everything spans the middle, so
    the order stays top to bottom.
    """
    notes = [i for i in items if i.kind == "note"]
    items = [i for i in items if i.kind != "note"]
    if not items:
        return notes
    x0 = min(i.bbox[0] for i in items)
    x1 = max(i.bbox[2] for i in items)
    # Spanning means reaching well into both halves: the middle is only estimated from the text's extent,
    # and a column that ends a little past it is still a column.
    mid, slack = (x0 + x1) / 2, (x1 - x0) * 0.1
    ordered: list[_Item] = []
    left: list[_Item] = []
    right: list[_Item] = []

    def flush():
        ordered.extend(sorted(left, key=lambda i: i.bbox[1]) + sorted(right, key=lambda i: i.bbox[1]))
        left.clear()
        right.clear()

    for item in sorted(items, key=lambda i: (i.bbox[1], i.bbox[0])):
        if item.bbox[0] < mid - slack and item.bbox[2] > mid + slack:
            flush()
            ordered.append(item)
        elif (item.bbox[0] + item.bbox[2]) / 2 < mid:
            left.append(item)
        else:
            right.append(item)
    flush()
    return ordered + notes


MARGIN = 0.1  # the top and bottom tenth of a page, where running headers, footers and page numbers sit
PAGE_NUMBER = re.compile(r"^(?:(?:page|trang)\s*)?\d{1,4}(?:\s*(?:/|of|trên)\s*\d{1,4})?$", re.I)


def _running_key(text: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"\d+", "#", text.replace("**", ""))).strip().lower()


def _drop_running_text(pages: list[list[_Item]], heights: list[float]) -> list[list[_Item]]:
    """Leave out running headers and footers (the same line in the margin of several pages, page numbers
    aside) and bare page numbers: in clean text they would interrupt a sentence at every page break."""

    def in_margin(item: _Item, height: float) -> bool:
        return item.kind == "text" and (
            item.bbox[3] < height * MARGIN or item.bbox[1] > height * (1 - MARGIN)
        )

    seen: dict[str, set[int]] = defaultdict(set)
    for n, (items, height) in enumerate(zip(pages, heights, strict=True)):
        for item in items:
            if in_margin(item, height):
                seen[_running_key(item.text)].add(n)
    repeated = min(3, len(pages))

    def running(item: _Item) -> bool:
        if PAGE_NUMBER.match(item.text.replace("**", "").strip()):
            return True
        return len(pages) > 1 and len(seen[_running_key(item.text)]) >= repeated

    return [
        [i for i in items if not (in_margin(i, height) and running(i))]
        for items, height in zip(pages, heights, strict=True)
    ]


# A paragraph that runs on to the next page: it ends mid-sentence and the next page goes on in lower case.
CARRIED_END = re.compile(r"[^.!?:;)\]\"”’*]$")
CARRIED_START = re.compile(r"^[a-z(]")
NOT_PARAGRAPH = ("|", "!", "#", "*", ">", "$", "\\", "<")  # a table, a picture, a heading, a note, a scan


def _carried_over(pages: list[list[str]], sources: list[list[list]] | None = None) -> list[list[str]]:
    """Each paragraph whole on one page: the page break goes after one cut by it.

    `sources`, when given, holds each paragraph's boxes on the PDF, page by page like `pages`; it is changed
    to match (a joined paragraph has the boxes of both parts)."""
    for n, (prev, page) in enumerate(itertools.pairwise(pages)):
        if not prev or not page:
            continue
        head, tail = prev[-1], page[0]
        if (
            head.startswith(NOT_PARAGRAPH)
            or tail.startswith(NOT_PARAGRAPH)
            or not CARRIED_END.search(head)
            or not CARRIED_START.match(tail)
        ):
            continue
        prev[-1] = f"{head[:-1]}{tail}" if head.endswith("-") else f"{head} {tail}"
        del page[0]
        if sources is not None:
            sources[n][-1] += sources[n + 1].pop(0)
    if sources is not None:
        sources[:] = [s for s, p in zip(sources, pages, strict=True) if p]
    return [p for p in pages if p]


def block_key(raw: str) -> str:
    """The key the reader makes a block's id from: FNV-1a over the UTF-16 code units of the block's source
    as the reader reads it (lib/markdown.ts `hash`)."""
    h = 0x811C9DC5
    data = raw.encode("utf-16-le")
    for i in range(0, len(data), 2):
        h = ((h ^ (data[i] | data[i + 1] << 8)) * 0x01000193) & 0xFFFFFFFF
    return f"{h:08x}"


READER_IMAGE = re.compile(r"^!\[[^\]]*\]\((?:https?://\S+|pm-image:[0-9a-f]{16}\.webp)\)$", re.I)
READER_LIST = re.compile(r"^\s*(?:[-*+]|\d+\.)\s+")
READER_STOP = re.compile(r"^(#{1,6}\s|```|>|\||---\s*$)")
READER_MATH = re.compile(r"^\s*\$\$(.*\S.*)\$\$\s*$")


def reader_keys(text: str) -> list[str]:
    """The keys of the blocks the reader parses `text` into: the block rules of lib/markdown.ts
    `parseMarkdown`, which the keys of the source map must match."""
    lines, keys, i = text.split("\n"), [], 0
    while i < len(lines):
        line = lines[i]
        if not line.strip() or re.match(r"^---\s*$", line):
            i += 1  # page breaks are not blocks of the text
        elif line.startswith("```"):
            j = next((k for k in range(i + 1, len(lines)) if lines[k].startswith("```")), len(lines))
            keys.append(block_key("```" + "\n".join(lines[i + 1 : j])))
            i = j + 1
        elif READER_IMAGE.match(line.strip()) or READER_MATH.match(line) or re.match(r"^#{1,6}\s+", line):
            keys.append(block_key(line))
            i += 1
        else:
            if line.lstrip().startswith("|"):
                test, prefix, strip = (lambda ln: ln.lstrip().startswith("|")), "", False
            elif line.startswith(">"):
                test, prefix, strip = (lambda ln: ln.startswith(">")), "> ", True
            elif READER_LIST.match(line):
                test, prefix, strip = READER_LIST.match, "", False
            else:
                para = [line.strip()]
                i += 1
                while i < len(lines) and lines[i].strip() and not READER_STOP.match(lines[i]):
                    if READER_LIST.match(lines[i]) or READER_MATH.match(lines[i]):
                        break
                    para.append(lines[i].strip())
                    i += 1
                keys.append(block_key(" ".join(para)))
                continue
            run = []
            while i < len(lines) and test(lines[i]):
                run.append(re.sub(r"^>\s?", "", lines[i]) if strip else lines[i])
                i += 1
            keys.append(block_key(prefix + "\n".join(run)))
    return keys


def _source_box(item: _Item, page: "pymupdf.Page") -> list[float]:
    """[page number, x, y, w, h] of an item, the box as fractions of the page."""
    area = page.rect
    x0, y0 = max(item.bbox[0], area.x0), max(item.bbox[1], area.y0)
    x1, y1 = min(item.bbox[2], area.x1), min(item.bbox[3], area.y1)
    box = (
        (x0 - area.x0) / area.width,
        (y0 - area.y0) / area.height,
        max(0.0, x1 - x0) / area.width,
        max(0.0, y1 - y0) / area.height,
    )
    return [page.number + 1, *(round(v, 4) for v in box)]


TABLE_IMAGE_REACH = 30.0  # points between a table's caption and its picture
IMAGE_LINE = re.compile(r"^!\[\]\(pm-image:([0-9a-f]{16}\.webp)\)$")


def _table_images(items: list[_Item]) -> list[str]:
    """The pictures on a page read next to a "Table N" caption (just over or under it): tables a PDF stores
    as images, whose text only OCR can give."""
    names = []
    for i, item in enumerate(items):
        m = IMAGE_LINE.match(item.text) if item.kind == "image" else None
        if not m:
            continue
        for near in items[max(0, i - 1) : i] + items[i + 1 : i + 2]:
            above, below = near.bbox[3] <= item.bbox[1] + 5, near.bbox[1] >= item.bbox[3] - 5
            gap = item.bbox[1] - near.bbox[3] if above else near.bbox[1] - item.bbox[3]
            if (
                near.kind == "text"
                and TABLE_CAPTION.match(near.text.strip())
                and (above or below)
                and gap <= TABLE_IMAGE_REACH
            ):
                names.append(m.group(1))
                break
    return names


MIN_PAGE_TEXT = 20  # characters: fewer, and the page has no text layer worth reading
SCAN_COVERAGE = 0.5  # of the page covered by pictures: a scan
DEFAULT_BODY_SIZE = 10.0
OCR_MARK = "<!--pm-ocr:{}-->"
OCR_LINE = re.compile(r"^<!--pm-ocr:(\d+)-->$", re.M)


def needs_ocr(page: "pymupdf.Page") -> bool:
    """A scanned page: a picture of the text, with no text layer to read it from."""
    if len(page.get_text("text").strip()) >= MIN_PAGE_TEXT:
        return False
    covered = sum(abs(pymupdf.Rect(i["bbox"]) & page.rect) for i in page.get_image_info())
    return covered >= abs(page.rect) * SCAN_COVERAGE


def scanned_pages(path: Path) -> list[int]:
    """The pages of a PDF that only OCR can read (numbered from 1); none for a file that cannot be opened."""
    try:
        with pymupdf.open(path) as doc:
            if doc.needs_pass or doc.is_encrypted:
                return []
            return [page.number + 1 for page in doc if needs_ocr(page)]
    except Exception:
        return []


def extract_pdf(path: Path, fallback_title: str, image_dir: Path | None = None) -> ExtractionResult:
    """`image_dir`: where to save the document's images; without it images are left out."""
    try:
        doc = pymupdf.open(path)
    except Exception as e:
        raise ExtractionError("MSG-13") from e

    with doc:
        if doc.needs_pass or doc.is_encrypted:
            raise ExtractionError("MSG-14")
        if not doc.is_pdf:
            raise ExtractionError("MSG-13")

        sizes: list[float] = []
        images = ImageSink(image_dir)
        scanned = {page.number for page in doc if needs_ocr(page)}
        for page in doc:
            if page.number in scanned:
                continue
            for block in page.get_text("dict", flags=DICT_FLAGS)["blocks"]:
                if block["type"] == 1:
                    images.note(block, page.number)
                    continue
                for line in block.get("lines", []):
                    for span in line["spans"]:
                        if span["text"].strip():
                            sizes.extend([span["size"]] * len(span["text"]))
        if not sizes and not scanned:
            raise ExtractionError("MSG-15")
        body_size = statistics.median(sizes) if sizes else DEFAULT_BODY_SIZE

        page_items = [
            [_Item(tuple(page.rect), OCR_MARK.format(page.number + 1), "ocr")]
            if page.number in scanned
            else _page_items(page, body_size, images)
            for page in doc
        ]
        page_items = _drop_running_text(page_items, [page.rect.height for page in doc])
        ordered = [_reading_order(items) for items in page_items]
        kept = [(items, page) for items, page in zip(ordered, doc, strict=True) if items]
        pages = [[i.text for i in items] for items, _ in kept]
        sources = [[[_source_box(i, page)] for i in items] for items, page in kept]
        pages = _carried_over(pages, sources)
        content = PAGE_SEPARATOR.join("\n\n".join(p) for p in pages)
        if not content.strip():
            raise ExtractionError("MSG-15")

        meta_title = (doc.metadata or {}).get("title") or ""
        return ExtractionResult(
            title=meta_title.strip() or fallback_title,
            content=content,
            page_count=doc.page_count,
            word_count=len(re.findall(r"\w+", content)),
            table_images=[name for items in ordered for name in _table_images(items)],
            equation_images={
                name: tag for name, tag in images.equations.items() if f"pm-image:{name}" in content
            },
            charts={name: chart for name, chart in images.charts.items() if f"pm-image:{name}" in content},
            source_map=[
                [key, boxes]
                for texts, page_boxes in zip(pages, sources, strict=True)
                for text, boxes in zip(texts, page_boxes, strict=True)
                for key in reader_keys(text)
            ],
            ocr_pages=sorted(n + 1 for n in scanned),
        )


def equation_count(path: Path) -> int:
    """About how many numbered equations a PDF has: its lines that are only a "(n)"."""
    try:
        with pymupdf.open(path) as doc:
            if doc.needs_pass or doc.is_encrypted:
                return 0
            return sum(
                1
                for page in doc
                for line in page.get_text("text").split("\n")
                if EQUATION_NUMBER.match(line.strip())
            )
    except Exception:
        return 0
