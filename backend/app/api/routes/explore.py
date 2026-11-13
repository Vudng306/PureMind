"""Explore: the reader describes a subject, the AI finds three to five documents worth reading in full, and
each one is checked for whether its text can be brought into the library.

Nothing is saved here. The reader adds a document with the library's own "save a link", which is when it is
fetched and processed; a page that does not let itself be read is opened where it is.
"""

import logging
import uuid
from typing import Literal

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import select

from app.api.deps import CurrentUser, SessionDep, SettingsDep
from app.api.routes.summaries import CONSENT_REQUIRED, NOT_CONFIGURED
from app.core.messages import MSG
from app.core.ratelimit import explore_check_limiter, explore_search_limiter
from app.models import Document
from app.services import ai_quota, discover, web
from app.services.openai_client import AIError

router = APIRouter(prefix="/explore", tags=["explore"])
log = logging.getLogger("app.explore")

# Users with a search running in this process, so a double click does not spend two questions.
_searching: set[uuid.UUID] = set()


class SearchIn(BaseModel):
    query: str = Field(min_length=3, max_length=500)
    language: Literal["vi", "en"] = "vi"

    @field_validator("query", mode="before")
    @classmethod
    def trimmed(cls, v):
        return " ".join(v.split()) if isinstance(v, str) else v


class FoundOut(BaseModel):
    url: str
    title: str
    source: str
    authors: str
    year: int | None
    kind: str
    summary: str
    reason: str
    # The reader's copy, when the address is in their library already.
    document_id: str | None = None


class SearchOut(BaseModel):
    documents: list[FoundOut]
    chat_quota_remaining: int


class CheckIn(BaseModel):
    url: str = Field(max_length=2048)


class CheckOut(BaseModel):
    status: Literal["importable", "blocked", "failed"]
    kind: str = ""
    import_url: str = ""
    title: str = ""
    word_count: int = 0
    pdf_url: str = ""
    document_id: str | None = None


async def _copies(session: SessionDep, user_id: uuid.UUID, urls: list[str]) -> dict[str, str]:
    """Which of the addresses the reader has saved already, each with its document."""
    if not urls:
        return {}
    rows = await session.execute(
        select(Document.url, Document.id).where(Document.user_id == user_id, Document.url.in_(urls))
    )
    return {url: str(doc_id) for url, doc_id in rows}


@router.post("/search", response_model=SearchOut)
async def search(payload: SearchIn, user: CurrentUser, session: SessionDep, settings: SettingsDep):
    """Find documents on a subject. A search that finds some costs one of the day's chat questions; one that
    fails or finds nothing costs none."""
    if not (user.reading_preferences or {}).get("ai_consent"):  # NFR-PRV: nothing leaves before consent
        raise HTTPException(status.HTTP_403_FORBIDDEN, CONSENT_REQUIRED)
    if not settings.openai_api_key:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, NOT_CONFIGURED)
    if ai_quota.chat_remaining(user, settings.chat_daily_quota) <= 0:
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, MSG["MSG-CHAT-QUOTA"])
    if user.id in _searching:
        raise HTTPException(status.HTTP_409_CONFLICT, MSG["MSG-EXPLORE-BUSY"])
    if not explore_search_limiter.hit(str(user.id)):
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, MSG["MSG-EXPLORE-LIMIT"])

    _searching.add(user.id)
    try:
        found = await discover.discover(settings, payload.query, payload.language)
    except AIError:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, MSG["MSG-26"]) from None
    finally:
        _searching.discard(user.id)

    if found:
        ai_quota.chat_consume(user)
        await session.commit()
    copies = await _copies(session, user.id, [f.url for f in found])
    return SearchOut(
        documents=[FoundOut(**vars(f), document_id=copies.get(f.url)) for f in found],
        chat_quota_remaining=ai_quota.chat_remaining(user, settings.chat_daily_quota),
    )


@router.post("/check", response_model=CheckOut)
async def check(payload: CheckIn, user: CurrentUser, session: SessionDep, settings: SettingsDep):
    """Whether the address's text can be brought into the library: a forecast from one visit, which saves
    nothing. `blocked` is a site that will not be read from here; `failed` is worth asking again."""
    try:
        url = str(web.validate_url(payload.url))
    except web.InvalidUrl:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, MSG["MSG-16"]) from None
    copies = await _copies(session, user.id, [url])
    if url in copies:
        return CheckOut(status="importable", import_url=url, document_id=copies[url])
    if not explore_check_limiter.hit(str(user.id)):
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, MSG["MSG-EXPLORE-LIMIT"])
    result = await discover.check(url, settings.web_contact)
    copy = (
        (await _copies(session, user.id, [result.import_url])) if result.import_url not in ("", url) else {}
    )
    return CheckOut(**vars(result), document_id=copy.get(result.import_url))
