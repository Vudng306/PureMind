"""Admin page, beyond accounts: the traffic, the feed's articles and the crawler that brings them.

The traffic is counts per day and part of the app, never who asked for what. The articles are the feed's
shared, openly licensed ones; nothing here reads a user's library. Every change is in the audit log.
"""

import logging
import uuid
from collections import Counter
from datetime import UTC, date, datetime, timedelta
from typing import Literal

from fastapi import APIRouter, BackgroundTasks, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy import delete, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import AdminUser, SessionDep
from app.api.routes.catalog import catalog
from app.core.messages import MSG
from app.models import (
    TOPICS,
    AdminAuditLog,
    Article,
    ArticleTopic,
    BlockedArticle,
    CrawlChannel,
    CrawlRun,
    Document,
    QuickReadReport,
    Short,
    TrafficDaily,
    User,
    UserActivityDaily,
    utcnow,
)
from app.services import crawler, traffic
from app.services.ai_quota import VN, today_vn
from app.services.articles import source_names

router = APIRouter(prefix="/admin", tags=["admin"])
log = logging.getLogger("app.admin")
TRAFFIC_DAYS = (7, 30, 90)


def _audit(session: AsyncSession, admin: User, action: str, **detail) -> None:
    session.add(AdminAuditLog(admin_id=admin.id, admin_email=admin.email, action=action, detail=detail))


# --- Traffic ----------------------------------------------------------------------------------------


class TrafficDay(BaseModel):
    day: date
    requests: int
    errors: int
    ai_calls: int
    active_users: int
    signups: int


class TrafficArea(BaseModel):
    area: str
    requests: int
    errors: int
    ai_calls: int


class TrafficTotals(BaseModel):
    users: int
    active_today: int
    signups: int
    requests: int
    errors: int
    ai_calls: int
    articles: int
    hidden_articles: int
    documents: int


class Traffic(BaseModel):
    days: list[TrafficDay]
    areas: list[TrafficArea]
    totals: TrafficTotals


@router.get("/traffic", response_model=Traffic)
async def get_traffic(_: AdminUser, session: SessionDep, days: int = Query(30)):
    """Requests, errors, AI calls, active accounts and sign-ups per day (Vietnam time), and by part of the app."""
    if days not in TRAFFIC_DAYS:
        raise HTTPException(422, MSG["MSG-INVALID"])
    await traffic.flush()
    today = today_vn()
    first = today - timedelta(days=days - 1)
    per_day = {
        r.day: r
        for r in await session.execute(
            select(
                TrafficDaily.day,
                func.sum(TrafficDaily.requests).label("requests"),
                func.sum(TrafficDaily.errors).label("errors"),
                func.sum(TrafficDaily.ai_calls).label("ai_calls"),
            )
            .where(TrafficDaily.day >= first)
            .group_by(TrafficDaily.day)
        )
    }
    active = dict(
        (
            await session.execute(
                select(UserActivityDaily.day, func.count())
                .where(UserActivityDaily.day >= first)
                .group_by(UserActivityDaily.day)
            )
        ).all()
    )
    since = datetime.combine(first, datetime.min.time(), VN).astimezone(UTC)
    signups = Counter(
        crawler.aware(c).astimezone(VN).date()
        for c in await session.scalars(select(User.created_at).where(User.created_at >= since))
    )
    series = []
    for i in range(days):
        day = first + timedelta(days=i)
        row = per_day.get(day)
        series.append(
            TrafficDay(
                day=day,
                requests=row.requests if row else 0,
                errors=row.errors if row else 0,
                ai_calls=row.ai_calls if row else 0,
                active_users=active.get(day, 0),
                signups=signups.get(day, 0),
            )
        )
    areas = [
        TrafficArea(area=r.area, requests=r.requests, errors=r.errors, ai_calls=r.ai_calls)
        for r in await session.execute(
            select(
                TrafficDaily.area,
                func.sum(TrafficDaily.requests).label("requests"),
                func.sum(TrafficDaily.errors).label("errors"),
                func.sum(TrafficDaily.ai_calls).label("ai_calls"),
            )
            .where(TrafficDaily.day >= first)
            .group_by(TrafficDaily.area)
            .order_by(func.sum(TrafficDaily.requests).desc())
        )
    ]

    async def count(stmt) -> int:
        return (await session.scalar(stmt)) or 0

    totals = TrafficTotals(
        users=await count(select(func.count()).select_from(User)),
        active_today=active.get(today, 0),
        signups=sum(d.signups for d in series),
        requests=sum(d.requests for d in series),
        errors=sum(d.errors for d in series),
        ai_calls=sum(d.ai_calls for d in series),
        articles=await count(select(func.count()).select_from(Article)),
        hidden_articles=await count(
            select(func.count()).select_from(Article).where(Article.hidden_at.is_not(None))
        ),
        documents=await count(select(func.count()).select_from(Document)),
    )
    return Traffic(days=series, areas=areas, totals=totals)


# --- Articles ---------------------------------------------------------------------------------------


class AdminArticle(BaseModel):
    id: uuid.UUID
    title: str
    source: str
    source_name: str
    url: str
    kind: str
    language: str
    license: str
    topics: list[str]
    tags: list[str]
    word_count: int
    published_at: datetime | None
    collected_at: datetime
    hidden_at: datetime | None
    is_guide: bool
    has_short: bool


class Facet(BaseModel):
    value: str
    count: int


class AdminArticlePage(BaseModel):
    items: list[AdminArticle]
    total: int
    page: int
    page_size: int
    sources: list[Facet]
    years: list[Facet]
    languages: list[Facet]
    kinds: list[Facet]


ArticleSort = Literal["newest", "oldest", "collected", "title"]
ArticleStatus = Literal["all", "visible", "hidden"]


def _article(a: Article, shorts: set[uuid.UUID]) -> AdminArticle:
    return AdminArticle(
        id=a.id,
        title=a.title,
        source=a.source,
        source_name=source_names().get(a.source, a.source),
        url=a.url,
        kind=a.kind,
        language=a.language,
        license=a.license,
        topics=sorted(t.topic for t in a.topics),
        tags=sorted(t.tag for t in a.tags),
        word_count=a.word_count,
        published_at=a.published_at,
        collected_at=a.collected_at,
        hidden_at=a.hidden_at,
        is_guide=a.based_on_id is not None,
        has_short=a.id in shorts,
    )


@router.get("/articles", response_model=AdminArticlePage)
async def list_articles(
    _: AdminUser,
    session: SessionDep,
    q: str = Query("", max_length=200),
    source: str = "",
    topic: str = "",
    kind: str = "",
    year: int | None = Query(None, ge=1900, le=2100),
    language: str = "",
    status_: ArticleStatus = Query("all", alias="status"),
    sort: ArticleSort = "newest",
    page: int = Query(1, ge=1),
    page_size: int = Query(25, ge=1, le=100),
):
    filters = []
    if needle := q.strip():
        like = f"%{needle.lower()}%"
        filters.append(or_(func.lower(Article.title).like(like), func.lower(Article.url).like(like)))
    if source:
        filters.append(Article.source == source)
    if topic:
        filters.append(Article.id.in_(select(ArticleTopic.article_id).where(ArticleTopic.topic == topic)))
    if kind:
        filters.append(Article.kind == kind)
    if year:
        filters += [
            Article.published_at >= datetime(year, 1, 1, tzinfo=UTC),
            Article.published_at < datetime(year + 1, 1, 1, tzinfo=UTC),
        ]
    if language:
        filters.append(Article.language == language)
    if status_ == "visible":
        filters.append(Article.hidden_at.is_(None))
    elif status_ == "hidden":
        filters.append(Article.hidden_at.is_not(None))
    order = {
        "newest": (Article.published_at.desc().nulls_last(), Article.id),
        "oldest": (Article.published_at.asc().nulls_last(), Article.id),
        "collected": (Article.collected_at.desc(), Article.id),
        "title": (Article.title, Article.id),
    }[sort]
    total = (await session.scalar(select(func.count()).select_from(Article).where(*filters))) or 0
    found = list(
        await session.scalars(
            select(Article).where(*filters).order_by(*order).offset((page - 1) * page_size).limit(page_size)
        )
    )
    shorts = set(
        await session.scalars(select(Short.article_id).where(Short.article_id.in_([a.id for a in found])))
    )
    names = source_names()
    by_source = (await session.execute(select(Article.source, func.count()).group_by(Article.source))).all()
    by_language = (
        await session.execute(select(Article.language, func.count()).group_by(Article.language))
    ).all()
    by_kind = (await session.execute(select(Article.kind, func.count()).group_by(Article.kind))).all()
    years = Counter(
        p.year
        for p in await session.scalars(select(Article.published_at).where(Article.published_at.is_not(None)))
    )
    return AdminArticlePage(
        items=[_article(a, shorts) for a in found],
        total=total,
        page=page,
        page_size=page_size,
        sources=[Facet(value=s, count=n) for s, n in sorted(by_source, key=lambda r: names.get(r[0], r[0]))],
        years=[Facet(value=str(y), count=n) for y, n in sorted(years.items(), reverse=True)],
        languages=[Facet(value=lang, count=n) for lang, n in sorted(by_language)],
        kinds=[Facet(value=k, count=n) for k, n in sorted(by_kind)],
    )


async def _article_or_404(session: AsyncSession, article_id: uuid.UUID) -> Article:
    article = await session.get(Article, article_id)
    if article is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, MSG["MSG-FEED-404"])
    return article


async def _one(session: AsyncSession, article: Article) -> AdminArticle:
    shorts = set(await session.scalars(select(Short.article_id).where(Short.article_id == article.id)))
    return _article(article, shorts)


@router.post("/articles/{article_id}/hide", response_model=AdminArticle)
async def hide_article(article_id: uuid.UUID, admin: AdminUser, session: SessionDep):
    """Out of the feed, its chat, its short posts and Explore, until shown again. Users' copies stay theirs."""
    article = await _article_or_404(session, article_id)
    if article.hidden_at is None:
        article.hidden_at = utcnow()
        _audit(session, admin, "article.hide", article_id=str(article.id), title=article.title[:200])
        await session.commit()
        await session.refresh(article)
    return await _one(session, article)


@router.post("/articles/{article_id}/show", response_model=AdminArticle)
async def show_article(article_id: uuid.UUID, admin: AdminUser, session: SessionDep):
    article = await _article_or_404(session, article_id)
    if article.hidden_at is not None:
        article.hidden_at = None
        _audit(session, admin, "article.show", article_id=str(article.id), title=article.title[:200])
        await session.commit()
        await session.refresh(article)
    return await _one(session, article)


@router.delete("/articles/{article_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_article(article_id: uuid.UUID, admin: AdminUser, session: SessionDep):
    """Gone from the feed and Explore with its guides and short posts, and never crawled again (its address and title
    are blocked). The copies users already took into their libraries are theirs and stay."""
    article = await _article_or_404(session, article_id)
    guides = (
        await session.scalar(
            select(func.count()).select_from(Article).where(Article.based_on_id == article.id)
        )
    ) or 0
    if await session.get(BlockedArticle, article.url) is None:
        session.add(BlockedArticle(url=article.url, title_key=article.title_key))
    _audit(
        session,
        admin,
        "article.delete",
        article_id=str(article.id),
        title=article.title[:200],
        source=article.source,
        guides=guides,
    )
    await session.execute(delete(Article).where(Article.id == article.id))
    await session.commit()


class LinkIn(BaseModel):
    url: str = Field(min_length=8, max_length=2048, pattern=r"^https?://")
    topics: list[str] = Field(default_factory=list, max_length=4)


class LinkOut(BaseModel):
    status: Literal["added", "updated", "duplicate", "too_old", "blocked", "not_found"]
    title: str | None
    article: AdminArticle | None


class QuickReadReports(BaseModel):
    """How many readers reported one catalog article's Quick Read, by reason. Counts only, never who."""

    article_id: str
    title: str
    url: str
    quick_title: str
    wrong: int = 0
    missing: int = 0
    other: int = 0
    last_at: datetime


@router.get("/quick-read-reports", response_model=list[QuickReadReports])
async def quick_read_reports(_: AdminUser, session: SessionDep):
    """The catalog's Quick Reads that readers reported, most recent first. One whose article has since left
    the catalog is gone with it."""
    rows = await session.execute(
        select(
            QuickReadReport.article_id,
            QuickReadReport.reason,
            func.count(),
            func.max(QuickReadReport.created_at),
        ).group_by(QuickReadReport.article_id, QuickReadReport.reason)
    )
    articles = {a["id"]: a for a in catalog()["articles"]}
    found: dict[str, QuickReadReports] = {}
    for article_id, reason, count, last_at in rows:
        article = articles.get(article_id)
        if article is None:
            continue
        item = found.setdefault(
            article_id,
            QuickReadReports(
                article_id=article_id,
                title=article["title"],
                url=article["url"],
                quick_title=article.get("quick", {}).get("title", ""),
                last_at=last_at,
            ),
        )
        setattr(item, reason, count)
        item.last_at = max(item.last_at, last_at)
    return sorted(found.values(), key=lambda r: r.last_at, reverse=True)


@router.post("/articles/from-link", response_model=LinkOut)
async def add_from_link(payload: LinkIn, admin: AdminUser, session: SessionDep):
    """One article from a supported source, read by that source's parser and checked for its licence and
    date (2023 on) like a crawl's."""
    if any(t not in TOPICS for t in payload.topics):
        raise HTTPException(422, MSG["MSG-INVALID"])
    try:
        added = await crawler.add_link(session, payload.url.strip(), payload.topics, admin.email)
    except crawler.UnsupportedLink:
        raise HTTPException(422, MSG["MSG-ADM-LINK-UNSUPPORTED"]) from None
    except Exception as e:
        log.warning("add from link %s: %r", payload.url, e)
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, MSG["MSG-ADM-LINK-FAILED"]) from None
    _audit(session, admin, "article.add", url=payload.url[:500], status=added.status)
    await session.commit()
    article = await session.get(Article, added.article_id) if added.article_id else None
    return LinkOut(
        status=added.status, title=added.title, article=await _one(session, article) if article else None
    )


# --- Crawler ----------------------------------------------------------------------------------------


class Channel(BaseModel):
    id: uuid.UUID
    key: str
    topics: list[str]
    enabled: bool


class SourceOut(BaseModel):
    id: str
    name: str
    enabled: bool
    channel: str | None
    hosts: list[str]
    article_count: int
    channels: list[Channel]


class Schedule(BaseModel):
    enabled: bool
    hour: int = Field(ge=0, le=23)


class RunOut(BaseModel):
    id: uuid.UUID
    trigger: str
    sources: list[str]
    status: str
    admin_email: str | None
    stats: dict
    error: str | None
    started_at: datetime
    finished_at: datetime | None


class CrawlOverview(BaseModel):
    schedule: Schedule
    cutoff: date
    running: RunOut | None
    last_run: RunOut | None
    sources: list[SourceOut]
    topics: list[str]


def _run(run: CrawlRun) -> RunOut:
    return RunOut(
        id=run.id,
        trigger=run.trigger,
        sources=list(run.sources),
        status=run.status,
        admin_email=run.admin_email,
        stats=run.stats or {},
        error=run.error,
        started_at=run.started_at,
        finished_at=run.finished_at,
    )


@router.get("/crawl", response_model=CrawlOverview)
async def crawl_overview(_: AdminUser, session: SessionDep):
    await crawler.seed_channels(session)
    off = await crawler.disabled_sources(session)
    counts = dict(
        (await session.execute(select(Article.source, func.count()).group_by(Article.source))).all()
    )
    channels: dict[str, list[Channel]] = {}
    for c in await session.scalars(select(CrawlChannel).order_by(CrawlChannel.created_at, CrawlChannel.key)):
        channels.setdefault(c.source, []).append(
            Channel(id=c.id, key=c.key, topics=list(c.topics), enabled=c.enabled)
        )
    running = await crawler.running(session)
    last = await session.scalar(
        select(CrawlRun).where(CrawlRun.trigger != "link").order_by(CrawlRun.started_at.desc()).limit(1)
    )
    return CrawlOverview(
        schedule=Schedule(**await crawler.setting(session, crawler.SCHEDULE_KEY, crawler.DEFAULT_SCHEDULE)),
        cutoff=crawler.CUTOFF.date(),
        running=_run(running) if running else None,
        last_run=_run(last) if last else None,
        sources=[
            SourceOut(
                id=s.id,
                name=s.name,
                enabled=s.id not in off,
                channel=s.channel,
                hosts=list(s.hosts),
                article_count=counts.get(s.id, 0),
                channels=channels.get(s.id, []),
            )
            for s in crawler.SOURCES.values()
        ],
        topics=list(TOPICS),
    )


@router.put("/crawl/schedule", response_model=Schedule)
async def set_schedule(payload: Schedule, admin: AdminUser, session: SessionDep):
    await crawler.put_setting(session, crawler.SCHEDULE_KEY, payload.model_dump())
    _audit(session, admin, "crawl.settings", **payload.model_dump())
    await session.commit()
    return payload


class SourceSwitch(BaseModel):
    enabled: bool


def _source(source_id: str) -> crawler.Source:
    if source_id not in crawler.SOURCES:
        raise HTTPException(status.HTTP_404_NOT_FOUND, MSG["MSG-INVALID"])
    return crawler.SOURCES[source_id]


@router.put("/crawl/sources/{source_id}", response_model=SourceSwitch)
async def switch_source(source_id: str, payload: SourceSwitch, admin: AdminUser, session: SessionDep):
    """A source switched off is left out of the daily run (an admin can still run it by hand)."""
    _source(source_id)
    off = await crawler.disabled_sources(session)
    off = off - {source_id} if payload.enabled else off | {source_id}
    await crawler.put_setting(session, crawler.SOURCES_KEY, {"disabled": sorted(off)})
    _audit(session, admin, "crawl.source", source=source_id, enabled=payload.enabled)
    await session.commit()
    return payload


class ChannelIn(BaseModel):
    key: str = Field(min_length=2, max_length=300)
    topics: list[str] = Field(min_length=1, max_length=4)


class ChannelUpdate(BaseModel):
    enabled: bool | None = None
    topics: list[str] | None = Field(None, min_length=1, max_length=4)


def _topics(topics: list[str]) -> list[str]:
    if any(t not in TOPICS for t in topics):
        raise HTTPException(422, MSG["MSG-INVALID"])
    return [t for t in TOPICS if t in topics]


@router.post("/crawl/sources/{source_id}/channels", response_model=Channel, status_code=201)
async def add_channel(source_id: str, payload: ChannelIn, admin: AdminUser, session: SessionDep):
    source = _source(source_id)
    if source.channel is None:
        raise HTTPException(422, MSG["MSG-ADM-CHANNEL-NONE"])
    key = crawler.channel_key(source, payload.key)
    if key is None:
        raise HTTPException(422, MSG["MSG-INVALID"])
    await crawler.seed_channels(session)
    exists = await session.scalar(
        select(CrawlChannel.id).where(CrawlChannel.source == source_id, CrawlChannel.key == key)
    )
    if exists:
        raise HTTPException(status.HTTP_409_CONFLICT, MSG["MSG-ADM-CHANNEL-EXISTS"])
    channel = CrawlChannel(source=source_id, key=key, topics=_topics(payload.topics), enabled=True)
    session.add(channel)
    _audit(session, admin, "channel.add", source=source_id, key=key, topics=channel.topics)
    await session.commit()
    return Channel(id=channel.id, key=channel.key, topics=channel.topics, enabled=channel.enabled)


async def _channel(session: AsyncSession, channel_id: uuid.UUID) -> CrawlChannel:
    channel = await session.get(CrawlChannel, channel_id)
    if channel is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, MSG["MSG-INVALID"])
    return channel


@router.patch("/crawl/channels/{channel_id}", response_model=Channel)
async def update_channel(
    channel_id: uuid.UUID, payload: ChannelUpdate, admin: AdminUser, session: SessionDep
):
    channel = await _channel(session, channel_id)
    if payload.enabled is not None:
        channel.enabled = payload.enabled
    if payload.topics is not None:
        channel.topics = _topics(payload.topics)
    _audit(
        session,
        admin,
        "channel.update",
        source=channel.source,
        key=channel.key,
        enabled=channel.enabled,
        topics=list(channel.topics),
    )
    await session.commit()
    return Channel(id=channel.id, key=channel.key, topics=list(channel.topics), enabled=channel.enabled)


@router.delete("/crawl/channels/{channel_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_channel(channel_id: uuid.UUID, admin: AdminUser, session: SessionDep):
    """The articles already brought from it stay."""
    channel = await _channel(session, channel_id)
    _audit(session, admin, "channel.delete", source=channel.source, key=channel.key)
    await session.delete(channel)
    await session.commit()


class RunIn(BaseModel):
    sources: list[str] | None = Field(None, max_length=len(crawler.SOURCES))


@router.post("/crawl/runs", response_model=RunOut, status_code=status.HTTP_202_ACCEPTED)
async def start_run(payload: RunIn, admin: AdminUser, session: SessionDep, background: BackgroundTasks):
    """Crawl now: the given sources, or every one switched on. The run goes on after the answer; its counts
    appear in the run list as each source is done."""
    if payload.sources is not None and (
        not payload.sources or any(s not in crawler.SOURCES for s in payload.sources)
    ):
        raise HTTPException(422, MSG["MSG-INVALID"])
    try:
        run = await crawler.start(session, "manual", payload.sources, admin.email)
    except crawler.CrawlBusy:
        raise HTTPException(status.HTTP_409_CONFLICT, MSG["MSG-ADM-CRAWL-BUSY"]) from None
    _audit(session, admin, "crawl.run", run_id=str(run.id), sources=list(run.sources))
    await session.commit()
    await session.refresh(run)
    background.add_task(crawler.execute, run.id)
    return _run(run)


class RunPage(BaseModel):
    items: list[RunOut]
    total: int
    page: int
    page_size: int


@router.get("/crawl/runs", response_model=RunPage)
async def list_runs(
    _: AdminUser,
    session: SessionDep,
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
):
    total = (await session.scalar(select(func.count()).select_from(CrawlRun))) or 0
    rows = await session.scalars(
        select(CrawlRun).order_by(CrawlRun.started_at.desc()).offset((page - 1) * page_size).limit(page_size)
    )
    return RunPage(items=[_run(r) for r in rows], total=total, page=page, page_size=page_size)
