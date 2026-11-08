"""What a document's licence allows when its reader wants to write about it publicly.

Only a copy of a shared article has a known licence. What a user uploads or saves from elsewhere has none, and
is treated as theirs to answer for: they confirm their rights when they publish, and its file is never public.
"""

from urllib.parse import urlsplit

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Article, Document

# The Conversation publishes under CC BY-ND throughout, even when the article is not in the catalogue here.
_ND_HOSTS = ("theconversation.com",)
_ND_LICENSE = "CC BY-ND 4.0"


def no_derivatives(license: str | None) -> bool:
    """CC BY-ND: it may be shared as it is and linked to, but never summarised, translated or adapted."""
    return bool(license) and "ND" in license.upper()


def _nd_host(url: str) -> bool:
    host = (urlsplit(url).hostname or "").lower()
    return any(host == h or host.endswith(f".{h}") for h in _ND_HOSTS)


async def license_of_url(session: AsyncSession, url: str | None) -> str | None:
    if not url:
        return None
    known = await session.scalar(select(Article.license).where(Article.url == url))
    if known:
        return known
    return _ND_LICENSE if _nd_host(url) else None


async def license_of(session: AsyncSession, doc: Document) -> str | None:
    """Looked up again when it matters: the article may have reached the catalogue after the copy was made."""
    return doc.license or await license_of_url(session, doc.url)


def credit_of(doc: Document) -> str:
    """The authors, container and year the user's citation gives; never the name of an uploaded file."""
    citation = doc.citation or {}
    authors = ", ".join(
        " ".join(p for p in (a.get("given"), a.get("family")) if p).strip()
        for a in (citation.get("authors") or [])
        if isinstance(a, dict)
    )
    parts = [authors, citation.get("container") or "", str(citation.get("year") or "")]
    return ". ".join(p for p in parts if p)[:1000]
