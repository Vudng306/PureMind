"""FR-CHAT-01: text embeddings with the OpenAI API, used to find the passages a question is about.

Vectors are stored as JSON arrays of floats (`document_chunks.embedding`), which PostgreSQL casts to
`vector` when pgvector is installed and Python reads back everywhere else. Like every other AI call, a
request is logged with model, tokens and duration, never with the content (NFR-OBS-02).
"""

import json
import logging
import math
import time

import httpx

from app.core.config import Settings
from app.services.openai_client import RETRY_STATUS, AIError, Usage

log = logging.getLogger("app.ai")

BATCH = 64  # inputs per request; a passage is ~400 tokens, well inside the 8k-token input limit
DECIMALS = 6  # enough precision for cosine similarity, and a third off the stored size


def encode(vector: list[float]) -> str:
    return json.dumps([round(v, DECIMALS) for v in vector], separators=(",", ":"))


def decode(text: str) -> list[float]:
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        return []
    return [float(v) for v in data] if isinstance(data, list) else []


def cosine(a: list[float], b: list[float]) -> float:
    """Similarity in -1..1; 0 when either vector is empty or of a different size (a stale index)."""
    if not a or len(a) != len(b):
        return 0.0
    dot = sum(x * y for x, y in zip(a, b, strict=True))
    norm = math.sqrt(sum(x * x for x in a)) * math.sqrt(sum(y * y for y in b))
    return dot / norm if norm else 0.0


async def _request(settings: Settings, inputs: list[str], purpose: str, usage: Usage) -> list[list[float]]:
    """One /embeddings call; transport errors and 429/5xx are retried once, like `openai_client.chat`."""
    body = {
        "model": settings.openai_embedding_model,
        "input": inputs,
        "dimensions": settings.embedding_dimensions,
    }
    last: Exception | None = None
    for attempt in range(2):
        started = time.monotonic()
        try:
            async with httpx.AsyncClient(timeout=settings.openai_timeout_seconds) as client:
                res = await client.post(
                    f"{settings.openai_base_url.rstrip('/')}/embeddings",
                    headers={"Authorization": f"Bearer {settings.openai_api_key}"},
                    json=body,
                )
            if res.status_code != 200:
                raise AIError(f"HTTP {res.status_code}", retryable=res.status_code in RETRY_STATUS)
            data = res.json()
            items = sorted(data["data"], key=lambda d: d["index"])
            vectors = [[float(v) for v in item["embedding"]] for item in items]
            if len(vectors) != len(inputs) or any(len(v) != settings.embedding_dimensions for v in vectors):
                raise AIError("unexpected embedding shape")
            tokens = int((data.get("usage") or {}).get("prompt_tokens") or 0)
        except (httpx.HTTPError, AIError, KeyError, IndexError, TypeError, json.JSONDecodeError) as e:
            last = e
            log.warning(
                "openai embeddings failed purpose=%s model=%s attempt=%d duration_ms=%d error=%s",
                purpose,
                settings.openai_embedding_model,
                attempt + 1,
                (time.monotonic() - started) * 1000,
                e,
            )
            if not (isinstance(e, httpx.HTTPError) or getattr(e, "retryable", False)):
                break
            continue
        usage.add(Usage(tokens, 0))
        log.info(
            "openai embeddings ok purpose=%s model=%s inputs=%d prompt_tokens=%d duration_ms=%d",
            purpose,
            settings.openai_embedding_model,
            len(inputs),
            tokens,
            (time.monotonic() - started) * 1000,
        )
        return vectors
    raise AIError(str(last))


async def embed(settings: Settings, texts: list[str], *, purpose: str, usage: Usage) -> list[list[float]]:
    """Embeddings for `texts`, in the same order. Sent in batches; one failed batch fails the whole call."""
    vectors: list[list[float]] = []
    for start in range(0, len(texts), BATCH):
        vectors += await _request(settings, texts[start : start + BATCH], purpose, usage)
    return vectors
