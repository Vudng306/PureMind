"""Scanned PDF pages read by the vision model (SRS 3.3: OpenAI), so a scan gets clean text like any PDF.

extract_pdf marks each page that is only a picture of text with an OCR_MARK line; each page the model
reads replaces its mark with the page's Markdown. The original PDF stays what the reader sees in "original"
mode; a page the model cannot read is left out of the clean text, as a figure would be.
"""

import asyncio
import base64
import logging
import re
from pathlib import Path

import pymupdf

from app.core.config import Settings
from app.services import openai_client
from app.services.extraction import OCR_LINE

log = logging.getLogger("app.ai")

MAX_PAGES = 150  # per document: bounds the cost and the time of one upload
CONCURRENCY = 4
MAX_EDGE = 2000  # pixels on the long side: small print stays legible
MAX_PAGE_TOKENS = 6000
BLANK = "BLANK_PAGE"

PROMPT = f"""Transcribe this scanned page of a document into Markdown.

- Copy the text exactly as printed, in its own language: do not translate, summarise, correct or complete \
it. Write an illegible word as […].
- Read in reading order: on a page of two columns, the whole left column, then the right one.
- Leave out running headers and footers, page numbers and line numbers.
- Headings as "#", "##" or "###" by level. Each paragraph on one line, paragraphs separated by a blank \
line; join a word hyphenated across the end of a line.
- Lists as "- " or "1. " items. Tables as GitHub-flavoured Markdown tables (a header row, then the \
separator row), every cell copied exactly.
- Symbols in running text in Unicode as printed (σ′, e₀, ≤, √).
- An equation set on a line of its own: its LaTeX on one line between $$ and $$, with its number (if it \
has one) as \\tag: $$w = \\frac{{M}}{{M_s}} - 1 \\tag{{1}}$$
- A figure, chart or photograph: do not describe it and do not write an image link; keep its caption as \
a paragraph.
- Do not use horizontal rules or code fences.
- If the page has no text, output exactly {BLANK}.

Output only the Markdown."""

FENCE = re.compile(r"^```[a-z]*\n|\n```$")
RULE = re.compile(r"^\s*([-*_])(\s*\1){2,}\s*$", re.M)  # "---" would read as a page break
IMAGE = re.compile(r"^\s*!\[[^\]\n]*\]\([^)\n]*\)\s*$", re.M)  # the model's made-up links to the figures
HEADING = re.compile(r"^(#{1,6})[ \t]+(.+?)[ \t]*$", re.M)
# A display equation over several lines, or in \[ \]: the reader reads one "$$…$$" line.
DISPLAY = re.compile(r"^[ \t]*(?:\$\$|\\\[)((?:(?!\n[ \t]*\n).)+?)(?:\$\$|\\\])[ \t]*$", re.M | re.S)


def _render(path: Path, page_number: int) -> bytes:
    with pymupdf.open(path) as doc:
        page = doc[page_number - 1]
        zoom = MAX_EDGE / max(page.rect.width, page.rect.height)
        pix = page.get_pixmap(matrix=pymupdf.Matrix(zoom, zoom), alpha=False)
        return pix.tobytes("jpeg", jpg_quality=80)


def _markdown(text: str) -> str | None:
    """The page's Markdown as the clean text holds it, or None for a blank page."""
    text = FENCE.sub("", text.strip()).strip()
    if not text or text.strip(" .") == BLANK:
        return None
    text = OCR_LINE.sub("", RULE.sub("", IMAGE.sub("", text)))  # no page breaks, pictures or marks
    text = HEADING.sub(lambda m: f"{m.group(1)} {' '.join(m.group(2).split())}", text)  # "#  3  Title"
    text = DISPLAY.sub(lambda m: f"$${' '.join(m.group(1).split())}$$", text)
    return re.sub(r"\n{3,}", "\n\n", text).strip() or None


async def _read(settings: Settings, path: Path, page_number: int) -> str | None:
    try:
        image = await asyncio.to_thread(_render, path, page_number)
    except Exception:
        log.exception("page_ocr could not render page %d of %s", page_number, path.name)
        return None
    data_url = "data:image/jpeg;base64," + base64.b64encode(image).decode()
    try:
        answer = await openai_client.chat(
            settings,
            [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": PROMPT},
                        {"type": "image_url", "image_url": {"url": data_url, "detail": "high"}},
                    ],
                }
            ],
            purpose="page_ocr",
            max_tokens=MAX_PAGE_TOKENS,
        )
    except openai_client.AIError:
        return None
    return _markdown(answer.text)


async def read_pages(settings: Settings, path: Path, pages: list[int]) -> dict[int, str]:
    """{page number: Markdown} for the scanned pages the model could read (none without an API key)."""
    pages = pages[:MAX_PAGES]
    if not pages or not settings.openai_api_key:
        return {}
    limit = asyncio.Semaphore(CONCURRENCY)

    async def one(n: int) -> str | None:
        async with limit:
            return await _read(settings, path, n)

    texts = await asyncio.gather(*(one(n) for n in pages))
    unread = [n for n, t in zip(pages, texts, strict=True) if t is None]
    if unread:
        log.info("page_ocr left out pages %s of %s", unread, path.name)
    return {n: t for n, t in zip(pages, texts, strict=True) if t}
