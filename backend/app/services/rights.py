"""The licence known for a saved address: the shared article's, or the one its publisher always uses."""

from urllib.parse import urlsplit

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Article

# The Conversation publishes under CC BY-ND throughout, even when the article is not in the catalogue here.
_ND_HOSTS = ("theconversation.com",)
_ND_LICENSE = "CC BY-ND 4.0"


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
