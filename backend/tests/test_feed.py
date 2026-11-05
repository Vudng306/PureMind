import asyncio
import json
import re
import uuid
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from urllib.parse import unquote_plus
from xml.etree import ElementTree

import pytest
from sqlalchemy import delete, select

from app.core.config import get_settings
from app.db.session import SessionLocal
from app.models import Article, ArticleTag, ArticleTopic, Short, User
from app.services import articles, crawler, guides, shorts, web
from app.services.openai_client import AIError, Completion, Usage
from app.services.sources import (
    CC_BY,
    CC_BY_SA,
    Item,
    arxiv,
    conversation,
    elife,
    europepmc,
    frym,
    globalvoices,
    openalex,
    owid,
    plos,
)

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
        kind=kw.pop("kind", "explainer"),
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


def test_clean_tags_are_short_lowercase_and_not_repeated():
    raw = [
        "  Sleep  Memory ",
        "sleep memory",
        "#Learning.",
        "x",
        "2024",
        "a" * 60,
        "Brain",
        "Mind",
        "Mood",
        "Diet",
        "Iron",
        "Zinc",
        "Salt",
        "Rest",
    ]
    assert articles.clean_tags(raw) == [
        "sleep memory",
        "learning",
        "brain",
        "mind",
        "mood",
        "diet",
        "iron",
        "zinc",
    ]


async def test_store_keeps_tags_and_a_refresh_without_tags_keeps_them(feed):
    await feed(
        replace(item("https://a.example/1", "Sleep and memory", ["mind"]), tags=["Sleep", "Memory", "sleep"])
    )
    await feed(item("https://a.example/1", "Sleep and memory", ["mind"], content=PROSE + " Updated."))
    await feed(
        replace(item("https://b.example/2", "Sleep and Memory.", ["mind"], source="plos"), tags=["learning"])
    )
    async with SessionLocal() as session:
        tags = sorted((await session.scalars(select(ArticleTag.tag))).all())
    assert tags == ["learning", "memory", "sleep"]  # the same title from two sources shares its tags


async def test_feed_narrows_by_kind_and_tag_and_lists_facets(client, auth, feed):
    await feed(
        replace(item("https://a.example/1", "Sleep note", ["mind"]), tags=["sleep", "memory"]),
        replace(item("https://a.example/2", "Sleep study", ["mind"], kind="research"), tags=["sleep"]),
        replace(item("https://a.example/3", "Jobs report", ["economy"], kind="report"), tags=["labour"]),
    )
    headers = auth()
    r = await client.get("/api/feed", params={"kind": "research"}, headers=headers)
    assert [a["title"] for a in r.json()["articles"]] == ["Sleep study"]
    assert r.json()["articles"][0]["tags"] == ["sleep"]
    r = await client.get("/api/feed", params={"tag": "SLEEP"}, headers=headers)
    assert {a["title"] for a in r.json()["articles"]} == {"Sleep note", "Sleep study"}
    r = await client.get("/api/feed", params={"tag": "sleep", "kind": "explainer"}, headers=headers)
    assert [a["title"] for a in r.json()["articles"]] == ["Sleep note"]
    assert (await client.get("/api/feed", params={"kind": "novel"}, headers=headers)).status_code == 422

    facets = (await client.get("/api/feed/facets", headers=headers)).json()
    assert {k["id"]: k["count"] for k in facets["kinds"]} == {"explainer": 1, "research": 1, "report": 1}
    assert facets["tags"][0] == {"tag": "sleep", "count": 2}
    only_reports = (await client.get("/api/feed/facets", params={"kind": "report"}, headers=headers)).json()
    assert [t["tag"] for t in only_reports["tags"]] == ["labour"]
    in_mind = (await client.get("/api/feed/facets", params={"topic": "mind"}, headers=headers)).json()
    assert {k["id"] for k in in_mind["kinds"]} == {"explainer", "research"}
    assert (
        await client.get("/api/feed/facets", params={"kind": "novel"}, headers=headers)
    ).status_code == 422


OAI_RECORDS = b"""<?xml version="1.0" encoding="UTF-8"?>
<OAI-PMH xmlns="http://www.openarchives.org/OAI/2.0/">
  <ListRecords>
    <record><metadata><arXiv xmlns="http://arxiv.org/OAI/arXiv/">
      <id>2610.01234</id><created>2026-10-20</created>
      <authors><author><keyname>Doe</keyname><forenames>Jane</forenames></author>
        <author><keyname>Nguyen</keyname><forenames>Lan</forenames></author></authors>
      <title>Teaching with
        language models</title>
      <categories>cs.CY cs.AI cs.XX</categories>
      <license>http://creativecommons.org/licenses/by/4.0/</license>
      <abstract>  How teachers use models. </abstract>
      <doi>10.1000/abc.1 10.1000/abc.2</doi>
    </arXiv></metadata></record>
    <record><header status="deleted"/></record>
    <resumptionToken>next-page</resumptionToken>
  </ListRecords>
</OAI-PMH>"""


def test_arxiv_reads_records_and_keeps_only_reusable_recent_ones():
    [record], token = arxiv.parse(OAI_RECORDS)
    assert token == "next-page"
    assert (
        record["title"] == "Teaching with language models"
        and record["abstract"] == "How teachers use models."
    )
    assert record["authors"] == ["Jane Doe", "Lan Nguyen"] and record["doi"] == "10.1000/abc.1"
    assert arxiv.tags_of(record["categories"]) == ["computers and society", "artificial intelligence"]

    earliest = datetime(2026, 1, 1, tzinfo=UTC)
    assert arxiv.usable(record, earliest)
    assert not arxiv.usable(
        {**record, "license": "http://arxiv.org/licenses/nonexclusive-distrib/1.0/"}, earliest
    )
    assert not arxiv.usable({**record, "created": "2025-12-31"}, earliest)

    made = arxiv.item_of(record, ["technology"], PROSE)
    assert made.kind == "research" and made.license == "CC BY 4.0"
    assert made.url == "https://arxiv.org/abs/2610.01234" and "not peer reviewed" in made.credit


def test_arxiv_text_starts_at_the_abstract():
    page = "# Title\n\nAuthors, University of X\n\n## Abstract\n\nThe claim.\n\n## 1 Introduction\n\nMore."
    assert arxiv.from_abstract(page).startswith("## Abstract")
    assert arxiv.from_abstract("No heading here.") == "No heading here."


def test_openalex_rebuilds_the_abstract_and_lists_cc_by_places_to_read():
    work = {
        "abstract_inverted_index": {"Jobs": [0], "are": [1], "changing": [2, 4], "fast": [3]},
        "locations": [
            {
                "license": "cc-by",
                "landing_page_url": "https://a.example/page",
                "pdf_url": "https://a.example/x.pdf",
            },
            {"license": None, "landing_page_url": "https://b.example/page", "pdf_url": None},
            {"license": "cc-by", "landing_page_url": "https://a.example/page", "pdf_url": None},
        ],
    }
    assert openalex.abstract_of(work) == "Jobs are changing fast changing"
    assert openalex.sources_of(work) == ["https://a.example/page", "https://a.example/x.pdf"]


def test_openalex_kind_follows_the_publisher_and_the_type():
    def work(doi: str, type_: str) -> dict:
        return {
            "doi": f"https://doi.org/{doi}",
            "title": "A work",
            "type": type_,
            "authorships": [],
            "keywords": [{"display_name": "Labour"}, {"display_name": "Trade"}],
            "publication_date": "2025-03-01",
        }

    assert openalex.item_of(work("10.1596/41", "book"), ["economy"], PROSE).kind == "report"
    assert openalex.item_of(work("10.5772/1", "book-chapter"), ["science"], PROSE).kind == "book"
    assert openalex.item_of(work("10.9999/1", "report"), ["society"], PROSE).kind == "report"
    assert openalex.item_of(work("10.5772/1", "book-chapter"), ["science"], PROSE).tags == ["Labour", "Trade"]


def test_plos_essays_are_their_own_kind_and_subjects_become_tags():
    doc = {
        "id": "10.1371/journal.pbio.1",
        "title_display": "A view on peer review",
        "article_type": "Essay",
        "subject": [
            "/Research and analysis methods/Research assessment/Peer review",
            "/Medicine and health sciences/Medical humanities/Medical journals",
            "/Research and analysis methods/Research assessment/Peer review",
        ],
        "publication_date": "2025-02-01T00:00:00Z",
    }
    made = plos.item_of(doc, ["science"], PROSE)
    assert made.kind == "essay" and made.tags == ["peer review", "medical journals"]
    assert plos.item_of({**doc, "article_type": "Research Article"}, ["science"], PROSE).kind == "research"
    assert 'article_type:("Essay" OR "Perspective")' in unquote_plus(
        plos.search_url("Biology", 1, essays=True)
    )


def test_plos_takes_the_title_as_words_and_a_summary_from_the_text_without_an_abstract():
    doc = {"id": "10.1371/journal.pone.1", "title_display": "A new species of <i>Colobus</i>\n monkey"}
    made = plos.item_of(doc, ["science"], PROSE)
    assert made.title == "A new species of Colobus monkey"
    assert made.summary.startswith("Researchers measured how sleep")


def test_plos_reads_the_article_from_its_opening_without_the_page_around_it():
    html = f"""<html><body><nav>Browse</nav><div id="artText">
      <div class="abstract"><h2>Abstract</h2><p>What the paper found, said briefly.</p></div>
      <div class="articleinfo"><p><strong>Citation:</strong> Someone (2025)</p></div>
      <div class="section toc-section"><h2>Introduction</h2><p>{PROSE}</p>
        <span class="equation"><img class="inline-graphic" src="e1.png"/></span>
        <div class="figure"><div class="img-box"><img alt="thumbnail" src="x.png"/></div>
          <div class="figure-inline-download">Download: PNG</div>
          <div class="figcaption">Fig 1. Sleep by group.</div>
          <p class="caption_target"></p><p class="caption_object">https://doi.org/10.1371/x.g001</p></div>
      </div></div></body></html>""".encode()
    text = plos.article_markdown(html, "https://journals.plos.org/x")
    assert text.startswith("## Abstract\n\nWhat the paper found")
    assert "## Introduction" in text and "Fig 1. Sleep by group." in text
    for left_out in ("Browse", "Citation", "Download", "thumbnail", "x.g001", "e1.png", "*["):
        assert left_out not in text


def test_openalex_takes_nothing_from_a_page_that_only_lists_other_works(monkeypatch):
    work = {
        "title": "A report",
        "locations": [{"license": "cc-by", "landing_page_url": "https://repo.example/1"}],
    }
    listing = " ".join(f"Another report {i} in the repository." for i in range(300))
    html = f"<html><body><article><h3>Related items</h3><p>{listing}</p></article></body></html>".encode()

    async def fetch_page(url, contact):
        return web.FetchResult(url=url, body=html, content_type="text/html")

    monkeypatch.setattr(openalex, "fetch_page", fetch_page)
    assert asyncio.run(openalex.text_of(work, "x")) == ""
    assert (
        openalex.cut_before(f"{PROSE}\n\n### Users also downloaded\n\nOther", openalex.TAIL_SECTIONS) == PROSE
    )


def test_every_crawled_source_has_a_name_to_show():
    names = articles.source_names()
    assert crawler.SOURCES.keys() <= names.keys()
    assert names["globalvoices"] == "Global Voices" and names["openalex"] == "OpenAlex"


def jats(body: str) -> ElementTree.Element:
    return ElementTree.fromstring(f"<article><body>{body}</body></article>")


def test_europe_pmc_keeps_tables_and_figure_captions_but_not_formulas_or_supplements():
    root = jats(
        """<sec><title>Results</title>
        <p>Lonely people slept less (<xref>Table 1</xref>).<fig id="f1"><label>Figure 1</label>
          <caption><title>Sleep by group.</title><p>Hours per night.</p></caption><graphic/></fig></p>
        <table-wrap id="t1"><label>Table 1</label><caption><title>Sleep and loneliness</title></caption>
          <table><thead><tr><th>Group</th><th>Hours</th></tr></thead>
          <tbody><tr><td>Lonely</td><td>6.1 | 6.3</td></tr><tr><td>Not lonely</td><td>7.4</td></tr></tbody></table>
        </table-wrap>
        <disp-formula>x = y</disp-formula><supplementary-material><p>Extra files</p></supplementary-material>
        <p>The gap held after adjustment.</p></sec>"""
    )
    text = europepmc.body_markdown(root)
    assert text.startswith("## Results\n\nLonely people slept less (Table 1).")
    assert "> Figure 1. Sleep by group. Hours per night." in text
    assert "> **Table 1. Sleep and loneliness**" in text
    assert "| Group | Hours |" in text and "| Lonely |" in text and "| Not lonely | 7.4 |" in text
    assert "x = y" not in text and "Extra files" not in text
    assert text.endswith("The gap held after adjustment.")


def test_europe_pmc_headings_follow_the_sections_and_the_apparatus_is_left_out():
    root = jats(
        """<sec><title>Methods</title><p>We asked people.</p>
          <sec><title>Sample</title><p>Two hundred adults.</p></sec>
          <sec><title>Empty</title><fig><graphic/></fig></sec></sec>
        <sec><title>Discussion</title><p>It held.</p></sec>
        <sec><title>Empty too</title></sec>
        <sec><title>Data Availability Statement</title><p>On request.</p></sec>
        <sec><title>Author contributions</title><p>All wrote.</p></sec>
        <sec><title>Conflicts of interest</title><p>None.</p></sec>
        <sec><title>References</title><ref-list><ref>Someone 2020</ref></ref-list></sec>"""
    )
    assert europepmc.body_markdown(root) == (
        "## Methods\n\nWe asked people.\n\n### Sample\n\nTwo hundred adults.\n\n## Discussion\n\nIt held."
    )


def test_europe_pmc_leaves_out_an_article_that_leans_on_its_figures():
    def figures(n: int) -> ElementTree.Element:
        return jats("<p>Words.</p>" + "<fig><label>Figure</label><caption><p>x</p></caption></fig>" * n)

    assert not europepmc.leans_on_visuals(figures(europepmc.MAX_VISUALS), 20_000)
    assert europepmc.leans_on_visuals(figures(europepmc.MAX_VISUALS + 1), 20_000)
    assert europepmc.leans_on_visuals(figures(4), 1_000)  # four in a thousand words
    assert not europepmc.leans_on_visuals(None, 1_000)


def test_global_voices_keeps_the_text_and_credit_but_not_the_images():
    body = f"""<?xml version="1.0"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"
     xmlns:dc="http://purl.org/dc/elements/1.1/"><channel>
  <item>
    <title>Why the young are leaving the village</title>
    <link>https://globalvoices.org/2026/10/30/why-the-young-leave/</link>
    <dc:creator><![CDATA[Jane Doe]]></dc:creator>
    <pubDate>Fri, 30 Oct 2026 19:30:47 +0000</pubDate>
    <category><![CDATA[Youth]]></category><category><![CDATA[English]]></category><category><![CDATA[Weblog]]></category>
    <description><![CDATA[Work is somewhere else.]]></description>
    <content:encoded><![CDATA[<p class='originally-published'><small>Originally published on Global Voices</small></p>
      <div class="wp-caption"><img src="https://x.example/a.jpg"><p>Photo credit</p></div><p>{PROSE}</p>]]></content:encoded>
  </item>
  <item><title>Too short</title><link>https://globalvoices.org/x/</link>
    <content:encoded><![CDATA[<p>Few words.</p>]]></content:encoded></item>
</channel></rss>""".encode()
    [made] = globalvoices.parse(body, ["society"])
    assert made.title == "Why the young are leaving the village" and made.license == "CC BY 3.0"
    assert made.credit == "Jane Doe · Global Voices" and made.tags == ["Youth"]
    assert "Photo credit" not in made.content and "Originally published" not in made.content
    assert made.published_at == datetime(2026, 10, 30, 19, 30, 47, tzinfo=UTC)
    assert made.summary == "Work is somewhere else."


async def _two_shorts(feed):
    await feed(
        open_item("https://a.example/1", "Sleep", ["mind"], source="plos"),
        open_item("https://a.example/2", "Rivers", ["environment"], source="plos"),
    )
    async with SessionLocal() as session:
        found = {a.title: a for a in await shorts.originals(session, per_topic=1, topics=None)}
        made = {t: Short(article_id=a.id, **SHORT.model_dump()) for t, a in found.items()}
        session.add_all(made.values())
        await session.commit()
        return {t: str(s.id) for t, s in made.items()}


async def test_for_you_goes_on_past_the_topics_followed(client, auth, feed):
    await _two_shorts(feed)
    headers = auth()
    await client.put("/api/feed/topics", json={"topics": ["environment"]}, headers=headers)
    r = await client.get("/api/feed/shorts", headers=headers)
    assert [c["original_title"] for c in r.json()["shorts"]] == ["Rivers"]
    r = await client.get("/api/feed/shorts?mode=for_you", headers=headers)
    assert [c["original_title"] for c in r.json()["shorts"]] == ["Rivers", "Sleep"] and r.json()["total"] == 2
    r = await client.get("/api/feed/shorts?mode=for_you&topic=mind", headers=headers)
    assert [c["original_title"] for c in r.json()["shorts"]] == ["Sleep"]
    assert (await client.get("/api/feed/shorts?mode=nope", headers=headers)).status_code == 422


async def test_short_progress_resumes_and_the_last_card_completes_it(client, auth, feed):
    ids = await _two_shorts(feed)
    headers = auth()
    sleep = ids["Sleep"]
    card = (await client.get(f"/api/feed/shorts/{sleep}", headers=headers)).json()
    last = len(SHORT.points) + 1
    assert card["total_cards"] == last + 1 and 3 <= card["total_cards"] <= 9
    assert card["card_index"] == 0 and card["completed"] is False

    r = await client.put(f"/api/feed/shorts/{sleep}/progress", json={"card_index": 2}, headers=headers)
    assert r.json() == {"card_index": 2, "completed": False}
    [reading] = (await client.get("/api/feed/shorts/reading", headers=headers)).json()
    assert reading["id"] == sleep and reading["card_index"] == 2

    r = await client.put(f"/api/feed/shorts/{sleep}/progress", json={"card_index": last}, headers=headers)
    assert r.json() == {"card_index": last, "completed": True}
    r = await client.put(f"/api/feed/shorts/{sleep}/progress", json={"card_index": 1}, headers=headers)
    assert r.json() == {"card_index": 1, "completed": True}
    assert (await client.get("/api/feed/shorts/reading", headers=headers)).json() == []

    for bad in (last + 1, -1):
        r = await client.put(f"/api/feed/shorts/{sleep}/progress", json={"card_index": bad}, headers=headers)
        assert r.status_code == 422
    other = auth(uuid.uuid4())
    assert (await client.get(f"/api/feed/shorts/{sleep}", headers=other)).json()["card_index"] == 0
    missing = uuid.uuid4()
    assert (await client.get(f"/api/feed/shorts/{missing}", headers=headers)).status_code == 404
    r = await client.put(f"/api/feed/shorts/{missing}/progress", json={"card_index": 0}, headers=headers)
    assert r.status_code == 404


async def test_not_interested_keeps_a_short_out_until_taken_back(client, auth, feed):
    ids = await _two_shorts(feed)
    headers = auth()
    url = f"/api/feed/shorts/{ids['Sleep']}"
    await client.put(f"{url}/progress", json={"card_index": 1}, headers=headers)
    r = await client.put(f"{url}/interest", json={"interested": False}, headers=headers)
    assert r.status_code == 204
    r = await client.get("/api/feed/shorts", headers=headers)
    assert [c["original_title"] for c in r.json()["shorts"]] == ["Rivers"] and r.json()["total"] == 1
    assert (await client.get("/api/feed/shorts/reading", headers=headers)).json() == []
    assert (await client.get(url, headers=headers)).status_code == 200  # a link to it still opens
    await client.put(f"{url}/interest", json={"interested": True}, headers=headers)
    assert (await client.get("/api/feed/shorts", headers=headers)).json()["total"] == 2


async def test_short_translation_is_written_once_and_checked(client, auth, feed, monkeypatch):
    ids = await _two_shorts(feed)
    url = f"/api/feed/shorts/{ids['Sleep']}"
    english = SHORT.model_copy(update={"title": "Why sleep?", "hook": "Sleep.", "takeaway": "Keep it."})
    replies = [english.model_dump_json()]
    calls = []

    async def fake_chat(settings, messages, **kw):
        calls.append(kw["purpose"])
        return Completion(replies[0], Usage())

    monkeypatch.setattr(shorts, "chat", fake_chat)
    monkeypatch.setattr(get_settings(), "openai_api_key", "test-key")
    headers = auth()
    assert (await client.post(f"{url}/translation", headers=headers)).status_code == 403  # no consent yet
    assert calls == []
    async with SessionLocal() as session:
        for user in await session.scalars(select(User)):
            user.reading_preferences = {**(user.reading_preferences or {}), "ai_consent": True}
        await session.commit()

    # A different number of points, or a number the short never states, is not a translation.
    replies[0] = english.model_copy(update={"points": english.points[:1]}).model_dump_json()
    assert (await client.post(f"{url}/translation", headers=headers)).status_code == 502
    replies[0] = english.model_copy(update={"takeaway": "Sleep 99 hours."}).model_dump_json()
    assert (await client.post(f"{url}/translation", headers=headers)).status_code == 502
    assert (await client.get(url, headers=headers)).json()["en"] is None
    calls.clear()

    replies[0] = english.model_dump_json()
    r = await client.post(f"{url}/translation", headers=headers)
    assert r.status_code == 200 and r.json()["title"] == "Why sleep?" and len(calls) == 1
    assert (await client.get(url, headers=headers)).json()["en"]["title"] == "Why sleep?"

    # Kept: another reader gets it at no cost, without consenting to anything.
    other = auth(uuid.uuid4())
    r = await client.post(f"{url}/translation", headers=other)
    assert r.status_code == 200 and len(calls) == 1

    # Rewritten: the old translation no longer stands for it.
    async with SessionLocal() as session:
        short = await session.get(Short, uuid.UUID(ids["Sleep"]))
        short.hook = "Một câu mở đầu khác."
        await session.commit()
    assert (await client.get(url, headers=headers)).json()["en"] is None


def test_a_translation_keeps_the_cards_and_the_numbers():
    source = shorts.Draft(
        title="Tựa", hook="Mở đầu", points=["Một ý có 2,5 triệu người.", "Ý hai."], takeaway="Kết"
    )
    fine = shorts.Draft(title="T", hook="H", points=["2.5 million people.", "Two."], takeaway="K")
    assert shorts.check_translation(fine, source) is fine
    with pytest.raises(AIError):
        shorts.check_translation(fine.model_copy(update={"points": ["Only one."]}), source)
    with pytest.raises(AIError):
        shorts.check_translation(fine.model_copy(update={"hook": "In 2019."}), source)


async def test_a_point_that_says_nothing_is_no_card(client, auth, feed):
    ids = await _two_shorts(feed)
    async with SessionLocal() as session:
        short = await session.get(Short, uuid.UUID(ids["Sleep"]))
        short.points = [*SHORT.points, "takeaway"]
        await session.commit()
    card = (await client.get(f"/api/feed/shorts/{ids['Sleep']}", headers=auth())).json()
    assert card["points"] == SHORT.points and card["total_cards"] == len(SHORT.points) + 2


async def test_write_short_refuses_too_few_points(feed, monkeypatch):
    await feed(open_item("https://a.example/by", "Attribution", ["mind"], source="plos"))
    thin = SHORT.model_copy(update={"points": [SHORT.points[0], "takeaway"]})

    async def fake_chat(settings, messages, **kw):
        return Completion(thin.model_dump_json(), Usage())

    monkeypatch.setattr(shorts, "chat", fake_chat)
    async with SessionLocal() as session:
        [original] = await shorts.originals(session, per_topic=5, topics=["mind"])
    with pytest.raises(AIError):
        await shorts.write(get_settings(), original)
