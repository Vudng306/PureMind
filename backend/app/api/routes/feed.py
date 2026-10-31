"""The feed (Bảng tin): openly licensed articles by topic, to read in the app.

Reading one puts a copy in the user's library, headed by the credit its licence asks for, so the reader,
highlights, summaries and the AI work on it as on anything the user added.
"""

import logging
import uuid
from collections.abc import AsyncIterator
from datetime import datetime

from fastapi import APIRouter, HTTPException, Query, Request, status
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased, undefer

from app.api.deps import CurrentUser, SessionDep, SettingsDep
from app.api.routes.chat import IN_PROGRESS, _sse
from app.api.routes.documents import _commit_new_link
from app.api.routes.summaries import CONSENT_REQUIRED, NOT_CONFIGURED
from app.core.messages import MSG
from app.db.session import SessionLocal
from app.models import TOPICS, Article, ArticleTopic, Document, ExtractionStatus, Short, SourceType, User
from app.schemas import Citation, DocumentOut, ExploreAsk
from app.services import ai_quota, embeddings, explore_chat
from app.services.articles import source_names
from app.services.html_markdown import word_count
from app.services.openai_client import AIError, Usage

router = APIRouter(prefix="/feed", tags=["feed"])
log = logging.getLogger("app.feed")

PAGE_SIZE = 20


class BasedOn(BaseModel):
    """The article a guide was written from."""

    title: str
    source_name: str
    url: str


class ArticleCard(BaseModel):
    id: uuid.UUID
    source: str
    source_name: str
    url: str
    title: str
    authors: str
    summary: str
    language: str
    kind: str
    license: str
    topics: list[str]
    word_count: int
    image_url: str | None
    published_at: datetime | None
    based_on: BasedOn | None = None
    # The user's copy, once they have opened it.
    document_id: uuid.UUID | None = None


class FeedPage(BaseModel):
    articles: list[ArticleCard]
    total: int
    has_more: bool
    # The topics the user follows; None until they have chosen.
    following: list[str] | None


class ShortCard(BaseModel):
    """A short post, with the article it was written from and what "read on" opens."""

    id: uuid.UUID
    title: str
    hook: str
    points: list[str]
    takeaway: str
    topics: list[str]
    source_name: str
    original_title: str
    original_url: str
    license: str
    license_url: str
    # What "read on" opens: the guide written from the article if there is one, else the article.
    read_id: uuid.UUID
    read_kind: str
    read_words: int
    # The user's copy of it, once they have opened it.
    document_id: uuid.UUID | None = None


class ShortsPage(BaseModel):
    shorts: list[ShortCard]
    total: int
    has_more: bool


class TopicCount(BaseModel):
    id: str
    count: int


class Topics(BaseModel):
    topics: list[TopicCount]
    following: list[str] | None


class ExploreAnswer(BaseModel):
    """An answer of the feed's chat: `articles` are the ones it was given, numbered from 1 as in the answer's
    [n]; `cited` the numbers it recommended, in order."""

    content: str
    articles: list[ArticleCard]
    cited: list[int]
    chat_quota_remaining: int


class FollowIn(BaseModel):
    topics: list[str] = Field(min_length=1, max_length=len(TOPICS))


def _following(user) -> list[str] | None:
    chosen = (user.reading_preferences or {}).get("topics")
    return [t for t in chosen if t in TOPICS] if isinstance(chosen, list) else None


@router.get("", response_model=FeedPage)
async def list_feed(
    user: CurrentUser,
    session: SessionDep,
    topic: str | None = None,
    offset: int = Query(0, ge=0, le=10_000),
    limit: int = Query(PAGE_SIZE, ge=1, le=50),
):
    """The articles of one topic, or of every topic the user follows (all of them before they choose)."""
    if topic is not None and topic not in TOPICS:
        raise HTTPException(422, MSG["MSG-INVALID"])
    following = _following(user)
    wanted = [topic] if topic else following
    stmt = select(Article)
    if wanted:
        stmt = stmt.where(
            Article.id.in_(select(ArticleTopic.article_id).where(ArticleTopic.topic.in_(wanted)))
        )
    total = await session.scalar(select(func.count()).select_from(stmt.subquery())) or 0
    found = list(
        await session.scalars(stmt.order_by(Article.rank.desc(), Article.id).offset(offset).limit(limit))
    )
    cards = await _cards(session, user.id, found)
    return FeedPage(articles=cards, total=total, has_more=offset + len(cards) < total, following=following)


async def _cards(session: AsyncSession, user_id: uuid.UUID, found: list[Article]) -> list[ArticleCard]:
    """The articles as the page shows them, with the user's copy of each they have opened."""
    copies = {}
    if found:
        rows = await session.execute(
            select(Document.url, Document.id).where(
                Document.user_id == user_id, Document.url.in_([a.url for a in found])
            )
        )
        copies = dict(rows.all())
    names = source_names()
    return [
        ArticleCard(
            id=a.id,
            source=a.source,
            source_name=names.get(a.source, a.source),
            url=a.url,
            title=a.title,
            authors=a.authors,
            summary=a.summary,
            language=a.language,
            kind=a.kind,
            license=a.license,
            topics=sorted(t.topic for t in a.topics),
            word_count=a.word_count,
            image_url=a.image_url,
            published_at=a.published_at,
            based_on=BasedOn(
                title=a.based_on.title,
                source_name=names.get(a.based_on.source, a.based_on.source),
                url=a.based_on.url,
            )
            if a.based_on
            else None,
            document_id=copies.get(a.url),
        )
        for a in found
    ]


@router.get("/shorts", response_model=ShortsPage)
async def list_shorts(
    user: CurrentUser,
    session: SessionDep,
    topic: str | None = None,
    offset: int = Query(0, ge=0, le=10_000),
    limit: int = Query(PAGE_SIZE, ge=1, le=50),
):
    """Short posts in the feed's order, of one topic or of the topics the user follows."""
    if topic is not None and topic not in TOPICS:
        raise HTTPException(422, MSG["MSG-INVALID"])
    wanted = [topic] if topic else _following(user)
    guide = aliased(Article)
    stmt = (
        select(Short, Article, guide)
        .join(Article, Short.article_id == Article.id)
        .outerjoin(guide, guide.based_on_id == Article.id)
    )
    if wanted:
        stmt = stmt.where(
            Article.id.in_(select(ArticleTopic.article_id).where(ArticleTopic.topic.in_(wanted)))
        )
    total = await session.scalar(select(func.count()).select_from(stmt.subquery())) or 0
    rows = (
        await session.execute(stmt.order_by(Article.rank.desc(), Short.id).offset(offset).limit(limit))
    ).all()
    reads = [g or a for _, a, g in rows]
    copies = {}
    if reads:
        found = await session.execute(
            select(Document.url, Document.id).where(
                Document.user_id == user.id, Document.url.in_([r.url for r in reads])
            )
        )
        copies = dict(found.all())
    names = source_names()
    cards = [
        ShortCard(
            id=short.id,
            title=short.title,
            hook=short.hook,
            points=short.points,
            takeaway=short.takeaway,
            topics=sorted(t.topic for t in article.topics),
            source_name=names.get(article.source, article.source),
            original_title=article.title,
            original_url=article.url,
            license=article.license,
            license_url=article.license_url,
            read_id=read.id,
            read_kind=read.kind,
            read_words=read.word_count,
            document_id=copies.get(read.url),
        )
        for (short, article, _), read in zip(rows, reads, strict=True)
    ]
    return ShortsPage(shorts=cards, total=total, has_more=offset + len(cards) < total)


# Users with a message being answered by this process, so a double click does not spend two questions.
_chatting: set[uuid.UUID] = set()


@router.post("/chat", response_model=ExploreAnswer)
async def chat(payload: ExploreAsk, request: Request, user: CurrentUser, settings: SettingsDep):
    """Talk about what to learn: the AI explains the subject briefly and recommends the feed's articles on it.

    The page keeps the conversation and sends the earlier turns along. With `Accept: text/event-stream` the
    answer is streamed: `sources` (the articles found), `delta`s, then `done` or `error`. A message costs one
    of the day's chat questions, like a question about a document; a failed answer costs none.
    """
    if not (user.reading_preferences or {}).get("ai_consent"):  # NFR-PRV: nothing leaves before consent
        raise HTTPException(status.HTTP_403_FORBIDDEN, CONSENT_REQUIRED)
    if not settings.openai_api_key:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, NOT_CONFIGURED)
    if ai_quota.chat_remaining(user, settings.chat_daily_quota) <= 0:
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, MSG["MSG-CHAT-QUOTA"])
    if user.id in _chatting:
        raise HTTPException(status.HTTP_409_CONFLICT, IN_PROGRESS)
    user_id, message, language = user.id, payload.content, payload.language
    history = [(t.role, t.content) for t in payload.history]

    async def work() -> AsyncIterator[tuple[str, dict]]:
        # Embedding tokens are logged on their own, like the document chat's.
        indexing, usage = Usage(), Usage()
        await explore_chat.index(settings, indexing)
        query = explore_chat.search_text(message, history)
        vector = (await embeddings.embed(settings, [query], purpose="explore_query", usage=indexing))[0]
        ids = await explore_chat.closest(vector, settings.explore_chat_articles)
        async with SessionLocal() as session:
            by_id = {a.id: a for a in await session.scalars(select(Article).where(Article.id.in_(ids)))}
            cards = await _cards(session, user_id, [by_id[i] for i in ids if i in by_id])
        yield "sources", {"articles": [c.model_dump(mode="json") for c in cards]}

        candidates = [
            explore_chat.Candidate(
                c.title, c.source_name, c.language, max(1, round(c.word_count / 220)), c.topics, c.summary
            )
            for c in cards
        ]
        messages = explore_chat.build_messages(message, candidates, history, language)
        parts: list[str] = []
        async for delta in explore_chat.answer(settings, messages, usage):
            parts.append(delta)
            yield "delta", {"text": delta}

        content = "".join(parts).strip()
        async with SessionLocal() as session:
            counted = await session.get(User, user_id)
            remaining = 0
            if counted is not None:
                ai_quota.chat_consume(counted)
                await session.commit()
                remaining = ai_quota.chat_remaining(counted, settings.chat_daily_quota)
        done = ExploreAnswer(
            content=content,
            articles=cards,
            cited=explore_chat.cited(content, len(cards)),
            chat_quota_remaining=remaining,
        )
        yield "done", done.model_dump(mode="json")

    if "text/event-stream" not in request.headers.get("accept", ""):
        _chatting.add(user_id)
        try:
            done: dict | None = None
            async for event, data in work():
                if event == "done":
                    done = data
        except AIError:
            raise HTTPException(status.HTTP_502_BAD_GATEWAY, MSG["MSG-26"]) from None
        finally:
            _chatting.discard(user_id)
        return JSONResponse(done)

    async def events() -> AsyncIterator[str]:
        if user_id in _chatting:
            yield _sse("error", {"detail": IN_PROGRESS})
            return
        _chatting.add(user_id)
        try:
            async for event, data in work():
                yield _sse(event, data)
        except AIError:
            yield _sse("error", {"detail": MSG["MSG-26"]})
        except Exception:
            log.exception("feed chat answer failed")
            yield _sse("error", {"detail": MSG["MSG-99"]})
        finally:
            _chatting.discard(user_id)

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.get("/topics", response_model=Topics)
async def list_topics(user: CurrentUser, session: SessionDep):
    """Every topic with how many articles it has, and the ones the user follows."""
    rows = await session.execute(select(ArticleTopic.topic, func.count()).group_by(ArticleTopic.topic))
    counts = dict(rows.all())
    return Topics(
        topics=[TopicCount(id=t, count=counts.get(t, 0)) for t in TOPICS], following=_following(user)
    )


@router.put("/topics", response_model=Topics)
async def follow_topics(payload: FollowIn, user: CurrentUser, session: SessionDep):
    """Choose the topics the feed shows."""
    if any(t not in TOPICS for t in payload.topics):
        raise HTTPException(422, MSG["MSG-INVALID"])
    chosen = [t for t in TOPICS if t in payload.topics]
    user.reading_preferences = {**(user.reading_preferences or {}), "topics": chosen}
    await session.commit()
    return await list_topics(user, session)


def _credit(article: Article) -> str:
    if (original := article.based_on) is not None:
        return MSG["MSG-FEED-CREDIT-GUIDE"].format(
            title=original.title.replace("[", "(").replace("]", ")"),
            url=original.url,
            credit=original.credit,
            source=source_names().get(original.source, original.source),
            license=article.license,
            license_url=article.license_url,
        )
    name = source_names().get(article.source, article.source)
    return MSG["MSG-FEED-CREDIT"].format(
        credit=article.credit,
        source=name,
        url=article.url,
        license=article.license,
        license_url=article.license_url,
    )


@router.post(
    "/{article_id}/open",
    response_model=DocumentOut,
    status_code=201,
    responses={200: {"model": DocumentOut, "description": "The article is in the library already"}},
)
async def open_article(article_id: uuid.UUID, user: CurrentUser, session: SessionDep):
    """The user's copy of the article, made on first reading: its text, headed by the credit."""
    article = await session.scalar(
        select(Article).where(Article.id == article_id).options(undefer(Article.content))
    )
    if article is None:
        raise HTTPException(404, MSG["MSG-FEED-404"])
    existing = await session.scalar(
        select(Document).where(Document.user_id == user.id, Document.url == article.url)
    )
    if existing is not None:
        return JSONResponse(DocumentOut.model_validate(existing).model_dump(mode="json"), status_code=200)
    content = f"*{_credit(article)}*\n\n{article.content}"
    citation = Citation(
        container=source_names().get(article.source, ""),
        year=article.published_at.year if article.published_at else None,
        doi=article.doi or "",
    )
    doc = Document(
        user_id=user.id,
        source_type=SourceType.manual,
        url=article.url,
        title=article.title,
        content_clean=content,
        word_count=word_count(content),
        published_at=article.published_at,
        extraction_status=ExtractionStatus.done,
        citation=citation.model_dump(),
    )
    if (dup := await _commit_new_link(session, doc, user, article.url)) is not None:
        return dup
    await session.refresh(doc)
    return doc
