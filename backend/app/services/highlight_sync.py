"""One highlight, shown in the clean text and on the original PDF alike.

The clean text is the common ground. Its words, without spacing, hyphens, case or accents (anchors.squash),
are counted over all its blocks; a highlight's passage is a range of that count, whichever view it was made
in. Each block is lined up with the characters PyMuPDF finds inside the block's boxes on the PDF, so a range
gives the lines it covers there, and a selection on a page gives the range it covers.

A passage is placed only when that is sure. The same words elsewhere are another passage; what cannot be told
apart, or is not in the other view at all, stays where it was made and is marked so (FR-05). Nothing here
changes a highlight's words, color or note.
"""

import bisect
import difflib
import logging
import uuid
from collections import OrderedDict
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path

import pymupdf
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm.attributes import flag_modified
from starlette.concurrency import run_in_threadpool

from app.core.config import Settings
from app.models import Document, Highlight
from app.schemas import file_type_of
from app.services import anchors, storage
from app.services.anchors import AMBIGUOUS, MAPPED, Highlighted, TextBlock, squash

log = logging.getLogger(__name__)

SYNCED, UNSYNCED = "synced", "unsynced"

BOX_MARGIN = 0.004  # of the page: a character at the very edge of its block's box still belongs to it
RECT_MARGIN = 0.003
MIN_RUN = 4  # characters in a row for a stretch of a block to count as found on the PDF
MAX_COMPARED = 40_000_000  # block × box characters: beyond this, lining them up is not attempted
COVERED = 0.98  # of a passage found on the PDF for its place there to be believed
OVERLAP = 0.6  # of a passage inside a selection for the selection to be that passage
CLEARLY = 0.2  # how far ahead the best of several places has to be
SAME_RECTS = 0.5  # of the smaller area, for two selections on a page to be the same one
CONTEXT = 32
MAX_RECTS = 200
INDEXES_KEPT = 16


@dataclass(frozen=True)
class PdfChar:
    c: str
    x0: float
    y0: float
    x1: float
    y1: float
    page: int
    line: tuple[int, int]


@lru_cache(maxsize=256)
def _read_page(path: str, modified: int, number: int) -> tuple[PdfChar, ...]:
    """The characters of a page with their boxes as fractions of it; only those that count in `squash`."""
    out: list[PdfChar] = []
    with pymupdf.open(path) as doc:
        if not 1 <= number <= doc.page_count:
            return ()
        page = doc[number - 1]
        area = page.rect
        data = page.get_text("rawdict", flags=pymupdf.TEXTFLAGS_TEXT)
    for b, block in enumerate(data["blocks"]):
        for n, line in enumerate(block.get("lines", [])):
            for span in line["spans"]:
                for ch in span["chars"]:
                    x0, y0, x1, y1 = ch["bbox"]
                    box = (
                        (x0 - area.x0) / area.width,
                        (y0 - area.y0) / area.height,
                        (x1 - area.x0) / area.width,
                        (y1 - area.y0) / area.height,
                    )
                    # One glyph can stand for several letters (a ligature).
                    out += [PdfChar(c, *box, number, (b, n)) for c in squash(ch["c"])]
    return tuple(out)


def _inside(ch: PdfChar, x: float, y: float, w: float, h: float, margin: float) -> bool:
    cx, cy = (ch.x0 + ch.x1) / 2, (ch.y0 + ch.y1) / 2
    return x - margin <= cx <= x + w + margin and y - margin <= cy <= y + h + margin


def _rect_values(r) -> tuple[float, float, float, float]:
    return (r["x"], r["y"], r["w"], r["h"]) if isinstance(r, dict) else (r.x, r.y, r.w, r.h)


def _area_shared(a, b) -> float:
    ax, ay, aw, ah = _rect_values(a)
    bx, by, bw, bh = _rect_values(b)
    w = min(ax + aw, bx + bw) - max(ax, bx)
    h = min(ay + ah, by + bh) - max(ay, by)
    return max(0.0, w) * max(0.0, h)


def same_selection(a: list, b: list) -> bool:
    """Two sets of rectangles on one page covering mostly the same area."""
    shared = sum(_area_shared(x, y) for x in a for y in b)
    area = min(sum(_rect_values(r)[2] * _rect_values(r)[3] for r in rects) for rects in (a, b))
    return area > 0 and shared / area >= SAME_RECTS


class TextIndex:
    """A text of a document, with its PDF when it has one."""

    def __init__(self, content: str, source_map: list | None, pdf: Path | None):
        self.blocks: list[TextBlock] = anchors.text_blocks(content, source_map)
        self.by_id = {b.id: b for b in self.blocks}
        self.starts: list[int] = []
        at = 0
        for b in self.blocks:
            self.starts.append(at)
            at += len(b.words)
        self.words = "".join(b.words for b in self.blocks)
        self.start_of = {b.id: s for b, s in zip(self.blocks, self.starts, strict=True)}
        self.pdf = pdf
        self._aligned: dict[str, dict[int, PdfChar]] = {}

    @property
    def two_views(self) -> bool:
        return self.pdf is not None and bool(self.blocks)

    def chars(self, page: int) -> tuple[PdfChar, ...]:
        if self.pdf is None:
            return ()
        try:
            return _read_page(str(self.pdf), self.pdf.stat().st_mtime_ns, int(page))
        except Exception:  # a file gone or unreadable: the highlight stays where it was made
            log.warning("no characters read from the file of a document")
            return ()

    def aligned(self, block: TextBlock) -> dict[int, PdfChar]:
        """{index in the block's words: its character on the PDF}, for what is sure to be the same."""
        if block.id in self._aligned:
            return self._aligned[block.id]
        chars: list[PdfChar] = []
        seen: set[PdfChar] = set()
        for page, x, y, w, h in block.boxes:
            for ch in self.chars(page):
                if ch not in seen and _inside(ch, x, y, w, h, BOX_MARGIN):
                    seen.add(ch)
                    chars.append(ch)
        pdf = "".join(ch.c for ch in chars)
        out: dict[int, PdfChar] = {}
        if pdf == block.words:
            out = dict(enumerate(chars))
        elif pdf and block.words and len(pdf) * len(block.words) <= MAX_COMPARED:
            matcher = difflib.SequenceMatcher(None, block.words, pdf, autojunk=False)
            for a, b, size in matcher.get_matching_blocks():
                if size >= MIN_RUN:
                    out.update((a + i, chars[b + i]) for i in range(size))
        self._aligned[block.id] = out
        return out

    def block_at(self, at: int) -> int:
        return max(0, bisect.bisect_right(self.starts, at) - 1)

    def spans(self, start: int, end: int) -> list[dict]:
        out = []
        for i in range(self.block_at(start), len(self.blocks)):
            base = self.starts[i]
            if base >= end:
                break
            block = self.blocks[i]
            a, z = max(start - base, 0), min(end - base, len(block.words))
            if z > a:
                out.append({"block": block.id, "start": a, "end": z})
        return out

    def occurrences(self, words: str) -> list[int]:
        out, at = [], self.words.find(words) if words else -1
        while at >= 0:
            out.append(at)
            at = self.words.find(words, at + 1)
        return out

    def pdf_place(self, start: int, end: int) -> list[dict] | None:
        """The lines a range covers on the PDF, page by page; None unless it is nearly all found there."""
        chars: list[PdfChar | None] = []
        for span in self.spans(start, end):
            aligned = self.aligned(self.by_id[span["block"]])
            chars += [aligned.get(i) for i in range(span["start"], span["end"])]
        found = [c for c in chars if c]
        if not chars or not chars[0] or not chars[-1] or len(found) / len(chars) < COVERED:
            return None
        lines: dict[tuple, list[float]] = {}
        for c in found:
            key = (c.page, c.line)
            box = lines.setdefault(key, [c.x0, c.y0, c.x1, c.y1])
            box[:] = [min(box[0], c.x0), min(box[1], c.y0), max(box[2], c.x1), max(box[3], c.y1)]
        pages: dict[int, list[dict]] = {}
        for (page, _), (x0, y0, x1, y1) in lines.items():
            x, y = max(0.0, x0), max(0.0, y0)
            w, h = min(1.0, x1) - x, min(1.0, y1) - y
            if w > 0 and h > 0:
                rect = {"x": round(x, 5), "y": round(y, 5), "w": round(w, 5), "h": round(h, 5)}
                pages.setdefault(page, []).append(rect)
        return [{"page": p, "rects": r[:MAX_RECTS]} for p, r in pages.items()] or None


@dataclass
class Place:
    """Where a highlight stands in both views."""

    sync: str
    start: int | None = None
    end: int | None = None
    clean: list[dict] | None = None
    pdf: list[dict] | None = None
    prefix: str | None = None
    suffix: str | None = None
    overlaps: list[uuid.UUID] = field(default_factory=list)


def _in_clean_text(ix: TextIndex, h: Highlighted) -> tuple[str, tuple[int, int] | None]:
    """A highlight made in the clean text: its range, starting from the block it was made in."""
    words = squash(h.text)
    if not words:
        return anchors.UNRESOLVED, None
    own = ix.by_id.get(h.block_id or "")
    if own is not None:
        found = anchors._found([own], words)
        if len(found) == 1:
            at = found[0][1]
        elif found:
            # The same words again in this block: the reader's own offset says which, or the words around.
            expected = len(squash(own.text[: h.start])) if h.start is not None else -1
            places = [p for _, p in found]
            if expected in places:
                at = expected
            else:
                scores = [anchors._agreement(own, p, len(words), h) for p in places]
                if not scores or max(scores) == 0 or scores.count(max(scores)) != 1:
                    return AMBIGUOUS, None
                at = places[scores.index(max(scores))]
        else:
            at = None
        if at is not None:
            start = ix.start_of[own.id] + at
            return MAPPED, (start, start + len(words))
    state, hit = anchors.pick(anchors._found(ix.blocks, words), words, h)
    if hit is None:
        return state, None
    start = ix.start_of[hit[0].id] + hit[1]
    return MAPPED, (start, start + len(words))


def _on_pdf_page(ix: TextIndex, h: Highlighted) -> tuple[str, tuple[int, int] | None]:
    """A selection on a PDF page: the words say what it is, the place on the page says which of them."""
    words = squash(h.text)
    hits = ix.occurrences(words)
    if not hits or not h.rects or not h.page:
        return anchors.UNRESOLVED, None
    boxes = [_rect_values(r) for r in h.rects]
    touched: set[int] = set()  # the positions in the text of the characters under the selection
    near: set[int] = set()  # the blocks with a box on this page under the selection
    for i, block in enumerate(ix.blocks):
        page_boxes = [b[1:] for b in block.boxes if b[0] == h.page]
        if not any(
            bx < x + w and x < bx + bw and by < y + hh and y < by + bh
            for bx, by, bw, bh in page_boxes
            for x, y, w, hh in boxes
        ):
            continue
        near.add(i)
        for at, ch in ix.aligned(block).items():
            if ch.page == h.page and any(_inside(ch, *b, RECT_MARGIN) for b in boxes):
                touched.add(ix.starts[i] + at)
    if touched:
        scored = sorted(
            ((len(touched.intersection(range(s, s + len(words)))) / len(words), s) for s in hits),
            reverse=True,
        )
        if scored[0][0] < OVERLAP:
            return anchors.UNRESOLVED, None
        if len(scored) > 1 and scored[1][0] >= OVERLAP and scored[0][0] - scored[1][0] < CLEARLY:
            return AMBIGUOUS, None
        return MAPPED, (scored[0][1], scored[0][1] + len(words))
    candidates = [s for s in hits if ix.block_at(s) in near]
    if len(candidates) == 1:
        return MAPPED, (candidates[0], candidates[0] + len(words))
    return (AMBIGUOUS, None) if candidates else (anchors.UNRESOLVED, None)


def place(ix: TextIndex, h: Highlighted) -> Place:
    made_on_pdf = h.block_id is None
    own_pdf = [{"page": h.page, "rects": h.rects}] if h.rects and h.page else None
    state, passage = _on_pdf_page(ix, h) if made_on_pdf else _in_clean_text(ix, h)
    if passage is None:
        sync = SYNCED if not ix.two_views else AMBIGUOUS if state == AMBIGUOUS else UNSYNCED
        return Place(sync, pdf=own_pdf)
    start, end = passage
    pdf = own_pdf or (ix.pdf_place(start, end) if ix.pdf is not None else None)
    return Place(
        SYNCED if pdf is not None or not ix.two_views else UNSYNCED,
        start,
        end,
        ix.spans(start, end),
        pdf,
        ix.words[max(0, start - CONTEXT) : start],
        ix.words[end : end + CONTEXT],
    )


# ---- the database side

_indexes: OrderedDict[tuple, TextIndex] = OrderedDict()


def forget(document_id: uuid.UUID) -> None:
    for key in [k for k in _indexes if k[0] == document_id]:
        del _indexes[key]


def _pdf_path(settings: Settings, doc: Document) -> Path | None:
    if not doc.file_storage_path or file_type_of(doc.source_type, doc.original_filename) != "pdf":
        return None
    try:
        path = storage.resolve(settings, doc.file_storage_path)
    except ValueError:
        return None
    return path if path.is_file() else None


async def index_of(session: AsyncSession, settings: Settings, doc: Document) -> TextIndex:
    pdf = _pdf_path(settings, doc)
    key = (doc.id, doc.content_version, str(pdf))
    if key in _indexes:
        _indexes.move_to_end(key)
        return _indexes[key]
    source_map = await session.scalar(select(Document.source_map).where(Document.id == doc.id))
    ix = await run_in_threadpool(TextIndex, doc.content_clean or "", source_map, pdf)
    _indexes[key] = ix
    while len(_indexes) > INDEXES_KEPT:
        _indexes.popitem(last=False)
    return ix


def view_of(h) -> Highlighted:
    return Highlighted(
        h.block_id,
        h.selected_text,
        h.page_number,
        h.prefix,
        h.suffix,
        h.rects is not None,
        h.start_offset,
        h.rects,
    )


async def place_in(ix: TextIndex, h) -> Place:
    """Where a highlight goes. Whatever goes wrong here, the highlight itself is still saved (FR-05)."""
    view = view_of(h)
    try:
        return await run_in_threadpool(place, ix, view)
    except Exception:
        log.exception("a highlight could not be placed")
        rects = [{"page": h.page_number, "rects": h.rects}] if h.rects and h.page_number else None
        return Place(UNSYNCED, pdf=rects)


def put(row: Highlight, where: Place, version: str | None) -> None:
    row.canonical_start, row.canonical_end = where.start, where.end
    row.clean_anchor, row.pdf_anchor = where.clean, where.pdf
    row.sync_status = where.sync
    if where.start is not None:
        row.content_version = version
        row.prefix = row.prefix if row.prefix is not None else where.prefix
        row.suffix = row.suffix if row.suffix is not None else where.suffix


async def neighbours(
    session: AsyncSession, user_id: uuid.UUID, doc: Document, h, where: Place
) -> tuple[Highlight | None, list[uuid.UUID]]:
    """FR-02: the highlight already on exactly this passage, and the others that overlap it."""
    rows = (
        await session.scalars(
            select(Highlight).where(Highlight.user_id == user_id, Highlight.document_id == doc.id)
        )
    ).all()
    same, overlapping = None, []
    version = doc.content_version
    words = squash(h.selected_text)
    for row in rows:
        if where.start is not None and row.canonical_start is not None and row.content_version == version:
            if (row.canonical_start, row.canonical_end) == (where.start, where.end):
                same = row
            elif row.canonical_start < where.end and where.start < row.canonical_end:
                overlapping.append(row.id)
        elif h.block_id is not None:
            place_of = (row.block_id, row.start_offset, row.end_offset)
            if place_of == (h.block_id, h.start_offset, h.end_offset) and squash(row.selected_text) == words:
                same = same or row  # not placed in the text, but the very selection made before
        elif (
            row.block_id is None
            and row.rects
            and row.page_number == h.page_number
            and squash(row.selected_text) == words
            and same_selection(row.rects, h.rects)
        ):
            same = same or row
    return same, overlapping


async def recheck(
    session: AsyncSession,
    settings: Settings,
    doc: Document,
    rows: list[Highlight],
    *,
    statuses: bool = True,
) -> dict[str, int]:
    """Place every highlight of a document in its text as it is now. Two on one passage keep their rows: the
    later is marked ambiguous, for the owner to look at. With `statuses`, also says how each stands (UC-04)."""
    forget(doc.id)
    ix = await index_of(session, settings, doc)
    places = [await place_in(ix, row) for row in rows]
    for row in rows:
        row.canonical_start = row.canonical_end = None
        flag_modified(row, "updated_at")  # placing it again is not an edit by its owner
    await session.flush()
    counts = {anchors.MAPPED: 0, anchors.AMBIGUOUS: 0, anchors.UNRESOLVED: 0}
    taken: set[tuple[int, int]] = set()
    version = doc.content_version
    ordered = sorted(zip(rows, places, strict=True), key=lambda pair: pair[0].created_at)
    for row, where in ordered:
        if where.start is not None and (where.start, where.end) in taken:
            where = Place(AMBIGUOUS, pdf=row.pdf_anchor if row.rects else None)
        elif where.start is not None:
            taken.add((where.start, where.end))
        put(row, where, version)
        flag_modified(row, "updated_at")
        if statuses:
            row.anchor_status = anchors.status(ix.blocks, view_of(row))
            if row.anchor_status == MAPPED:
                row.content_version = version  # checked against this text
            counts[row.anchor_status] += 1
    return counts
