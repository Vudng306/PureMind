"""Numbered display equations read back as LaTeX by the vision model (SRS 3.3: OpenAI).

extract_pdf keeps each numbered equation as a picture, since its text layer (math fonts, stretched
delimiters, stacked fractions) does not read back as the equation; each picture the model transcribes
replaces its `![](pm-image:…)` line in the clean text with a `$$…$$` line the reader typesets. A picture the
model cannot read, or reads two ways, stays a picture: OCR never fails an extraction.
"""

import asyncio
import logging
import re
import uuid

from app.core.config import Settings
from app.services import chat_image, openai_client, storage

log = logging.getLogger("app.ai")

MAX_EQUATIONS = 60  # per document: bounds the cost of one upload
CONCURRENCY = 4
MAX_EDGE = 1600
MAX_LATEX = 1500  # characters
READINGS = 2  # independent readings that must agree
NOT_AN_EQUATION = "NOT_AN_EQUATION"

PROMPT = f"""Transcribe the equation in the image into LaTeX.

- Output only the LaTeX of the equation, on one line: no $ or \\[ delimiters, no code fence, no comment.
- Copy it exactly as printed: every symbol, subscript and superscript. Do not simplify, rearrange or \
complete it.
- Leave out the equation's number; write no \\tag or \\label.
- Upright subscripts and units as printed, with \\mathrm (\\rho_{{\\mathrm{{w}}}}).
- A fraction written with a slanted bar (ᴹ⁄ₘ) is a fraction: write \\frac.
- Several aligned lines: one \\begin{{aligned}} … \\end{{aligned}} with \\\\ between the lines.
- If the image is not an equation, output exactly {NOT_AN_EQUATION}."""

FENCE = re.compile(r"^```[a-z]*\n|\n```$")
DELIMITERS = re.compile(r"^(?:\$\$?|\\\[|\\\()\s*|\s*(?:\$\$?|\\\]|\\\))$")
TAG = re.compile(r"\\(?:tag|label)\*?\{[^{}]*\}")
# What two readings of one equation may differ by without it being a different equation.
STYLE = re.compile(
    r"\\(?:left|right|big|Big|bigg|Bigg|displaystyle|mathrm|mathit|text|operatorname)\b|\\[,;:! ]"
)
SPACE = re.compile(r"\s+")


def _latex(text: str) -> str | None:
    """The model's answer if it is the LaTeX of an equation, on one line."""
    text = DELIMITERS.sub("", FENCE.sub("", text.strip()).strip()).strip()
    text = TAG.sub("", SPACE.sub(" ", text)).strip()
    if not text or NOT_AN_EQUATION in text or len(text) > MAX_LATEX or "$" in text:
        return None
    depth = 0
    for i, ch in enumerate(text):  # braces must pair up, or the reader could not typeset it
        if ch in "{}" and (i == 0 or text[i - 1] != "\\"):
            depth += 1 if ch == "{" else -1
            if depth < 0:
                return None
    return text if depth == 0 else None


def _same(a: str, b: str) -> bool:
    def norm(s: str) -> str:
        s = STYLE.sub("", s).replace("\\dfrac", "\\frac").replace("\\tfrac", "\\frac")
        return re.sub(r"[\s{}]", "", s)

    return norm(a) == norm(b)


async def _transcribe(settings: Settings, document_id: uuid.UUID, name: str) -> str | None:
    """The equation's LaTeX, when two independent readings agree: a wrong symbol in an equation changes
    what it says, and a picture of the right one is better."""
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
            *(openai_client.chat(settings, messages, purpose="equation_ocr") for _ in range(READINGS))
        )
    except (chat_image.ImageUnavailable, openai_client.AIError):
        return None
    readings = [_latex(a.text) for a in answers]
    if any(r is None for r in readings) or not all(_same(readings[0], r) for r in readings[1:]):
        return None
    return readings[0]


def math_line(latex: str, tag: str | None = None) -> str:
    """The clean text's line for a display equation: `$$…$$`, numbered with \\tag."""
    number = " \\tag{" + tag + "}" if tag else ""
    return f"$${latex}{number}$$"


async def transcribe_equations(
    settings: Settings, document_id: uuid.UUID, content: str, equations: dict[str, str]
) -> tuple[str, dict[str, str]]:
    """The clean text with each equation picture the model could read replaced by its `$$…$$` line, and
    the replacements made (the picture's line -> the equation's line). `equations`: picture -> number."""
    names = list(equations)[:MAX_EQUATIONS]
    replaced: dict[str, str] = {}
    if not names or not settings.openai_api_key:
        return content, replaced
    limit = asyncio.Semaphore(CONCURRENCY)

    async def one(name: str) -> str | None:
        async with limit:
            return await _transcribe(settings, document_id, name)

    readings = await asyncio.gather(*(one(n) for n in names))
    folder = storage.resolve(settings, storage.images_path(document_id))
    for name, latex in zip(names, readings, strict=True):
        if latex is None:
            log.info("equation_ocr kept the picture document=%s image=%s", document_id, name)
            continue
        line = math_line(latex, equations[name])
        pattern = re.compile(r"^!\[\]\(pm-image:" + re.escape(name) + r"\)$", re.M)
        content = pattern.sub(lambda _, t=line: t, content)  # a function: LaTeX's "\" are not escapes
        replaced[f"![](pm-image:{name})"] = line
        if not re.search(r"pm-image:" + re.escape(name), content):
            (folder / name).unlink(missing_ok=True)
    return content, replaced
