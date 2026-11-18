"""What each call to OpenAI used and what it cost, for the admin's cost page.

One row per call, retries included: the feature, the model, the token counts and the price worked out when the
call was made, so a later change of price leaves the past as it was. Never the text sent or received, nor which
document it was about (NFR-PRV-01). Calls of one request share its id, so the page can add them up.

Kept in memory and written with the traffic counts (crawler.tick), when the admin page asks and when a script
ends, so an AI call waits for no database write and cannot fail because of one.
"""

import logging
import re
import time
import uuid
from dataclasses import dataclass
from datetime import date

from sqlalchemy import insert

from app.core import logging as applog
from app.db.session import SessionLocal
from app.models import AiUsageEvent, utcnow
from app.services.ai_quota import today_vn

log = logging.getLogger("app.ai")

MAX_WAITING = 5000  # what is kept for a database that is away, the newest first


@dataclass(frozen=True)
class Price:
    """US dollars per million tokens."""

    input: float
    cached: float
    output: float


# OpenAI's standard prices, https://developers.openai.com/api/docs/pricing, read on PRICES_CHECKED.
PRICES_CHECKED = date(2026, 11, 18)
PRICES: dict[str, Price] = {
    "gpt-4.1": Price(2.00, 0.50, 8.00),
    "gpt-4.1-mini": Price(0.40, 0.10, 1.60),
    "gpt-4o": Price(2.50, 1.25, 10.00),
    "gpt-4o-mini": Price(0.15, 0.075, 0.60),
    "text-embedding-3-small": Price(0.02, 0.02, 0.0),
}
WEB_SEARCH_USD = 10.00 / 1000  # per call of the web search tool, on top of its tokens


@dataclass(frozen=True)
class Tokens:
    prompt: int = 0  # cached ones included, as OpenAI counts them
    cached: int = 0
    completion: int = 0


def _count(value: object) -> int:
    return value if isinstance(value, int) and value > 0 else 0


def read_tokens(data: object) -> Tokens:
    """The `usage` of an answer from Chat Completions, Embeddings or Responses; zeros when it has none."""
    usage = data.get("usage") if isinstance(data, dict) else None
    if not isinstance(usage, dict):
        return Tokens()
    details = usage.get("prompt_tokens_details") or usage.get("input_tokens_details")
    return Tokens(
        prompt=_count(usage.get("prompt_tokens", usage.get("input_tokens"))),
        cached=_count(details.get("cached_tokens")) if isinstance(details, dict) else 0,
        completion=_count(usage.get("completion_tokens", usage.get("output_tokens"))),
    )


def price_of(model: str) -> Price | None:
    """A dated snapshot ("gpt-4.1-2025-04-14") costs what its model costs."""
    return PRICES.get(model) or PRICES.get(re.sub(r"-\d{4}-\d{2}-\d{2}$", "", model))


def cost_of(model: str, tokens: Tokens, web_searches: int = 0) -> float | None:
    """In US dollars; None for a model with no known price, so it is reported instead of counted as free."""
    if not (tokens.prompt or tokens.completion or web_searches):
        return 0.0
    price = price_of(model)
    if price is None:
        return None
    cached = min(tokens.cached, tokens.prompt)
    per_million = (
        (tokens.prompt - cached) * price.input + cached * price.cached + tokens.completion * price.output
    )
    return per_million / 1_000_000 + web_searches * WEB_SEARCH_USD


_waiting: list[dict] = []


def _user_id() -> uuid.UUID | None:
    try:
        return uuid.UUID(applog.user_id_var.get() or "")
    except ValueError:
        return None


def record(
    purpose: str, model: str, tokens: Tokens, started: float, *, ok: bool = True, web_searches: int = 0
) -> None:
    """Note one call. `started` is its `time.monotonic()`. Outside a request (a crawl, a script) it stands alone."""
    _waiting.append(
        {
            "id": uuid.uuid4(),
            "created_at": utcnow(),
            "day": today_vn(),
            "request_id": (applog.request_id_var.get() or applog.new_request_id())[:64],
            "user_id": _user_id(),
            "purpose": purpose[:32],
            "model": model[:64],
            "prompt_tokens": tokens.prompt,
            "cached_tokens": tokens.cached,
            "completion_tokens": tokens.completion,
            "web_searches": web_searches,
            "cost_usd": cost_of(model, tokens, web_searches),
            "ok": ok,
            "duration_ms": int((time.monotonic() - started) * 1000),
        }
    )
    del _waiting[:-MAX_WAITING]


async def flush() -> None:
    """Write what is waiting. A failure keeps it for the next time and never reaches the caller."""
    events = _waiting[:]
    if not events:
        return
    del _waiting[: len(events)]
    try:
        async with SessionLocal() as session:
            await session.execute(insert(AiUsageEvent), events)
            await session.commit()
    except Exception as e:
        log.warning("ai usage not written, %d events kept: %r", len(events), e)
        _waiting[:0] = events
        del _waiting[:-MAX_WAITING]


def reset() -> None:
    """Forget what was noted and not written (the tests)."""
    _waiting.clear()
