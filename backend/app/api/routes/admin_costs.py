"""Admin page: what the AI costs, in tokens and US dollars, overall and request by request.

Built from `ai_usage_events`, which holds counts and never anything a user sent or received. An admin sees who
used how much, as on the accounts page, not what they asked.
"""

import uuid
from collections import defaultdict
from datetime import date, datetime, timedelta

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import case, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import AdminUser, SessionDep
from app.api.routes.admin_content import TRAFFIC_DAYS
from app.core.messages import MSG
from app.models import AiUsageEvent as Event
from app.models import User
from app.services import ai_usage
from app.services.ai_quota import today_vn

router = APIRouter(prefix="/admin", tags=["admin"])
TOP_USERS = 10


class Spend(BaseModel):
    calls: int
    failed_calls: int
    prompt_tokens: int
    cached_tokens: int
    completion_tokens: int
    web_searches: int
    cost_usd: float
    unpriced_calls: int


class SpendTotals(Spend):
    requests: int
    today_cost_usd: float


class SpendDay(Spend):
    day: date


class SpendByKey(Spend):
    key: str


class SpendByUser(Spend):
    user_id: uuid.UUID
    email: str


class ModelPrice(BaseModel):
    model: str
    input: float
    cached: float
    output: float


class Prices(BaseModel):
    checked: date
    web_search_per_1k: float
    models: list[ModelPrice]


class AiCosts(BaseModel):
    days: list[SpendDay]
    totals: SpendTotals
    features: list[SpendByKey]
    models: list[SpendByKey]
    users: list[SpendByUser]
    prices: Prices


class RequestCall(BaseModel):
    id: uuid.UUID
    at: datetime
    purpose: str
    model: str
    prompt_tokens: int
    cached_tokens: int
    completion_tokens: int
    web_searches: int
    cost_usd: float | None
    ok: bool
    duration_ms: int


class AiRequest(BaseModel):
    request_id: str
    at: datetime
    user_id: uuid.UUID | None
    email: str | None
    prompt_tokens: int
    cached_tokens: int
    completion_tokens: int
    cost_usd: float
    unpriced_calls: int
    calls: list[RequestCall]


class AiRequestPage(BaseModel):
    items: list[AiRequest]
    total: int
    page: int
    page_size: int


_SPEND = (
    func.count().label("calls"),
    func.coalesce(func.sum(case((Event.ok.is_(False), 1), else_=0)), 0).label("failed_calls"),
    func.coalesce(func.sum(Event.prompt_tokens), 0).label("prompt_tokens"),
    func.coalesce(func.sum(Event.cached_tokens), 0).label("cached_tokens"),
    func.coalesce(func.sum(Event.completion_tokens), 0).label("completion_tokens"),
    func.coalesce(func.sum(Event.web_searches), 0).label("web_searches"),
    func.coalesce(func.sum(Event.cost_usd), 0.0).label("cost_usd"),
    func.coalesce(func.sum(case((Event.cost_usd.is_(None), 1), else_=0)), 0).label("unpriced_calls"),
)
_NOTHING = {name.key: 0 for name in _SPEND}


def _spend(row) -> dict:
    return {name: getattr(row, name) for name in _NOTHING}


async def _first_day(days: int) -> date:
    """The range's first day, after writing what is waiting so the page is up to date."""
    if days not in TRAFFIC_DAYS:
        raise HTTPException(422, MSG["MSG-INVALID"])
    await ai_usage.flush()
    return today_vn() - timedelta(days=days - 1)


async def _by(session: AsyncSession, column, first: date) -> list[SpendByKey]:
    rows = await session.execute(
        select(column.label("key"), *_SPEND)
        .where(Event.day >= first)
        .group_by(column)
        .order_by(func.sum(Event.cost_usd).desc().nulls_last(), column)
    )
    return [SpendByKey(key=r.key, **_spend(r)) for r in rows]


@router.get("/ai-costs", response_model=AiCosts)
async def ai_costs(_: AdminUser, session: SessionDep, days: int = Query(30)):
    """Tokens and cost per day (Vietnam time), per feature, per model and for the accounts that use the most."""
    first = await _first_day(days)
    today = today_vn()
    per_day = {
        r.day: r
        for r in await session.execute(
            select(Event.day, *_SPEND).where(Event.day >= first).group_by(Event.day)
        )
    }
    series = []
    for i in range(days):
        day = first + timedelta(days=i)
        row = per_day.get(day)
        series.append(SpendDay(day=day, **(_spend(row) if row else _NOTHING)))

    total = (await session.execute(select(*_SPEND).where(Event.day >= first))).one()
    requests = await session.scalar(
        select(func.count(func.distinct(Event.request_id))).where(Event.day >= first)
    )
    users = await session.execute(
        select(User.id, User.email, *_SPEND)
        .join(User, User.id == Event.user_id)
        .where(Event.day >= first)
        .group_by(User.id, User.email)
        .order_by(func.sum(Event.cost_usd).desc().nulls_last(), User.email)
        .limit(TOP_USERS)
    )
    return AiCosts(
        days=series,
        totals=SpendTotals(
            **_spend(total),
            requests=requests or 0,
            today_cost_usd=series[-1].cost_usd if series[-1].day == today else 0,
        ),
        features=await _by(session, Event.purpose, first),
        models=await _by(session, Event.model, first),
        users=[SpendByUser(user_id=r.id, email=r.email, **_spend(r)) for r in users],
        prices=Prices(
            checked=ai_usage.PRICES_CHECKED,
            web_search_per_1k=ai_usage.WEB_SEARCH_USD * 1000,
            models=[
                ModelPrice(model=m, input=p.input, cached=p.cached, output=p.output)
                for m, p in ai_usage.PRICES.items()
            ],
        ),
    )


@router.get("/ai-costs/requests", response_model=AiRequestPage)
async def ai_cost_requests(
    _: AdminUser,
    session: SessionDep,
    days: int = Query(30),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
):
    """Requests that used the AI, newest first, each with its calls and what they add up to."""
    first = await _first_day(days)
    groups = (
        select(
            Event.request_id,
            Event.user_id,
            func.max(Event.created_at).label("at"),
            *_SPEND,
        )
        .where(Event.day >= first)
        .group_by(Event.request_id, Event.user_id)
    )
    total = await session.scalar(select(func.count()).select_from(groups.subquery()))
    rows = (
        await session.execute(
            groups.order_by(func.max(Event.created_at).desc(), Event.request_id)
            .offset((page - 1) * page_size)
            .limit(page_size)
        )
    ).all()

    calls: dict[tuple[str, uuid.UUID | None], list[RequestCall]] = defaultdict(list)
    if rows:
        events = await session.scalars(
            select(Event)
            .where(Event.day >= first, Event.request_id.in_([r.request_id for r in rows]))
            .order_by(Event.created_at, Event.id)
        )
        for e in events:
            calls[(e.request_id, e.user_id)].append(
                RequestCall(
                    id=e.id,
                    at=e.created_at,
                    purpose=e.purpose,
                    model=e.model,
                    prompt_tokens=e.prompt_tokens,
                    cached_tokens=e.cached_tokens,
                    completion_tokens=e.completion_tokens,
                    web_searches=e.web_searches,
                    cost_usd=e.cost_usd,
                    ok=e.ok,
                    duration_ms=e.duration_ms,
                )
            )
    ids = {r.user_id for r in rows if r.user_id}
    emails = (
        dict((await session.execute(select(User.id, User.email).where(User.id.in_(ids)))).all())
        if ids
        else {}
    )
    return AiRequestPage(
        items=[
            AiRequest(
                request_id=r.request_id,
                at=r.at,
                user_id=r.user_id if r.user_id in emails else None,
                email=emails.get(r.user_id),
                prompt_tokens=r.prompt_tokens,
                cached_tokens=r.cached_tokens,
                completion_tokens=r.completion_tokens,
                cost_usd=r.cost_usd,
                unpriced_calls=r.unpriced_calls,
                calls=calls[(r.request_id, r.user_id)],
            )
            for r in rows
        ],
        total=total or 0,
        page=page,
        page_size=page_size,
    )
