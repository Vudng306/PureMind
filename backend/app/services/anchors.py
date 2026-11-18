"""Clean Reader UC-04, TSD §9.1: where the highlights of a document stand once its file is read again.

The rules are those of the reader's lib/anchor.ts `locate`, which places a highlight in the text it shows:
at its own block while that block is unchanged, otherwise at the one place in the new text that holds its
passage. Found in several places with nothing around it to settle which, it is `ambiguous`; not found, it is
`unresolved`. Neither is placed on a guess, and neither is deleted: the highlight keeps its quote and note.

The server does not render Markdown, so it compares the words only — no spacing, case or accents — which is
also how the reader finds a passage that moved.
"""

import re
import unicodedata
from dataclasses import dataclass, field

from app.services.extraction import block_key, reader_blocks

CONTEXT = 32  # characters kept on each side of a passage (lib/anchor.ts)
AGREE = 12  # how much of a side has to agree for it to count
LONG = 20  # a passage this long (letters, no spaces) is its own proof when found once

MAPPED, AMBIGUOUS, UNRESOLVED = "mapped", "ambiguous", "unresolved"
# White space, and what a line end or a typesetter puts inside a word (lib/anchor.ts `canon`).
LEFT_OUT = re.compile(r"[\s\-\u2010\u2011\u00ad\u2063\u200b\u200c\u200d\ufeff]+")


@dataclass
class TextBlock:
    id: str  # as the reader names it: "b<key>", then "b<key>-1"… for the same block again
    words: str  # squashed: see squash()
    page: int | None
    text: str = ""  # as the reader shows it, about (see plain)
    boxes: list = field(default_factory=list)  # [[page, x, y, w, h], …] on the PDF (Document.source_map)


def squash(text: str) -> str:
    """The words without spacing, hyphens, case or accents: the form the clean text and the PDF are compared
    in, and what canonical offsets count (lib/anchor.ts `canon` gives the same, code point for code point)."""
    text = unicodedata.normalize("NFD", unicodedata.normalize("NFKC", text))
    text = "".join(c for c in text if unicodedata.category(c)[0] != "M").replace("đ", "d").replace("Đ", "D")
    return LEFT_OUT.sub("", text.lower()).replace("ς", "σ")


def plain(raw: str) -> str:
    """A block's words as the reader shows them: no Markdown marks, pictures or table rules."""
    text = re.sub(r"!\[[^\]]*\]\([^)]*\)", "", raw)
    text = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", text)  # a link shows its words
    text = re.sub(r"^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+|\d+\.\s+)", "", text, flags=re.M)
    text = re.sub(r"\*\*|__|`|<br\s*/?>|\\(?=[*_\\`#|])", "", text)
    text = re.sub(r"(?<![\w*])\*(?=\S)([^*]+?)(?<=\S)\*(?![\w*])", r"\1", text)  # *emphasis*
    text = re.sub(r"^\|?[\s:|-]+\|?$", "", text, flags=re.M)  # a table's rule row
    return text.replace("|", " ").replace("⁣", "").replace("­", "")


def text_blocks(content: str, source_map: list | None = None) -> list[TextBlock]:
    """The blocks of a clean text, named as the reader names them, with their PDF page when known."""
    places: dict[str, list] = {}
    seen: dict[str, int] = {}
    for key, boxes in source_map or []:
        n = seen.get(key, 0)
        seen[key] = n + 1
        if boxes:
            places[f"b{key}{f'-{n}' if n else ''}"] = boxes
    out, counts = [], {}
    for raw in reader_blocks(content):
        key = block_key(raw)
        n = counts.get(key, 0)
        counts[key] = n + 1
        block_id = f"b{key}{f'-{n}' if n else ''}"
        text = plain(raw)
        boxes = places.get(block_id, [])
        out.append(TextBlock(block_id, squash(text), boxes[0][0] if boxes else None, text, boxes))
    return out


@dataclass
class Highlighted:
    """What a highlight says about its place (models.Highlight)."""

    block_id: str | None
    text: str
    page: int | None
    prefix: str | None
    suffix: str | None
    on_pdf: bool  # it has rectangles on a page of the original file
    start: int | None = None  # where it starts in its block, as the reader counted
    rects: list | None = None


def _found(blocks: list[TextBlock], words: str) -> list[tuple[TextBlock, int]]:
    out = []
    for block in blocks:
        i = block.words.find(words)
        while i >= 0:
            out.append((block, i))
            i = block.words.find(words, i + len(words))
    return out


def _agreement(block: TextBlock, at: int, length: int, h: Highlighted) -> int:
    """How many sides (0–2) of a place read like the words that were around the highlight."""
    before = squash(h.prefix or "")[-AGREE:]
    after = squash(h.suffix or "")[:AGREE]
    n = 0
    if before and block.words[:at].endswith(before):
        n += 1
    if after and block.words[at + length :].startswith(after):
        n += 1
    return n


def pick(found: list[tuple[TextBlock, int]], words: str, h: Highlighted):
    """(status, the place): which of the places holding the words is the highlight's, if that is sure."""
    if not found:
        return UNRESOLVED, None  # a highlight also drawn on the PDF still shows there, not in the clean text
    has_context = bool(squash(h.prefix or "") or squash(h.suffix or ""))
    if len(found) == 1:
        block, at = found[0]
        if len(words) >= LONG:
            sure = True
        elif has_context:
            sure = _agreement(block, at, len(words), h) > 0
        else:
            sure = h.page is None or block.page == h.page
        return (MAPPED, found[0]) if sure else (AMBIGUOUS, None)
    if has_context:
        scores = [_agreement(block, at, len(words), h) for block, at in found]
        best = max(scores)
        if best > 0 and scores.count(best) == 1:
            return MAPPED, found[scores.index(best)]
    elif h.page is not None:
        on_page = [place for place in found if place[0].page == h.page]
        if len(on_page) == 1:
            return MAPPED, on_page[0]
    return AMBIGUOUS, None


def status(blocks: list[TextBlock], h: Highlighted) -> str:
    """mapped, ambiguous or unresolved: where the highlight stands in the new text (lib/anchor.ts `locate`)."""
    words = squash(h.text)
    if h.block_id is None:
        # Made on the original PDF only: the file has not changed, so neither has its place.
        return MAPPED if h.on_pdf else UNRESOLVED
    if not words:
        return UNRESOLVED
    own = next((b for b in blocks if b.id == h.block_id), None)
    if own is not None and words in own.words:
        return MAPPED  # the same block, word for word: its id is the hash of its source
    return pick(_found(blocks, words), words, h)[0]
