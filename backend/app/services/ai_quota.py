"""Daily AI quotas, reset at 00:00 Vietnam time; failures are not counted.

Two counters: summaries and notebooks share one (`ai_daily_quota`), chat questions have their own
(`chat_daily_quota`) because an answer costs a fraction of what writing a notebook costs.
"""

from datetime import date, datetime, timedelta, timezone

from app.models import User

# Vietnam has no daylight saving time; a fixed offset avoids needing tzdata on Windows.
VN = timezone(timedelta(hours=7))


def today_vn() -> date:
    return datetime.now(VN).date()


def remaining(user: User, limit: int) -> int:
    used = user.ai_quota_used if user.ai_quota_date == today_vn() else 0
    return max(0, limit - used)


def consume(user: User) -> None:
    """Count one successful AI request (the caller commits)."""
    today = today_vn()
    if user.ai_quota_date != today:
        user.ai_quota_date = today
        user.ai_quota_used = 0
    user.ai_quota_used += 1


def chat_remaining(user: User, limit: int) -> int:
    """FR-CHAT-02: questions left today."""
    used = user.chat_quota_used if user.chat_quota_date == today_vn() else 0
    return max(0, limit - used)


def chat_consume(user: User) -> None:
    """Count one answered question (the caller commits)."""
    today = today_vn()
    if user.chat_quota_date != today:
        user.chat_quota_date = today
        user.chat_quota_used = 0
    user.chat_quota_used += 1
