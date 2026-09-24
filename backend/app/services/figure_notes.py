"""Figures described in words for the AI (SRS 3.3: OpenAI), once per document, after its text is extracted.

The summary and the chat read text only, so a figure used to be dropped from what they see — and with it
the results a paper shows in its charts. Each figure extracted from the file (`pm-image:`) is described
once by the vision model; the AI text then carries `[Figure: …]` where the image was (html_markdown.
strip_images), so the chat can find a figure by what it shows and the summary can mention it. The reader
still shows the image itself. A figure that cannot be described is left out, as before: this never fails
anything.
"""

import asyncio
import logging
import re
import uuid

from app.core.config import Settings
from app.services import chat_image, openai_client
from app.services.summarizer import Language, detect_language

log = logging.getLogger("app.ai")

MAX_FIGURES = 30  # per document: bounds the cost of one upload
CONCURRENCY = 4
MAX_EDGE = 1024  # enough to read axis labels and legends
MAX_NOTE_CHARS = 1200
SKIP = "SKIP"
FIGURE_LINE = re.compile(r"^!\[[^\]\n]*\]\(pm-image:([0-9a-f]{16}\.webp)\)$", re.M)
LANGUAGE_NAMES: dict[Language, str] = {"vi": "Vietnamese", "en": "English"}

PROMPT = """You describe a figure from a document for a search index and for an assistant that answers \
questions about the document but cannot see the figure.

Write {language} plain text, 2 to 6 sentences, with no Markdown and no preamble ("This image shows…" is \
fine, "Sure" is not):
- what kind of figure it is (line chart, bar chart, scatter plot, schematic, flowchart, photograph, map…) \
and what it shows;
- for a chart: the quantity on each axis with its unit, the series or cases compared, and the trends, \
peaks, crossings and values that can be read from it;
- for a diagram: its parts and how they are connected;
- labels and symbols as printed (keep symbols such as σ, e, w_L unchanged).
State only what the figure shows; do not guess beyond it. If the image is only decoration (a logo, an \
icon, a border, an empty area), output exactly {skip}."""


def figure_names(content: str) -> list[str]:
    """The document's own figures in the clean text, in reading order, each once."""
    return list(dict.fromkeys(FIGURE_LINE.findall(content)))


async def _describe(
    settings: Settings, document_id: uuid.UUID, content: str, name: str, language: Language
) -> str | None:
    src = f"pm-image:{name}"
    figure = chat_image.find(content, src)
    about = [PROMPT.format(language=LANGUAGE_NAMES[language], skip=SKIP)]
    if figure and figure.context:
        about.append("Where the figure sits in the document (use it for names and units):\n" + figure.context)
    try:
        data_url = await chat_image.load(settings, document_id, src, MAX_EDGE)
        answer = await openai_client.chat(
            settings,
            [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": "\n\n".join(about)},
                        {"type": "image_url", "image_url": {"url": data_url, "detail": "high"}},
                    ],
                }
            ],
            purpose="figure_notes",
        )
    except (chat_image.ImageUnavailable, openai_client.AIError):
        return None
    note = " ".join(answer.text.split())  # one line: it stands in for the image line
    if not note or note.strip(" .").upper() == SKIP:
        return None
    return note[:MAX_NOTE_CHARS]


async def describe_figures(settings: Settings, document_id: uuid.UUID, content: str) -> dict[str, str]:
    """{image name: description} for the figures the model could describe."""
    names = figure_names(content)[:MAX_FIGURES]
    if not names or not settings.openai_api_key:
        return {}
    language = detect_language(content)
    limit = asyncio.Semaphore(CONCURRENCY)

    async def one(name: str) -> str | None:
        async with limit:
            return await _describe(settings, document_id, content, name, language)

    notes = await asyncio.gather(*(one(n) for n in names))
    skipped = sum(n is None for n in notes)
    if skipped:
        log.info("figure_notes left out %d of %d figures document=%s", skipped, len(names), document_id)
    return {name: note for name, note in zip(names, notes, strict=True) if note}
