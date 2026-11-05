"""The shared catalog: open articles anyone may browse, and a signed-in reader may take into their library."""

import json
import logging
from collections.abc import AsyncIterator, Collection
from datetime import UTC, datetime
from functools import lru_cache
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, HTTPException, Query, Response, status
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel
from sqlalchemy import select

from app.api.deps import CurrentUser, SessionDep, SettingsDep
from app.api.routes.documents import _commit_new_link
from app.api.routes.summaries import CONSENT_REQUIRED, NOT_CONFIGURED
from app.api.routes.translate import _sse
from app.core.messages import MSG
from app.core.ratelimit import translate_article_day_limiter
from app.db.session import SessionLocal
from app.models import (
    Article,
    BlockedArticle,
    ContentTranslation,
    Document,
    ExtractionStatus,
    QuickReadReport,
    SourceType,
    utcnow,
)
from app.schemas import Citation, DocumentOut
from app.services import article_translation, quick_reads
from app.services.html_markdown import word_count
from app.services.openai_client import AIError

router = APIRouter(prefix="/catalog", tags=["catalog"])
log = logging.getLogger("app.catalog")
CATALOG = Path(__file__).resolve().parents[2] / "data" / "catalog.json"
PICKS = CATALOG.with_name("catalog-picks.json")  # the feed's short articles, from scripts/pick_explore
QUICK = quick_reads.OUTPUT
VI = article_translation.OUTPUT


def _modified(path: Path) -> int:
    return path.stat().st_mtime_ns if path.exists() else 0


@lru_cache(maxsize=1)
def _load(modified: int, picks_modified: int, quick_modified: int, vi_modified: int):
    data = json.loads(CATALOG.read_text(encoding="utf-8"))
    # The short reads come first: a reader is meant to start with one before committing to a long paper.
    if PICKS.exists():
        data["articles"] = json.loads(PICKS.read_text(encoding="utf-8")) + data["articles"]
    quick = quick_reads.load(QUICK)
    vi = quick_reads.load(VI)
    for article in data["articles"]:
        article["word_count"] = word_count(article["content"])
        if article["id"] in quick:
            article["quick"] = quick[article["id"]]
        if article["id"] in vi:
            article["vi"] = vi[article["id"]]
        article["keeps_translation"] = article_translation.may_keep(article)
        article["translatable"] = article_translation.translatable(article)
    return data


def catalog():
    if not CATALOG.exists():
        return {"updated_at": None, "articles": []}
    return _load(_modified(CATALOG), _modified(PICKS), _modified(QUICK), _modified(VI))


async def _taken_down(session) -> set[str]:
    """The addresses of the articles an admin has hidden or deleted. The catalog's files are copies, so what
    an admin decides is looked up here and reaches Explore at once, with no new copy written."""
    hidden = await session.scalars(select(Article.url).where(Article.hidden_at.is_not(None)))
    deleted = await session.scalars(select(BlockedArticle.url))
    return {*hidden, *deleted}


def list_articles(
    q: str = "",
    topic: str = "",
    kind: str = "",
    offset: int = 0,
    limit: int = 24,
    taken_down: Collection[str] = frozenset(),
):
    data = catalog()
    articles = [a for a in data["articles"] if a.get("url") not in taken_down]
    topics = sorted({a["topic"] for a in articles})
    needle = q.strip().casefold()
    filtered = [
        a
        for a in articles
        if (not topic or a["topic"] == topic)
        and (not kind or a["kind"] == kind)
        and (
            not needle
            or needle
            in (
                a["title"]
                + " "
                + a.get("description", "")
                + " "
                + a["topic"]
                + " "
                + a["authors"]
                + " "
                + a.get("quick", {}).get("title", "")
                + " "
                + a.get("vi", {}).get("title", "")
            ).casefold()
        )
    ]
    return {
        "total": len(filtered),
        "topics": topics,
        "updated_at": data["updated_at"],
        "articles": [
            {k: v for k, v in a.items() if k not in {"content", "abstract", "license_statement"}}
            for a in filtered[offset : offset + limit]
        ],
    }


@router.get("")
async def browse(
    session: SessionDep,
    q: str = Query("", max_length=200),
    topic: str = "",
    kind: str = "",
    offset: int = Query(0, ge=0),
    limit: int = Query(24, ge=1, le=200),
):
    return list_articles(q, topic, kind, offset, limit, await _taken_down(session))


def get_article(article_id: str):
    article = next((a for a in catalog()["articles"] if a["id"] == article_id), None)
    if article is None:
        raise HTTPException(404, "Không tìm thấy bài viết")
    return article


async def _shown(session, article_id: str) -> dict:
    """The article, unless an admin has taken it down. Readers' copies in their libraries are not affected."""
    article = get_article(article_id)
    if article.get("url") in await _taken_down(session):
        raise HTTPException(404, "Không tìm thấy bài viết")
    return article


@router.get("/{article_id}")
async def read_article(article_id: str, session: SessionDep):
    return await _shown(session, article_id)


async def _kept_translation(session, article: dict) -> str | None:
    """The stored translation of the article's present text. CC BY-ND articles never have one."""
    row = await session.get(
        ContentTranslation, (article["id"], article_translation.LANGUAGE, article_translation.CONTENT_TYPE)
    )
    return (
        row.translated_text
        if row and row.source_version == article_translation.source_version(article)
        else None
    )


@router.get("/{article_id}/translation")
async def read_translation(article_id: str, session: SessionDep):
    """A translation already kept, which anyone may read; `text` is null when there is none."""
    return {"text": await _kept_translation(session, await _shown(session, article_id))}


async def _keep_translation(settings, article: dict, text: str) -> None:
    async with SessionLocal() as session:
        await session.merge(
            ContentTranslation(
                content_id=article["id"],
                language=article_translation.LANGUAGE,
                content_type=article_translation.CONTENT_TYPE,
                source_version=article_translation.source_version(article),
                translated_text=text,
                translation_model=settings.openai_model,
            )
        )
        await session.commit()


@router.post("/{article_id}/translation")
async def translate_article(article_id: str, user: CurrentUser, session: SessionDep, settings: SettingsDep):
    """Streams a short read's text in Vietnamese as `delta` events followed by `done` or `error`. Kept for everyone
    if its licence allows; otherwise it is this reader's and gone afterwards."""
    article = await _shown(session, article_id)
    if not article_translation.translatable(article):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, MSG["MSG-26"])
    kept = await _kept_translation(session, article)

    async def events() -> AsyncIterator[str]:
        if kept:
            yield _sse("delta", {"text": kept})
            yield _sse("done", {"kept": True})
            return
        parts: list[str] = []
        try:
            async for part in article_translation.translate(settings, article["content"]):
                parts.append(part)
                yield _sse("delta", {"text": part})
            if article_translation.may_keep(article):
                await _keep_translation(settings, article, "\n\n".join(parts))
            yield _sse("done", {"kept": article_translation.may_keep(article)})
        except AIError as e:
            log.warning("article translation failed article=%s error=%s", article["id"], e)
            yield _sse("error", {"detail": MSG["MSG-26"]})
        except Exception:
            log.exception("article translation failed")
            yield _sse("error", {"detail": MSG["MSG-99"]})

    if not kept:
        if not (user.reading_preferences or {}).get("ai_consent"):  # NFR-PRV, as for every AI feature
            raise HTTPException(status.HTTP_403_FORBIDDEN, CONSENT_REQUIRED)
        if not settings.openai_api_key:
            raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, NOT_CONFIGURED)
        if not translate_article_day_limiter.hit(str(user.id)):
            log.warning("article translation rate limit hit user=%s", user.id)
            raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, MSG["MSG-TR-RATE"])
    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


def _published(article: dict) -> datetime | None:
    try:
        return datetime.fromisoformat(article.get("published_at") or "").replace(tzinfo=UTC)
    except ValueError:
        return None


@router.post(
    "/{article_id}/open",
    response_model=DocumentOut,
    status_code=201,
    responses={200: {"model": DocumentOut, "description": "The article is in the library already"}},
)
async def open_article(article_id: str, user: CurrentUser, session: SessionDep):
    """The user's copy of a shared article, made when they pick it: its text, headed by the credit."""
    article = await _shown(session, article_id)
    url = article["url"]
    existing = await session.scalar(select(Document).where(Document.user_id == user.id, Document.url == url))
    if existing is not None:
        return JSONResponse(DocumentOut.model_validate(existing).model_dump(mode="json"), status_code=200)

    credit = MSG["MSG-FEED-CREDIT"].format(
        credit=article.get("authors") or article["source"],
        source=article["source"],
        url=article.get("attribution_url") or url,
        license=article["license"],
        license_url=article["license_url"],
    )
    note = f"\n\n*{article['content_note']}*" if article.get("content_note") else ""
    content = f"*{credit}*{note}\n\n{article.get('content') or article.get('description', '')}"
    published = _published(article)
    doc = Document(
        user_id=user.id,
        source_type=SourceType.manual,
        url=url,
        title=article["title"],
        content_clean=content,
        word_count=word_count(content),
        published_at=published,
        extraction_status=ExtractionStatus.done,
        citation=Citation(
            container=article["source"],
            year=published.year if published else None,
            doi=article.get("doi") or "",
        ).model_dump(),
    )
    if (dup := await _commit_new_link(session, doc, user, url)) is not None:
        return dup
    await session.refresh(doc)
    return doc


class QuickReadReportIn(BaseModel):
    reason: Literal["wrong", "missing", "other"]


@router.post("/{article_id}/quick/report", status_code=status.HTTP_204_NO_CONTENT)
async def report_quick_read(
    article_id: str, payload: QuickReadReportIn, user: CurrentUser, session: SessionDep
) -> Response:
    """A reader says the article's Quick Read is wrong. Saying so again changes the reason, not the count."""
    if "quick" not in await _shown(session, article_id):
        raise HTTPException(404, "Không tìm thấy bài viết")
    report = await session.get(QuickReadReport, (article_id, user.id))
    if report is None:
        session.add(QuickReadReport(article_id=article_id, user_id=user.id, reason=payload.reason))
    else:
        report.reason = payload.reason
        report.created_at = utcnow()
    await session.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
