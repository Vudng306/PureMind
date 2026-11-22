import json

import httpx
import pytest

from app.core.config import get_settings
from app.core.messages import MSG
from app.services import discover, explore_quality, openai_client
from app.services.openai_client import AIError, Completion, Usage
from tests.pdfs import text_pdf
from tests.test_epub_web import ARTICLE, fake_web  # noqa: F401 — the fixture is used by name
from tests.test_summaries import consent

SLEEP = "https://journal.example.org/sleep-and-memory"
NAP = "https://www.health.example.com/naps/"
LONG = b"<html><head><title>Sleep and memory</title></head><body><article>%s</article></body></html>" % (
    b"<p>" + b"Sleep helps the brain keep what it learned during the day. " * 40 + b"</p>"
)


def cite(url: str, title: str, text: str, marker: str) -> dict:
    start = text.index(marker)
    return {
        "type": "url_citation",
        "url": url,
        "title": title,
        "start_index": start,
        "end_index": start + len(marker),
    }


def searched() -> dict:
    """What the Responses API answers after a web search: notes, with the pages they cite."""
    text = "1. Sleep and memory, 2019 (a) Covers consolidation.\n2. Naps (b) A short guide.\n3. A video (c)\nAgain (d)"
    return {
        "status": "completed",
        "output": [
            {"type": "web_search_call", "action": {"type": "search"}},
            {
                "type": "message",
                "content": [
                    {
                        "type": "output_text",
                        "text": text,
                        "annotations": [
                            cite(f"{SLEEP}?utm_source=openai", "Sleep  and memory", text, "(a)"),
                            cite(NAP, "", text, "(b)"),
                            cite("https://www.youtube.com/watch?v=1", "A video", text, "(c)"),
                            cite(f"{SLEEP}/", "Sleep and memory", text, "(d)"),
                            {"type": "file_citation", "url": "https://x.example/"},
                        ],
                    }
                ],
            },
        ],
        "usage": {"input_tokens": 900, "output_tokens": 80},
    }


def test_candidates_are_only_the_pages_the_search_cited():
    candidates, notes = discover.read_search(searched())
    # The tracking is gone, the video is not a document, and a page cited twice is one candidate.
    assert [(c.url, c.title) for c in candidates] == [
        (SLEEP, "Sleep and memory"),
        (NAP, "www.health.example.com"),
    ]
    assert (
        notes
        == "1. Sleep and memory, 2019 [1] Covers consolidation.\n2. Naps [2] A short guide.\n3. A video (c)\nAgain [1]"
    )
    assert discover.clean_url("javascript:alert(1)") is None
    # A site's name after the title goes; a dash inside a title stays.
    assert (
        discover.tidy_title("Giấc ngủ và trí nhớ | Vinmec", "https://www.vinmec.com/a")
        == "Giấc ngủ và trí nhớ"
    )
    assert discover.tidy_title(
        "Ngủ ít có giảm trí nhớ? - Báo VnExpress Sức khỏe", "https://vnexpress.net/a"
    ) == ("Ngủ ít có giảm trí nhớ?")
    assert discover.tidy_title("Sleep - a review", "https://journal.example.org/a") == "Sleep - a review"
    assert discover.tidy_title("", "https://journal.example.org/a") == "journal.example.org"
    assert discover.clean_url("https://m.facebook.com/page") is None


def test_the_choice_keeps_the_searchs_address_and_title():
    candidates = [discover.Candidate(SLEEP, "Sleep and memory"), discover.Candidate(NAP, "Naps")]
    row = {"source": "Journal", "authors": "", "year": 2019, "kind": "paper", "summary": "S.", "reason": "R."}
    text = json.dumps(
        {
            "documents": [
                {**row, "number": 2, "url": "https://invented.example/"},
                {**row, "number": 7},  # a number it was not given
                {**row, "number": 2},  # the same document again
                {**row, "number": 1, "year": 20190, "kind": "podcast"},
            ]
        }
    )
    found = discover.read_choice(text, candidates)
    assert [(f.url, f.title) for f in found] == [(NAP, "Naps"), (SLEEP, "Sleep and memory")]
    assert found[1].year is None and found[1].kind == "other"
    with pytest.raises(AIError):
        discover.read_choice("not json", candidates)
    # Never more than five, however many it names.
    many = [discover.Candidate(f"https://a.example/{n}", str(n)) for n in range(9)]
    text = json.dumps({"documents": [{**row, "number": n} for n in range(1, 10)]})
    assert len(discover.read_choice(text, many)) == 5


@pytest.fixture
def explore_ai(monkeypatch):
    """The two AI steps, faked: the search answers `searched()`, the choice answers what the test gives."""
    settings = get_settings()
    monkeypatch.setattr(settings, "openai_api_key", "sk-test")
    from app.api.routes import explore

    explore._searching.clear()
    state = {"searches": [], "choices": [], "search": searched(), "choice": None}

    async def responses(settings, body, purpose, usage):
        state["searches"].append(body)
        if isinstance(state["search"], Exception):
            raise state["search"]
        return state["search"]

    async def chat(settings, messages, **kw):
        if kw["purpose"] == "explore_intent":
            query = json.loads(messages[1]["content"])["query"]
            return Completion(
                json.dumps(
                    {
                        "intent": state.get("intent", "DISCOVERY"),
                        "topic": query,
                        "document_type": state.get("document_type", "general"),
                        "guidance": state.get("guidance", ""),
                    }
                ),
                Usage(100, 50),
            )
        state["choices"].append((messages, kw))
        if isinstance(state["choice"], Exception):
            raise state["choice"]
        return Completion(json.dumps({"documents": state["choice"]}), Usage(300, 90))

    async def verify(candidates, contact):
        return state.get(
            "evidence",
            [
                explore_quality.Evidence(
                    c.url,
                    c.title if c.url == SLEEP else "Naps",
                    "Journal of Sleep",
                    "A. Author" if c.url == SLEEP else "",
                    2019 if c.url == SLEEP else None,
                    "FULLTEXT_AVAILABLE",
                    "Sleep supports memory consolidation.",
                )
                for c in candidates
            ],
        )

    monkeypatch.setattr(discover, "_responses", responses)
    monkeypatch.setattr(explore_quality, "verify", verify)
    monkeypatch.setattr(openai_client, "chat", chat)
    return state


def pick(number: int, **over) -> dict:
    return {
        "number": number,
        "source": "Journal of Sleep",
        "authors": "A. Author",
        "year": 2019,
        "kind": "paper",
        "summary": "Bài tổng quan về giấc ngủ và trí nhớ.",
        "reason": "Trả lời đúng câu hỏi.",
        **over,
    }


async def ask(client, headers, query="Vì sao giấc ngủ giúp ta nhớ lâu hơn?", **body):
    return await client.post("/api/explore/search", headers=headers, json={"query": query, **body})


async def test_search_returns_the_chosen_documents(client, auth, explore_ai):
    h = auth()
    explore_ai["choice"] = [pick(2, authors="", year=None), pick(1)]

    assert (await client.post("/api/explore/search", json={"query": "sleep"})).status_code == 401
    # Nothing is sent before the user agrees (NFR-PRV).
    r = await ask(client, h)
    assert r.status_code == 403 and not explore_ai["searches"]
    await consent(client, h)
    assert (await ask(client, h, query="  a ")).status_code == 422

    r = await ask(client, h, language="vi")
    assert r.status_code == 200, r.text
    body = r.json()
    assert [d["url"] for d in body["documents"]] == [NAP, SLEEP]
    assert body["documents"][1] == {
        "url": SLEEP,
        "title": "Sleep and memory",
        "source": "Journal of Sleep",
        "authors": "A. Author",
        "year": 2019,
        "kind": "paper",
        "summary": "Bài tổng quan về giấc ngủ và trí nhớ.",
        "reason": "Trả lời đúng câu hỏi.",
        "document_id": None,
        "access": "FULLTEXT_AVAILABLE",
    }
    assert body["documents"][0]["authors"] == "" and body["documents"][0]["year"] is None
    assert body["chat_quota_remaining"] == get_settings().chat_daily_quota - 1

    # The search is a web search the model must make; the choice sees numbers and hosts, and is told the language.
    search = explore_ai["searches"][0]
    assert search["tools"] == [{"type": "web_search"}] and search["tool_choice"] == "required"
    assert search["input"] == "Vì sao giấc ngủ giúp ta nhớ lâu hơn?"
    messages, kw = explore_ai["choices"][0]
    assert "Vietnamese" in messages[0]["content"] and kw["json_schema"]["strict"] is True
    assert "[1] Sleep and memory (journal.example.org)" in messages[1]["content"]


async def test_nothing_found_and_failures_cost_no_question(client, auth, explore_ai):
    h = auth()
    await consent(client, h)
    quota = get_settings().chat_daily_quota

    # The search cited nothing: no second call, an empty list, no question spent.
    explore_ai["search"] = {"status": "completed", "output": [], "usage": {}}
    r = await ask(client, h)
    assert r.status_code == 200 and r.json() == {
        "documents": [],
        "chat_quota_remaining": quota,
        "intent": "DISCOVERY",
        "guidance": "",
    }
    assert not explore_ai["choices"]

    # The AI judged none of them good enough.
    explore_ai["search"], explore_ai["choice"] = searched(), []
    r = await ask(client, h)
    assert r.status_code == 200 and r.json() == {
        "documents": [],
        "chat_quota_remaining": quota,
        "intent": "DISCOVERY",
        "guidance": "",
    }

    explore_ai["choice"] = AIError("HTTP 500")
    r = await ask(client, h)
    assert r.status_code == 502 and r.json()["detail"] == MSG["MSG-26"]
    explore_ai["search"] = AIError("HTTP 500")
    assert (await ask(client, h)).status_code == 502

    explore_ai["search"], explore_ai["choice"] = searched(), [pick(1)]
    r = await ask(client, h)
    assert r.json()["chat_quota_remaining"] == quota - 1


async def test_search_limits(client, auth, explore_ai, monkeypatch):
    from app.core.ratelimit import explore_search_limiter

    h = auth()
    await consent(client, h)
    explore_ai["choice"] = [pick(1)]
    monkeypatch.setattr(explore_search_limiter, "limit", 1)
    assert (await ask(client, h)).status_code == 200
    r = await ask(client, h)
    assert r.status_code == 429 and r.json()["detail"] == MSG["MSG-EXPLORE-LIMIT"]

    monkeypatch.setattr(get_settings(), "chat_daily_quota", 1)
    r = await ask(client, h)
    assert r.status_code == 429 and r.json()["detail"] == MSG["MSG-CHAT-QUOTA"]

    monkeypatch.setattr(get_settings(), "openai_api_key", "")
    assert (await ask(client, h)).status_code == 503


async def check(client, headers, url):
    return await client.post("/api/explore/check", headers=headers, json={"url": url})


def page(body: bytes, status: int = 200, kind: str = "text/html; charset=utf-8") -> httpx.Response:
    return httpx.Response(status, headers={"content-type": kind}, content=body)


async def test_check_says_what_can_be_imported(client, auth, fake_web):  # noqa: F811
    h = auth()
    pdf = text_pdf()
    for host in ("journal.example.org", "files.example.org", "paywall.example.com", "shell.example.com"):
        fake_web.dns[host] = ["93.184.216.34"]
    fake_web.dns["intranet.example.com"] = ["10.0.0.5"]
    fake_web.routes.update(
        {
            "journal.example.org/sleep-and-memory": page(LONG),
            "files.example.org/report.pdf": page(pdf, kind="application/pdf"),
            "files.example.org/fake.pdf": page(b"<html>Sign in</html>", kind="application/pdf"),
            "paywall.example.com/story": page(b"", 403),
            "journal.example.org/broken": page(b"", 500),
            # A short page: a teaser. One names its PDF and hands it over, one names a PDF it keeps.
            "shell.example.com/teaser": page(ARTICLE),
            "shell.example.com/open": page(
                ARTICLE.replace(b"<head>", b'<head><meta name="citation_pdf_url" content="/open.pdf">')
            ),
            "shell.example.com/open.pdf": page(pdf, kind="application/pdf"),
            "shell.example.com/closed": page(
                ARTICLE.replace(b"<head>", b'<head><meta name="citation_pdf_url" content="/closed.pdf">')
            ),
            "shell.example.com/closed.pdf": page(b"", 403),
        }
    )
    assert (await client.post("/api/explore/check", json={"url": SLEEP})).status_code == 401
    assert (await check(client, h, "ftp://x.example/a")).status_code == 422

    r = await check(client, h, SLEEP)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "importable" and body["kind"] == "article" and body["import_url"] == SLEEP
    assert body["title"] == "Sleep and memory" and body["word_count"] >= discover.MIN_WORDS

    r = await check(client, h, "https://files.example.org/report.pdf")
    assert (r.json()["status"], r.json()["kind"]) == ("importable", "pdf")
    assert (await check(client, h, "https://files.example.org/fake.pdf")).json()["status"] == "blocked"

    # A site that refuses, and an address that is not public: not read, and nothing else is tried.
    assert (await check(client, h, "https://paywall.example.com/story")).json()["status"] == "blocked"
    assert (await check(client, h, "https://intranet.example.com/wiki")).json()["status"] == "blocked"
    # A server error or a host that does not answer may pass: worth asking again.
    assert (await check(client, h, "https://journal.example.org/broken")).json()["status"] == "failed"
    assert (await check(client, h, "https://gone.example.net/a")).json()["status"] == "failed"

    body = (await check(client, h, "https://shell.example.com/teaser")).json()
    assert body["status"] == "blocked" and body["pdf_url"] == "" and body["title"] == "Vi sao can doc cham"
    body = (await check(client, h, "https://shell.example.com/open")).json()
    assert body["status"] == "importable" and body["kind"] == "pdf"
    assert body["import_url"] == "https://shell.example.com/open.pdf"
    body = (await check(client, h, "https://shell.example.com/closed")).json()
    assert body["status"] == "blocked" and body["pdf_url"] == "https://shell.example.com/closed.pdf"


async def test_check_saves_nothing_and_knows_the_readers_copy(client, auth, fake_web, explore_ai):  # noqa: F811
    h = auth()
    fake_web.dns["journal.example.org"] = ["93.184.216.34"]
    fake_web.routes["journal.example.org/sleep-and-memory"] = page(LONG)

    assert (await check(client, h, SLEEP)).json()["document_id"] is None
    assert (await client.get("/api/documents", headers=h)).json() == []

    # The reader adds it with the library's own "save a link"; from then on Explore points at the copy.
    saved = await client.post("/api/documents/save-url", headers=h, json={"url": SLEEP})
    assert saved.status_code == 201, saved.text
    visits = len(fake_web.requests)
    body = (await check(client, h, SLEEP)).json()
    assert body["status"] == "importable" and body["document_id"] == saved.json()["id"]
    assert len(fake_web.requests) == visits  # no second visit for what is saved already

    await consent(client, h)
    explore_ai["choice"] = [pick(1), pick(2)]
    found = (await ask(client, h)).json()["documents"]
    assert [d["document_id"] for d in found] == [saved.json()["id"], None]
    # Someone else's copy is not this reader's.
    assert (await check(client, auth(), SLEEP)).json()["document_id"] is None


async def test_check_does_not_call_a_subscribers_page_importable(client, auth, fake_web):  # noqa: F811
    from tests.test_epub_web import PAYWALLED

    h = auth()
    fake_web.dns["journal.example.com"] = ["93.184.216.34"]
    named = PAYWALLED.replace(
        b"<head>", b'<head><meta name="citation_pdf_url" content="/articles/closed.pdf">'
    )
    fake_web.routes.update(
        {
            "journal.example.com/articles/closed": page(named),
            # Asked for the PDF, the publisher sends its sign-in page.
            "journal.example.com/articles/closed.pdf": page(b"<html>Sign in</html>"),
        }
    )
    body = (await check(client, h, "https://journal.example.com/articles/closed")).json()
    # Hundreds of words on the page, but they are a preview and references: not something to import.
    assert body["status"] == "blocked" and body["import_url"] == ""
    assert body["pdf_url"] == "https://journal.example.com/articles/closed.pdf"


async def test_check_calls_a_bot_check_blocked_not_worth_retrying(client, auth, fake_web):  # noqa: F811
    h = auth()
    fake_web.dns["papers.example.org"] = ["93.184.216.34"]
    challenge = httpx.Response(
        202, headers={"content-type": "text/html", "x-amzn-waf-action": "challenge"}, content=LONG
    )
    fake_web.routes.update(
        {"papers.example.org/document/1": page(b"", 420), "papers.example.org/document/2": challenge}
    )
    for n in (1, 2):
        body = (await check(client, h, f"https://papers.example.org/document/{n}")).json()
        # "failed" would offer to check again, which gets the same answer.
        assert body["status"] == "blocked" and body["import_url"] == "", body
