"""Tables a PDF stores as pictures, read back as Markdown tables by the vision model (SRS 3.3: OpenAI).

extract_pdf lists the pictures that sit by a "Table N" caption; each one the model transcribes replaces its
`![](pm-image:…)` line in the clean text, so the table can be read, searched, highlighted and asked about
like any other. A picture the model cannot read stays a picture: OCR never fails an extraction.
"""

import asyncio
import logging
import re
import uuid

from app.core.config import Settings
from app.services import chat_image, openai_client, storage

log = logging.getLogger("app.ai")

MAX_TABLES = 20  # per document: bounds the cost of one upload
CONCURRENCY = 4
MAX_EDGE = 2048  # small type (subscripts, footnote marks) must stay legible
NOT_A_TABLE = "NOT_A_TABLE"

PROMPT = f"""Transcribe the table in the image into a GitHub-flavoured Markdown table.

- Output only the table: no code fence, no caption, no comment.
- Copy every cell exactly as printed: numbers, units, signs and symbols. Write Greek letters, subscripts \
and superscripts in Unicode (ρd, wL, cm³, σ′); do not convert or round anything.
- The first row of the Markdown table is the table's header. A header of several levels becomes one row \
whose cells join the levels ("Stress – σ (kPa)").
- Every row has the same number of cells as the table has columns. A cell spanning several rows or columns \
(a section title across the table, a group header): write its text in the first cell it covers, leave the \
others empty.
- Read subscripts and superscripts of several letters whole (e₀ˢˢ, e₀ⁱˡ, e_NC); write one that has no \
Unicode form with "_" or "^".
- A cell of several lines: join them with a space, or with <br> where the lines are separate items.
- Escape a "|" inside a cell as "\\|".
- If the image is not a table, output exactly {NOT_A_TABLE}."""

FENCE = re.compile(r"^```[a-z]*\n|\n```$")
SEPARATOR = re.compile(r"^\|(\s*:?-{3,}:?\s*\|)+$")
NUMBER = re.compile(r"\d+(?:[.,]\d+)*(?:[eE][-+−]?\d+)?")
READINGS = 2  # independent readings of each table that must agree on its numbers
CELL_SPLIT = re.compile(r"(?<!\\)\|")  # "\|" is a bar inside a cell


def _markdown_table(text: str) -> str | None:
    """The model's answer if it is a Markdown table (a header, its separator and at least one row)."""
    lines = [ln.strip() for ln in FENCE.sub("", text.strip()).strip().split("\n") if ln.strip()]
    if len(lines) < 3 or not all(ln.startswith("|") and ln.endswith("|") for ln in lines):
        return None
    if not SEPARATOR.match(lines[1].replace(" ", "")):
        return None
    # Rows short of cells (a section title across the table) are padded, or the columns would shift.
    rows = [[c.strip() for c in CELL_SPLIT.split(ln)[1:-1]] for ln in lines[:1] + lines[2:]]
    width = max(len(r) for r in rows)
    out = ["| " + " | ".join(r + [""] * (width - len(r))) + " |" for r in rows]
    return "\n".join([out[0], "|" + "---|" * width, *out[1:]])


def _numbers(table: str) -> list[str]:
    return NUMBER.findall(table)


async def _transcribe(settings: Settings, document_id: uuid.UUID, name: str) -> str | None:
    """The table, when two independent readings agree on every number in it: a vision model can misread or
    make up a value, and a wrong number in a table of results is worse than a picture of the right one."""
    try:
        data_url = await chat_image.load(settings, document_id, f"pm-image:{name}", MAX_EDGE)
        messages = [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": PROMPT},
                    {"type": "image_url", "image_url": {"url": data_url, "detail": "high"}},
                ],
            }
        ]
        answers = await asyncio.gather(
            *(openai_client.chat(settings, messages, purpose="table_ocr") for _ in range(READINGS))
        )
    except (chat_image.ImageUnavailable, openai_client.AIError):
        return None
    tables = [_markdown_table(a.text) for a in answers]
    if any(t is None for t in tables) or len({tuple(_numbers(t)) for t in tables}) > 1:
        return None
    return tables[0]


async def transcribe_tables(
    settings: Settings, document_id: uuid.UUID, content: str, names: list[str]
) -> tuple[str, dict[str, str]]:
    """The clean text with each table picture the model could read replaced by its Markdown table, and
    the replacements made (the picture's line -> the table)."""
    names = list(dict.fromkeys(names))[:MAX_TABLES]
    replaced: dict[str, str] = {}
    if not names or not settings.openai_api_key:
        return content, replaced
    limit = asyncio.Semaphore(CONCURRENCY)

    async def one(name: str) -> str | None:
        async with limit:
            return await _transcribe(settings, document_id, name)

    tables = await asyncio.gather(*(one(n) for n in names))
    folder = storage.resolve(settings, storage.images_path(document_id))
    for name, table in zip(names, tables, strict=True):
        if table is None:
            log.info("table_ocr kept the picture document=%s image=%s", document_id, name)
            continue
        line = re.compile(r"^!\[\]\(pm-image:" + re.escape(name) + r"\)$", re.M)
        content = line.sub(lambda _, t=table: t, content)  # a function: the table's "\" are not escapes
        replaced[f"![](pm-image:{name})"] = table
        if not re.search(r"pm-image:" + re.escape(name), content):
            (folder / name).unlink(missing_ok=True)  # the picture is no longer shown
    return content, replaced
