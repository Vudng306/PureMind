import json
import uuid
from dataclasses import replace
from datetime import UTC, datetime

import pytest
from sqlalchemy import delete, select

from app.api.routes import catalog
from app.db.session import SessionLocal
from app.models import (
    AdminAuditLog,
    AppSetting,
    Article,
    BlockedArticle,
    CrawlChannel,
    CrawlRun,
    Short,
)
from app.services import crawler, quick_reads, sources, traffic, web
from app.services.sources import europepmc
from tests.test_admin import _make_admin, _make_user
from tests.test_feed import item


@pytest.fixture
async def clean():
    """No articles, channels, runs or crawl settings left from another test."""
    async with SessionLocal() as session:
        for table in (Short, Article, BlockedArticle, CrawlChannel, CrawlRun, AppSetting):
            await session.execute(delete(table))
        await session.commit()

    async def add(*items):
        async with SessionLocal() as session:
            return await crawler.keep(session, list(items))

    return add


async def test_regular_user_cannot_reach_the_content_admin(client, auth):
    _, h = await _make_user(client, auth)
    for method, path in [
        ("GET", "/api/admin/traffic"),
        ("GET", "/api/admin/articles"),
        ("POST", f"/api/admin/articles/{uuid.uuid4()}/hide"),
        ("DELETE", f"/api/admin/articles/{uuid.uuid4()}"),
        ("POST", "/api/admin/articles/from-link"),
        ("GET", "/api/admin/crawl"),
        ("POST", "/api/admin/crawl/runs"),
        ("GET", "/api/admin/crawl/runs"),
        ("PUT", "/api/admin/crawl/schedule"),
    ]:
        assert (await client.request(method, path, headers=h, json={})).status_code == 403, path


async def test_traffic_counts_requests_active_users_and_signups(client, auth):
    traffic.reset()
    admin = await _make_admin(client, auth)
    uid, h = await _make_user(client, auth)
    for _ in range(3):
        assert (await client.get("/api/account", headers=h)).status_code == 200
    await client.get("/api/healthz")  # outside the API's parts: not counted

    r = await client.get("/api/admin/traffic", headers=admin, params={"days": 7})
    assert r.status_code == 200, r.text
    body = r.json()
    assert len(body["days"]) == 7
    today = body["days"][-1]
    assert today["active_users"] >= 2 and today["signups"] >= 2
    areas = {a["area"]: a for a in body["areas"]}
    assert areas["account"]["requests"] >= 5
    assert "healthz" not in areas
    assert body["totals"]["requests"] == sum(d["requests"] for d in body["days"])
    # Counts only: no user id or e-mail in the answer.
    assert str(uid) not in r.text and "@example.com" not in r.text
    assert (await client.get("/api/admin/traffic", headers=admin, params={"days": 12})).status_code == 422


async def test_only_articles_from_2023_on_are_kept(clean):
    counts = await clean(
        item("https://a.example/new", "New", ["science"], published_at=datetime(2024, 5, 1, tzinfo=UTC)),
        item("https://a.example/old", "Old", ["science"], published_at=datetime(2022, 12, 31, tzinfo=UTC)),
        item("https://a.example/undated", "Undated", ["science"], published_at=None),
    )
    assert (counts["fetched"], counts["added"], counts["too_old"]) == (3, 1, 2)


async def test_list_filter_hide_show_and_delete_articles(client, auth, clean):
    admin = await _make_admin(client, auth)
    await clean(
        item(
            "https://a.example/1", "Sleep and memory", ["mind"], published_at=datetime(2024, 3, 1, tzinfo=UTC)
        ),
        item(
            "https://b.example/2",
            "Forests",
            ["environment"],
            source="plos",
            kind="research",
            tags=["forests", "ecology"],
            published_at=datetime(2025, 1, 2, tzinfo=UTC),
        ),
    )
    r = await client.get("/api/admin/articles", headers=admin)
    body = r.json()
    assert body["total"] == 2
    assert {f["value"] for f in body["kinds"]} == {"explainer", "research"}
    assert body["items"][0]["tags"] == ["ecology", "forests"]
    assert {f["value"] for f in body["years"]} == {"2024", "2025"}
    assert {f["value"] for f in body["sources"]} == {"conversation", "plos"}
    assert body["items"][0]["title"] == "Forests"  # newest first

    for params, titles in [
        ({"q": "SLEEP"}, ["Sleep and memory"]),
        ({"source": "plos"}, ["Forests"]),
        ({"kind": "research"}, ["Forests"]),
        ({"kind": "report"}, []),
        ({"topic": "mind"}, ["Sleep and memory"]),
        ({"year": 2024}, ["Sleep and memory"]),
        ({"language": "vi"}, []),
    ]:
        r = await client.get("/api/admin/articles", headers=admin, params=params)
        assert [a["title"] for a in r.json()["items"]] == titles, params

    sleep = next(a for a in body["items"] if a["title"] == "Sleep and memory")
    _, reader = await _make_user(client, auth)
    r = await client.post(f"/api/admin/articles/{sleep['id']}/hide", headers=admin)
    assert r.status_code == 200 and r.json()["hidden_at"] is not None
    feed = (await client.get("/api/feed", headers=reader)).json()
    assert [a["title"] for a in feed["articles"]] == ["Forests"]
    assert (await client.post(f"/api/feed/{sleep['id']}/open", headers=reader)).status_code == 404
    r = await client.get("/api/admin/articles", headers=admin, params={"status": "hidden"})
    assert [a["title"] for a in r.json()["items"]] == ["Sleep and memory"]

    r = await client.post(f"/api/admin/articles/{sleep['id']}/show", headers=admin)
    assert r.json()["hidden_at"] is None
    assert (await client.get("/api/feed", headers=reader)).json()["total"] == 2

    r = await client.delete(f"/api/admin/articles/{sleep['id']}", headers=admin)
    assert r.status_code == 204
    assert (await client.get("/api/admin/articles", headers=admin)).json()["total"] == 1
    # A crawl that meets it again, by address or by title, leaves it out.
    async with SessionLocal() as session:
        counts = await crawler.keep(
            session,
            [
                item("https://a.example/1", "Sleep and memory", ["mind"]),
                item("https://c.example/elsewhere", "Sleep and Memory", ["mind"], source="elife"),
            ],
        )
    assert (counts["blocked"], counts["added"]) == (2, 0)

    async with SessionLocal() as session:
        actions = list(
            await session.scalars(
                select(AdminAuditLog.action)
                .where(AdminAuditLog.action.like("article.%"))
                .order_by(AdminAuditLog.created_at)
            )
        )
    assert actions[-3:] == ["article.hide", "article.show", "article.delete"]
    assert (await client.post(f"/api/admin/articles/{uuid.uuid4()}/hide", headers=admin)).status_code == 404


async def test_hiding_or_deleting_an_article_takes_it_off_explore(client, auth, clean, tmp_path, monkeypatch):
    """Explore reads copies in JSON files, so what an admin decides has to reach it without a new copy."""
    admin = await _make_admin(client, auth)
    _, reader = await _make_user(client, auth)
    url = "https://a.example/sleep"
    await clean(item(url, "Sleep and memory", ["mind"], published_at=datetime(2024, 3, 1, tzinfo=UTC)))
    article_id = (await client.get("/api/admin/articles", headers=admin)).json()["items"][0]["id"]

    common = {
        "kind": "explainer",
        "authors": "Jane Doe",
        "description": "",
        "content": "Some text",
        "source": "The Conversation",
        "license": "CC BY-ND 4.0",
        "license_url": "https://creativecommons.org/licenses/by-nd/4.0/",
    }
    pick_id = uuid.UUID(article_id).hex
    pick = {**common, "id": pick_id, "url": url, "title": "Sleep and memory", "topic": "Mind"}
    paper = {**common, "id": "paper", "url": "https://b.example/paper", "title": "Forests", "topic": "Nature"}
    (tmp_path / "catalog.json").write_text(
        json.dumps({"updated_at": "x", "articles": [paper]}), encoding="utf-8"
    )
    (tmp_path / "picks.json").write_text(json.dumps([pick]), encoding="utf-8")
    quick = {
        "title": "T",
        "problem": "P",
        "points": ["1", "2", "3"],
        "conclusion": "C",
        "results_complete": True,
    }
    quick_reads.save({pick_id: quick}, tmp_path / "quick.json")
    monkeypatch.setattr(catalog, "CATALOG", tmp_path / "catalog.json")
    monkeypatch.setattr(catalog, "PICKS", tmp_path / "picks.json")
    monkeypatch.setattr(catalog, "QUICK", tmp_path / "quick.json")
    monkeypatch.setattr(catalog, "VI", tmp_path / "no-vi.json")
    catalog._load.cache_clear()

    async def statuses():
        return {
            "detail": (await client.get(f"/api/catalog/{pick_id}")).status_code,
            "translation": (await client.get(f"/api/catalog/{pick_id}/translation")).status_code,
            "report": (
                await client.post(
                    f"/api/catalog/{pick_id}/quick/report", headers=reader, json={"reason": "wrong"}
                )
            ).status_code,
        }

    shown = {"detail": 200, "translation": 200, "report": 204}
    gone = {"detail": 404, "translation": 404, "report": 404}

    listed = (await client.get("/api/catalog")).json()
    assert {a["id"] for a in listed["articles"]} == {pick_id, "paper"} and listed["topics"] == [
        "Mind",
        "Nature",
    ]
    assert await statuses() == shown
    r = await client.post(f"/api/catalog/{pick_id}/open", headers=reader)
    assert r.status_code == 201, r.text
    copy = r.json()["id"]

    assert (await client.post(f"/api/admin/articles/{article_id}/hide", headers=admin)).status_code == 200
    listed = (await client.get("/api/catalog")).json()
    assert [a["id"] for a in listed["articles"]] == ["paper"]
    assert listed["total"] == 1 and listed["topics"] == ["Nature"]
    assert (await client.get("/api/catalog", params={"q": "sleep"})).json()["total"] == 0
    assert await statuses() == gone
    assert (await client.post(f"/api/catalog/{pick_id}/open", headers=reader)).status_code == 404
    # The copy a reader already took is theirs.
    assert (await client.get(f"/api/documents/{copy}", headers=reader)).status_code == 200

    assert (await client.post(f"/api/admin/articles/{article_id}/show", headers=admin)).status_code == 200
    assert (await client.get("/api/catalog")).json()["total"] == 2
    assert await statuses() == shown

    assert (await client.delete(f"/api/admin/articles/{article_id}", headers=admin)).status_code == 204
    assert [a["id"] for a in (await client.get("/api/catalog")).json()["articles"]] == ["paper"]
    assert await statuses() == gone
    assert (await client.get(f"/api/documents/{copy}", headers=reader)).status_code == 200
    # A paper no admin touched is not affected.
    assert (await client.get("/api/catalog/paper")).status_code == 200
    catalog._load.cache_clear()


async def test_channels_are_seeded_once_and_kept_by_admins(client, auth, clean):
    admin = await _make_admin(client, auth)
    r = await client.get("/api/admin/crawl", headers=admin)
    assert r.status_code == 200, r.text
    sources = {s["id"]: s for s in r.json()["sources"]}
    assert set(sources) == set(crawler.SOURCES)
    assert len(sources["conversation"]["channels"]) == len(crawler.conversation.FEEDS)
    assert sources["owid"]["channel"] is None and sources["owid"]["channels"] == []
    assert r.json()["cutoff"] == "2023-01-01"

    url = "/api/admin/crawl/sources/conversation/channels"
    r = await client.post(
        url,
        headers=admin,
        json={"key": "https://theconversation.com/topics/astronomy-123/", "topics": ["science"]},
    )
    assert r.status_code == 201, r.text
    channel = r.json()
    assert channel["key"] == "topics/astronomy-123"
    again = await client.post(url, headers=admin, json={"key": "topics/astronomy-123", "topics": ["science"]})
    assert again.status_code == 409
    assert (
        await client.post(url, headers=admin, json={"key": "not a section!", "topics": ["science"]})
    ).status_code == 422
    assert (
        await client.post(url, headers=admin, json={"key": "us/sport", "topics": ["gossip"]})
    ).status_code == 422
    r = await client.post(
        "/api/admin/crawl/sources/owid/channels", headers=admin, json={"key": "x y", "topics": ["science"]}
    )
    assert r.status_code == 422

    r = await client.patch(
        f"/api/admin/crawl/channels/{channel['id']}",
        headers=admin,
        json={"enabled": False, "topics": ["science", "technology"]},
    )
    assert r.json()["enabled"] is False and r.json()["topics"] == ["science", "technology"]

    # Removing every default does not bring them back.
    first = sources["elife"]["channels"]
    for c in first:
        assert (await client.delete(f"/api/admin/crawl/channels/{c['id']}", headers=admin)).status_code == 204
    r = await client.get("/api/admin/crawl", headers=admin)
    assert next(s for s in r.json()["sources"] if s["id"] == "elife")["channels"] == []


async def test_a_run_reads_the_enabled_channels_and_records_the_counts(client, auth, clean, monkeypatch):
    admin = await _make_admin(client, auth)
    seen = {}

    async def conversation_collect(contact, feeds):
        seen["feeds"] = dict(feeds)
        return [
            item("https://a.example/new", "New", ["mind"], published_at=datetime(2025, 6, 1, tzinfo=UTC)),
            item("https://a.example/old", "Old", ["mind"], published_at=datetime(2020, 1, 1, tzinfo=UTC)),
        ]

    async def owid_collect(contact):
        crawler.log.warning("unrelated")  # only the sources' own warnings count as errors
        import logging

        logging.getLogger("app.services.sources").warning("Our World in Data x: timed out")
        return []

    monkeypatch.setitem(
        crawler.SOURCES,
        "conversation",
        replace(crawler.SOURCES["conversation"], collect=conversation_collect),
    )
    monkeypatch.setitem(crawler.SOURCES, "owid", replace(crawler.SOURCES["owid"], collect=owid_collect))

    overview = (await client.get("/api/admin/crawl", headers=admin)).json()
    conv = next(s for s in overview["sources"] if s["id"] == "conversation")
    off = conv["channels"][0]
    await client.patch(f"/api/admin/crawl/channels/{off['id']}", headers=admin, json={"enabled": False})

    r = await client.post("/api/admin/crawl/runs", headers=admin, json={"sources": ["conversation", "owid"]})
    assert r.status_code == 202, r.text
    run_id = r.json()["id"]
    runs = (await client.get("/api/admin/crawl/runs", headers=admin)).json()
    run = next(x for x in runs["items"] if x["id"] == run_id)
    assert run["status"] == "done" and run["trigger"] == "manual" and run["finished_at"]
    stats = run["stats"]
    assert (stats["conversation"]["added"], stats["conversation"]["too_old"]) == (1, 1)
    assert stats["owid"]["errors"] == 1 and "timed out" in stats["owid"]["error_messages"][0]
    assert off["key"] not in seen["feeds"] and len(seen["feeds"]) == len(conv["channels"]) - 1

    assert (
        await client.post("/api/admin/crawl/runs", headers=admin, json={"sources": ["nowhere"]})
    ).status_code == 422
    async with SessionLocal() as session:
        session.add(CrawlRun(trigger="schedule", sources=["owid"], status="running", stats={}))
        await session.commit()
    assert (await client.post("/api/admin/crawl/runs", headers=admin, json={})).status_code == 409


async def test_switched_off_sources_stay_out_of_the_daily_run(client, auth, clean):
    admin = await _make_admin(client, auth)
    r = await client.put("/api/admin/crawl/sources/frym", headers=admin, json={"enabled": False})
    assert r.status_code == 200
    async with SessionLocal() as session:
        run = await crawler.start(session, "schedule", None, None)
        assert "frym" not in run.sources and "owid" in run.sources
        run.status = "done"
        await session.commit()
        # By hand, a switched-off source can still be run.
        run = await crawler.start(session, "manual", ["frym"], "a@example.com")
        assert run.sources == ["frym"]
        run.status = "done"
        await session.commit()
    assert (
        await client.put("/api/admin/crawl/sources/nowhere", headers=admin, json={"enabled": True})
    ).status_code == 404


async def test_the_daily_run_is_due_once_after_its_hour(client, auth, clean):
    admin = await _make_admin(client, auth)
    r = await client.put("/api/admin/crawl/schedule", headers=admin, json={"enabled": True, "hour": 5})
    assert r.status_code == 200
    assert (
        await client.put("/api/admin/crawl/schedule", headers=admin, json={"enabled": True, "hour": 24})
    ).status_code == 422
    # 05:30 and 04:30 in Vietnam (UTC+7).
    after, before = datetime(2026, 3, 1, 22, 30, tzinfo=UTC), datetime(2026, 3, 1, 21, 30, tzinfo=UTC)
    async with SessionLocal() as session:
        assert await crawler.due(session, after)
        assert not await crawler.due(session, before)
        session.add(CrawlRun(trigger="schedule", sources=[], status="done", stats={}, started_at=after))
        await session.commit()
        assert not await crawler.due(session, datetime(2026, 3, 1, 23, 0, tzinfo=UTC))
        # The next day: a run cut off by a restart is run again, one that failed by itself is not.
        day_two = datetime(2026, 3, 2, 22, 30, tzinfo=UTC)
        cut_off = CrawlRun(
            trigger="schedule", sources=[], status="failed", error="interrupted", stats={}, started_at=day_two
        )
        session.add(cut_off)
        await session.commit()
        assert await crawler.due(session, day_two)
        cut_off.error = "no source answered"
        await session.commit()
        assert not await crawler.due(session, day_two)
    await client.put("/api/admin/crawl/schedule", headers=admin, json={"enabled": False, "hour": 5})
    async with SessionLocal() as session:
        assert not await crawler.due(session, datetime(2026, 3, 2, 23, 0, tzinfo=UTC))


async def test_a_restart_leaves_a_crawl_running_from_the_command_line(clean):
    async with SessionLocal() as session:
        runs = {
            "command line": CrawlRun(trigger="manual", sources=[], status="running", stats={}),
            "admin": CrawlRun(trigger="manual", sources=[], status="running", admin_email="a@x.io", stats={}),
            "schedule": CrawlRun(trigger="schedule", sources=[], status="running", stats={}),
        }
        session.add_all(runs.values())
        await session.commit()
        ids = {name: run.id for name, run in runs.items()}
    await crawler.recover()
    async with SessionLocal() as session:
        status = {name: (await session.get(CrawlRun, run_id)).status for name, run_id in ids.items()}
    assert status == {"command line": "running", "admin": "failed", "schedule": "failed"}


async def test_add_from_link_checks_the_source_and_the_date(client, auth, clean, monkeypatch):
    admin = await _make_admin(client, auth)
    url = "/api/admin/articles/from-link"
    r = await client.post(url, headers=admin, json={"url": "https://example.com/post", "topics": []})
    assert r.status_code == 422 and "PLOS" in r.json()["detail"]

    dates = iter([datetime(2025, 2, 1, tzinfo=UTC), datetime(2021, 2, 1, tzinfo=UTC)])

    async def from_link(link, contact, topics):
        return item(
            link, f"Linked {link[-1]}", topics or ["science"], source="elife", published_at=next(dates)
        )

    monkeypatch.setitem(crawler.SOURCES, "elife", replace(crawler.SOURCES["elife"], from_link=from_link))
    r = await client.post(
        url, headers=admin, json={"url": "https://elifesciences.org/articles/1", "topics": ["health"]}
    )
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "added" and r.json()["article"]["topics"] == ["health"]
    r = await client.post(
        url, headers=admin, json={"url": "https://elifesciences.org/articles/2", "topics": []}
    )
    assert r.json()["status"] == "too_old" and r.json()["article"] is None

    async def broken(link, contact, topics):
        raise RuntimeError("timeout")

    monkeypatch.setitem(crawler.SOURCES, "elife", replace(crawler.SOURCES["elife"], from_link=broken))
    r = await client.post(
        url, headers=admin, json={"url": "https://elifesciences.org/articles/3", "topics": []}
    )
    assert r.status_code == 502
    runs = (await client.get("/api/admin/crawl/runs", headers=admin)).json()["items"]
    assert [x["trigger"] for x in runs[:2]] == ["link", "link"]


def test_links_go_to_their_source():
    assert (
        crawler.source_of("https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0300000").id
        == "plos"
    )
    assert crawler.source_of("https://doi.org/10.1371/journal.pbio.1").id == "plos"
    assert crawler.source_of("https://doi.org/10.3389/frym.2024.1").id == "frym"
    assert crawler.source_of("https://www.theconversation.com/why-1").id == "conversation"
    assert crawler.source_of("https://europepmc.org/article/PMC/PMC1234").id == "europepmc"
    with pytest.raises(crawler.UnsupportedLink):
        crawler.source_of("https://doi.org/10.1000/other")
    with pytest.raises(crawler.UnsupportedLink):
        crawler.source_of("https://evil.example/theconversation.com")


def test_channel_keys_are_what_each_source_reads():
    key = crawler.channel_key
    assert (
        key(crawler.SOURCES["conversation"], "https://theconversation.com/us/health/articles.atom")
        == "us/health"
    )
    assert key(crawler.SOURCES["conversation"], "topics/space-1") == "topics/space-1"
    assert key(crawler.SOURCES["conversation"], "rm -rf") is None
    assert key(crawler.SOURCES["elife"], "https://elifesciences.org/subjects/neuroscience") == "neuroscience"
    assert key(crawler.SOURCES["europepmc"], "  sleep   memory ") == "sleep memory"
    assert key(crawler.SOURCES["arxiv"], "https://arxiv.org/list/cs.AI") is None
    assert key(crawler.SOURCES["arxiv"], "https://arxiv.org/list/physics:astro-ph") == "physics:astro-ph"
    assert key(crawler.SOURCES["arxiv"], "cs:cs:AI; rm") is None
    assert key(crawler.SOURCES["openalex"], "https://doi.org/10.1596/") == "10.1596"
    assert key(crawler.SOURCES["openalex"], "10.1596/abc") is None


async def test_a_dropped_connection_gets_a_second_try_and_a_missing_page_does_not(monkeypatch):
    calls = []

    async def no_wait(_seconds):
        return None

    async def dropped_once(url, contact="", accept=""):
        calls.append(url)
        if len(calls) == 1:
            raise web.FetchFailed from TimeoutError()
        return web.FetchResult(url=url, content_type="text/html", body=b"ok")

    monkeypatch.setattr(sources.asyncio, "sleep", no_wait)
    monkeypatch.setattr(web, "fetch_url", dropped_once)
    assert await sources.fetch("https://example.org/a", "") == b"ok"
    assert len(calls) == 2

    calls.clear()

    async def missing(url, contact="", accept=""):
        calls.append(url)
        raise web.FetchFailed("HTTP 404")

    monkeypatch.setattr(web, "fetch_url", missing)
    with pytest.raises(web.FetchFailed):
        await sources.fetch("https://example.org/b", "")
    assert len(calls) == 1


def test_an_error_always_says_what_went_wrong():
    assert sources.reason(web.FetchFailed("HTTP 404")) == "HTTP 404"
    timed_out = web.FetchFailed()
    timed_out.__cause__ = TimeoutError()
    assert sources.reason(timed_out) == "TimeoutError"
    assert sources.reason(ValueError()) == "ValueError"


def test_a_coming_print_issue_is_dated_by_when_the_article_went_online():
    ahead = {"firstPublicationDate": "2999-12-01", "firstIndexDate": "2026-10-28"}
    assert europepmc.published_of(ahead) == datetime(2026, 10, 28, tzinfo=UTC)
    assert europepmc.published_of({"firstPublicationDate": "2999-12-01"}) <= datetime.now(UTC)
    out = {"firstPublicationDate": "2024-03-01", "firstIndexDate": "2024-05-01"}
    assert europepmc.published_of(out) == datetime(2024, 3, 1, tzinfo=UTC)
    assert europepmc.published_of({}) is None


def test_global_voices_channels_are_topic_feeds():
    key = crawler.channel_key
    source = crawler.SOURCES["globalvoices"]
    assert key(source, "https://globalvoices.org/-/topics/youth/feed/") == "-/topics/youth"
    assert key(source, "-/topics/arts-culture") == "-/topics/arts-culture"
    assert key(source, "https://globalvoices.org/2026/10/30/post/") is None
    assert crawler.source_of("https://globalvoices.org/2026/10/30/post/").id == "globalvoices"
