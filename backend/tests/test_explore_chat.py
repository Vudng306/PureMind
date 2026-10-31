import json

import pytest
from sqlalchemy import func, select

from app.core.config import get_settings
from app.core.messages import MSG
from app.db.session import SessionLocal
from app.models import Article
from app.services import embeddings, explore_chat
from app.services.openai_client import AIError
from tests.test_chat import FakeAnswer, FakeEmbed
from tests.test_feed import feed, item  # noqa: F401 — the fixture is used by name
from tests.test_summaries import consent

# The fake embedding counts these words, so a question about sleep really is nearest the sleep article.
VOCAB = ("sleep", "memory", "forest", "heart")


def fake_vector(text: str) -> list[float]:
    lowered = text.lower()
    return [float(lowered.count(word)) for word in VOCAB] + [0.1]


@pytest.fixture
def explore_ai(monkeypatch):
    settings = get_settings()
    monkeypatch.setattr(settings, "openai_api_key", "sk-test")
    monkeypatch.setattr(settings, "explore_chat_articles", 2)
    from app.api.routes import feed as feed_route

    feed_route._chatting.clear()
    embed = FakeEmbed()
    monkeypatch.setattr("tests.test_chat.fake_vector", fake_vector)
    monkeypatch.setattr(embeddings, "embed", embed)

    def install(*answers: str | Exception) -> tuple[FakeEmbed, FakeAnswer]:
        answer = FakeAnswer(*answers)
        monkeypatch.setattr(explore_chat, "answer", answer)
        return embed, answer

    return install


async def articles_in(feed):  # noqa: F811
    await feed(
        item("https://a.example/sleep", "Why sleep helps memory", ["mind"]),
        item("https://a.example/forest", "Forests and the climate", ["environment"]),
        item("https://a.example/heart", "How the heart works", ["health"]),
    )


async def say(client, headers, content: str, **body):
    return await client.post("/api/feed/chat", headers=headers, json={"content": content, **body})


async def test_recommends_the_nearest_articles(client, auth, feed, explore_ai):  # noqa: F811
    await articles_in(feed)
    h = auth()
    embed, answer = explore_ai("Giấc ngủ giúp ghi nhớ. Nên đọc [1], và [7] nữa.")

    # Nothing is sent before the user agrees (NFR-PRV).
    r = await say(client, h, "Tôi muốn hiểu về sleep và memory")
    assert r.status_code == 403 and not embed.calls and not answer.calls
    await consent(client, h)

    r = await say(client, h, "Tôi muốn hiểu về sleep và memory", language="vi")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["articles"][0]["title"] == "Why sleep helps memory"
    assert len(body["articles"]) == 2  # explore_chat_articles
    assert body["cited"] == [1]  # a number it was not given is dropped
    assert body["chat_quota_remaining"] == get_settings().chat_daily_quota - 1
    # Only the articles found go into the prompt, numbered.
    prompt = answer.passages
    assert "[1] Why sleep helps memory" in prompt and "How the heart works" not in prompt
    assert "Vietnamese" in answer.calls[-1][0]["content"]

    # Every article was indexed once; the next message only embeds the query.
    assert embed.purposes("explore_index") == 1 and embed.purposes("explore_query") == 1
    async with SessionLocal() as session:
        assert await session.scalar(select(func.count()).where(Article.embedding_model.is_(None))) == 0
    await say(client, h, "Còn forest?")
    assert embed.purposes("explore_index") == 1 and embed.purposes("explore_query") == 2


async def test_a_follow_up_searches_with_the_earlier_question(client, auth, feed, explore_ai):  # noqa: F811
    await articles_in(feed)
    h = auth()
    embed, answer = explore_ai("Đây [1].")
    await consent(client, h)

    history = [
        {"role": "user", "content": "Kể về heart"},
        {"role": "assistant", "content": "Tim bơm máu [1]."},
    ]
    r = await say(client, h, "cho trẻ em thì sao?", history=history)
    assert r.status_code == 200, r.text
    assert r.json()["articles"][0]["title"] == "How the heart works"
    query = [texts for purpose, texts in embed.calls if purpose == "explore_query"][-1]
    assert query == ["Kể về heart\ncho trẻ em thì sao?"]
    # The earlier turns are passed to the model, oldest first.
    assert [m["role"] for m in answer.calls[-1]] == ["system", "user", "assistant", "user"]


async def test_streams_the_articles_then_the_answer(client, auth, feed, explore_ai):  # noqa: F811
    await articles_in(feed)
    h = auth()
    explore_ai("Rừng hấp thụ carbon [1].")
    await consent(client, h)

    async with client.stream(
        "POST",
        "/api/feed/chat",
        headers={**h, "Accept": "text/event-stream"},
        json={"content": "forest"},
    ) as res:
        assert res.status_code == 200
        events = []
        async for line in res.aiter_lines():
            if line.startswith("event:"):
                events.append([line[6:].strip(), ""])
            elif line.startswith("data:") and events:
                events[-1][1] += line[5:].strip()

    names = [name for name, _ in events]
    assert names[0] == "sources" and "delta" in names and names[-1] == "done"
    assert json.loads(events[0][1])["articles"][0]["title"] == "Forests and the climate"
    done = json.loads(events[-1][1])
    assert done["content"] == "Rừng hấp thụ carbon [1]." and done["cited"] == [1]


async def test_a_failed_answer_costs_nothing(client, auth, feed, explore_ai):  # noqa: F811
    await articles_in(feed)
    h = auth()
    explore_ai(AIError("boom"))
    await consent(client, h)

    r = await say(client, h, "sleep")
    assert r.status_code == 502 and r.json()["detail"] == MSG["MSG-26"]
    r = await client.get("/api/account", headers=h)
    assert r.json()["chat_quota_remaining"] == get_settings().chat_daily_quota


async def test_empty_and_unconfigured(client, auth, monkeypatch, feed):  # noqa: F811
    h = auth()
    await consent(client, h)
    assert (await say(client, h, "   ")).status_code == 422
    monkeypatch.setattr(get_settings(), "openai_api_key", "")
    assert (await say(client, h, "sleep")).status_code == 503
