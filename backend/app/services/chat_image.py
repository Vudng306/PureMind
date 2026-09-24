"""A figure the reader asks the chat about: find it in the document, load it, and hand it to the model.

Only images that are in the document's own clean text can be asked about — extracted ones (`pm-image:`) are
read from storage, a web article's are fetched with the same public-address checks as the article itself —
so the chat is never a way to send the AI, or to make the server fetch, an arbitrary address.
"""

import base64
import io
import re
import uuid
from dataclasses import dataclass

from PIL import Image

from app.core.config import Settings
from app.services import storage, web
from app.services.extraction import IMAGE_NAME
from app.services.html_markdown import strip_images

DOC_IMAGE = re.compile(r"^pm-image:(.+)$")
HEADING = re.compile(r"^#{1,6}\s+(.+?)\s*#*$")
MAX_EDGE = 1024  # enough to read a chart; bigger only costs more tokens
MAX_CONTEXT_CHARS = 1500


class ImageUnavailable(Exception):
    pass


@dataclass
class Figure:
    src: str
    alt: str
    context: str  # the heading above it and the text just before and after it


def find(content: str, src: str) -> Figure | None:
    """The image line for `src` in the document's clean text, with the text around it."""
    lines = content.split("\n")
    pattern = re.compile(r"^\s*!\[([^\]\n]*)\]\(" + re.escape(src) + r"\)\s*$")
    for i, line in enumerate(lines):
        if m := pattern.match(line):
            return Figure(src, m.group(1).strip(), _context(lines, i))
    return None


def _paragraphs(lines: list[str]) -> list[str]:
    text = strip_images("\n".join(lines))
    return [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip() and p.strip() != "---"]


def _context(lines: list[str], at: int) -> str:
    heading = next((m.group(1) for line in reversed(lines[:at]) if (m := HEADING.match(line))), None)
    before = [p for p in _paragraphs(lines[:at]) if not HEADING.match(p)][-1:]
    after = [p for p in _paragraphs(lines[at + 1 :]) if not HEADING.match(p)][:1]
    half = MAX_CONTEXT_CHARS // 2
    parts = [f"Section: {heading}"] if heading else []
    parts += [f"Text before the figure: {p[-half:]}" for p in before]
    parts += [f"Text after the figure: {p[:half]}" for p in after]
    return "\n".join(parts)


async def load(settings: Settings, document_id: uuid.UUID, src: str, max_edge: int = MAX_EDGE) -> str:
    """The image as a data URL small enough to send, or ImageUnavailable."""
    if m := DOC_IMAGE.match(src):
        if not IMAGE_NAME.match(m.group(1)):
            raise ImageUnavailable
        path = storage.resolve(settings, f"{storage.images_path(document_id)}/{m.group(1)}")
        try:
            data = path.read_bytes()
        except OSError as e:
            raise ImageUnavailable from e
    else:
        try:
            data = (await web.fetch_url(src, settings.web_contact)).body
        except (web.InvalidUrl, web.BlockedAddress, web.FetchFailed) as e:
            raise ImageUnavailable from e
    try:
        with Image.open(io.BytesIO(data)) as img:
            img = img.convert("RGB")
            img.thumbnail((max_edge, max_edge))
            out = io.BytesIO()
            img.save(out, "JPEG", quality=85)
    except Exception as e:  # not an image Pillow reads (SVG, HTML error page, a decompression bomb…)
        raise ImageUnavailable from e
    return "data:image/jpeg;base64," + base64.b64encode(out.getvalue()).decode()
