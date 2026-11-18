import itertools
import json
import time
import uuid
from datetime import timedelta

import httpx
import pytest
from sqlalchemy import delete, select

from app.core import logging as applog
from app.core.config import get_settings
from app.db.session import SessionLocal
from app.models import AiUsageEvent
from app.services import ai_usage, discover, embeddings, openai_client
from app.services.openai_client import AIError, Usage
from tests.test_admin import _make_admin, _make_user
from tests.test_summaries import consent


@pytest.fixture
async def clean():
    ai_usage.reset()
    async with SessionLocal() as session:
        await session.execute(delete(AiUsageEvent))
        await session.commit()
    yield
    ai_usage.reset()


@pytest.fixture
def settings():
    return get_settings().model_copy(update={"openai_api_key": "sk-x", "openai_model": "gpt-4.1-mini"})


def replying(monkeypatch, module, *replies):
    real = httpx.AsyncClient
    waiting = list(replies)
    monkeypatch.setattr(
        module.httpx,
        "AsyncClient",
        lambda **kw: real(transport=httpx.MockTransport(lambda _: waiting.pop(0)), **kw),
    )


def answer(finish="stop", **usage):
    return httpx.Response(
        200,
        json={"choices": [{"message": {"content": "ok"}, "finish_reason": finish}], "usage": usage},
    )


def stream_body(prompt: int, completion: int) -> str:
    lines = [
        {"choices": [{"delta": {"content": "hi"}, "finish_reason": None}]},
        {"choices": [{"delta": {}, "finish_reason": "stop"}]},
        {"choices": [], "usage": {"prompt_tokens": prompt, "completion_tokens": completion}},
    ]
    return "".join(f"data: {json.dumps(line)}\n\n" for line in lines) + "data: [DONE]\n\n"


async def stored() -> list[AiUsageEvent]:
    await ai_usage.flush()
    async with SessionLocal() as session:
        return list(await session.scalars(select(AiUsageEvent).order_by(AiUsageEvent.created_at)))


_ticks = itertools.count()


def note(
    purpose="chat", model="gpt-4.1", prompt=1000, cached=0, completion=100, request="r1", user=None, **kw
):
    request_token = applog.request_id_var.set(request)
    user_token = applog.user_id_var.set(str(user) if user else None)
    try:
        ai_usage.record(purpose, model, ai_usage.Tokens(prompt, cached, completion), time.monotonic(), **kw)
        # The clock can read the same for two calls in a row: keep them in the order they were noted.
        ai_usage._waiting[-1]["created_at"] += timedelta(seconds=next(_ticks))
    finally:
        applog.request_id_var.reset(request_token)
        applog.user_id_var.reset(user_token)


def test_cost_counts_cached_tokens_at_their_own_price():
    tokens = ai_usage.Tokens(prompt=1_000_000, cached=400_000, completion=500_000)
    assert ai_usage.cost_of("gpt-4.1", tokens) == pytest.approx(0.6 * 2 + 0.4 * 0.5 + 0.5 * 8)
    assert ai_usage.cost_of("gpt-4.1-2025-04-14", tokens) == ai_usage.cost_of("gpt-4.1", tokens)


def test_cost_of_web_search_and_unknown_models():
    assert ai_usage.cost_of("gpt-4.1", ai_usage.Tokens(), web_searches=2) == pytest.approx(0.02)
    assert ai_usage.cost_of("no-such-model", ai_usage.Tokens(prompt=5)) is None
    assert ai_usage.cost_of("no-such-model", ai_usage.Tokens()) == 0


def test_read_tokens_from_each_api_shape():
    chat = {
        "usage": {"prompt_tokens": 9, "completion_tokens": 2, "prompt_tokens_details": {"cached_tokens": 4}}
    }
    responses = {
        "usage": {"input_tokens": 7, "output_tokens": 3, "input_tokens_details": {"cached_tokens": 1}}
    }
    assert ai_usage.read_tokens(chat) == ai_usage.Tokens(9, 4, 2)
    assert ai_usage.read_tokens(responses) == ai_usage.Tokens(7, 1, 3)
    assert ai_usage.read_tokens({"usage": None}) == ai_usage.read_tokens([]) == ai_usage.Tokens()


async def test_every_attempt_of_a_call_is_recorded(clean, monkeypatch, settings):
    replying(
        monkeypatch,
        openai_client,
        httpx.Response(500),
        answer(prompt_tokens=100, completion_tokens=10, prompt_tokens_details={"cached_tokens": 40}),
    )
    done = await openai_client.chat(settings, [], purpose="summary")
    assert done.usage == Usage(100, 10)

    failed, ok = sorted(await stored(), key=lambda e: e.ok)
    assert (failed.ok, failed.prompt_tokens, failed.cost_usd) == (False, 0, 0)
    assert (ok.ok, ok.purpose, ok.model, ok.prompt_tokens, ok.cached_tokens) == (
        True,
        "summary",
        "gpt-4.1-mini",
        100,
        40,
    )
    assert ok.cost_usd == pytest.approx((60 * 0.4 + 40 * 0.1 + 10 * 1.6) / 1_000_000)


async def test_an_answer_cut_short_still_counts_its_tokens(clean, monkeypatch, settings):
    replying(monkeypatch, openai_client, answer("length", prompt_tokens=50, completion_tokens=4000))
    with pytest.raises(AIError):
        await openai_client.chat(settings, [], purpose="summary")
    [event] = await stored()
    assert not event.ok and event.completion_tokens == 4000 and event.cost_usd > 0


async def test_streamed_calls_are_recorded(clean, monkeypatch, settings):
    replying(monkeypatch, openai_client, httpx.Response(200, text=stream_body(30, 5)))
    usage = Usage()
    got = [p async for p in openai_client.chat_stream(settings, [], purpose="chat", usage=usage)]
    assert got == ["hi"] and usage == Usage(30, 5)
    [event] = await stored()
    assert (event.purpose, event.prompt_tokens, event.completion_tokens) == ("chat", 30, 5)


async def test_embeddings_and_web_search_are_recorded(clean, monkeypatch, settings):
    vector = [0.0] * settings.embedding_dimensions
    replying(
        monkeypatch,
        embeddings,
        httpx.Response(
            200, json={"data": [{"index": 0, "embedding": vector}], "usage": {"prompt_tokens": 8}}
        ),
        httpx.Response(
            200,
            json={
                "status": "completed",
                "output": [{"type": "web_search_call"}, {"type": "web_search_call"}, {"type": "message"}],
                "usage": {"input_tokens": 1000, "output_tokens": 100},
            },
        ),
    )
    await embeddings.embed(settings, ["x"], purpose="chat_query", usage=Usage())
    await discover._responses(settings, {"model": "gpt-4.1"}, "explore_search", Usage())

    events = {e.purpose: e for e in await stored()}
    query, search = events["chat_query"], events["explore_search"]
    assert query.model == settings.openai_embedding_model and query.prompt_tokens == 8
    assert search.web_searches == 2
    assert search.cost_usd == pytest.approx(0.02 + (1000 * 2 + 100 * 8) / 1_000_000)


async def test_a_failed_write_keeps_the_events(clean, monkeypatch):
    note()

    def broken():
        raise RuntimeError("database away")

    monkeypatch.setattr(ai_usage, "SessionLocal", broken)
    await ai_usage.flush()
    monkeypatch.undo()
    assert len(await stored()) == 1


async def test_a_streamed_request_keeps_its_user_and_id_on_its_calls(clean, client, auth, monkeypatch):
    uid, headers = await _make_user(client, auth)
    await consent(client, headers)
    monkeypatch.setattr(get_settings(), "openai_api_key", "sk-x")
    replying(monkeypatch, openai_client, httpx.Response(200, text=stream_body(30, 5)))

    r = await client.post(
        "/api/translate",
        headers={**headers, "Accept": "text/event-stream"},
        json={"text": "Machine learning is a field of study."},
    )
    assert r.status_code == 200 and "event: done" in r.text
    [event] = await stored()
    assert event.purpose == "translate" and event.user_id == uid
    assert event.request_id == r.headers["X-Request-ID"]


async def test_regular_user_cannot_see_costs(client, auth):
    _, headers = await _make_user(client, auth)
    for path in ("/api/admin/ai-costs", "/api/admin/ai-costs/requests"):
        assert (await client.get(path, headers=headers)).status_code == 403


async def test_cost_page_adds_up_by_day_feature_model_and_user(clean, client, auth):
    admin = await _make_admin(client, auth)
    uid, _ = await _make_user(client, auth)
    note("chat_query", "text-embedding-3-small", prompt=10, completion=0, request="a", user=uid)
    note("chat", "gpt-4.1", prompt=1000, completion=100, request="a", user=uid)
    note("summary", "gpt-4.1-mini", prompt=500, completion=50, request="b", user=uid, ok=False)
    note("guide", "no-such-model", prompt=5, completion=5, request="c")

    r = await client.get("/api/admin/ai-costs", headers=admin, params={"days": 7})
    assert r.status_code == 200, r.text
    body = r.json()
    expected = (10 * 0.02 + 1000 * 2 + 100 * 8 + 500 * 0.4 + 50 * 1.6) / 1_000_000
    totals = body["totals"]
    assert totals["cost_usd"] == pytest.approx(expected)
    assert totals["today_cost_usd"] == pytest.approx(expected)
    assert (totals["requests"], totals["calls"], totals["failed_calls"], totals["unpriced_calls"]) == (
        3,
        4,
        1,
        1,
    )
    assert len(body["days"]) == 7 and body["days"][-1]["calls"] == 4
    assert body["features"][0]["key"] == "chat"
    assert {m["key"] for m in body["models"]} == {
        "gpt-4.1",
        "gpt-4.1-mini",
        "text-embedding-3-small",
        "no-such-model",
    }
    assert [u["user_id"] for u in body["users"]] == [str(uid)]
    assert body["prices"]["web_search_per_1k"] == 10
    assert (await client.get("/api/admin/ai-costs", headers=admin, params={"days": 12})).status_code == 422


async def test_requests_are_listed_with_their_calls(clean, client, auth):
    admin = await _make_admin(client, auth)
    uid, _ = await _make_user(client, auth)
    note("chat_query", "text-embedding-3-small", prompt=10, completion=0, request="a", user=uid)
    note("chat", "gpt-4.1", prompt=1000, completion=100, request="a", user=uid)
    note("guide", "gpt-4.1", prompt=5, completion=5, request="b", user=uuid.uuid4())

    r = await client.get("/api/admin/ai-costs/requests", headers=admin, params={"days": 7, "page_size": 1})
    assert r.status_code == 200, r.text
    assert r.json()["total"] == 2
    [newest] = r.json()["items"]
    assert newest["request_id"] == "b" and newest["user_id"] is None and newest["email"] is None

    r = await client.get(
        "/api/admin/ai-costs/requests", headers=admin, params={"days": 7, "page": 2, "page_size": 1}
    )
    [item] = r.json()["items"]
    assert (
        item["request_id"] == "a" and item["user_id"] == str(uid) and item["email"].endswith("@example.com")
    )
    assert [c["purpose"] for c in item["calls"]] == ["chat_query", "chat"]
    assert item["prompt_tokens"] == 1010 and item["completion_tokens"] == 100
    assert item["cost_usd"] == pytest.approx(sum(c["cost_usd"] for c in item["calls"]))


async def test_deleting_an_account_keeps_the_cost_but_not_the_name(clean, client, auth, monkeypatch):
    admin = await _make_admin(client, auth)
    uid, _ = await _make_user(client, auth)
    note(user=uid)
    await ai_usage.flush()

    async def no_supabase(*_):
        return None

    monkeypatch.setattr("app.api.routes.admin.delete_auth_user", no_supabase)
    assert (await client.delete(f"/api/admin/users/{uid}", headers=admin)).status_code == 204
    [event] = await stored()
    assert event.user_id is None and event.cost_usd > 0
