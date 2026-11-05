"""How much PureMind is used, for the admin page: requests, errors and AI calls per day and part of the app,
and how many accounts were active each day. Counts only: no address, path parameter or anything a user sent.

Counted in memory as requests come and written every minute (crawler.loop) or when the admin page asks, so a
request costs no database write.
"""

import contextlib
import uuid
from collections import defaultdict
from datetime import date, timedelta

from sqlalchemy import delete
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert

from app.db.session import SessionLocal
from app.models import TrafficDaily, UserActivityDaily
from app.services.ai_quota import today_vn

# The requests that ask the AI for something, by endpoint.
AI_ENDPOINTS = {
    ("POST", "/api/summaries"),
    ("POST", "/api/notebooks/generate"),
    ("POST", "/api/chat/conversations/{conversation_id}/messages"),
    ("POST", "/api/feed/chat"),
    ("POST", "/api/translate"),
}
ACTIVITY_DAYS = 90
# The platform's health checks are not use.
UNCOUNTED = {"healthz"}

_counts: dict[tuple[date, str], list[int]] = defaultdict(lambda: [0, 0, 0])
_active: set[tuple[date, uuid.UUID]] = set()


def area_of(path: str) -> str | None:
    """ "/api/documents/…" -> "documents": the part of the app a request is for; None outside the API."""
    parts = path.split("/")
    return parts[2][:24] if len(parts) > 2 and parts[1] == "api" and parts[2] else None


def record(method: str, endpoint: str, status: int, user_id: str | None) -> None:
    area = area_of(endpoint)
    if area is None or area in UNCOUNTED or method == "OPTIONS":
        return
    day = today_vn()
    counts = _counts[(day, area)]
    counts[0] += 1
    counts[1] += status >= 500
    counts[2] += status < 400 and (method, endpoint) in AI_ENDPOINTS
    if user_id:
        with contextlib.suppress(ValueError):
            _active.add((day, uuid.UUID(user_id)))


async def flush() -> None:
    """Add what was counted since the last flush to the database."""
    global _counts, _active
    counts, active = _counts, _active
    _counts, _active = defaultdict(lambda: [0, 0, 0]), set()
    if not counts and not active:
        return
    async with SessionLocal() as session:
        insert = pg_insert if session.bind.dialect.name == "postgresql" else sqlite_insert
        if counts:
            stmt = insert(TrafficDaily).values(
                [
                    {"day": d, "area": a, "requests": r, "errors": e, "ai_calls": ai}
                    for (d, a), (r, e, ai) in counts.items()
                ]
            )
            await session.execute(
                stmt.on_conflict_do_update(
                    index_elements=["day", "area"],
                    set_={
                        "requests": TrafficDaily.requests + stmt.excluded.requests,
                        "errors": TrafficDaily.errors + stmt.excluded.errors,
                        "ai_calls": TrafficDaily.ai_calls + stmt.excluded.ai_calls,
                    },
                )
            )
        if active:
            stmt = insert(UserActivityDaily).values([{"day": d, "user_id": u} for d, u in active])
            await session.execute(stmt.on_conflict_do_nothing(index_elements=["day", "user_id"]))
            await session.execute(
                delete(UserActivityDaily).where(
                    UserActivityDaily.day < today_vn() - timedelta(days=ACTIVITY_DAYS)
                )
            )
        await session.commit()


def reset() -> None:
    """Forget what was counted and not written (the tests)."""
    _counts.clear()
    _active.clear()
