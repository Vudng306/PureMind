"""Translate a passage selected in the reader, English into Vietnamese.

A translation is not stored and costs no AI credits; a per-user rate limit stops a script from running up
the OpenAI bill. Like every AI feature, the passage is only sent to OpenAI once the user has agreed to it.
"""

import json
import logging
from collections.abc import AsyncIterator

from fastapi import APIRouter, HTTPException, Request, status
from fastapi.responses import JSONResponse, StreamingResponse

from app.api.deps import CurrentUser, SettingsDep
from app.api.routes.summaries import CONSENT_REQUIRED, NOT_CONFIGURED
from app.core.messages import MSG
from app.core.ratelimit import translate_day_limiter, translate_minute_limiter
from app.schemas import TranslateIn, TranslateOut
from app.services import translator
from app.services.openai_client import AIError, Usage

router = APIRouter(prefix="/translate", tags=["translate"])
log = logging.getLogger("app.translate")


def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


@router.post("", response_model=TranslateOut)
async def translate(payload: TranslateIn, request: Request, user: CurrentUser, settings: SettingsDep):
    """With `Accept: text/event-stream` the translation is streamed as `delta` events followed by `done` or
    `error`."""
    if not (user.reading_preferences or {}).get("ai_consent"):  # NFR-PRV: content leaves only after consent
        raise HTTPException(status.HTTP_403_FORBIDDEN, CONSENT_REQUIRED)
    if not settings.openai_api_key:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, NOT_CONFIGURED)
    key = str(user.id)
    if not (translate_minute_limiter.hit(key) and translate_day_limiter.hit(key)):
        # The limit is not shown to users: the message does not say there is one.
        log.warning("translate rate limit hit user=%s", key)
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, MSG["MSG-TR-RATE"])
    text = payload.text

    async def work() -> AsyncIterator[tuple[str, dict]]:
        parts: list[str] = []
        async for delta in translator.translate(settings, text, Usage()):
            parts.append(delta)
            yield "delta", {"text": delta}
        done = TranslateOut(
            translation="".join(parts).strip(),
            source=translator.SOURCE,
            target=translator.TARGET,
        )
        yield "done", done.model_dump()

    if "text/event-stream" not in request.headers.get("accept", ""):
        done: dict | None = None
        try:
            async for event, data in work():
                if event == "done":
                    done = data
        except AIError:
            raise HTTPException(status.HTTP_502_BAD_GATEWAY, MSG["MSG-26"]) from None
        return JSONResponse(done)

    async def events() -> AsyncIterator[str]:
        try:
            async for event, data in work():
                yield _sse(event, data)
        except AIError:
            yield _sse("error", {"detail": MSG["MSG-26"]})
        except Exception:
            log.exception("translation failed")
            yield _sse("error", {"detail": MSG["MSG-99"]})

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
