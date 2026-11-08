"""Publish flow and community: privacy, licences, moderation and the audit log."""

import json
import uuid

import pytest
from sqlalchemy import delete, select, update

from app.core.config import get_settings
from app.db.session import SessionLocal
from app.main import app
from app.models import AdminAuditLog, Document, Notebook, Post, User
from app.services import openai_client, post_checks
from app.services.openai_client import AIError, Completion, Usage
from tests import test_highlights
from tests.test_admin import _make_admin, _make_user

CARDS = [
    {"heading": "Một", "body": "Điều thứ nhất tôi rút ra."},
    {"heading": "Hai", "body": "Điều thứ hai tôi rút ra."},
    {"heading": "Ba", "body": "Điều thứ ba tôi rút ra."},
]
SECRET = "SECRET-PRIVATE-TEXT"


async def new_doc(client, h) -> dict:
    doc_id = await test_highlights.new_doc(client, h)
    return (await client.get(f"/api/documents/{doc_id}", headers=h)).json()


async def create(client, h, doc: dict, **kw):
    return await test_highlights.create(client, h, doc["id"], **kw)


@pytest.fixture(autouse=True)
async def _no_posts_from_other_tests():
    async with SessionLocal() as s:
        await s.execute(delete(Post))
        await s.commit()


async def set_doc(doc_id: str, **values) -> None:
    async with SessionLocal() as s:
        await s.execute(update(Document).where(Document.id == uuid.UUID(doc_id)).values(**values))
        await s.commit()


async def draft(client, h, doc=None, *, kind="insight", **fields) -> dict:
    doc = doc or await new_doc(client, h)
    r = await client.post("/api/posts", headers=h, json={"document_id": doc["id"], "kind": kind})
    assert r.status_code == 201, r.text
    post = r.json()
    body = {"title": "Bài của tôi", "cards": CARDS, "topic": "science", **fields}
    r = await client.patch(f"/api/posts/{post['id']}", headers=h, json=body)
    assert r.status_code == 200, r.text
    return r.json()


async def publish(client, h, post_id: str, **kw) -> None:
    r = await client.post(f"/api/posts/{post_id}/publish", headers=h, json={"confirm_rights": True, **kw})
    assert r.status_code == 200, r.text


async def published(client, h, doc=None, **fields) -> dict:
    post = await draft(client, h, doc, **fields)
    await publish(client, h, post["id"])
    return post


async def test_uploading_a_document_makes_nothing_public(client, auth):
    h = auth()
    doc = await new_doc(client, h)
    await create(client, h, doc)
    assert (await client.get("/api/community", headers=auth())).json()["items"] == []
    assert (await client.get(f"/api/community/{doc['id']}", headers=auth())).status_code == 404


async def test_a_draft_stays_private_until_published_and_after_unpublishing(client, auth):
    h, reader = auth(), auth()
    post = await draft(client, h)
    assert (await client.get(f"/api/community/{post['id']}", headers=reader)).status_code == 404
    assert (await client.get(f"/api/posts/{post['id']}", headers=reader)).status_code == 404
    assert (await client.patch(f"/api/posts/{post['id']}", headers=reader, json={"title": "x"})).status_code == 404
    assert (await client.delete(f"/api/posts/{post['id']}", headers=reader)).status_code == 404
    r = await client.post(f"/api/posts/{post['id']}/publish", headers=reader, json={"confirm_rights": True})
    assert r.status_code == 404

    await publish(client, h, post["id"])
    seen = (await client.get(f"/api/community/{post['id']}", headers=reader)).json()
    assert seen["title"] == "Bài của tôi"
    assert seen["mine"] is False

    # A published post is not edited in place.
    assert (await client.patch(f"/api/posts/{post['id']}", headers=h, json={"title": "x"})).status_code == 409
    assert (await client.post(f"/api/posts/{post['id']}/unpublish", headers=h)).status_code == 200
    assert (await client.get(f"/api/community/{post['id']}", headers=reader)).status_code == 404
    assert (await client.get("/api/community", headers=reader)).json()["items"] == []
    assert (await client.patch(f"/api/posts/{post['id']}", headers=h, json={"title": "Sửa"})).status_code == 200


async def test_the_community_needs_a_signed_in_reader(client, auth):
    assert (await client.get("/api/community")).status_code == 401


async def test_a_public_post_never_shows_email_private_sources_or_the_document(client, auth):
    uid = uuid.uuid4()
    h = auth(uid, email="rieng.tu@example.com")
    doc = await new_doc(client, h)  # an upload: no address, so unnamed by default
    await set_doc(doc["id"], title=f"{SECRET} title", content_clean=f"{SECRET} body", note=SECRET)
    post = await draft(client, h, doc)
    assert post["sources"][0]["shown"] is False
    await publish(client, h, post["id"])

    for path in (f"/api/community/{post['id']}", "/api/community"):
        raw = (await client.get(path, headers=auth())).text
        assert SECRET not in raw
        assert "rieng.tu@example.com" not in raw
        assert "file_storage_path" not in raw
    seen = (await client.get(f"/api/community/{post['id']}", headers=auth())).json()
    assert seen["sources"] == []


async def test_an_author_with_no_name_is_not_named_by_email(client, auth):
    uid = uuid.uuid4()
    h = auth(uid, email="khong.ten@example.com")
    assert (await client.get("/api/account", headers=h)).status_code == 200
    async with SessionLocal() as s:
        await s.execute(update(User).where(User.id == uid).values(display_name=None))
        await s.commit()
    post = await published(client, h)
    seen = (await client.get(f"/api/community/{post['id']}", headers=auth())).json()
    assert seen["author"] == {"name": ""}


async def test_a_named_source_is_public_only_when_the_author_chooses(client, auth):
    h = auth()
    doc = await new_doc(client, h)
    post = await draft(client, h, doc)
    source = post["sources"][0]
    r = await client.patch(f"/api/posts/{post['id']}", headers=h, json={"shown_source_ids": [source["id"]]})
    assert r.json()["sources"][0]["shown"] is True
    await publish(client, h, post["id"])
    seen = (await client.get(f"/api/community/{post['id']}", headers=auth())).json()
    assert [s["title"] for s in seen["sources"]] == [doc["title"]]


@pytest.mark.parametrize(
    ("fields", "code"),
    [
        ({"title": ""}, "CHECK-TITLE"),
        ({"topic": None}, "CHECK-TOPIC"),
        ({"cards": CARDS[:2]}, "CHECK-CARD-COUNT"),
        ({"cards": CARDS * 3 + CARDS[:1]}, None),  # 10 cards is refused when saved
        ({"cards": [*CARDS[:2], {"heading": "x", "body": " "}]}, "CHECK-CARD-EMPTY"),
    ],
)
async def test_checks_stop_an_unfinished_post(client, auth, fields, code):
    h = auth()
    doc = await new_doc(client, h)
    post = (await client.post("/api/posts", headers=h, json={"document_id": doc["id"]})).json()
    r = await client.patch(
        f"/api/posts/{post['id']}", headers=h, json={"title": "T", "cards": CARDS, "topic": "science", **fields}
    )
    if code is None:
        assert r.status_code == 422
        return
    check = (await client.get(f"/api/posts/{post['id']}/check", headers=h)).json()
    assert code in [i["code"] for i in check["issues"]]
    assert check["can_publish"] is False
    r = await client.post(f"/api/posts/{post['id']}/publish", headers=h, json={"confirm_rights": True})
    assert r.status_code == 422


async def test_publishing_needs_the_rights_confirmation(client, auth):
    h = auth()
    post = await draft(client, h)
    r = await client.post(f"/api/posts/{post['id']}/publish", headers=h, json={"confirm_rights": False})
    assert r.status_code == 422
    assert (await client.get(f"/api/community/{post['id']}", headers=auth())).status_code == 404


async def nd_doc(client, h) -> dict:
    doc = await new_doc(client, h)
    await set_doc(
        doc["id"], license="CC BY-ND 4.0", url="https://theconversation.com/a-" + uuid.uuid4().hex, title="Bài ND"
    )
    return doc


async def test_a_summary_of_a_cc_by_nd_source_cannot_be_published(client, auth):
    h = auth()
    post = await draft(client, h, await nd_doc(client, h), kind="summary")
    check = (await client.get(f"/api/posts/{post['id']}/check", headers=h)).json()
    assert "CHECK-SUMMARY-ND" in [i["code"] for i in check["issues"]]
    r = await client.post(f"/api/posts/{post['id']}/publish", headers=h, json={"confirm_rights": True})
    assert r.status_code == 422


async def test_an_insight_on_a_cc_by_nd_source_is_allowed_in_ones_own_words(client, auth):
    h = auth()
    post = await draft(client, h, await nd_doc(client, h), kind="insight")
    check = (await client.get(f"/api/posts/{post['id']}/check", headers=h)).json()
    assert [(i["code"], i["level"]) for i in check["issues"]] == [("CHECK-ND-SOURCE", "warning")]
    await publish(client, h, post["id"])


async def test_a_cc_by_nd_source_cannot_be_copied_verbatim(client, auth):
    h = auth()
    original = " ".join(f"từ{i}" for i in range(200))
    doc = await nd_doc(client, h)
    await set_doc(doc["id"], content_clean=original)
    copied = " ".join(f"từ{i}" for i in range(50, 110))
    post = await draft(client, h, doc, cards=[*CARDS[:2], {"heading": "", "body": copied}])
    check = (await client.get(f"/api/posts/{post['id']}/check", headers=h)).json()
    assert "CHECK-OVERLAP-ND" in [i["code"] for i in check["issues"]]
    r = await client.post(f"/api/posts/{post['id']}/publish", headers=h, json={"confirm_rights": True})
    assert r.status_code == 422


async def test_copying_from_an_upload_warns_but_the_author_decides(client, auth):
    h = auth()
    doc = await new_doc(client, h)
    original = " ".join(f"chữ{i}" for i in range(100))
    await set_doc(doc["id"], content_clean=original)
    post = await draft(client, h, doc, cards=[*CARDS[:2], {"heading": "", "body": original}])
    check = (await client.get(f"/api/posts/{post['id']}/check", headers=h)).json()
    assert [(i["code"], i["level"]) for i in check["issues"]] == [("CHECK-OVERLAP", "warning")]
    assert check["can_publish"] is True


def test_longest_overlap_counts_consecutive_words():
    source = " ".join(f"w{i}" for i in range(100))
    assert post_checks.longest_overlap(" ".join(f"w{i}" for i in range(10, 65)), source) == 55
    assert post_checks.longest_overlap(" ".join(f"w{i}" for i in range(10, 45)), source) == 0
    assert post_checks.longest_overlap("hoàn toàn khác", source) == 0
    # Case and punctuation do not hide a copy.
    copied = ", ".join(f"W{i}" for i in range(40))
    assert post_checks.longest_overlap(copied, source) == 40


async def test_an_openly_licensed_source_must_be_credited(client, auth):
    h = auth()
    doc = await new_doc(client, h)
    await set_doc(doc["id"], license="CC BY 4.0", url="https://example.org/" + uuid.uuid4().hex)
    post = await draft(client, h, doc)
    assert post["sources"][0]["shown"] is True
    r = await client.patch(f"/api/posts/{post['id']}", headers=h, json={"shown_source_ids": []})
    assert r.status_code == 200
    check = (await client.get(f"/api/posts/{post['id']}/check", headers=h)).json()
    assert "CHECK-CREDIT-REQUIRED" in [i["code"] for i in check["issues"]]


async def test_sharing_the_original_is_a_link_never_the_file(client, auth):
    h = auth()
    upload = await new_doc(client, h)
    r = await client.post("/api/posts", headers=h, json={"document_id": upload["id"], "kind": "link"})
    assert r.status_code == 422

    doc = await nd_doc(client, h)  # a link to a CC BY-ND article is fine
    r = await client.post("/api/posts", headers=h, json={"document_id": doc["id"], "kind": "link"})
    assert r.status_code == 201
    post = r.json()
    assert len(post["cards"]) == 1
    r = await client.patch(
        f"/api/posts/{post['id']}",
        headers=h,
        json={"title": "Nên đọc", "topic": "science", "cards": [{"heading": "", "body": "Vì bài này rõ ràng."}]},
    )
    assert r.status_code == 200
    await publish(client, h, post["id"])
    seen = (await client.get(f"/api/community/{post['id']}", headers=auth())).json()
    assert seen["sources"][0]["url"].startswith("https://theconversation.com/")
    assert seen["kind"] == "link"
    # Sharing is not a route to the file: someone else still cannot open it.
    assert (await client.get(f"/api/documents/{doc['id']}/file", headers=auth())).status_code == 404
    assert (await client.get(f"/api/documents/{doc['id']}", headers=auth())).status_code == 404


async def test_a_post_starts_from_exactly_one_thing_of_ones_own(client, auth):
    h = auth()
    doc = await new_doc(client, h)
    nb = (await client.post("/api/notebooks", headers=h, json={"title": "Sổ"})).json()
    assert (await client.post("/api/posts", headers=h, json={})).status_code == 422
    r = await client.post("/api/posts", headers=h, json={"document_id": doc["id"], "notebook_id": nb["id"]})
    assert r.status_code == 422
    assert (await client.post("/api/posts", headers=auth(), json={"document_id": doc["id"]})).status_code == 404
    assert (await client.post("/api/posts", headers=auth(), json={"notebook_id": nb["id"]})).status_code == 404


async def test_a_post_from_a_notebook_keeps_its_sources_and_deleting_it_keeps_the_notebook(client, auth):
    h = auth()
    doc = await new_doc(client, h)
    nb = (await client.post("/api/notebooks", headers=h, json={"title": "Sổ", "document_id": doc["id"]})).json()
    post = (await client.post("/api/posts", headers=h, json={"notebook_id": nb["id"]})).json()
    assert post["notebook_id"] == nb["id"]
    assert [s["document_id"] for s in post["sources"]] == [doc["id"]]
    assert post["ai_assisted"] is False
    assert (await client.delete(f"/api/posts/{post['id']}", headers=h)).status_code == 204
    assert (await client.get(f"/api/notebooks/{nb['id']}", headers=h)).status_code == 200


async def test_a_post_from_an_ai_notebook_needs_a_human_read(client, auth):
    h = auth()
    doc = await new_doc(client, h)
    nb = (await client.post("/api/notebooks", headers=h, json={"title": "Sổ", "document_id": doc["id"]})).json()
    async with SessionLocal() as s:
        await s.execute(update(Notebook).where(Notebook.id == uuid.UUID(nb["id"])).values(ai_model="gpt"))
        await s.commit()
    post = (await client.post("/api/posts", headers=h, json={"notebook_id": nb["id"]})).json()
    assert post["ai_assisted"] is True
    await client.patch(
        f"/api/posts/{post['id']}", headers=h, json={"title": "T", "cards": CARDS, "topic": "science"}
    )
    r = await client.post(f"/api/posts/{post['id']}/publish", headers=h, json={"confirm_rights": True})
    assert r.status_code == 422
    await publish(client, h, post["id"], confirm_reviewed=True)
    seen = (await client.get(f"/api/community/{post['id']}", headers=auth())).json()
    assert seen["ai_assisted"] is True


async def test_an_ai_notebook_on_a_cc_by_nd_source_cannot_become_a_post(client, auth):
    h = auth()
    doc = await nd_doc(client, h)
    nb = (await client.post("/api/notebooks", headers=h, json={"title": "Sổ", "document_id": doc["id"]})).json()
    async with SessionLocal() as s:
        await s.execute(update(Notebook).where(Notebook.id == uuid.UUID(nb["id"])).values(ai_model="gpt"))
        await s.commit()
    post = (await client.post("/api/posts", headers=h, json={"notebook_id": nb["id"]})).json()
    await client.patch(
        f"/api/posts/{post['id']}", headers=h, json={"title": "T", "cards": CARDS, "topic": "science"}
    )
    check = (await client.get(f"/api/posts/{post['id']}/check", headers=h)).json()
    assert "CHECK-AI-ND" in [i["code"] for i in check["issues"]]


@pytest.fixture
def ai(monkeypatch):
    """A consented OpenAI that answers with a valid draft, and counts how often it was asked."""
    settings = get_settings()
    monkeypatch.setattr(settings, "openai_api_key", "test-key", raising=False)
    calls = []

    async def fake(_settings, messages, **kw):
        calls.append({"messages": messages, **kw})
        cards = [{"heading": f"Thẻ {i}", "body": f"Nội dung {i}"} for i in range(3)]
        return Completion(text=json.dumps({"title": "Nháp AI", "cards": cards}), usage=Usage())

    monkeypatch.setattr(openai_client, "chat", fake)
    monkeypatch.setattr("app.services.post_writer.chat", fake)
    return calls


async def consent(client, h) -> None:
    r = await client.patch("/api/account", headers=h, json={"reading_preferences": {"ai_consent": True}})
    assert r.status_code == 200


async def test_ai_draft_refuses_cc_by_nd_and_asks_openai_nothing(client, auth, ai):
    h = auth()
    await consent(client, h)
    doc = await nd_doc(client, h)
    await create(client, h, doc)
    post = await draft(client, h, doc)
    r = await client.post(f"/api/posts/{post['id']}/draft", headers=h)
    assert r.status_code == 422
    assert ai == []


async def test_ai_draft_needs_consent(client, auth, ai):
    h = auth()
    doc = await new_doc(client, h)
    await create(client, h, doc)
    post = await draft(client, h, doc)
    assert (await client.post(f"/api/posts/{post['id']}/draft", headers=h)).status_code == 403
    assert ai == []


async def test_ai_draft_reads_only_the_authors_marks_never_the_whole_document(client, auth, ai):
    h = auth()
    await consent(client, h)
    doc = await new_doc(client, h)
    await set_doc(doc["id"], content_clean=f"{SECRET} whole document")
    await create(client, h, doc)
    post = await draft(client, h, doc)
    r = await client.post(f"/api/posts/{post['id']}/draft", headers=h)
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["ai_assisted"] is True
    assert out["title"] == "Nháp AI"
    assert out["status"] == "draft"  # it does not publish itself
    assert len(ai) == 1
    assert SECRET not in json.dumps(ai[0]["messages"], ensure_ascii=False)
    r = await client.post(f"/api/posts/{post['id']}/publish", headers=h, json={"confirm_rights": True})
    assert r.status_code == 422  # the human read is still needed


async def test_ai_draft_with_nothing_to_read_spends_nothing(client, auth, ai):
    h = auth()
    await consent(client, h)
    post = await draft(client, h)
    assert (await client.post(f"/api/posts/{post['id']}/draft", headers=h)).status_code == 422
    assert ai == []


async def test_a_failed_ai_draft_uses_no_quota(client, auth, ai, monkeypatch):
    uid = uuid.uuid4()
    h = auth(uid)
    await consent(client, h)
    doc = await new_doc(client, h)
    await create(client, h, doc)
    post = await draft(client, h, doc)

    async def broken(*_a, **_k):
        raise AIError("down")

    monkeypatch.setattr("app.services.post_writer.chat", broken)
    assert (await client.post(f"/api/posts/{post['id']}/draft", headers=h)).status_code == 502
    async with SessionLocal() as s:
        assert (await s.get(User, uid)).ai_quota_used == 0


async def test_feed_is_newest_first_filters_by_topic_and_pages(client, auth):
    h = auth()
    first = await published(client, h, topic="science")
    second = await published(client, h, topic="health")
    items = (await client.get("/api/community", headers=h)).json()
    assert [i["id"] for i in items["items"]] == [second["id"], first["id"]]
    assert items["items"][0]["mine"] is True
    only = (await client.get("/api/community", headers=h, params={"topic": "science"})).json()
    assert [i["id"] for i in only["items"]] == [first["id"]]
    page = (await client.get("/api/community", headers=h, params={"limit": 1})).json()
    assert page["has_more"] is True


async def test_readers_save_and_unsave(client, auth):
    h, reader = auth(), auth()
    post = await published(client, h)
    assert (await client.post(f"/api/community/{post['id']}/save", headers=reader)).status_code == 204
    assert (await client.post(f"/api/community/{post['id']}/save", headers=reader)).status_code == 204
    assert (await client.get(f"/api/community/{post['id']}", headers=reader)).json()["saved"] is True
    assert [p["id"] for p in (await client.get("/api/community/saved", headers=reader)).json()] == [post["id"]]
    assert (await client.delete(f"/api/community/{post['id']}/save", headers=reader)).status_code == 204
    assert (await client.get("/api/community/saved", headers=reader)).json() == []


async def test_comments_are_public_flat_and_removable_by_their_author(client, auth):
    h, reader = auth(), auth()
    post = await published(client, h)
    path = f"/api/community/{post['id']}/comments"
    assert (await client.post(path, headers=reader, json={"body": "   "})).status_code == 422
    assert (await client.post(path, headers=reader, json={"body": "x" * 1001})).status_code == 422
    r = await client.post(path, headers=reader, json={"body": "Bài hay"})
    assert r.status_code == 201
    comment = r.json()
    assert comment["mine"] is True
    listed = (await client.get(path, headers=h)).json()
    assert [(c["body"], c["mine"]) for c in listed] == [("Bài hay", False)]
    assert (await client.get(f"/api/community/{post['id']}", headers=h)).json()["comment_count"] == 1
    assert (await client.delete(f"/api/community/comments/{comment['id']}", headers=h)).status_code == 404
    assert (await client.delete(f"/api/community/comments/{comment['id']}", headers=reader)).status_code == 204
    assert (await client.get(path, headers=h)).json() == []


async def test_nothing_can_be_done_with_a_draft_as_a_reader(client, auth):
    h, reader = auth(), auth()
    post = await draft(client, h)
    base = f"/api/community/{post['id']}"
    assert (await client.post(f"{base}/save", headers=reader)).status_code == 404
    assert (await client.post(f"{base}/report", headers=reader, json={"reason": "spam"})).status_code == 404
    assert (await client.get(f"{base}/comments", headers=reader)).status_code == 404
    assert (await client.post(f"{base}/comments", headers=reader, json={"body": "x"})).status_code == 404


async def test_admin_sees_only_public_text_and_never_the_private_side(client, auth):
    admin = await _make_admin(client, auth)
    uid, h = await _make_user(client, auth, email="tacgia@example.com")
    doc = await new_doc(client, h)
    await set_doc(doc["id"], title=f"{SECRET} title", content_clean=f"{SECRET} body", note=SECRET)
    await create(client, h, doc)
    nb = (await client.post("/api/notebooks", headers=h, json={"title": SECRET})).json()
    await client.patch(f"/api/notebooks/{nb['id']}", headers=h, json={"content": SECRET})
    unpublished = await draft(client, h, doc, title=f"{SECRET} draft")
    post = await published(client, h, doc)

    r = await client.get("/api/admin/posts", headers=admin)
    assert r.status_code == 200
    raw = r.text
    assert SECRET not in raw  # no document, notebook, draft or unnamed source
    assert "tacgia@example.com" not in raw
    assert [i["id"] for i in r.json()["items"]] == [post["id"]]
    assert r.json()["items"][0]["sources"] == []
    assert unpublished["id"] not in raw
    # Nor can a draft be acted on.
    assert (await client.post(f"/api/admin/posts/{unpublished['id']}/hide", headers=admin)).status_code == 404
    assert uid


async def test_non_admins_cannot_moderate(client, auth):
    h = auth()
    post = await published(client, h)
    for method, path in [
        ("GET", "/api/admin/posts"),
        ("POST", f"/api/admin/posts/{post['id']}/hide"),
        ("POST", f"/api/admin/posts/{post['id']}/show"),
        ("DELETE", f"/api/admin/posts/{post['id']}"),
        ("GET", "/api/admin/comments"),
        ("POST", f"/api/admin/comments/{uuid.uuid4()}/hide"),
    ]:
        assert (await client.request(method, path, headers=h)).status_code == 403, path


async def test_reports_reach_the_admin_as_counts_and_a_hide_is_audited_without_text(client, auth):
    admin = await _make_admin(client, auth)
    h, reader = auth(), auth()
    post = await published(client, h)
    r = await client.post(f"/api/community/{post['id']}/report", headers=reader, json={"reason": "free text"})
    assert r.status_code == 422
    for reason in ("spam", "copyright"):  # the latest reason stands
        r = await client.post(f"/api/community/{post['id']}/report", headers=reader, json={"reason": reason})
        assert r.status_code == 204
    reported = (await client.get("/api/admin/posts", headers=admin, params={"state": "reported"})).json()
    assert reported["items"][0]["reports"] == {"copyright": 1}

    assert (await client.post(f"/api/admin/posts/{post['id']}/hide", headers=admin)).status_code == 204
    assert (await client.get(f"/api/community/{post['id']}", headers=reader)).status_code == 404
    assert (await client.get("/api/community", headers=reader)).json()["items"] == []
    mine = (await client.get(f"/api/posts/{post['id']}", headers=h)).json()
    assert mine["hidden"] is True  # the author is told

    # Hiding is not undone by the author, who can still delete.
    assert (await client.post(f"/api/posts/{post['id']}/unpublish", headers=h)).status_code == 409
    r = await client.post(f"/api/posts/{post['id']}/publish", headers=h, json={"confirm_rights": True})
    assert r.status_code == 409

    assert (await client.post(f"/api/admin/posts/{post['id']}/show", headers=admin)).status_code == 204
    assert (await client.get(f"/api/community/{post['id']}", headers=reader)).status_code == 200

    assert (await client.delete(f"/api/admin/posts/{post['id']}", headers=admin)).status_code == 204
    assert (await client.get(f"/api/posts/{post['id']}", headers=h)).status_code == 404

    async with SessionLocal() as s:
        logs = (
            await s.scalars(
                select(AdminAuditLog).where(AdminAuditLog.action.in_(("post.hide", "post.show", "post.delete")))
            )
        ).all()
    assert {log.action for log in logs} == {"post.hide", "post.show", "post.delete"}
    assert all(set(log.detail) == {"post_id"} and log.detail["post_id"] == post["id"] for log in logs)
    # Whose post it was, as for account actions: the log has to answer who was acted on.
    assert all(log.target_user_id and log.target_email for log in logs)


async def test_comment_moderation_is_audited_without_text(client, auth):
    admin = await _make_admin(client, auth)
    h, reader = auth(), auth()
    post = await published(client, h)
    comment = (
        await client.post(f"/api/community/{post['id']}/comments", headers=reader, json={"body": "Nội dung xấu"})
    ).json()
    r = await client.post(f"/api/community/comments/{comment['id']}/report", headers=h, json={"reason": "offensive"})
    assert r.status_code == 204
    listed = (await client.get("/api/admin/comments", headers=admin)).json()
    assert listed[0]["reports"] == {"offensive": 1}
    assert (await client.post(f"/api/admin/comments/{comment['id']}/hide", headers=admin)).status_code == 204
    assert (await client.get(f"/api/community/{post['id']}/comments", headers=h)).json() == []
    assert (await client.get(f"/api/community/{post['id']}", headers=h)).json()["comment_count"] == 0
    assert (await client.post(f"/api/admin/comments/{comment['id']}/show", headers=admin)).status_code == 204
    assert len((await client.get(f"/api/community/{post['id']}/comments", headers=h)).json()) == 1
    async with SessionLocal() as s:
        logs = (await s.scalars(select(AdminAuditLog).where(AdminAuditLog.action.like("comment.%")))).all()
    assert logs
    assert all("Nội dung xấu" not in json.dumps(log.detail, ensure_ascii=False) for log in logs)


async def test_a_locked_authors_posts_and_comments_leave_the_community(client, auth):
    admin = await _make_admin(client, auth)
    uid, h = await _make_user(client, auth)
    reader = auth()
    post = await published(client, h)
    other = await published(client, reader)
    await client.post(f"/api/community/{other['id']}/comments", headers=h, json={"body": "Của người bị khóa"})
    async with SessionLocal() as s:
        await s.execute(update(User).where(User.id == uid).values(disabled_at=await _now()))
        await s.commit()
    assert (await client.get(f"/api/community/{post['id']}", headers=reader)).status_code == 404
    assert (await client.get(f"/api/community/{other['id']}/comments", headers=reader)).json() == []
    assert admin


async def _now():
    from app.models import utcnow

    return utcnow()


async def test_deleting_an_account_takes_its_posts(client, auth):
    uid, h = await _make_user(client, auth)
    post = await published(client, h)
    async with SessionLocal() as s:
        user = await s.get(User, uid)
        await s.delete(user)
        await s.commit()
    assert (await client.get(f"/api/community/{post['id']}", headers=auth())).status_code == 404


def test_ai_draft_is_counted_as_an_ai_call():
    from app.services.traffic import AI_ENDPOINTS

    assert ("POST", "/api/posts/{post_id}/draft") in AI_ENDPOINTS
    assert "/api/posts/{post_id}/draft" in app.openapi()["paths"]
