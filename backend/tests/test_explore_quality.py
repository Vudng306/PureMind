import json

import pytest

from app.core.config import get_settings
from app.services import discover, explore_quality, openai_client
from app.services.openai_client import AIError, Completion, Usage
from tests.test_epub_web import PAYWALLED, fake_web  # noqa: F401
from tests.test_explore import LONG, NAP, SLEEP, ask, explore_ai, page, pick  # noqa: F401
from tests.test_summaries import consent


@pytest.mark.parametrize("intent", ["DIRECT_QUERY", "AMBIGUOUS"])
async def test_non_discovery_never_searches_or_consumes_quota(client, auth, explore_ai, intent):  # noqa: F811
    headers = auth()
    await consent(client, headers)
    explore_ai.update(intent=intent, guidance="Bạn muốn tìm hiểu khía cạnh nào?")
    response = await ask(client, headers, query="Thời tiết hôm nay thế nào?")
    assert response.status_code == 200
    assert response.json()["intent"] == intent
    assert response.json()["guidance"]
    assert response.json()["documents"] == []
    assert response.json()["chat_quota_remaining"] == get_settings().chat_daily_quota
    assert not explore_ai["searches"] and not explore_ai["choices"]


async def test_verified_metadata_overrides_model_guesses(client, auth, explore_ai):  # noqa: F811
    headers = auth()
    await consent(client, headers)
    explore_ai["evidence"] = [
        explore_quality.Evidence(
            SLEEP, "Verified title", "Observed publisher", "", None, "METADATA_ONLY", "Description of memory."
        )
    ]
    explore_ai["choice"] = [pick(1, authors="Invented", year=2025, summary="Invented findings")]
    result = (await ask(client, headers)).json()["documents"][0]
    assert result["title"] == "Verified title"
    assert result["source"] == "Observed publisher"
    assert result["authors"] == result["summary"] == ""
    assert result["year"] is None and result["access"] == "METADATA_ONLY"


async def test_academic_requests_preserve_query_and_prioritize_research(client, auth, explore_ai):  # noqa: F811
    headers = auth()
    await consent(client, headers)
    explore_ai.update(document_type="academic", choice=[])
    query = "Tìm bài nghiên cứu tiếng Việt về thói quen đọc sách"
    assert (await ask(client, headers, query=query)).status_code == 200
    assert explore_ai["searches"][0]["input"].startswith(query)
    assert "original research" in explore_ai["searches"][0]["input"]


async def test_unverified_and_redirect_duplicates_are_removed(client, auth, explore_ai):  # noqa: F811
    headers = auth()
    await consent(client, headers)
    explore_ai["evidence"] = [explore_quality.Evidence(SLEEP), explore_quality.Evidence(NAP)]
    response = await ask(client, headers)
    assert response.json()["documents"] == [] and not explore_ai["choices"]
    explore_ai["evidence"] = [
        explore_quality.Evidence(SLEEP, "One", access="PARTIAL_CONTENT", text="Evidence"),
        explore_quality.Evidence(SLEEP + "/", "Duplicate", access="PARTIAL_CONTENT", text="Evidence"),
    ]
    explore_ai["choice"] = [pick(1), pick(2)]
    assert len((await ask(client, headers)).json()["documents"]) == 1


async def test_verification_access_states_and_ssrf(fake_web):  # noqa: F811
    fake_web.dns.update({"journal.example.org": ["93.184.216.34"], "private.example.org": ["10.0.0.1"]})
    fake_web.routes.update(
        {
            "journal.example.org/full": page(LONG),
            "journal.example.org/partial": page(
                b"<title>Excerpt</title><article>" + b"Evidence text. " * 30 + b"</article>"
            ),
            "journal.example.org/meta": page(
                b'<title>Identity</title><meta name="description" content="A description">'
            ),
            "journal.example.org/paywall": page(PAYWALLED),
            "journal.example.org/blocked": page(b"", 403),
            "journal.example.org/gone": page(b"", 500),
        }
    )
    paths = ["full", "partial", "meta", "paywall", "blocked", "gone"]
    candidates = [discover.Candidate(f"https://journal.example.org/{path}", path) for path in paths]
    candidates.append(discover.Candidate("https://private.example.org/a", "Private"))
    evidence = await explore_quality.verify(candidates)
    assert [item.access for item in evidence] == [
        "FULLTEXT_AVAILABLE",
        "PARTIAL_CONTENT",
        "METADATA_ONLY",
        "ACCESS_RESTRICTED",
        "ACCESS_RESTRICTED",
        "UNAVAILABLE",
        "ACCESS_RESTRICTED",
    ]
    assert evidence[0].text and evidence[1].text
    assert evidence[4].title == evidence[4].text == ""


@pytest.mark.parametrize(
    "payload",
    [
        "not json",
        json.dumps({"intent": "DISCOVERY"}),
        json.dumps({"intent": "DISCOVERY", "topic": "", "document_type": "general", "guidance": ""}),
    ],
)
async def test_invalid_classifier_fails_closed(monkeypatch, payload):
    async def chat(*args, **kwargs):
        return Completion(payload, Usage())

    monkeypatch.setattr(openai_client, "chat", chat)
    with pytest.raises(AIError):
        await explore_quality.classify(get_settings(), "sleep", "en", Usage())


def test_metadata_author_must_not_be_an_article_lead():
    html = LONG.replace(b"<head>", b'<head><meta name="author" content="Interviewer: how does this work?">')
    assert explore_quality.extract(html, SLEEP).authors == ""
    html = LONG.replace(b"<head>", b'<head><meta name="author" content="A. Researcher">')
    assert explore_quality.extract(html, SLEEP).authors == "A. Researcher"


def test_observed_publication_date_and_canonical_query_normalization():
    html = LONG.replace(
        b"<head>",
        b'<head><meta name="citation_publication_date" content="2022/09/15">'
        b'<link rel="canonical" href="https://journal.example.org/sleep-and-memory">',
    )
    result = explore_quality.extract(html, SLEEP + "?error=cookies&code=random")
    assert result.url == SLEEP and result.year == 2022
    # An unrelated canonical destination cannot replace the visited page.
    html = html.replace(SLEEP.encode(), b"https://unrelated.example.org/another")
    assert explore_quality.extract(html, SLEEP).url == SLEEP


async def test_direct_guidance_does_not_promise_live_lookup(monkeypatch):
    async def chat(*args, **kwargs):
        return Completion(
            json.dumps(
                {
                    "intent": "DIRECT_QUERY",
                    "topic": "weather",
                    "document_type": "general",
                    "guidance": "Tell me your city so I can check the weather",
                }
            ),
            Usage(),
        )

    monkeypatch.setattr(openai_client, "chat", chat)
    result = await explore_quality.classify(get_settings(), "weather today", "en", Usage())
    assert "city" not in result.guidance and "deeper reading" in result.guidance


def test_an_index_record_is_never_evidence_of_full_text():
    from tests.test_epub_web import SPAN, _record

    html = _record(600, SPAN).replace(b"<head>", b'<head><meta name="description" content="Downloadable!">')
    result = explore_quality.extract(html, "https://ideas.repec.org/a/x.html")
    # The ranking step may name it, but never summarize a 51-page paper from its abstract page.
    assert result.access == "ACCESS_RESTRICTED" and result.text == "Downloadable!"
    assert result.title == "Trust in AI-driven decision-making: a systematic literature review"
