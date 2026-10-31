"""The feed's shared articles: storing what the sources bring (once each), and the order they are shown in."""

import hashlib
import re
import unicodedata
import uuid
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import TOPICS, Article, ArticleTopic, utcnow
from app.services.html_markdown import word_count
from app.services.sources import Item, plain

# Sources whose articles are news: their newest come first. The others are evergreen and mixed.
NEWS_KINDS = ("explainer", "data")


def title_key(title: str) -> str:
    """The title without case, accents or punctuation: the same work under two sources' spellings."""
    folded = unicodedata.normalize("NFD", title.replace("đ", "d").replace("Đ", "D"))
    folded = "".join(c for c in folded if not unicodedata.combining(c)).lower()
    return " ".join(re.findall(r"[a-z0-9]+", folded))[:500]


def shuffle(url: str) -> float:
    """A number in [0, 1) that stays the same for an address: a stable shuffle."""
    return int(hashlib.sha256(url.encode()).hexdigest()[:8], 16) / 0x100000000


def ranks(rows: list[tuple[uuid.UUID, str, str, str, datetime | None]]) -> dict[uuid.UUID, float]:
    """The feed's order for (id, source, url, kind, published_at) rows: the sources take turns, so a page
    mixes them however many articles each has; within a source the newest news comes first."""
    by_source: dict[str, list[tuple]] = defaultdict(list)
    for row in rows:
        by_source[row[1]].append(row)
    order: dict[uuid.UUID, float] = {}
    for found in by_source.values():
        found.sort(
            key=lambda r: (
                (-(r[4].timestamp() if r[4] else 0), shuffle(r[2]))
                if r[3] in NEWS_KINDS
                else (shuffle(r[2]),)
            )
        )
        for i, (id_, _, url, _, _) in enumerate(found):
            # Turn i of every source, in an order of their own that changes from turn to turn.
            order[id_] = -(i + shuffle(f"{i}:{url}") * 0.99)
    return order


@dataclass
class Stored:
    added: int = 0
    updated: int = 0
    duplicates: int = 0


def _fill(article: Article, item: Item) -> None:
    article.source = item.source
    article.title = item.title[:500]
    article.title_key = title_key(item.title)
    article.authors = item.authors[:1000]
    article.language = item.language
    article.kind = item.kind
    article.license = item.license
    article.license_url = item.license_url
    article.credit = item.credit[:1000]
    article.summary = plain(item.summary)
    article.content = item.content
    article.image_url = item.image_url
    article.word_count = word_count(item.content)
    article.doi = item.doi
    article.published_at = item.published_at


async def store(session: AsyncSession, items: list[Item]) -> Stored:
    """Add the new articles and refresh the known ones (by address), with the topics their source gives
    now. A title already in the feed from another source is the same work: it is not added twice, only
    given the new topics."""
    result = Stored()
    for item in items:
        topics = {t for t in item.topics if t in TOPICS} or {"science"}
        # Looked up first: a query flushes, after which a new article's topics would have to be loaded.
        based_on = item.based_on and await session.scalar(
            select(Article.id).where(Article.url == item.based_on)
        )
        article = await session.scalar(select(Article).where(Article.url == item.url))
        if article is None:
            article = await session.scalar(select(Article).where(Article.title_key == title_key(item.title)))
            if article is not None:
                result.duplicates += 1
                _add_topics(article, topics)
                continue
            article = Article(url=item.url, collected_at=utcnow())
            _fill(article, item)
            session.add(article)
            result.added += 1
        else:
            _fill(article, item)
            # The source's own topics replace the old ones, so a change of the topic list reaches it,
            # and the guides written from it.
            guides = list(await session.scalars(select(Article).where(Article.based_on_id == article.id)))
            for each in [article, *guides]:
                each.topics = [t for t in each.topics if t.topic in topics]
                _add_topics(each, topics)
            result.updated += 1
        if based_on:
            article.based_on_id = based_on
        _add_topics(article, topics)
        await session.flush()
    await rerank(session)
    return result


def _add_topics(article: Article, topics: set[str]) -> None:
    have = {t.topic for t in article.topics}
    article.topics.extend(ArticleTopic(topic=t) for t in sorted(topics - have))


async def rerank(session: AsyncSession) -> None:
    """Order the whole feed again, now that a source has new articles."""
    rows = await session.execute(
        select(Article.id, Article.source, Article.url, Article.kind, Article.published_at)
    )
    order = ranks([tuple(r) for r in rows])
    if order:
        await session.execute(update(Article), [{"id": k, "rank": v} for k, v in order.items()])
    await session.commit()


def source_names() -> dict[str, str]:
    from app.services import guides
    from app.services.sources import conversation, elife, europepmc, frym, owid, plos

    return {m.SOURCE: m.NAME for m in (conversation, owid, plos, europepmc, elife, frym, guides)}
