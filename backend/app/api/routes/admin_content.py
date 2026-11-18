"""Admin page, beyond accounts: the traffic. Counts per day and part of the app, never who asked for what."""

from collections import Counter
from datetime import UTC, date, datetime, timedelta

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import func, select

from app.api.deps import AdminUser, SessionDep
from app.core.messages import MSG
from app.models import Document, TrafficDaily, User, UserActivityDaily
from app.services import traffic
from app.services.ai_quota import VN, today_vn

router = APIRouter(prefix="/admin", tags=["admin"])
TRAFFIC_DAYS = (7, 30, 90)


def _aware(value: datetime) -> datetime:
    """SQLite hands timestamps back without their zone."""
    return value.replace(tzinfo=UTC) if value.tzinfo is None else value


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
        _aware(c).astimezone(VN).date()
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
        documents=await count(select(func.count()).select_from(Document)),
    )
    return Traffic(days=series, areas=areas, totals=totals)
