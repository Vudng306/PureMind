"""Reader v2 phase 4 (P1): research analysis, saving a translation, explaining a selection, time left."""

import uuid

import pytest
from sqlalchemy import func, select

from app.core.config import get_settings
from app.db.session import SessionLocal
from app.models import AiArtifact
from app.services import doc_chat, reader_ai, translator
from app.services.doc_chat import Chunk
from tests.pdfs import text_pdf
from tests.test_chat import ask, chat_ai, start  # noqa: F401  (chat_ai is a fixture)
from tests.test_reader_notebook import DEEP, ai  # noqa: F401  (ai is a fixture)
from tests.test_summaries import consent, new_doc

ANALYSIS = {
    "document_type": "research",
    "question": [{"text": "Học máy giúp gì cho việc học?", "sources": [1]}],
    "method": [{"text": "Một thí nghiệm hai nhóm.", "sources": [2]}],
    "data": [],
    "findings": [{"text": "Nhóm thử nghiệm nhớ tốt hơn.", "sources": [3, 2]}],
    "limitations": [],
    "applicability": [],
}
ESSAY = {**{name: [] for name in reader_ai.ANALYSIS_FIELDS}, "document_type": "essay"}


def chunk(position: int, text: str) -> Chunk:
    return Chunk(position, None, None, text, 10)


# --- Research analysis (AI-111) ------------------------------------------------------------------------------


def test_analysis_keeps_only_what_the_document_reports():
    chunks = [chunk(i, f"passage {i}") for i in range(1, 4)]
    parsed = reader_ai.parse_analysis(reader_ai.json.dumps(ANALYSIS), chunks)
    assert parsed["document_type"] == "research"
    assert parsed["data"] == [] and parsed["limitations"] == []  # not reported stays empty, never filled
    assert [p["sources"] for p in parsed["findings"]] == [[3, 2]]
    assert [c["text"] for c in parsed["citations"]] == ["passage 1", "passage 2", "passage 3"]
    assert "score" not in reader_ai.json.dumps(reader_ai.SCHEMAS["analysis"])  # TSD 6.5: no 0-100 rating

    with pytest.raises(reader_ai.NotResearch):
        reader_ai.parse_analysis(reader_ai.json.dumps(ESSAY), chunks)
    with pytest.raises(ValueError):  # a study with nothing in it is not an analysis
        reader_ai.parse_analysis(reader_ai.json.dumps({**ESSAY, "document_type": "report"}), chunks)


async def test_research_analysis_is_made_for_a_study(client, auth, ai):  # noqa: F811
    h = auth()
    doc = await new_doc(client, h, text_pdf(3))
    await consent(client, h)
    fake = ai(ANALYSIS)
    r = await client.post(f"/api/documents/{doc}/ai/analysis", headers=h)
    assert r.status_code == 201, r.text
    made = r.json()
    assert made["kind"] == "analysis" and made["payload"]["method"][0]["text"] == "Một thí nghiệm hai nhóm."
    assert fake.calls[-1]["purpose"] == "reader_analysis"
    assert "never fill it from general knowledge" in fake.calls[-1]["messages"][1]["content"]
    assert (await client.get(f"/api/documents/{doc}/ai/analysis", headers=h)).json()["id"] == made["id"]

    # One field, or the whole of it, kept as a note with its headings and citations.
    one = await client.post(
        "/api/notes/from-ai",
        headers=h,
        json={"source": "artifact", "source_id": made["id"], "part": "findings:0"},
    )
    assert one.status_code == 201 and one.json()["body"] == "Nhóm thử nghiệm nhớ tốt hơn. [3][2]"
    assert one.json()["provenance"]["source"] == "analysis"
    whole = await client.post(
        "/api/notes/from-ai", headers=h, json={"source": "artifact", "source_id": made["id"], "part": "all"}
    )
    body = whole.json()["body"]
    assert body.startswith("Research question\n- ") and "Sample and data" not in body  # empty fields left out

    # Found by the global search, as the other results are.
    found = (await client.get("/api/search?q=thí nghiệm hai nhóm", headers=h)).json()["summaries"]
    assert found["total"] == 1


async def test_an_essay_gets_no_research_analysis(client, auth, ai):  # noqa: F811
    h = auth()
    doc = await new_doc(client, h, text_pdf(3))
    await consent(client, h)
    quota = get_settings().ai_daily_quota

    # The model finds it is an essay: nothing stored, no quota used.
    ai(ESSAY)
    r = await client.post(f"/api/documents/{doc}/ai/analysis", headers=h)
    assert r.status_code == 422 and "nghiên cứu" in r.json()["detail"]
    me = (await client.get("/api/account", headers=h)).json()
    assert me["ai_quota_remaining"] == quota

    # A deep summary that already found an essay keeps it from being asked for at all.
    ai({**DEEP, "document_type": "essay"})
    assert (await client.post(f"/api/documents/{doc}/ai/deep", headers=h)).status_code == 201
    fake = ai(ANALYSIS)
    r = await client.post(f"/api/documents/{doc}/ai/analysis", headers=h)
    assert r.status_code == 422 and not fake.calls
    async with SessionLocal() as session:
        mine = select(AiArtifact.kind).where(AiArtifact.document_id == uuid.UUID(doc))
        kinds = (await session.scalars(mine)).all()
    assert "analysis" not in kinds


async def test_a_short_document_is_not_analysed(client, auth, ai):  # noqa: F811
    h = auth()
    doc = await new_doc(client, h, text_pdf(2))
    await consent(client, h)
    fake = ai(ANALYSIS)
    r = await client.post(f"/api/documents/{doc}/ai/analysis", headers=h)
    assert r.status_code == 422 and not fake.calls


# --- Translation kept as a note (AN-107) ---------------------------------------------------------------------


async def test_translation_is_kept_beside_the_original(client, auth):
    h, other = auth(), auth()
    doc = await new_doc(client, h, text_pdf(2))
    body = {
        "quote": "Machine learning is a field of study.",
        "translation": "Học máy là một ngành học.",
        "target": "vi",
    }

    r = await client.post(f"/api/documents/{doc}/notes/translation", headers=h, json=body)
    assert r.status_code == 201, r.text
    note = r.json()
    assert note["origin"] == "ai_saved" and note["body"] == "Học máy là một ngành học."
    p = note["provenance"]
    assert p["source"] == "translation" and p["quote"] == body["quote"] and p["language"] == "vi"
    assert p["source_id"] is None and p["citations"] == []

    # Saved twice: the note already there. The document's own text is untouched.
    again = await client.post(f"/api/documents/{doc}/notes/translation", headers=h, json=body)
    assert again.status_code == 200 and again.json()["id"] == note["id"]
    content = (await client.get(f"/api/documents/{doc}", headers=h)).json()["content_clean"]
    assert "Học máy là một ngành học" not in content

    # Someone else's document looks like a missing one; an empty translation is refused.
    assert (
        await client.post(f"/api/documents/{doc}/notes/translation", headers=other, json=body)
    ).status_code == 404
    blank = {**body, "translation": "   "}
    assert (
        await client.post(f"/api/documents/{doc}/notes/translation", headers=h, json=blank)
    ).status_code == 422


def test_translation_goes_both_ways():
    assert translator.direction("Machine learning is a field of study.") == ("en", "vi")
    assert translator.direction("Học máy là một lĩnh vực nghiên cứu.") == ("vi", "en")
    messages = translator.build_messages("Học máy", "vi", "en")
    assert "from Vietnamese into natural, accurate English" in messages[0]["content"]


# --- Explain a selection (AI-110) ----------------------------------------------------------------------------


def test_the_selection_is_found_with_its_neighbours():
    chunks = [chunk(i, f"Paragraph {i}: **topic** number {i} of the text.") for i in range(1, 8)]
    near = doc_chat.around_quote(chunks, "topic number 4 of the")
    assert [c.position for c in near] == [3, 4, 5]
    assert doc_chat.around_quote(chunks, "not in the document") == []
    merged = doc_chat.merge_passages(near, [chunks[0], chunks[3], chunks[6]], 5)
    assert [c.position for c in merged] == [1, 3, 4, 5, 7]  # reading order, no passage twice
    assert [c.position for c in doc_chat.merge_passages(near, chunks, 4)] == [1, 3, 4, 5]


async def test_explaining_a_selection_reads_the_passages_around_it(client, auth, chat_ai, monkeypatch):  # noqa: F811
    h = auth()
    monkeypatch.setattr(get_settings(), "chat_context_chunks", 4)
    _, answer = chat_ai("Đoạn này nói về chương 9 [2].")
    doc, conv = await start(client, h, text_pdf(12))
    r = await ask(
        client, h, doc, conv, "Giải thích đoạn này", quote="Machine learning is a field of study, page 9."
    )
    assert r.status_code == 200, r.text
    passages = answer.passages
    assert "page 9." in passages and "page 8." in passages and "page 10." in passages
    assert "not the document's claim" in passages
    async with SessionLocal() as session:
        mine = select(func.count()).select_from(AiArtifact).where(AiArtifact.document_id == uuid.UUID(doc))
        assert await session.scalar(mine) == 0


# --- Time left (RD-112) --------------------------------------------------------------------------------------


async def test_time_left_can_be_turned_off(client, auth):
    h = auth()
    r = await client.patch("/api/account", headers=h, json={"reading_preferences": {"time_left": False}})
    assert r.status_code == 200 and r.json()["reading_preferences"]["time_left"] is False
