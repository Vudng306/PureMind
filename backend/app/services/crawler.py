"""The crawler: reads the feed's sources from the channels admins keep, on a daily schedule or when an admin
asks, and stores what was published from 2023 on. Every run is recorded with what each source brought.

A source is code (it knows its site's API and licence); a channel is data: a section, subject or search of a
source, and the feed's topics for what comes from there.
"""

import asyncio
import logging
import re
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from urllib.parse import urlsplit

from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.db.session import SessionLocal
from app.models import TOPICS, AppSetting, Article, BlockedArticle, CrawlChannel, CrawlRun, utcnow
from app.services import articles, explore_chat, traffic
from app.services.ai_quota import VN
from app.services.openai_client import AIError, Usage
from app.services.sources import (
    Item,
    arxiv,
    conversation,
    elife,
    europepmc,
    frym,
    globalvoices,
    hlb,
    openalex,
    owid,
    plos,
)

log = logging.getLogger("app.crawler")

# Only what was published from this day on is kept; an article without a date cannot be placed, so it goes too.
CUTOFF = datetime(2023, 1, 1, tzinfo=UTC)
# The sources ask a crawler for a way to reach whoever runs it; a local run has only localhost to give.
PROJECT_URL = "https://github.com/Vudng306/PureMind"
# A run that has said nothing for this long died with its process.
STALE_RUN = timedelta(hours=2)
INTERRUPTED = "interrupted"
SCHEDULE_KEY = "crawl.schedule"
SOURCES_KEY = "crawl.sources"
SEEDED_KEY = "crawl.seeded"
DEFAULT_SCHEDULE = {"enabled": True, "hour": 3}  # 03:00 Vietnam time
MAX_ERRORS_KEPT = 5
_tasks: set[asyncio.Task] = set()


@dataclass(frozen=True)
class Source:
    id: str
    name: str
    collect: Callable[..., Awaitable[list[Item]]]
    from_link: Callable[[str, str, list[str]], Awaitable[Item | None]]
    hosts: tuple[str, ...]
    # What a channel names on this source ("section", "subject", "query"), and the ones it starts with;
    # None: the source is read whole and sorts its articles into topics itself.
    channel: str | None = None
    defaults: dict[str, list[str]] | None = None


SOURCES = {
    s.id: s
    for s in (
        Source(
            conversation.SOURCE,
            conversation.NAME,
            conversation.collect,
            conversation.from_link,
            ("theconversation.com",),
            "section",
            conversation.FEEDS,
        ),
        Source(
            globalvoices.SOURCE,
            globalvoices.NAME,
            globalvoices.collect,
            globalvoices.from_link,
            ("globalvoices.org",),
            "section",
            globalvoices.FEEDS,
        ),
        Source(owid.SOURCE, owid.NAME, owid.collect, owid.from_link, ("ourworldindata.org",)),
        Source(
            plos.SOURCE,
            plos.NAME,
            plos.collect,
            plos.from_link,
            ("journals.plos.org", "plos.org", "doi.org"),
            "subject",
            plos.SUBJECTS,
        ),
        Source(
            europepmc.SOURCE,
            europepmc.NAME,
            europepmc.collect,
            europepmc.from_link,
            ("europepmc.org", "www.ebi.ac.uk"),
            "query",
            europepmc.QUERIES,
        ),
        Source(
            elife.SOURCE,
            elife.NAME,
            elife.collect,
            elife.from_link,
            ("elifesciences.org",),
            "subject",
            elife.SUBJECTS,
        ),
        Source(frym.SOURCE, frym.NAME, frym.collect, frym.from_link, ("kids.frontiersin.org",)),
        Source(hlb.SOURCE, hlb.NAME, hlb.collect, hlb.from_link, hlb.HOSTS),
        Source(
            arxiv.SOURCE,
            arxiv.NAME,
            arxiv.collect,
            arxiv.from_link,
            ("arxiv.org",),
            "set",
            arxiv.SETS,
        ),
        Source(
            openalex.SOURCE,
            openalex.NAME,
            openalex.collect,
            openalex.from_link,
            (),
            "publisher",
            openalex.PUBLISHERS,
        ),
    )
}


class CrawlBusy(Exception):
    """A run is going already."""


class UnsupportedLink(Exception):
    """The address is not on a source the crawler knows."""


def contact() -> str:
    own = get_settings().web_contact
    return own if own and "localhost" not in own and "127.0.0.1" not in own else PROJECT_URL


def aware(value: datetime | None) -> datetime | None:
    """SQLite hands timestamps back without their zone."""
    return value.replace(tzinfo=UTC) if value is not None and value.tzinfo is None else value


# --- Settings ---------------------------------------------------------------------------------------


async def setting(session: AsyncSession, key: str, default: dict) -> dict:
    row = await session.get(AppSetting, key)
    return {**default, **row.value} if row else dict(default)


async def put_setting(session: AsyncSession, key: str, value: dict) -> None:
    row = await session.get(AppSetting, key)
    if row is None:
        session.add(AppSetting(key=key, value=value, updated_at=utcnow()))
    else:
        row.value, row.updated_at = value, utcnow()


async def disabled_sources(session: AsyncSession) -> set[str]:
    return set((await setting(session, SOURCES_KEY, {"disabled": []}))["disabled"])


async def seed_channels(session: AsyncSession) -> None:
    """Give each source its own list of channels once; after that the list is the admins'."""
    seeded = set((await setting(session, SEEDED_KEY, {"sources": []}))["sources"])
    missing = [s for s in SOURCES.values() if s.defaults is not None and s.id not in seeded]
    if not missing:
        return
    for source in missing:
        have = set(await session.scalars(select(CrawlChannel.key).where(CrawlChannel.source == source.id)))
        session.add_all(
            CrawlChannel(source=source.id, key=key, topics=list(topics), enabled=True)
            for key, topics in source.defaults.items()
            if key not in have
        )
    await put_setting(session, SEEDED_KEY, {"sources": sorted(seeded | {s.id for s in missing})})
    await session.commit()


async def channels_of(session: AsyncSession, source: str) -> dict[str, list[str]]:
    rows = await session.scalars(
        select(CrawlChannel)
        .where(CrawlChannel.source == source, CrawlChannel.enabled.is_(True))
        .order_by(CrawlChannel.created_at, CrawlChannel.key)
    )
    return {c.key: [t for t in c.topics if t in TOPICS] or ["science"] for c in rows}


def channel_key(source: Source, raw: str) -> str | None:
    """What an admin typed for a channel, as the source reads it; None when it cannot be one.

    The Conversation: a section or topic, or its address ("topics/psychology-28", "us/health").
    eLife: a subject's id or its page ("neuroscience"). PLOS: a subject area. Europe PMC: a search. arXiv: a set ("cs:cs:AI", "econ"). OpenAlex: a publisher's DOI prefix ("10.1596").
    """
    value = " ".join(raw.split())
    if source.id == conversation.SOURCE:
        value = re.sub(r"^https?://(www\.)?theconversation\.com/", "", value.lower())
        value = re.sub(r"/articles\.atom$", "", value).strip("/")
        return value if re.fullmatch(r"(topics/[a-z0-9-]+-\d+|[a-z]{2}(/[a-z0-9-]+)?)", value) else None
    if source.id == globalvoices.SOURCE:
        value = re.sub(r"^https?://(www\.)?globalvoices\.org/", "", value.lower())
        value = re.sub(r"/feed$", "", value.strip("/")).strip("/")
        return value if re.fullmatch(r"-/topics/[a-z0-9-]+", value) else None
    if source.id == elife.SOURCE:
        value = re.sub(r"^https?://(www\.)?elifesciences\.org/subjects/", "", value.lower()).strip("/")
        return value if re.fullmatch(r"[a-z0-9-]{2,80}", value) else None
    if source.id == arxiv.SOURCE:
        value = re.sub(r"^https?://(www\.)?arxiv\.org/list/", "", value).strip("/")
        return value if re.fullmatch(r"[A-Za-z-]{2,20}(:[A-Za-z-]{2,20}){0,2}", value) else None
    if source.id == openalex.SOURCE:
        value = re.sub(r"^https?://(dx\.)?doi\.org/", "", value).strip("/")
        return value if re.fullmatch(r"10\.\d{4,9}", value) else None
    return value if 2 <= len(value) <= 300 else None


# --- What is kept -----------------------------------------------------------------------------------


def recent(item: Item) -> bool:
    published = aware(item.published_at)
    return published is not None and published >= CUTOFF


async def blocked(session: AsyncSession, items: list[Item]) -> set[str]:
    """The addresses among `items` that an admin deleted, by address or by title."""
    if not items:
        return set()
    keys = {articles.title_key(i.title): i.url for i in items}
    rows = await session.execute(
        select(BlockedArticle.url, BlockedArticle.title_key).where(
            or_(BlockedArticle.url.in_([i.url for i in items]), BlockedArticle.title_key.in_(list(keys)))
        )
    )
    found = set()
    for url, key in rows:
        found.add(url)
        if key in keys:
            found.add(keys[key])
    return found


class _Errors(logging.Handler):
    """The warnings the sources log while one is read: an article or a section they could not fetch."""

    def __init__(self):
        super().__init__(logging.WARNING)
        self.count = 0
        self.messages: list[str] = []

    def emit(self, record: logging.LogRecord) -> None:
        self.count += 1
        if len(self.messages) < MAX_ERRORS_KEPT:
            self.messages.append(record.getMessage()[:200])


async def keep(session: AsyncSession, items: list[Item]) -> dict:
    """Store the recent, not deleted, articles among `items`; the counts of what happened to them."""
    fresh = [i for i in items if recent(i)]
    refused = await blocked(session, fresh)
    wanted = [i for i in fresh if i.url not in refused]
    stored = await articles.store(session, wanted)
    return {
        "fetched": len(items),
        "added": stored.added,
        "updated": stored.updated,
        "duplicates": stored.duplicates,
        "too_old": len(items) - len(fresh),
        "blocked": len(fresh) - len(wanted),
    }


# --- Runs -------------------------------------------------------------------------------------------


async def running(session: AsyncSession) -> CrawlRun | None:
    return await session.scalar(
        select(CrawlRun)
        .where(CrawlRun.status == "running", CrawlRun.started_at > utcnow() - STALE_RUN)
        .order_by(CrawlRun.started_at.desc())
        .limit(1)
    )


async def start(
    session: AsyncSession, trigger: str, sources: list[str] | None, admin_email: str | None
) -> CrawlRun:
    """Record a new run of the given sources (every switched-on one by default); `execute` does it."""
    if await running(session) is not None:
        raise CrawlBusy
    off = await disabled_sources(session)
    names = [s for s in (sources or SOURCES) if s in SOURCES and (sources or s not in off)]
    run = CrawlRun(trigger=trigger, sources=names, status="running", admin_email=admin_email, stats={})
    session.add(run)
    await session.commit()
    return run


async def execute(run_id: uuid.UUID) -> None:
    """Read each source of the run in turn, storing what it brings and recording the counts as it goes."""
    async with SessionLocal() as session:
        run = await session.get(CrawlRun, run_id)
        if run is None:
            return
        await seed_channels(session)
        names = list(run.sources)
    stats: dict[str, dict] = {}
    failed = None
    try:
        for name in names:
            stats[name] = await _source(name)
            async with SessionLocal() as session:
                run = await session.get(CrawlRun, run_id)
                run.stats = dict(stats)
                await session.commit()
    except Exception as e:
        log.exception("crawl run %s failed", run_id)
        failed = str(e)[:500] or type(e).__name__
    async with SessionLocal() as session:
        run = await session.get(CrawlRun, run_id)
        run.stats = stats
        run.status = "failed" if failed else "done"
        run.error = failed
        run.finished_at = utcnow()
        await session.commit()
    if any(s.get("added") for s in stats.values()):
        await _index()


async def _source(name: str) -> dict:
    source = SOURCES[name]
    errors = _Errors()
    logging.getLogger("app.services.sources").addHandler(errors)
    try:
        if source.defaults is None:
            items = await source.collect(contact())
        else:
            async with SessionLocal() as session:
                channels = await channels_of(session, name)
            items = await source.collect(contact(), channels) if channels else []
    except Exception as e:
        log.warning("crawl %s: %s", name, e)
        errors.count += 1
        errors.messages.append(str(e)[:200])
        items = []
    finally:
        logging.getLogger("app.services.sources").removeHandler(errors)
    async with SessionLocal() as session:
        counts = await keep(session, items)
    return {**counts, "errors": errors.count, "error_messages": errors.messages}


async def _index() -> None:
    """The feed's chat searches the articles by meaning; embedding the new ones now spares its first reader."""
    settings = get_settings()
    if not settings.openai_api_key:
        return
    try:
        await explore_chat.index(settings, Usage())
    except AIError as e:
        log.warning("chat index skipped: %s", e)


def source_of(url: str) -> Source:
    host = (urlsplit(url).hostname or "").lower()
    for source in SOURCES.values():
        if any(host == h or host.endswith("." + h) for h in source.hosts):
            # doi.org is PLOS's only for its own DOIs; any other goes to the source whose prefix it has.
            if host == "doi.org" and "10.1371/" not in url:
                continue
            return source
    if host == "doi.org" and "10.3389/frym" in url:
        return SOURCES[frym.SOURCE]
    raise UnsupportedLink


@dataclass
class Added:
    status: str  # added, updated, duplicate, too_old, blocked, not_found
    article_id: uuid.UUID | None = None
    title: str | None = None


async def add_link(session: AsyncSession, url: str, topics: list[str], admin_email: str) -> Added:
    """One article an admin points to, read by its source's own parser and checked like a crawl's."""
    source = source_of(url)
    item = await source.from_link(url, contact(), [t for t in topics if t in TOPICS])
    if item is None:
        return Added("not_found")
    counts = await keep(session, [item])
    status = next(
        (k for k in ("too_old", "blocked", "added", "updated", "duplicates") if counts[k]), "not_found"
    )
    session.add(
        CrawlRun(
            trigger="link",
            sources=[source.id],
            status="done",
            admin_email=admin_email,
            stats={source.id: {**counts, "errors": 0, "error_messages": []}},
            finished_at=utcnow(),
        )
    )
    await session.commit()
    article = await session.scalar(
        select(Article).where(
            or_(Article.url == item.url, Article.title_key == articles.title_key(item.title))
        )
    )
    return Added(
        "duplicate" if status == "duplicates" else status,
        article.id if article and status in ("added", "updated", "duplicates") else None,
        item.title,
    )


# --- The schedule -----------------------------------------------------------------------------------


async def due(session: AsyncSession, now: datetime | None = None) -> bool:
    """Whether the daily run should start now: past its hour (Vietnam time), and not run yet today. A run cut off
    by a restart does not count; one that failed on its own does, so a broken source is not retried every minute."""
    schedule = await setting(session, SCHEDULE_KEY, DEFAULT_SCHEDULE)
    if not schedule["enabled"]:
        return False
    local = (now or utcnow()).astimezone(VN)
    if local.hour < schedule["hour"]:
        return False
    since = local.replace(hour=schedule["hour"], minute=0, second=0, microsecond=0).astimezone(UTC)
    done = await session.scalar(
        select(func.count())
        .select_from(CrawlRun)
        .where(
            CrawlRun.trigger == "schedule",
            CrawlRun.started_at >= since,
            or_(CrawlRun.error.is_(None), CrawlRun.error != INTERRUPTED),
        )
    )
    return not done


async def tick() -> None:
    """One beat of the background loop: write the traffic counts, and start the daily crawl when it is due."""
    await traffic.flush()
    async with SessionLocal() as session:
        if not await due(session):
            return
        try:
            run = await start(session, "schedule", None, None)
        except CrawlBusy:
            return
    # In its own task, so the traffic keeps being written while the sources are read.
    task = asyncio.create_task(execute(run.id))
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)


async def recover() -> None:
    """At start-up: a run still marked running died with the last process. Not one started from the command line
    (manual, with no admin): that is its own process and may well be alive; if not, `running` lets it go stale."""
    async with SessionLocal() as session:
        runs = select(CrawlRun).where(
            CrawlRun.status == "running",
            or_(CrawlRun.trigger != "manual", CrawlRun.admin_email.is_not(None)),
        )
        for run in await session.scalars(runs):
            run.status, run.error, run.finished_at = "failed", INTERRUPTED, utcnow()
        await session.commit()


async def loop(every: float = 60) -> None:
    while True:
        try:
            await tick()
        except Exception:
            log.exception("background tick failed")
        await asyncio.sleep(every)
