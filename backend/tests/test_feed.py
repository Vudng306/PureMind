import json
import re
import uuid
from dataclasses import replace
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import delete, select

from app.core.config import get_settings
from app.db.session import SessionLocal
from app.models import Article, ArticleTopic, Short
from app.services import articles, guides, shorts
from app.services.openai_client import AIError, Completion, Usage
from app.services.sources import CC_BY, CC_BY_SA, Item, conversation, elife, frym, owid

PROSE = " ".join(["Researchers measured how sleep shapes memory in hundreds of volunteers."] * 40)

ATOM_FEED = f"""<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>tag:theconversation.com,2011:article/1</id>
    <published>2026-10-28T12:00:00Z</published>
    <link rel="alternate" type="text/html" href="https://theconversation.com/sleep-and-memory-1"/>
    <title>Why sleep helps you remember</title>
    <summary>A good night locks in what you learned.</summary>
    <content type="html">&lt;figure&gt;&lt;img src="https://images.theconversation.com/getty.jpg"&gt;
      &lt;figcaption&gt;Photo: Getty&lt;/figcaption&gt;&lt;/figure&gt;
      &lt;p&gt;{PROSE}&lt;/p&gt;
      &lt;img src="https://counter.theconversation.com/content/1/count.gif" width="1" height="1"&gt;
      &lt;p class="fine-print"&gt;&lt;em&gt;Jane Doe receives funding from the NSF.&lt;/em&gt;&lt;/p&gt;</content>
    <author><name>Jane Doe, Professor of Psychology, University of Somewhere</name></author>
    <author><name>Lan Nguyen, PhD Candidate, University of Somewhere</name></author>
    <rights>Licensed as Creative Commons – attribution, no derivatives.</rights>
  </entry>
  <entry>
    <link rel="alternate" href="https://theconversation.com/too-short-2"/>
    <title>Too short</title>
    <content type="html">&lt;p&gt;Only a few words.&lt;/p&gt;</content>
  </entry>
</feed>""".encode()


def test_conversation_keeps_the_text_and_credit_but_not_the_images():
    [item] = conversation.parse(ATOM_FEED, ["mind"])
    assert item.url == "https://theconversation.com/sleep-and-memory-1"
    assert "!" not in item.content and "getty" not in item.content.lower() and "count.gif" not in item.content
    assert "receives funding" in item.content  # their disclosure is part of the article
    assert item.credit == (
        "Jane Doe, Professor of Psychology, University of Somewhere; "
        "Lan Nguyen, PhD Candidate, University of Somewhere"
    )
    assert item.authors == "Jane Doe, Lan Nguyen"
    assert item.license == "CC BY-ND 4.0"
    assert item.summary == "A good night locks in what you learned."
    assert item.published_at == datetime(2026, 10, 28, 12, tzinfo=UTC)


def test_owid_topics_come_from_the_words():
    assert owid.topics_of("How much development aid is spent on climate change?") == ["environment"]
    assert owid.topics_of("Life expectancy and child mortality") == ["health"]
    assert owid.topics_of("Something else entirely") == ["science"]


def elife_insight(**kw) -> dict:
    return {
        "id": "113304",
        "type": "insight",
        "doi": "10.7554/eLife.113304",
        "title": "Lymphatic vessels <i>under</i> pressure",
        "authorLine": "Asser F Bedair, Osama F Harraz",
        "published": "2026-10-29T00:00:00Z",
        "subjects": [{"id": "cell-biology"}, {"id": "neuroscience"}],
        "copyright": {"license": "CC-BY-4.0"},
        "impactStatement": "Lymphatic vessels beat <b>faster</b> as they fill.",
        "body": [
            {
                "type": "section",
                "title": "Main text",
                "content": [
                    {"type": "paragraph", "text": f'{PROSE} (<a href="#bib3">Norrmén et al., 2011</a>).'},
                    {"type": "figure", "assets": [{"type": "image", "title": "A figure"}]},
                    {
                        "type": "section",
                        "title": "What next",
                        "content": [{"type": "paragraph", "text": "Open questions."}],
                    },
                ],
            }
        ],
        **kw,
    }


def test_elife_keeps_the_insights_prose_and_its_credit():
    item = elife.item_of(elife_insight())
    assert item.url == "https://elifesciences.org/articles/113304"
    assert item.title == "Lymphatic vessels under pressure"
    assert "(Norrmén et al., 2011)" in item.content and "#bib3" not in item.content  # references unlinked
    assert (
        "## What next" in item.content and "Main text" not in item.content and "A figure" not in item.content
    )
    assert item.topics == ["mind", "science"]
    assert item.license == CC_BY[0] and item.credit == "Asser F Bedair, Osama F Harraz · eLife"
    assert item.summary == "Lymphatic vessels beat faster as they fill."
    assert item.doi == "10.7554/elife.113304" and item.published_at == datetime(2026, 10, 29, tzinfo=UTC)


def test_elife_skips_what_is_not_cc_by_or_too_short():
    assert elife.item_of(elife_insight(copyright={"license": "CC0-1.0"})) is None
    assert elife.item_of(elife_insight(body=[{"type": "paragraph", "text": "Only a few words."}])) is None


def test_frym_takes_only_cc_by_works():
    body = json.dumps(
        {
            "message": {
                "items": [
                    {
                        "DOI": "10.3389/frym.2026.1",
                        "title": ["Open"],
                        "license": [{"URL": "https://creativecommons.org/licenses/by/4.0/"}],
                    },
                    {
                        "DOI": "10.3389/frym.2026.2",
                        "title": ["No derivatives"],
                        "license": [{"URL": "https://creativecommons.org/licenses/by-nd/4.0/"}],
                    },
                    {"DOI": "10.3389/frym.2026.3", "title": ["Unknown"]},
                ]
            }
        }
    ).encode()
    assert [w["title"][0] for w in frym.open_works(body)] == ["Open"]


def test_frym_keeps_the_article_and_glossary_but_not_the_journal_notes():
    html = f"""<html><head><title>How a Stroke Can Make Half of the World Seem to Disappear</title></head><body>
      <a href="/articles/neuroscience-and-psychology" data-event="fulltext-specialty">Neuroscience and Psychology</a>
      <article><h1>How a Stroke Can Make Half of the World Seem to Disappear</h1>
        <h2>What is a Stroke?</h2><p>{PROSE}</p>
        <h3>Glossary</h3><p><strong>Stroke</strong>: <strong>↑</strong> When blood cannot reach the brain.</p>
        <h2>Conflict of Interest</h2><p>The authors declare no conflict.</p>
        <h3>References</h3><p>[1] Someone. 2022.</p>
      </article></body></html>""".encode()
    work = {
        "DOI": "10.3389/FRYM.2026.1900102",
        "title": ["How a Stroke Can  Make Half of the World Seem to Disappear"],
        "author": [{"given": "Eugénie", "family": "Cataldo"}, {"given": "Ilaria", "family": "Sani"}],
        "published": {"date-parts": [[2026, 10, 28]]},
        "abstract": "<jats:p>Imagine it is your birthday.</jats:p>",
    }
    item = frym.page_item(html, "https://kids.frontiersin.org/articles/10.3389/frym.2026.1900102", work)
    assert "What is a Stroke?" in item.content and "**Stroke**: When blood" in item.content
    assert "Conflict of Interest" not in item.content and "Someone. 2022" not in item.content
    assert item.title == "How a Stroke Can Make Half of the World Seem to Disappear"
    assert item.topics == ["mind", "science"]
    assert item.credit == "Eugénie Cataldo, Ilaria Sani · Frontiers for Young Minds"
    assert item.summary == "Imagine it is your birthday."
    assert item.doi == "10.3389/frym.2026.1900102" and item.published_at == datetime(2026, 10, 28, tzinfo=UTC)


def test_title_key_ignores_case_accents_and_punctuation():
    assert articles.title_key("Đại số – Lịch sử!") == articles.title_key("dai so lich su")


def test_sources_take_turns_and_news_comes_newest_first():
    now = datetime(2026, 10, 29, tzinfo=UTC)
    rows = [
        (f"c{i}", "conversation", f"https://c/{i}", "explainer", now - timedelta(days=i)) for i in range(4)
    ] + [("p0", "plos", "https://p/0", "research", None)]
    order = articles.ranks(rows)
    feed = sorted(order, key=order.get, reverse=True)
    assert set(feed[:2]) == {"c0", "p0"}  # one of each before the second of either
    assert feed[2:] == ["c1", "c2", "c3"]


def item(url: str, title: str, topics: list[str], **kw) -> Item:
    return Item(
        source=kw.pop("source", "conversation"),
        url=url,
        title=title,
        content=kw.pop("content", PROSE),
        language="en",
        kind="explainer",
        license="CC BY-ND 4.0",
        license_url="https://creativecommons.org/licenses/by-nd/4.0/",
        credit="Jane Doe, University of Somewhere",
        topics=topics,
        summary="A **short** [summary](https://x).",
        published_at=kw.pop("published_at", datetime.now(UTC)),
        **kw,
    )


@pytest.fixture
async def feed():
    """An empty feed, filled by each test."""
    async with SessionLocal() as session:
        await session.execute(delete(Short))
        await session.execute(delete(Article))
        await session.commit()

    async def add(*items: Item) -> articles.Stored:
        async with SessionLocal() as session:
            return await articles.store(session, list(items))

    return add


async def test_store_refreshes_by_address_and_skips_the_same_title(feed):
    first = await feed(item("https://a.example/1", "Sleep and memory", ["mind"]))
    assert (first.added, first.updated, first.duplicates) == (1, 0, 0)
    again = await feed(
        item("https://a.example/1", "Sleep and memory", ["mind"], content=PROSE + " Updated."),
        item("https://b.example/other", "Sleep and Memory.", ["health"], source="plos"),
    )
    assert (again.added, again.updated, again.duplicates) == (0, 1, 1)
    async with SessionLocal() as session:
        [article] = (await session.scalars(select(Article))).all()
        assert article.url == "https://a.example/1"
        assert sorted(t.topic for t in article.topics) == ["health", "mind"]
        assert article.summary == "A short summary."


async def test_feed_follows_the_chosen_topics(client, auth, feed):
    await feed(
        item("https://a.example/mind", "On memory", ["mind"]),
        item("https://a.example/health", "On hearts", ["health"]),
        item("https://a.example/env", "On forests", ["environment"]),
    )
    headers = auth()
    r = await client.get("/api/feed", headers=headers)
    assert r.status_code == 200
    assert r.json()["following"] is None and r.json()["total"] == 3  # everything, before choosing

    r = await client.put("/api/feed/topics", json={"topics": ["health", "mind"]}, headers=headers)
    assert r.json()["following"] == ["health", "mind"]
    assert {t["id"]: t["count"] for t in r.json()["topics"]}["environment"] == 1

    r = await client.get("/api/feed", headers=headers)
    assert sorted(a["title"] for a in r.json()["articles"]) == ["On hearts", "On memory"]
    r = await client.get("/api/feed", params={"topic": "environment"}, headers=headers)
    assert [a["title"] for a in r.json()["articles"]] == ["On forests"]
    assert r.json()["articles"][0]["source_name"] == "The Conversation"

    assert (await client.get("/api/feed", params={"topic": "gossip"}, headers=headers)).status_code == 422
    r = await client.put("/api/feed/topics", json={"topics": ["gossip"]}, headers=headers)
    assert r.status_code == 422


async def test_feed_pages(client, auth, feed):
    await feed(*(item(f"https://a.example/{i}", f"Article {i}", ["science"]) for i in range(5)))
    headers = auth()
    first = (await client.get("/api/feed", params={"limit": 3}, headers=headers)).json()
    rest = (await client.get("/api/feed", params={"limit": 3, "offset": 3}, headers=headers)).json()
    assert first["has_more"] and not rest["has_more"]
    assert len({a["id"] for a in first["articles"] + rest["articles"]}) == 5


async def test_open_copies_the_article_with_its_credit(client, auth, feed):
    await feed(item("https://a.example/read", "Read me", ["mind"]))
    headers = auth()
    [card] = (await client.get("/api/feed", headers=headers)).json()["articles"]
    assert card["document_id"] is None

    r = await client.post(f"/api/feed/{card['id']}/open", headers=headers)
    assert r.status_code == 201
    doc = r.json()
    assert doc["title"] == "Read me" and doc["url"] == "https://a.example/read"
    assert doc["extraction_status"] == "done"
    first_line = doc["content_clean"].split("\n\n")[0]
    assert "Jane Doe, University of Somewhere" in first_line
    assert "[The Conversation](https://a.example/read)" in first_line
    assert "CC BY-ND 4.0" in first_line
    assert doc["content_clean"].endswith(PROSE)

    again = await client.post(f"/api/feed/{card['id']}/open", headers=headers)
    assert again.status_code == 200 and again.json()["id"] == doc["id"]
    [card] = (await client.get("/api/feed", headers=headers)).json()["articles"]
    assert card["document_id"] == doc["id"]

    # Someone else gets a copy of their own.
    other = await client.post(f"/api/feed/{card['id']}/open", headers=auth())
    assert other.status_code == 201 and other.json()["id"] != doc["id"]


async def test_open_unknown_article(client, auth):
    r = await client.post(f"/api/feed/{uuid.uuid4()}/open", headers=auth())
    assert r.status_code == 404


async def test_feed_needs_an_account(client):
    assert (await client.get("/api/feed")).status_code == 401


async def test_refresh_takes_the_sources_new_topics(feed):
    await feed(item("https://a.example/t", "Topics change", ["mind"]))
    await feed(item("https://a.example/t", "Topics change", ["philosophy"]))
    async with SessionLocal() as session:
        [article] = (await session.scalars(select(Article))).all()
        assert [t.topic for t in article.topics] == ["philosophy"]


GUIDE = guides.Guide(
    title="Vì sao   giấc ngủ giúp bạn nhớ lâu hơn?",
    summary="Giấc ngủ sắp xếp lại những gì bạn học trong ngày.",
    hook="Bạn thức trắng ôn thi, sáng hôm sau đầu óc trống rỗng.",
    sections=[
        guides.Section(heading=f"Câu hỏi {i}?", body=f"Đoạn {i}.", key_point=f"Ý {i}.") for i in range(3)
    ],
    takeaways=guides.Takeaways(kind="try", items=["Ngủ đủ 7 tiếng.", "Ôn lại trước khi ngủ."]),
    discussion="Có nên thức khuya để học thêm?",
    caution="Mất ngủ kéo dài thì nên gặp bác sĩ.",
)


def open_item(url: str, title: str, topics: list[str], license=CC_BY, **kw) -> Item:
    return replace(item(url, title, topics, **kw), license=license[0], license_url=license[1])


def test_guide_has_the_shape_and_the_original_licence():
    original = Article(
        url="https://plos.example/1#x",
        title="Sleep",
        license=CC_BY_SA[0],
        license_url=CC_BY_SA[1],
        image_url=None,
    )
    original.topics = [ArticleTopic(topic="mind"), ArticleTopic(topic="health")]
    guide = guides.item_of(GUIDE, original)
    assert guide.url == "https://plos.example/1#puremind-vi" and guide.based_on == original.url
    assert guide.title == "Vì sao giấc ngủ giúp bạn nhớ lâu hơn?"
    assert (guide.language, guide.kind, guide.license) == ("vi", "guide", "CC BY-SA 4.0")
    assert guide.topics == ["health", "mind"]
    text = guide.content
    assert text.startswith("Bạn thức trắng") and len(re.findall(r"^## Câu hỏi \d\?$", text, re.M)) == 3
    assert text.count("> 💡 **Điểm cốt lõi:**") == 3
    assert "## Thử ngay\n\n1. Ngủ đủ 7 tiếng.\n2. Ôn lại trước khi ngủ." in text
    assert "## Câu hỏi để bàn luận" in text and text.endswith(
        "> ⚠️ **Lưu ý:** Mất ngủ kéo dài thì nên gặp bác sĩ."
    )
    with pytest.raises(AIError):
        guides.parse('{"title": "x"}')


async def test_guides_adapt_only_open_licences_once(feed):
    await feed(
        item("https://a.example/nd", "No derivatives", ["mind"]),
        open_item("https://a.example/by", "Attribution", ["mind"], source="plos"),
    )
    async with SessionLocal() as session:
        found = await guides.originals(session, per_topic=5, topics=["mind"])
        assert [a.title for a in found] == ["Attribution"]
        written = guides.item_of(GUIDE, found[0])
    await feed(written)
    async with SessionLocal() as session:
        assert await guides.originals(session, per_topic=5, topics=["mind"]) == []


async def test_write_guide_asks_the_ai(feed, monkeypatch):
    await feed(open_item("https://a.example/by", "Attribution", ["mind"], source="plos"))
    seen = {}

    async def fake_chat(settings, messages, **kw):
        seen.update(kw, prompt=messages[1]["content"])
        return Completion(GUIDE.model_dump_json(), Usage())

    monkeypatch.setattr(guides, "chat", fake_chat)
    async with SessionLocal() as session:
        [original] = await guides.originals(session, per_topic=1, topics=["mind"])
        written = await guides.write(get_settings(), original)
    assert seen["json_schema"] == guides.GUIDE_SCHEMA and seen["purpose"] == "guide"
    assert seen["prompt"].startswith("Title: Attribution\nBy: Jane Doe") and PROSE[:50] in seen["prompt"]
    assert written.based_on == "https://a.example/by"


async def test_open_guide_credits_the_original(client, auth, feed):
    await feed(open_item("https://a.example/by", "Sleep [and] memory", ["mind"], source="plos"))
    async with SessionLocal() as session:
        [original] = await guides.originals(session, per_topic=1, topics=["mind"])
        written = guides.item_of(GUIDE, original)
    await feed(written)
    headers = auth()
    r = await client.get("/api/feed", headers=headers)
    card = next(a for a in r.json()["articles"] if a["kind"] == "guide")
    assert card["source_name"] == "PureMind" and card["language"] == "vi"
    assert card["based_on"] == {
        "title": "Sleep [and] memory",
        "source_name": "PLOS",
        "url": "https://a.example/by",
    }

    doc = (await client.post(f"/api/feed/{card['id']}/open", headers=headers)).json()
    first_line = doc["content_clean"].split("\n\n")[0]
    assert "[Sleep (and) memory](https://a.example/by)" in first_line
    assert "Jane Doe, University of Somewhere (PLOS)" in first_line and "CC BY 4.0" in first_line


async def test_guides_follow_their_originals_topics(feed):
    await feed(open_item("https://a.example/by", "Attribution", ["travel"], source="plos"))
    async with SessionLocal() as session:
        [original] = await guides.originals(session, per_topic=1, topics=["travel"])
        written = guides.item_of(GUIDE, original)
    await feed(written)
    await feed(open_item("https://a.example/by", "Attribution", ["history"], source="plos"))
    async with SessionLocal() as session:
        guide = await session.scalar(select(Article).where(Article.kind == "guide"))
        assert [t.topic for t in guide.topics] == ["history"]


SHORT = shorts.Draft(
    title="Ngủ ngon có giúp nhớ bài?",
    hook="Bạn học khuya rồi quên sạch?",
    points=["Giấc ngủ **củng cố** trí nhớ.", "Người ngủ đủ nhớ tốt hơn.", "Ôn trước khi ngủ có ích."],
    takeaway="Ngủ đủ là một phần của việc học.",
)


async def test_write_short_asks_the_ai_once_per_open_article(feed, monkeypatch):
    await feed(
        item("https://a.example/nd", "No derivatives", ["mind"]),
        open_item("https://a.example/by", "Attribution", ["mind"], source="plos"),
    )
    seen = {}

    async def fake_chat(settings, messages, **kw):
        seen.update(kw, prompt=messages[1]["content"])
        return Completion(SHORT.model_dump_json(), Usage())

    monkeypatch.setattr(shorts, "chat", fake_chat)
    async with SessionLocal() as session:
        [original] = await shorts.originals(session, per_topic=5, topics=["mind"])
        assert original.title == "Attribution"
        short = await shorts.write(get_settings(), original)
        session.add(short)
        await session.commit()
        assert await shorts.originals(session, per_topic=5, topics=["mind"]) == []
    assert seen["json_schema"] == shorts.SHORT_SCHEMA and seen["purpose"] == "short"
    assert seen["prompt"].startswith("Title: Attribution\nBy: Jane Doe")
    assert short.points[0] == "Giấc ngủ củng cố trí nhớ." and short.article_id == original.id
    with pytest.raises(AIError):
        shorts.parse('{"title": "x"}')


async def test_shorts_read_on_into_the_guide(client, auth, feed):
    await feed(
        open_item("https://a.example/1", "Sleep", ["mind"], source="plos"),
        open_item("https://a.example/2", "Rivers", ["environment"], source="plos"),
    )
    async with SessionLocal() as session:
        found = {a.title: a for a in await shorts.originals(session, per_topic=1, topics=None)}
        for a in found.values():
            session.add(Short(article_id=a.id, **SHORT.model_dump()))
        await session.commit()
        written = guides.item_of(GUIDE, found["Sleep"])
    await feed(written)
    headers = auth()
    r = await client.get("/api/feed/shorts", headers=headers)
    assert r.status_code == 200 and r.json()["total"] == 2
    cards = {c["original_title"]: c for c in r.json()["shorts"]}
    sleep, rivers = cards["Sleep"], cards["Rivers"]
    assert sleep["read_kind"] == "guide" and sleep["source_name"] == "PLOS"
    assert sleep["original_url"] == "https://a.example/1" and sleep["license"] == "CC BY 4.0"
    assert rivers["read_kind"] == "explainer" and rivers["read_id"] == str(found["Rivers"].id)
    assert sleep["points"] == SHORT.points and sleep["document_id"] is None

    opened = (await client.post(f"/api/feed/{sleep['read_id']}/open", headers=headers)).json()
    assert opened["url"] == written.url
    r = await client.get("/api/feed/shorts?topic=mind", headers=headers)
    [card] = r.json()["shorts"]
    assert card["document_id"] == opened["id"] and r.json()["has_more"] is False
    assert (await client.get("/api/feed/shorts?topic=nope", headers=headers)).status_code == 422
