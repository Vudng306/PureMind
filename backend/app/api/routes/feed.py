"""The feed (Bảng tin): openly licensed articles by topic, to read in the app.

Reading one puts a copy in the user's library, headed by the credit its licence asks for, so the reader,
highlights, summaries and the AI work on it as on anything the user added. A visitor without an account sees
the same feed and reads an article here, with nothing kept for them: what they follow, where they stopped and
what they read all need an account.
"""

import logging
import uuid
from collections.abc import AsyncIterator
from datetime import datetime
from typing import Literal

from fastapi import APIRouter, HTTPException, Query, Request, Response, status
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import case, exists, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased, undefer

from app.api.deps import CurrentUser, OptionalUser, SessionDep, SettingsDep
from app.api.routes.chat import IN_PROGRESS, _sse
from app.api.routes.documents import _commit_new_link
from app.api.routes.summaries import CONSENT_REQUIRED, NOT_CONFIGURED
from app.core.messages import MSG
from app.core.ratelimit import translate_article_day_limiter
from app.db.session import SessionLocal
from app.models import (
    KINDS,
    TOPICS,
    Article,
    ArticleTag,
    ArticleTopic,
    ContentTranslation,
    Document,
    ExtractionStatus,
    Short,
    ShortState,
    SourceType,
    User,
    utcnow,
)
from app.schemas import Citation, DocumentOut, ExploreAsk
from app.services import ai_quota, embeddings, explore_chat, shorts
from app.services.articles import source_names
from app.services.html_markdown import word_count
from app.services.openai_client import AIError, Usage

router = APIRouter(prefix="/feed", tags=["feed"])
log = logging.getLogger("app.feed")

PAGE_SIZE = 20
TOP_TAGS = 30
READING_NOW = 3  # shorts offered to pick up again
SHORT_LANGUAGE = "en"  # the shorts are written in Vietnamese
SHORT_CONTENT = "short"


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
    tags: list[str] = []
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
    # What the viewer needs: how many cards it reads as, and the user's place among them.
    total_cards: int
    card_index: int = 0
    completed: bool = False
    # The same cards in English, once someone has asked for them.
    en: shorts.Draft | None = None


class ProgressIn(BaseModel):
    card_index: int = Field(ge=0)


class ProgressOut(BaseModel):
    card_index: int
    completed: bool


class InterestIn(BaseModel):
    interested: bool


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


def _following(user: User | None) -> list[str] | None:
    """The topics the user chose; None, meaning every topic, before they choose and for a visitor."""
    chosen = (user.reading_preferences or {}).get("topics") if user else None
    return [t for t in chosen if t in TOPICS] if isinstance(chosen, list) else None


@router.get("", response_model=FeedPage)
async def list_feed(
    user: OptionalUser,
    session: SessionDep,
    topic: str | None = None,
    kind: str | None = None,
    tag: str | None = Query(None, max_length=48),
    offset: int = Query(0, ge=0, le=10_000),
    limit: int = Query(PAGE_SIZE, ge=1, le=50),
):
    """The articles of one topic, or of every topic the user follows (all of them before they choose);
    narrowed to one kind (research, report, book...) or one tag."""
    if (topic is not None and topic not in TOPICS) or (kind is not None and kind not in KINDS):
        raise HTTPException(422, MSG["MSG-INVALID"])
    following = _following(user)
    wanted = [topic] if topic else following
    stmt = select(Article).where(Article.hidden_at.is_(None))
    if kind:
        stmt = stmt.where(Article.kind == kind)
    if tag:
        stmt = stmt.where(Article.id.in_(select(ArticleTag.article_id).where(ArticleTag.tag == tag.lower())))
    if wanted:
        stmt = stmt.where(
            Article.id.in_(select(ArticleTopic.article_id).where(ArticleTopic.topic.in_(wanted)))
        )
    total = await session.scalar(select(func.count()).select_from(stmt.subquery())) or 0
    found = list(
        await session.scalars(stmt.order_by(Article.rank.desc(), Article.id).offset(offset).limit(limit))
    )
    cards = await _cards(session, user.id if user else None, found)
    return FeedPage(articles=cards, total=total, has_more=offset + len(cards) < total, following=following)


async def _cards(session: AsyncSession, user_id: uuid.UUID | None, found: list[Article]) -> list[ArticleCard]:
    """The articles as the page shows them, with the user's copy of each they have opened."""
    copies = {}
    if found and user_id:
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
            tags=sorted(t.tag for t in a.tags),
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


def _shorts_query():
    """Each short still to be seen, with its article and the guide written from that article, if any."""
    guide = aliased(Article)
    return (
        select(Short, Article, guide)
        .join(Article, Short.article_id == Article.id)
        .outerjoin(guide, (guide.based_on_id == Article.id) & guide.hidden_at.is_(None))
        .where(Article.hidden_at.is_(None))
    )


async def _short_cards(session: AsyncSession, user_id: uuid.UUID | None, rows) -> list[ShortCard]:
    """The shorts as the viewer shows them, with the user's copy of what each opens and their place in it
    (a visitor has neither, and starts each on its first card)."""
    reads = [g or a for _, a, g in rows]
    ids = [short.id for short, _, _ in rows]
    copies, states, kept = {}, {}, {}
    if rows and user_id:
        found = await session.execute(
            select(Document.url, Document.id).where(
                Document.user_id == user_id, Document.url.in_([r.url for r in reads])
            )
        )
        copies = dict(found.all())
        states = {
            s.short_id: s
            for s in await session.scalars(
                select(ShortState).where(ShortState.user_id == user_id, ShortState.short_id.in_(ids))
            )
        }
    if rows:
        kept = {
            k.content_id: k
            for k in await session.scalars(
                select(ContentTranslation).where(
                    ContentTranslation.content_id.in_([str(i) for i in ids]),
                    ContentTranslation.language == SHORT_LANGUAGE,
                    ContentTranslation.content_type == SHORT_CONTENT,
                )
            )
        }
    names = source_names()
    cards = []
    for (short, article, _), read in zip(rows, reads, strict=True):
        state = states.get(short.id)
        translation = kept.get(str(short.id))
        cards.append(
            ShortCard(
                id=short.id,
                title=short.title,
                hook=short.hook,
                points=shorts.usable(short.points),
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
                total_cards=shorts.cards_in(short),
                card_index=state.card_index if state else 0,
                completed=state.completed if state else False,
                en=shorts.Draft.model_validate_json(translation.translated_text)
                if translation and translation.source_version == shorts.version(shorts.text_of(short))
                else None,
            )
        )
    return cards


@router.get("/shorts", response_model=ShortsPage)
async def list_shorts(
    user: OptionalUser,
    session: SessionDep,
    topic: str | None = None,
    mode: Literal["following", "for_you"] = "following",
    offset: int = Query(0, ge=0, le=10_000),
    limit: int = Query(PAGE_SIZE, ge=1, le=50),
):
    """Short posts in the feed's order, of one topic or of the topics the user follows. "for_you" goes on past
    those into the other topics, so a reader following little still has something to discover. The ones the user
    said they are not interested in stay out."""
    if topic is not None and topic not in TOPICS:
        raise HTTPException(422, MSG["MSG-INVALID"])
    wanted = [topic] if topic else _following(user)
    stmt = _shorts_query()
    if user:
        stmt = stmt.where(
            ~exists().where(
                ShortState.short_id == Short.id, ShortState.user_id == user.id, ShortState.dismissed.is_(True)
            )
        )
    order = [Article.rank.desc(), Short.id]
    if wanted:
        chosen = Article.id.in_(select(ArticleTopic.article_id).where(ArticleTopic.topic.in_(wanted)))
        if mode == "for_you" and not topic:
            order.insert(0, case((chosen, 0), else_=1))
        else:
            stmt = stmt.where(chosen)
    total = await session.scalar(select(func.count()).select_from(stmt.subquery())) or 0
    rows = (await session.execute(stmt.order_by(*order).offset(offset).limit(limit))).all()
    cards = await _short_cards(session, user.id if user else None, rows)
    return ShortsPage(shorts=cards, total=total, has_more=offset + len(cards) < total)


@router.get("/shorts/reading", response_model=list[ShortCard])
async def reading_shorts(user: CurrentUser, session: SessionDep):
    """The shorts the user left partway through, the latest first."""
    rows = (
        await session.execute(
            _shorts_query()
            .join(ShortState, ShortState.short_id == Short.id)
            .where(
                ShortState.user_id == user.id,
                ShortState.card_index > 0,
                ShortState.completed.is_(False),
                ShortState.dismissed.is_(False),
            )
            .order_by(ShortState.updated_at.desc())
            .limit(READING_NOW)
        )
    ).all()
    return await _short_cards(session, user.id, rows)


async def _short_row(session: AsyncSession, short_id: uuid.UUID):
    row = (await session.execute(_shorts_query().where(Short.id == short_id))).first()
    if row is None:
        raise HTTPException(404, MSG["MSG-FEED-404"])
    return row


@router.get("/shorts/{short_id}", response_model=ShortCard)
async def get_short(short_id: uuid.UUID, user: OptionalUser, session: SessionDep):
    """One short, as a shared link or "continue reading" opens it, whether or not it is in the list."""
    [card] = await _short_cards(session, user.id if user else None, [await _short_row(session, short_id)])
    return card


async def _change_state(session: AsyncSession, user_id: uuid.UUID, short_id: uuid.UUID, change) -> ShortState:
    """Applies `change` to the user's state of the short, made if it is their first. Two tabs may both make it."""
    for attempt in (1, 2):
        state = await session.get(ShortState, (user_id, short_id))
        if state is None:
            state = ShortState(
                user_id=user_id, short_id=short_id, card_index=0, completed=False, dismissed=False
            )
            session.add(state)
        change(state)
        state.updated_at = utcnow()
        try:
            await session.commit()
            break
        except IntegrityError:
            await session.rollback()
            if attempt == 2:
                raise
    return state


@router.put("/shorts/{short_id}/progress", response_model=ProgressOut)
async def save_short_progress(
    short_id: uuid.UUID, payload: ProgressIn, user: CurrentUser, session: SessionDep
):
    """Where the user stopped. Reaching the last card completes the short for good; going back over it does not
    undo that."""
    short, _, _ = await _short_row(session, short_id)
    last = shorts.cards_in(short) - 1
    if payload.card_index > last:
        raise HTTPException(422, MSG["MSG-INVALID"])

    def change(state: ShortState) -> None:
        state.card_index = payload.card_index
        state.completed = state.completed or payload.card_index == last

    state = await _change_state(session, user.id, short_id, change)
    return ProgressOut(card_index=state.card_index, completed=state.completed)


@router.put("/shorts/{short_id}/interest", status_code=204)
async def set_short_interest(
    short_id: uuid.UUID, payload: InterestIn, user: CurrentUser, session: SessionDep
):
    """ "Not interested" keeps the short out of the user's feed; taking it back returns it."""
    await _short_row(session, short_id)

    def change(state: ShortState) -> None:
        state.dismissed = not payload.interested

    await _change_state(session, user.id, short_id, change)
    return Response(status_code=204)


@router.post("/shorts/{short_id}/translation", response_model=shorts.Draft)
async def translate_short(short_id: uuid.UUID, user: CurrentUser, session: SessionDep, settings: SettingsDep):
    """The short in English: written on the first request and kept for everyone, as shorts only come from articles
    whose licence allows adapting them."""
    short, article, _ = await _short_row(session, short_id)
    if "ND" in article.license:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, MSG["MSG-26"])
    source = shorts.text_of(short)
    source_version = shorts.version(source)
    kept = await session.get(ContentTranslation, (str(short_id), SHORT_LANGUAGE, SHORT_CONTENT))
    if kept is not None and kept.source_version == source_version:
        return shorts.Draft.model_validate_json(kept.translated_text)
    if not (user.reading_preferences or {}).get("ai_consent"):  # NFR-PRV, as for every AI feature
        raise HTTPException(status.HTTP_403_FORBIDDEN, CONSENT_REQUIRED)
    if not settings.openai_api_key:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, NOT_CONFIGURED)
    if not translate_article_day_limiter.hit(str(user.id)):
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, MSG["MSG-TR-RATE"])
    await session.commit()  # no connection held while the model writes
    try:
        translation = await shorts.translate(settings, source)
    except AIError:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, MSG["MSG-26"]) from None
    await session.merge(
        ContentTranslation(
            content_id=str(short_id),
            language=SHORT_LANGUAGE,
            content_type=SHORT_CONTENT,
            source_version=source_version,
            translated_text=translation.model_dump_json(),
            translation_model=settings.openai_model,
        )
    )
    await session.commit()
    return translation


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
async def list_topics(user: OptionalUser, session: SessionDep):
    """Every topic with how many articles it has, and the ones the user follows."""
    rows = await session.execute(
        select(ArticleTopic.topic, func.count())
        .join(Article, Article.id == ArticleTopic.article_id)
        .where(Article.hidden_at.is_(None))
        .group_by(ArticleTopic.topic)
    )
    counts = dict(rows.all())
    return Topics(
        topics=[TopicCount(id=t, count=counts.get(t, 0)) for t in TOPICS], following=_following(user)
    )


class KindCount(BaseModel):
    id: str
    count: int


class TagCount(BaseModel):
    tag: str
    count: int


class Facets(BaseModel):
    kinds: list[KindCount]
    tags: list[TagCount]


@router.get("/facets", response_model=Facets)
async def list_facets(
    user: OptionalUser,
    session: SessionDep,
    topic: str | None = None,
    kind: str | None = None,
):
    """What the feed can be narrowed by: each kind with its articles, and the most used tags, among the
    articles of `topic` (or of the topics the user follows) and of `kind` for the tags."""
    if (topic is not None and topic not in TOPICS) or (kind is not None and kind not in KINDS):
        raise HTTPException(422, MSG["MSG-INVALID"])
    wanted = [topic] if topic else _following(user)
    visible = select(Article.id).where(Article.hidden_at.is_(None))
    if wanted:
        visible = visible.where(
            Article.id.in_(select(ArticleTopic.article_id).where(ArticleTopic.topic.in_(wanted)))
        )
    kinds = dict(
        (
            await session.execute(
                select(Article.kind, func.count()).where(Article.id.in_(visible)).group_by(Article.kind)
            )
        ).all()
    )
    tagged = visible.where(Article.kind == kind) if kind else visible
    tags = (
        await session.execute(
            select(ArticleTag.tag, func.count().label("n"))
            .where(ArticleTag.article_id.in_(tagged))
            .group_by(ArticleTag.tag)
            .order_by(func.count().desc(), ArticleTag.tag)
            .limit(TOP_TAGS)
        )
    ).all()
    return Facets(
        kinds=[KindCount(id=k, count=kinds[k]) for k in KINDS if kinds.get(k)],
        tags=[TagCount(tag=t, count=n) for t, n in tags],
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
    if article is None or article.hidden_at is not None:
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
        license=article.license,
    )
    if (dup := await _commit_new_link(session, doc, user, article.url)) is not None:
        return dup
    await session.refresh(doc)
    return doc


class FeedArticle(BaseModel):
    """An article to read without an account: its text headed by its credit, as the library's copy would be."""

    id: uuid.UUID
    title: str
    source_name: str
    url: str
    authors: str
    language: str
    kind: str
    license: str
    license_url: str
    topics: list[str]
    word_count: int
    published_at: datetime | None
    content: str


@router.get("/articles/{article_id}", response_model=FeedArticle)
async def read_article(article_id: uuid.UUID, session: SessionDep):
    """An article to read where it is, for a visitor: nothing goes in a library. A signed-in reader opens it
    instead (POST /feed/{id}/open), which keeps their copy."""
    article = await session.scalar(
        select(Article).where(Article.id == article_id).options(undefer(Article.content))
    )
    if article is None or article.hidden_at is not None:
        raise HTTPException(404, MSG["MSG-FEED-404"])
    return FeedArticle(
        id=article.id,
        title=article.title,
        source_name=source_names().get(article.source, article.source),
        url=article.url,
        authors=article.authors,
        language=article.language,
        kind=article.kind,
        license=article.license,
        license_url=article.license_url,
        topics=sorted(t.topic for t in article.topics),
        word_count=article.word_count,
        published_at=article.published_at,
        content=f"*{_credit(article)}*\n\n{article.content}",
    )
