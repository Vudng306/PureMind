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
from dataclasses import dataclass

from app.services.extraction import block_key, reader_blocks

CONTEXT = 32  # characters kept on each side of a passage (lib/anchor.ts)
AGREE = 12  # how much of a side has to agree for it to count
LONG = 20  # a passage this long (letters, no spaces) is its own proof when found once

MAPPED, AMBIGUOUS, UNRESOLVED = "mapped", "ambiguous", "unresolved"


@dataclass
class TextBlock:
    id: str  # as the reader names it: "b<key>", then "b<key>-1"… for the same block again
    words: str  # squashed: see squash()
    page: int | None


def squash(text: str) -> str:
    """The words without spacing, case or accents (lib/find.ts `normalize`, then no white space)."""
    text = unicodedata.normalize("NFD", unicodedata.normalize("NFKC", text))
    text = "".join(c for c in text if not unicodedata.combining(c)).replace("đ", "d").replace("Đ", "D")
    return re.sub(r"\s+", "", text.lower())


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
    pages: dict[str, int] = {}
    seen: dict[str, int] = {}
    for key, boxes in source_map or []:
        n = seen.get(key, 0)
        seen[key] = n + 1
        if boxes:
            pages[f"b{key}{f'-{n}' if n else ''}"] = boxes[0][0]
    out, counts = [], {}
    for raw in reader_blocks(content):
        key = block_key(raw)
        n = counts.get(key, 0)
        counts[key] = n + 1
        block_id = f"b{key}{f'-{n}' if n else ''}"
        out.append(TextBlock(block_id, squash(plain(raw)), pages.get(block_id)))
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
    found = _found(blocks, words)
    if not found:
        return UNRESOLVED  # a highlight also drawn on the PDF still shows there, but not in the clean text
    has_context = bool(squash(h.prefix or "") or squash(h.suffix or ""))
    if len(found) == 1:
        block, at = found[0]
        if len(words) >= LONG:
            return MAPPED
        if has_context:
            return MAPPED if _agreement(block, at, len(words), h) > 0 else AMBIGUOUS
        return MAPPED if h.page is None or block.page == h.page else AMBIGUOUS
    if has_context:
        scores = [_agreement(block, at, len(words), h) for block, at in found]
        best = max(scores)
        if best > 0 and scores.count(best) == 1:
            return MAPPED
    elif h.page is not None and sum(1 for block, _ in found if block.page == h.page) == 1:
        return MAPPED
    return AMBIGUOUS
