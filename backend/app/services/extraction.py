"""PDF content extraction with PyMuPDF (SRS FR-DOC-02, CON-04)."""

import re
import statistics
from dataclasses import dataclass
from pathlib import Path

import pymupdf

PAGE_SEPARATOR = "\n\n---\n\n"
BOLD_FLAG = 1 << 4


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


def _span_text(span: dict) -> str:
    text = span["text"]
    if not text.strip():
        return text
    if span["flags"] & BOLD_FLAG:
        lead = text[: len(text) - len(text.lstrip())]
        trail = text[len(text.rstrip()) :]
        return f"{lead}**{text.strip()}**{trail}"
    return text


def _inside(bbox, rects) -> bool:
    x0, y0, x1, y1 = bbox
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    return any(r.x0 <= cx <= r.x1 and r.y0 <= cy <= r.y1 for r in rects)


def _page_markdown(page: "pymupdf.Page", body_size: float) -> str:
    parts: list[tuple[float, str]] = []

    tables = []
    # find_tables' default "lines" strategy needs ruling lines; skipping pages without vector drawings
    # avoids its (expensive) character analysis on plain text pages (NFR-PERF-06).
    if len(page.get_cdrawings()) >= 2:
        try:
            tables = list(page.find_tables().tables)
        except Exception:  # table detection is best effort
            tables = []
    table_rects = [pymupdf.Rect(t.bbox) for t in tables]
    for t in tables:
        md = t.to_markdown(clean=True).strip()
        if md:
            parts.append((t.bbox[1], md))

    data = page.get_text("dict", flags=pymupdf.TEXTFLAGS_TEXT)
    for block in data["blocks"]:
        if block["type"] == 1:
            parts.append((block["bbox"][1], "*[Hình ảnh]*"))
            continue
        if _inside(block["bbox"], table_rects):
            continue
        lines = []
        sizes = []
        for line in block["lines"]:
            spans = line["spans"]
            text = "".join(_span_text(s) for s in spans).strip()
            if text:
                lines.append(text)
                sizes.extend(s["size"] for s in spans if s["text"].strip())
        if not lines:
            continue
        text = " ".join(lines)
        text = re.sub(r"\*\*\s*\*\*", "", text)
        prefix = _heading_prefix(max(sizes), body_size) if sizes else ""
        if prefix:
            text = prefix + text.replace("**", "")
        parts.append((block["bbox"][1], text))

    parts.sort(key=lambda p: p[0])
    return "\n\n".join(p[1] for p in parts)


def extract_pdf(path: Path, fallback_title: str) -> ExtractionResult:
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
        for page in doc:
            for block in page.get_text("dict", flags=pymupdf.TEXTFLAGS_TEXT)["blocks"]:
                for line in block.get("lines", []):
                    for span in line["spans"]:
                        if span["text"].strip():
                            sizes.extend([span["size"]] * len(span["text"]))
        if not sizes:
            raise ExtractionError("MSG-15")
        body_size = statistics.median(sizes)

        pages = [_page_markdown(page, body_size) for page in doc]
        content = PAGE_SEPARATOR.join(p for p in pages if p.strip())
        if not content.strip():
            raise ExtractionError("MSG-15")

        meta_title = (doc.metadata or {}).get("title") or ""
        return ExtractionResult(
            title=meta_title.strip() or fallback_title,
            content=content,
            page_count=doc.page_count,
            word_count=len(re.findall(r"\w+", content)),
        )
