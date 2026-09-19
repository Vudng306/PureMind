"""Minimal OpenAI Chat Completions client (SRS 3.3: AI provider is the OpenAI API).

Uses httpx directly. Every call is logged with model, tokens, duration and outcome — never the content
(NFR-OBS-02).
"""

import json
import logging
import time
from collections.abc import AsyncIterator
from dataclasses import dataclass

import httpx

from app.core.config import Settings

log = logging.getLogger("app.ai")

RETRY_STATUS = {408, 409, 429, 500, 502, 503, 504}


class AIError(Exception):
    """The AI service failed or returned something unusable (MSG-26)."""

    def __init__(self, message: str, retryable: bool = False):
        super().__init__(message)
        self.retryable = retryable


@dataclass
class Usage:
    prompt_tokens: int = 0
    completion_tokens: int = 0

    def add(self, other: "Usage") -> None:
        self.prompt_tokens += other.prompt_tokens
        self.completion_tokens += other.completion_tokens


@dataclass
class Completion:
    text: str
    usage: Usage


async def chat(
    settings: Settings,
    messages: list[dict],
    *,
    purpose: str,
    json_schema: dict | None = None,
    max_tokens: int = 4000,
) -> Completion:
    """One chat completion; transport errors and 429/5xx are retried once."""
    body: dict = {"model": settings.openai_model, "messages": messages, "max_completion_tokens": max_tokens}
    if json_schema is not None:
        body["response_format"] = {"type": "json_schema", "json_schema": json_schema}

    last: Exception | None = None
    for attempt in range(2):
        started = time.monotonic()
        try:
            async with httpx.AsyncClient(timeout=settings.openai_timeout_seconds) as client:
                res = await client.post(
                    f"{settings.openai_base_url.rstrip('/')}/chat/completions",
                    headers={"Authorization": f"Bearer {settings.openai_api_key}"},
                    json=body,
                )
            if res.status_code != 200:
                raise AIError(f"HTTP {res.status_code}", retryable=res.status_code in RETRY_STATUS)
            data = res.json()
            choice = data["choices"][0]
            text = choice["message"].get("content") or ""
            if choice.get("finish_reason") not in (None, "stop") or not text.strip():
                raise AIError(f"finish_reason={choice.get('finish_reason')}")
            u = data.get("usage") or {}
            usage = Usage(int(u.get("prompt_tokens") or 0), int(u.get("completion_tokens") or 0))
        except (httpx.HTTPError, AIError, KeyError, IndexError, TypeError, json.JSONDecodeError) as e:
            last = e
            log.warning(
                "openai call failed purpose=%s model=%s attempt=%d duration_ms=%d error=%s",
                purpose, settings.openai_model, attempt + 1, (time.monotonic() - started) * 1000, e,
            )
            # Timeouts and network errors are worth one more try; a malformed answer or a 4xx is not.
            if not (isinstance(e, httpx.HTTPError) or getattr(e, "retryable", False)):
                break
            continue
        log.info(
            "openai call ok purpose=%s model=%s prompt_tokens=%d completion_tokens=%d duration_ms=%d",
            purpose, settings.openai_model, usage.prompt_tokens, usage.completion_tokens,
            (time.monotonic() - started) * 1000,
        )
        return Completion(text, usage)
    raise AIError(str(last))


async def chat_stream(
    settings: Settings,
    messages: list[dict],
    *,
    purpose: str,
    usage: Usage,
    max_tokens: int = 4000,
) -> AsyncIterator[str]:
    """A streamed chat completion: yields text deltas and adds the token counts to `usage` at the end.

    Failures before the first delta are retried once like `chat`; after that the error is raised (the caller
    has already shown part of the answer). A truncated or empty answer raises AIError.
    """
    body = {
        "model": settings.openai_model,
        "messages": messages,
        "max_completion_tokens": max_tokens,
        "stream": True,
        "stream_options": {"include_usage": True},
    }
    last: Exception | None = None
    for attempt in range(2):
        started = time.monotonic()
        sent = False
        finish: str | None = None
        got = Usage()
        try:
            async with httpx.AsyncClient(timeout=settings.openai_timeout_seconds) as client:
                async with client.stream(
                    "POST",
                    f"{settings.openai_base_url.rstrip('/')}/chat/completions",
                    headers={"Authorization": f"Bearer {settings.openai_api_key}"},
                    json=body,
                ) as res:
                    if res.status_code != 200:
                        raise AIError(f"HTTP {res.status_code}", retryable=res.status_code in RETRY_STATUS)
                    async for line in res.aiter_lines():
                        if not line.startswith("data:"):
                            continue
                        data = line[5:].strip()
                        if data == "[DONE]":
                            break
                        chunk = json.loads(data)
                        if u := chunk.get("usage"):
                            got = Usage(int(u.get("prompt_tokens") or 0), int(u.get("completion_tokens") or 0))
                        for choice in chunk.get("choices") or []:
                            if text := (choice.get("delta") or {}).get("content"):
                                sent = True
                                yield text
                            finish = choice.get("finish_reason") or finish
            if finish not in (None, "stop") or not sent:
                raise AIError(f"finish_reason={finish}")
        except (httpx.HTTPError, AIError, KeyError, TypeError, json.JSONDecodeError) as e:
            last = e
            log.warning(
                "openai stream failed purpose=%s model=%s attempt=%d duration_ms=%d error=%s",
                purpose, settings.openai_model, attempt + 1, (time.monotonic() - started) * 1000, e,
            )
            if sent or not (isinstance(e, httpx.HTTPError) or getattr(e, "retryable", False)):
                break
            continue
        usage.add(got)
        log.info(
            "openai stream ok purpose=%s model=%s prompt_tokens=%d completion_tokens=%d duration_ms=%d",
            purpose, settings.openai_model, got.prompt_tokens, got.completion_tokens,
            (time.monotonic() - started) * 1000,
        )
        return
    raise AIError(str(last))
