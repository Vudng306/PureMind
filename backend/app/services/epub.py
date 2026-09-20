"""EPUB validation and extraction (SRS FR-DOC-01 step 3, FR-DOC-02 step 3)."""

import posixpath
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

from bs4 import BeautifulSoup

from app.services.extraction import ExtractionError, ExtractionResult
from app.services.html_markdown import clean_soup, html_to_markdown, word_count

MAX_ENTRIES = 5000
MAX_UNCOMPRESSED = 300 * 1024 * 1024  # zip-bomb guard
MIN_CHAPTER_CHARS = 50
NS = {
    "c": "urn:oasis:names:tc:opendocument:xmlns:container",
    "opf": "http://www.idpf.org/2007/opf",
    "dc": "http://purl.org/dc/elements/1.1/",
}
JUNK_HINTS = ("nav", "toc", "footnote", "copyright", "advert")


def looks_like_epub(head: bytes) -> bool:
    """A ZIP whose first entry is `mimetype` = application/epub+zip (stored uncompressed)."""
    return head.startswith(b"PK\x03\x04") and b"mimetypeapplication/epub+zip" in head


def extract_epub(path: Path, fallback_title: str) -> ExtractionResult:
    try:
        zf = zipfile.ZipFile(path)
    except (zipfile.BadZipFile, OSError) as e:
        raise ExtractionError("MSG-13") from e

    with zf:
        infos = zf.infolist()
        if len(infos) > MAX_ENTRIES or sum(i.file_size for i in infos) > MAX_UNCOMPRESSED:
            raise ExtractionError("MSG-13")
        names = {i.filename for i in infos}
        if "META-INF/encryption.xml" in names:  # DRM-protected content cannot be read
            raise ExtractionError("MSG-13")
        try:
            container = ET.fromstring(zf.read("META-INF/container.xml"))
            rootfile = container.find(".//c:rootfile", NS).get("full-path")
            opf = ET.fromstring(zf.read(rootfile))
        except (KeyError, AttributeError, ET.ParseError) as e:
            raise ExtractionError("MSG-13") from e

        base = posixpath.dirname(rootfile)
        manifest = {
            item.get("id"): (
                posixpath.normpath(posixpath.join(base, item.get("href", ""))),
                item.get("media-type", ""),
                item.get("properties", ""),
            )
            for item in opf.findall(".//opf:manifest/opf:item", NS)
        }
        title_el = opf.find(".//dc:title", NS)
        title = (title_el.text or "").strip() if title_el is not None else ""

        chapters: list[str] = []
        for ref in opf.findall(".//opf:spine/opf:itemref", NS):
            entry = manifest.get(ref.get("idref"))
            if not entry:
                continue
            href, media_type, props = entry
            if "html" not in media_type or "nav" in props.split() or href not in names:
                continue
            soup = BeautifulSoup(zf.read(href), "html.parser")
            clean_soup(soup)
            for el in soup.find_all(True):
                if el.decomposed:
                    continue
                hint = " ".join(
                    [*(el.get("class") or []), el.get("id") or "", el.get("epub:type") or ""]
                ).lower()
                if any(h in hint for h in JUNK_HINTS):
                    el.decompose()
            body = soup.body or soup
            md = html_to_markdown(body)
            if len(md) >= MIN_CHAPTER_CHARS:
                chapters.append(md)

    content = "\n\n".join(chapters)
    if not content.strip():
        raise ExtractionError("MSG-15")
    return ExtractionResult(
        title=title or fallback_title, content=content, page_count=None, word_count=word_count(content)
    )
