import json

import pytest
from sqlalchemy import select

from app.core.config import get_settings
from app.db.session import SessionLocal
from app.models import User
from app.services import openai_client
from app.services.openai_client import AIError, Completion, Usage
from tests.test_summaries import consent, new_doc


@pytest.fixture
def study_ai(monkeypatch):
    monkeypatch.setattr(get_settings(), "openai_api_key", "test")

    def install(kind="quiz", bad=False):
        async def fake(settings, messages, **kwargs):
            if bad:
                raise AIError("offline")
            source = messages[-1]["content"].strip().splitlines()[0][:100]
            return Completion(
                json.dumps(
                    {
                        "items": [
                            {
                                "question": f"Question {i}",
                                "answer": "Explanation",
                                "options": ["A", "B", "C", "D"] if kind == "quiz" else [],
                                "correct": i,
                                "source": source,
                            }
                            for i in range(3)
                        ]
                    }
                ),
                Usage(),
            )

        monkeypatch.setattr(openai_client, "chat", fake)

    return install


async def test_quiz_grading_history_isolation_and_delete(client, auth, study_ai):
    h = auth()
    doc = await new_doc(client, h)
    await consent(client, h)
    study_ai()
    r = await client.post("/api/study", headers=h, json={"document_id": doc, "kind": "quiz", "count": 3})
    assert r.status_code == 201, r.text
    data = r.json()
    sid = data["id"]
    assert "correct" not in data["items"][0] and "answer" not in data["items"][0]
    assert len((await client.get("/api/study", headers=h)).json()) == 1
    other = auth()
    assert (await client.get(f"/api/study/{sid}/attempts", headers=other)).status_code == 404
    assert (await client.delete(f"/api/study/{sid}", headers=other)).status_code == 404
    assert (
        await client.post(f"/api/study/{sid}/attempts", headers=h, json={"answers": [0, 1, 4]})
    ).status_code == 422
    r = await client.post(f"/api/study/{sid}/attempts", headers=h, json={"answers": [0, 1, 0]})
    assert r.status_code == 201, r.text
    assert r.json()["score"] == 2
    assert r.json()["items"][2]["correct"] == 2
    assert len((await client.get(f"/api/study/{sid}/attempts", headers=h)).json()) == 1
    assert (await client.delete(f"/api/study/{sid}", headers=h)).status_code == 204
    assert (await client.get(f"/api/study/{sid}/attempts", headers=h)).status_code == 404


async def test_consent_failure_quota_and_document_ownership(client, auth, study_ai):
    h = auth()
    doc = await new_doc(client, h)
    body = {"document_id": doc, "kind": "quiz", "count": 3}
    study_ai()
    assert (await client.post("/api/study", headers=h, json=body)).status_code == 403
    await consent(client, h)
    assert (await client.post("/api/study", headers=auth(), json=body)).status_code == 404
    study_ai(bad=True)
    assert (await client.post("/api/study", headers=h, json=body)).status_code == 502
    async with SessionLocal() as session:
        user = await session.scalar(
            select(User).where(User.id.in_(select(User.id))).order_by(User.created_at.desc())
        )
        # Failed generation creates no sets; successful generation below spends exactly one credit.
        assert user is not None
    assert (await client.get("/api/study", headers=h)).json() == []
    study_ai()
    assert (await client.post("/api/study", headers=h, json=body)).status_code == 201
    account = (await client.get("/api/account", headers=h)).json()
    assert account["ai_quota_remaining"] == get_settings().ai_daily_quota - 1


async def test_flashcard_requires_highlights_and_saves_schedule(client, auth, study_ai):
    h = auth()
    doc = await new_doc(client, h)
    await consent(client, h)
    study_ai("flashcards")
    body = {"document_id": doc, "kind": "flashcards", "count": 3}
    assert (await client.post("/api/study", headers=h, json=body)).status_code == 422
    r = await client.post(
        f"/api/documents/{doc}/highlights",
        headers=h,
        json={"selected_text": "A highlighted source about learning.", "color": "yellow", "page_number": 1},
    )
    assert r.status_code == 201, r.text
    r = await client.post("/api/study", headers=h, json=body)
    assert r.status_code == 201, r.text
    sid = r.json()["id"]
    assert r.json()["items"][0]["answer"] == "Explanation"
    assert (
        await client.post(f"/api/study/{sid}/review", headers=auth(), json={"index": 0, "remembered": True})
    ).status_code == 404
    r = await client.post(f"/api/study/{sid}/review", headers=h, json={"index": 0, "remembered": True})
    assert r.status_code == 200, r.text
    assert r.json()["progress"]["0"]["interval"] == 1
    r = await client.post(f"/api/study/{sid}/review", headers=h, json={"index": 0, "remembered": True})
    assert r.json()["progress"]["0"]["interval"] == 2
    r = await client.post(f"/api/study/{sid}/review", headers=h, json={"index": 0, "remembered": False})
    assert r.json()["progress"]["0"]["interval"] == 0
