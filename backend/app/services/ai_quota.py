"""Daily AI quota: N requests per user per day, reset at 00:00 Vietnam time; failures are not counted."""

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
