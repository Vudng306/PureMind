import json
import uuid
from datetime import UTC, datetime
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from sqlalchemy import update

from app.api.routes import catalog
from app.core.config import get_settings
from app.db.session import SessionLocal
from app.models import ContentTranslation, User
from app.scripts import pick_explore
from app.scripts.collect_catalog import EXCLUDED_TITLES, OUTPUT, PER_TOPIC, TOPICS, fits_topic, search_query
from app.services import article_translation, quick_reads
from app.services.html_markdown import word_count
from app.services.openai_client import AIError, Completion, Usage
from tests.test_summaries import consent


@pytest.fixture
def shared_catalog(tmp_path, monkeypatch):
    path = tmp_path / "catalog.json"
    path.write_text(
        json.dumps(
            {
                "updated_at": "2026-10-28",
                "articles": [
                    {
                        "id": "a",
                        "title": "Climate",
                        "topic": "Environment",
                        "kind": "research",
                        "authors": "Alice",
                        "description": "Biodiversity",
                        "content": "Full body",
                        "abstract": "Abstract",
                    },
                    {
                        "id": "b",
                        "title": "Learning",
                        "topic": "Education",
                        "kind": "knowledge",
                        "authors": "Bob",
                        "description": "Memory",
                        "content": "Another body",
                    },
                ],
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(catalog, "CATALOG", path)
    monkeypatch.setattr(catalog, "PICKS", tmp_path / "no-picks.json")
    monkeypatch.setattr(catalog, "VI", tmp_path / "no-vi.json")
    catalog._load.cache_clear()


def test_search_and_pagination_do_not_return_full_text(shared_catalog):
    result = catalog.list_articles(q="ALICE", topic="Environment", kind="research", offset=0, limit=1)
    assert result["total"] == 1
    assert result["articles"][0]["id"] == "a"
    assert "content" not in result["articles"][0]
    assert "abstract" not in result["articles"][0]
    assert result["articles"][0]["word_count"] == 2  # a card says how long the read is
    assert catalog.list_articles(q="", topic="", kind="", offset=1, limit=1)["articles"][0]["id"] == "b"


def test_shared_article_and_unknown_id(shared_catalog):
    assert catalog.get_article("a")["content"] == "Full body"
    with pytest.raises(HTTPException) as exc:
        catalog.get_article("missing")
    assert exc.value.status_code == 404


def test_missing_catalog_is_empty(tmp_path, monkeypatch):
    monkeypatch.setattr(catalog, "CATALOG", tmp_path / "missing.json")
    assert catalog.catalog()["articles"] == []


@pytest.fixture
def open_catalog(shared_catalog):
    data = json.loads(catalog.CATALOG.read_text(encoding="utf-8"))
    data["articles"][0].update(
        url="https://europepmc.org/articles/PMC1",
        source="Europe PMC",
        published_at="2026-10-09",
        license="CC BY",
        license_url="https://creativecommons.org/licenses/by/4.0/",
        attribution_url="https://europepmc.org/articles/PMC1",
        content_note="Figures are left out.",
    )
    catalog.CATALOG.write_text(json.dumps(data), encoding="utf-8")
    catalog._load.cache_clear()


async def test_open_puts_the_article_in_the_library_once(client, auth, open_catalog):
    headers = auth()
    assert (await client.post("/api/catalog/a/open")).status_code == 401  # browsing is public, keeping is not

    r = await client.post("/api/catalog/a/open", headers=headers)
    assert r.status_code == 201, r.text
    doc = r.json()
    assert doc["title"] == "Climate" and doc["extraction_status"] == "done"
    r = await client.get(f"/api/documents/{doc['id']}", headers=headers)
    content = r.json()["content_clean"]
    assert (
        content.startswith("*Alice · ") and "[CC BY](https://creativecommons.org/licenses/by/4.0/)" in content
    )
    assert "*Figures are left out.*" in content and content.endswith("Full body")

    again = await client.post("/api/catalog/a/open", headers=headers)
    assert again.status_code == 200 and again.json()["id"] == doc["id"]
    assert (await client.post("/api/catalog/missing/open", headers=headers)).status_code == 404


@pytest.mark.parametrize(
    ("topic", "title"),
    [
        (
            "Di cư và hòa nhập",
            "Mechanisms of Neural Stem Cell Mediated Neurogenesis and Therapeutic Prospects Following "
            "Ischemic Stroke: A Review.",
        ),
        ("Di cư và hòa nhập", "Directed cell migration in wound healing."),
        (
            "Mạng xã hội và công nghệ",
            "Conceptualizing an athlete support ecosystem for women in professional team sport.",
        ),
        (
            "Mạng xã hội và công nghệ",
            "Editorial: Understandings and experiences of colourism: global perspectives",
        ),
        (
            "Công việc và kinh tế",
            "Artificial intelligence anxiety and academic burnout among Chinese postgraduate students: "
            "perceived stress and rumination as serial mediators",
        ),
        ("Giáo dục", "Federated deep learning for image segmentation."),
        ("Tâm lý và các mối quan hệ", "Social Isolation, Loneliness and Subclinical Atherosclerosis."),
        ("Môi trường", "Climate Change and Pediatric Gastrointestinal Health: A Narrative Review."),
    ],
)
def test_a_title_that_only_shares_a_word_with_the_topic_does_not_fit(topic, title):
    assert not fits_topic(topic, title)


@pytest.mark.parametrize(
    ("topic", "title"),
    [
        ("Di cư và hòa nhập", "Latin American Asylum Seekers in Spain: Acculturation Preferences."),
        ("Di cư và hòa nhập", "Late-Life Migration to Israel as an Ambivalent Process."),
        ("Mạng xã hội và công nghệ", "The Impact of Social Media Engagement on Adult Self-Esteem."),
        ("Giáo dục", "AI and higher education: teachers' perceptions of students' ethical tensions."),
        ("Môi trường", "Fine-Grain Data Reveal Vulnerability of Biodiversity to Climate Change."),
    ],
)
def test_a_title_about_the_topic_fits(topic, title):
    assert fits_topic(topic, title)


def test_the_search_is_on_titles_and_stays_open_licensed():
    query = search_query("Di cư và hòa nhập")
    assert query.startswith('TITLE:("migrant" OR ')
    assert "OPEN_ACCESS:Y" in query and "LICENSE:cc-by" in query
    assert '"migration"' not in query  # bare, it also means the migration of cells


def test_an_editorial_is_not_collected_as_research():
    assert EXCLUDED_TITLES.match("Editorial: Understandings and experiences of colourism")


def test_the_collected_catalog_keeps_every_article_in_a_topic_it_fits():
    articles = json.loads(OUTPUT.read_text(encoding="utf-8"))["articles"]
    for topic in TOPICS:
        titles = [a["title"] for a in articles if a["topic"] == topic]
        assert len(titles) == PER_TOPIC, topic
        assert [t for t in titles if not fits_topic(topic, t)] == [], topic
    assert {a["license"] for a in articles} <= {"CC BY", "CC0"}


QUICK = {
    "title": "Khí hậu đổi thay thì sao?",
    "problem": "Điều gì xảy ra với đa dạng sinh học?",
    "points": ["Một.", "Hai.", "Ba."],
    "conclusion": "Kết luận.",
    "results_complete": True,
}


@pytest.fixture
def quick_catalog(shared_catalog, tmp_path, monkeypatch):
    path = tmp_path / "catalog-quick.json"
    quick_reads.save({"a": QUICK, "gone": QUICK}, path)
    monkeypatch.setattr(catalog, "QUICK", path)
    catalog._load.cache_clear()
    return path


def test_an_article_carries_its_quick_read_and_search_finds_it(quick_catalog):
    listed = catalog.list_articles(q="khí hậu", topic="", kind="", offset=0, limit=10)
    assert [a["id"] for a in listed["articles"]] == ["a"]
    assert listed["articles"][0]["quick"]["title"] == QUICK["title"]
    assert "quick" not in catalog.get_article("b")

    catalog.QUICK.unlink()  # no Quick Reads yet: the catalog still works
    assert "quick" not in catalog.get_article("a")


def _body(**change) -> str:
    return json.dumps({**QUICK, **change})


async def test_a_quick_read_is_given_the_whole_text_and_may_not_add_numbers(monkeypatch):
    article = {"title": "T", "authors": "A", "content": "start " * 6000 + "We found 2,798 comments in 2024."}
    seen = {}

    async def fake_chat(settings, messages, **kw):
        seen.update(messages=messages, **kw)
        return Completion(reply, Usage())

    monkeypatch.setattr(quick_reads, "chat", fake_chat)
    reply = _body(points=["Có 2.798 bình luận.", "Năm 2024.", "Ba."])
    written = await quick_reads.write(get_settings(), article)
    assert written["points"][0] == "Có 2.798 bình luận." and written["results_complete"] is True
    assert "2,798 comments" in seen["messages"][1]["content"]  # past where a short's source stops
    assert seen["purpose"] == "quick_read" and seen["json_schema"] == quick_reads.QUICK_READ_SCHEMA

    reply = _body(points=["Có 45% người đồng ý.", "Hai.", "Ba."])
    with pytest.raises(AIError, match="45"):
        await quick_reads.write(get_settings(), article)
    with pytest.raises(AIError):
        quick_reads.parse(_body(points=["Một.", "Hai."]))

    reply = _body(problem="từ " * quick_reads.MAX_WORDS)
    with pytest.raises(AIError, match="too long"):
        await quick_reads.write(get_settings(), article)


def test_a_quick_read_is_only_for_a_long_article_that_may_be_adapted():
    assert quick_reads.wanted_for({"word_count": 6000, "license": "CC BY"})
    assert not quick_reads.wanted_for({"word_count": 6000, "license": "CC BY-ND 4.0"})
    assert not quick_reads.wanted_for({"word_count": 1200, "license": "CC BY 4.0"})


def test_every_written_quick_read_belongs_to_the_catalog_and_is_quick():
    known = {a["id"]: a for a in json.loads(OUTPUT.read_text(encoding="utf-8"))["articles"]}
    for article_id, quick in quick_reads.load().items():
        assert article_id in known
        draft = quick_reads.Draft.model_validate({k: v for k, v in quick.items() if k != "written_at"})
        quick_reads.check(draft, known[article_id]["title"] + " " + known[article_id]["content"])


async def test_a_reader_reports_a_quick_read_and_an_admin_sees_only_the_counts(
    client, auth, open_catalog, quick_catalog
):
    url = "/api/catalog/a/quick/report"
    assert (await client.post(url, json={"reason": "wrong"})).status_code == 401
    reader, other = uuid.uuid4(), uuid.uuid4()
    headers = auth(reader, email="reader@example.com")
    assert (await client.post(url, json={"reason": "nonsense"}, headers=headers)).status_code == 422
    assert (await client.post(url, json={"reason": "wrong"}, headers=headers)).status_code == 204
    # Asked again, the reader changes their reason rather than counting twice.
    assert (await client.post(url, json={"reason": "missing"}, headers=headers)).status_code == 204
    assert (
        await client.post(url, json={"reason": "wrong"}, headers=auth(other, email="other@example.com"))
    ).status_code == 204
    no_quick = await client.post("/api/catalog/b/quick/report", json={"reason": "wrong"}, headers=headers)
    assert no_quick.status_code == 404

    assert (await client.get("/api/admin/quick-read-reports", headers=headers)).status_code == 403
    async with SessionLocal() as s:
        await s.execute(update(User).where(User.id == reader).values(role="admin"))
        await s.commit()
    [row] = (await client.get("/api/admin/quick-read-reports", headers=headers)).json()
    assert (row["article_id"], row["wrong"], row["missing"], row["other"]) == ("a", 1, 1, 0)
    assert row["quick_title"] == QUICK["title"] and "user_id" not in row


def _article(**change):
    return SimpleNamespace(
        **{
            "id": uuid.uuid4(),
            "title": "How friends help us",
            "summary": "",
            "source": "conversation",
            "word_count": 1200,
            "url": "https://example.org/how-friends-help",
            "hidden_at": None,
            "based_on_id": None,
            "published_at": datetime(2026, 10, 1, tzinfo=UTC),
            "topics": [SimpleNamespace(topic="mind")],
            **change,
        }
    )


@pytest.mark.parametrize(
    ("topic", "title", "feed_topics"),
    [
        ("Di cư và hòa nhập", "For centuries, bird migration was a mystery", {"environment", "society"}),
        ("Di cư và hòa nhập", "Khia's song about an asylum", {"culture"}),
        ("Giáo dục", "Teachers on strike", {"economy"}),  # the feed does not hold it under education
    ],
)
def test_a_pick_has_to_be_about_the_topic(topic, title, feed_topics):
    assert not pick_explore.fits(topic, title, feed_topics)


@pytest.mark.parametrize(
    ("topic", "title", "feed_topics"),
    [
        ("Di cư và hòa nhập", "What refugees bring with them", {"society"}),
        ("Môi trường", "For centuries, bird migration was a mystery", {"environment"}),
        ("Tâm lý và các mối quan hệ", "Should you cut off your friend?", {"mind"}),
    ],
)
def test_a_title_about_the_topic_may_be_picked(topic, title, feed_topics):
    assert pick_explore.fits(topic, title, feed_topics)


def test_an_ordinary_article_may_go_on_explore():
    assert pick_explore.eligible(_article())
    assert pick_explore.eligible(_article(title="How friends help us in the US", source="globalvoices"))
    assert pick_explore.eligible(_article(title="Refugees in Australia"))  # a story of moving names the place


@pytest.mark.parametrize(
    "change",
    [
        {"title": "Why Trump is wrong about friends"},
        {"title": "Friends in Australia"},
        {"title": "How the US makes friends"},
        {"title": "Friends and violence"},
        {"summary": "An election is coming."},
        {"source": "frym"},  # written for children
        {"word_count": 300},
        {"word_count": 5000},
        {"hidden_at": datetime(2026, 10, 1, tzinfo=UTC)},
        {"based_on_id": uuid.uuid4()},  # the AI's guide to another article
        {"url": "https://example.org/a-cree-psychotherapist-reflects"},
    ],
)
def test_what_does_not_go_on_explore(change):
    assert not pick_explore.eligible(_article(**change))


def test_no_article_is_picked_twice_and_one_source_leaves_room_for_others():
    articles = [_article(title=f"Friends {n}") for n in range(15)]
    articles += [_article(title=f"Friends abroad {n}", source="globalvoices") for n in range(2)]
    both = _article(title="Friends and their phones", topics=[SimpleNamespace(topic="mind")])
    chosen = pick_explore.choose([*articles, both], per_topic=12)
    picked = chosen["Tâm lý và các mối quan hệ"] + chosen["Mạng xã hội và công nghệ"]
    assert len(picked) == len({a.id for a in picked})
    assert sum(a.source == "globalvoices" for a in chosen["Tâm lý và các mối quan hệ"]) == 2
    assert len(chosen["Tâm lý và các mối quan hệ"]) == 12


def test_a_pick_comes_before_the_long_papers_with_its_length(shared_catalog, tmp_path, monkeypatch):
    path = tmp_path / "catalog-picks.json"
    path.write_text(
        json.dumps(
            [
                {
                    "id": "p",
                    "title": "Short",
                    "topic": "Education",
                    "kind": "explainer",
                    "authors": "Cy",
                    "content": "One two three",
                }
            ]
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(catalog, "PICKS", path)
    catalog._load.cache_clear()
    listed = catalog.list_articles(q="", topic="", kind="", offset=0, limit=10)
    assert [a["id"] for a in listed["articles"]] == ["p", "a", "b"]
    assert listed["articles"][0]["word_count"] == 3
    assert catalog.get_article("p")["content"] == "One two three"


def test_the_written_picks_keep_to_the_rules():
    picks = json.loads(pick_explore.OUTPUT.read_text(encoding="utf-8"))
    papers = json.loads(OUTPUT.read_text(encoding="utf-8"))["articles"]
    assert len({a["id"] for a in picks}) == len(picks)
    assert not {a["url"] for a in picks} & {a["url"] for a in papers}
    for pick in picks:
        assert pick["topic"] in pick_explore.TOPICS, pick["title"]
        assert pick_explore.TOPICS[pick["topic"]][1].search(pick["title"]), pick["title"]
        assert pick_explore.MIN_WORDS <= word_count(pick["content"]) <= pick_explore.MAX_WORDS, pick["title"]
        assert pick["license"] and pick["license_url"] and pick["authors"], pick["title"]
        assert "We send two regular newsletters" not in pick["content"], pick["title"]
    quick = quick_reads.load()
    assert not {a["id"] for a in picks} & set(quick)


def test_an_article_is_cut_between_paragraphs_into_pieces():
    first, second = "a" * 2000, "b" * 2000
    assert article_translation.pieces(f"{first}\n\n{second}\n\nc") == [first, f"{second}\n\nc"]


@pytest.mark.parametrize(
    "translation",
    [
        "Chỉ một đoạn.",  # a paragraph was dropped
        "Có 50 người.\n\nHai 999.",  # a number was changed
        "Có 50 người.\n\n[Xem](https://elsewhere.example/x)",  # a link of its own
        "Có 50 người.\n\n![Xem](//elsewhere.example/x.png)",  # a picture of its own, without the scheme
    ],
)
def test_a_translation_that_changes_the_article_is_refused(translation):
    source = "There are 50 people.\n\n[See](https://source.example/x)"
    with pytest.raises(AIError):
        article_translation.check(translation, source)


def test_a_translation_that_loses_most_of_a_paragraph_is_refused():
    with pytest.raises(AIError):
        article_translation.check(
            "Ngắn.\n\nNgắn.", "A long first paragraph of text.\n\nA long second one, too."
        )


def test_a_translation_may_break_up_a_paragraph_the_source_ran_together():
    source = "Additional informationWhy these estimates might be conservative"
    assert article_translation.check("Thông tin bổ sung\n\nVì sao các ước tính này có thể thận trọng", source)


def test_a_translation_may_write_in_digits_what_vietnamese_does():
    source = "More than one in three, in June."
    assert article_translation.check("Hơn 1 trong 3, vào tháng 6.", source)
    with pytest.raises(AIError):
        article_translation.check("Hơn 1 trong 4, vào tháng 6.", source)


def test_a_translation_may_write_a_number_its_own_way_and_keep_the_links():
    source = "There are 2,798 people.\n\n[See](https://source.example/x)"
    assert article_translation.check("Có 2.798 người.\n\n[Xem](https://source.example/x)", source)


TRANSLATED = "Bản dịch."


@pytest.fixture
def translating(monkeypatch):
    calls: list[str] = []

    async def fake_chat(settings, messages, **kwargs):
        calls.append(messages[-1]["content"])
        return Completion(TRANSLATED, Usage())

    monkeypatch.setattr(article_translation, "chat", fake_chat)
    monkeypatch.setattr(get_settings(), "openai_api_key", "sk-test")
    return calls


def _licensed(monkeypatch, license: str):
    article = {**catalog.get_article("a"), "license": license, "language": "en"}
    article["keeps_translation"] = article_translation.may_keep(article)
    monkeypatch.setattr(catalog, "get_article", lambda _: article)


async def test_a_translation_that_may_be_kept_is_kept_and_anyone_can_read_it(
    client, auth, shared_catalog, translating, monkeypatch
):
    _licensed(monkeypatch, "CC BY 4.0")
    url = "/api/catalog/a/translation"
    assert (await client.get(url)).json() == {"text": None}
    assert (await client.post(url)).status_code == 401
    headers = auth()
    assert (
        await client.post(url, headers=headers)
    ).status_code == 403  # has not agreed to send content to OpenAI

    await consent(client, headers)
    stream = await client.post(url, headers=headers)
    assert TRANSLATED in stream.text and '"kept": true' in stream.text
    assert (await client.get(url)).json() == {"text": TRANSLATED}

    # A second reader costs nothing, and needs no agreement.
    await client.post(url, headers=auth(uuid.uuid4(), email="other@example.com"))
    assert len(translating) == 1
    async with SessionLocal() as s:
        row = await s.get(ContentTranslation, ("a", "vi", "article"))
        await s.delete(row)
        await s.commit()


async def test_a_translation_of_a_no_derivatives_article_is_never_kept(
    client, auth, shared_catalog, translating, monkeypatch
):
    _licensed(monkeypatch, "CC BY-ND 4.0")
    headers = auth()
    await consent(client, headers)
    url = "/api/catalog/a/translation"
    stream = await client.post(url, headers=headers)
    assert TRANSLATED in stream.text and '"kept": false' in stream.text
    assert (await client.get(url)).json() == {"text": None}
    async with SessionLocal() as s:
        assert await s.get(ContentTranslation, ("a", "vi", "article")) is None


async def test_a_long_paper_is_not_translated_here(client, auth, shared_catalog, translating, monkeypatch):
    article = {**catalog.get_article("a"), "word_count": 9000}
    monkeypatch.setattr(catalog, "get_article", lambda _: article)
    headers = auth()
    await consent(client, headers)
    assert (await client.post("/api/catalog/a/translation", headers=headers)).status_code == 422
    assert translating == []


async def test_a_failed_translation_says_so_and_keeps_nothing(client, auth, shared_catalog, monkeypatch):
    async def failing_chat(settings, messages, **kwargs):
        raise AIError("down")

    monkeypatch.setattr(article_translation, "chat", failing_chat)
    monkeypatch.setattr(get_settings(), "openai_api_key", "sk-test")
    _licensed(monkeypatch, "CC BY 4.0")
    headers = auth()
    await consent(client, headers)
    stream = await client.post("/api/catalog/a/translation", headers=headers)
    assert "event: error" in stream.text
    assert (await client.get("/api/catalog/a/translation")).json() == {"text": None}


def test_a_card_carries_its_vietnamese_and_search_finds_it(shared_catalog, tmp_path, monkeypatch):
    path = tmp_path / "catalog-vi.json"
    quick_reads.save({"b": {"title": "Việc học", "description": "Về trí nhớ."}}, path)
    monkeypatch.setattr(catalog, "VI", path)
    catalog._load.cache_clear()
    listed = catalog.list_articles(q="việc học", topic="", kind="", offset=0, limit=10)
    assert [a["id"] for a in listed["articles"]] == ["b"]
    assert listed["articles"][0]["vi"]["description"] == "Về trí nhớ."
