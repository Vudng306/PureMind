import uuid
from unittest.mock import AsyncMock, patch

from sqlalchemy import update

from app.db.session import SessionLocal
from app.models import User
from tests.pdfs import text_pdf
from tests.test_documents import upload

BAN = "app.api.routes.admin.set_auth_user_banned"
DELETE = "app.api.routes.admin.delete_auth_user"


async def _make_admin(client, auth) -> dict:
    uid = uuid.uuid4()
    h = auth(uid, email=f"admin-{uid.hex[:8]}@example.com")
    assert (await client.get("/api/account", headers=h)).status_code == 200
    async with SessionLocal() as s:
        await s.execute(update(User).where(User.id == uid).values(role="admin"))
        await s.commit()
    return h


async def _make_user(client, auth, **kw) -> tuple[uuid.UUID, dict]:
    uid = uuid.uuid4()
    h = auth(uid, **kw)
    assert (await client.get("/api/account", headers=h)).status_code == 200
    return uid, h


async def test_regular_user_cannot_reach_admin_routes(client, auth):
    _, h = await _make_user(client, auth)
    assert (await client.get("/api/account", headers=h)).json()["role"] == "user"
    for method, path in [
        ("GET", "/api/admin/users"),
        ("GET", f"/api/admin/users/{uuid.uuid4()}"),
        ("POST", f"/api/admin/users/{uuid.uuid4()}/disable"),
        ("DELETE", f"/api/admin/users/{uuid.uuid4()}"),
        ("GET", "/api/admin/audit-log"),
    ]:
        r = await client.request(method, path, headers=h)
        assert r.status_code == 403, path
    assert (await client.get("/api/admin/users")).status_code == 401


async def test_list_search_and_detail_show_counts_not_content(client, auth):
    admin = await _make_admin(client, auth)
    uid, h = await _make_user(client, auth, email="lan.nguyen@example.com")
    doc = (await upload(client, h, text_pdf(2))).json()

    r = await client.get("/api/admin/users", headers=admin, params={"q": "LAN.NGUYEN"})
    assert r.status_code == 200
    body = r.json()
    assert body["total"] == 1
    item = body["items"][0]
    assert item["id"] == str(uid)
    assert item["document_count"] == 1
    assert item["storage_bytes"] > 0
    assert item["last_seen_at"] is not None

    r = await client.get(f"/api/admin/users/{uid}", headers=admin)
    assert r.status_code == 200
    detail = r.json()
    assert detail["documents_by_status"] == {"done": 1}
    assert detail["highlight_count"] == 0

    # NFR-PRV-01: nothing the user read or wrote leaves through the admin API.
    text = r.text + (await client.get("/api/admin/users", headers=admin)).text
    content = (await client.get(f"/api/documents/{doc['id']}", headers=h)).json()["content_clean"]
    assert content and content[:40] not in text
    assert doc["title"] not in text

    # `%` is a literal, not a wildcard.
    r = await client.get("/api/admin/users", headers=admin, params={"q": "%"})
    assert r.json()["total"] == 0


async def test_disable_blocks_requests_and_bans_login(client, auth):
    admin = await _make_admin(client, auth)
    uid, h = await _make_user(client, auth)

    with patch(BAN, new=AsyncMock()) as ban:
        r = await client.post(f"/api/admin/users/{uid}/disable", headers=admin)
    assert r.status_code == 200 and r.json()["disabled_at"]
    ban.assert_awaited_once()
    assert ban.await_args.args[1:] == (uid, True)

    r = await client.get("/api/account", headers=h)
    assert r.status_code == 403
    assert "khóa" in r.json()["detail"]

    with patch(BAN, new=AsyncMock()) as ban:
        r = await client.post(f"/api/admin/users/{uid}/enable", headers=admin)
    assert r.status_code == 200 and r.json()["disabled_at"] is None
    assert ban.await_args.args[1:] == (uid, False)
    assert (await client.get("/api/account", headers=h)).status_code == 200

    log = (await client.get("/api/admin/audit-log", headers=admin, params={"user_id": str(uid)})).json()
    assert [e["action"] for e in log["items"]] == ["user.enable", "user.disable"]


async def test_disable_keeps_account_open_when_supabase_fails(client, auth):
    from app.services.supabase_admin import SupabaseAdminError

    admin = await _make_admin(client, auth)
    uid, h = await _make_user(client, auth)
    with patch(BAN, new=AsyncMock(side_effect=SupabaseAdminError)):
        r = await client.post(f"/api/admin/users/{uid}/disable", headers=admin)
    assert r.status_code == 502
    assert (await client.get("/api/account", headers=h)).status_code == 200


async def test_admins_cannot_be_locked_or_deleted(client, auth):
    admin = await _make_admin(client, auth)
    me = (await client.get("/api/account", headers=admin)).json()["id"]
    with patch(BAN, new=AsyncMock()) as ban, patch(DELETE, new=AsyncMock()) as delete:
        assert (await client.post(f"/api/admin/users/{me}/disable", headers=admin)).status_code == 409
        assert (await client.delete(f"/api/admin/users/{me}", headers=admin)).status_code == 409
    ban.assert_not_awaited()
    delete.assert_not_awaited()


async def test_reset_quota(client, auth):
    from app.services.ai_quota import today_vn

    admin = await _make_admin(client, auth)
    uid, h = await _make_user(client, auth)
    async with SessionLocal() as s:
        await s.execute(
            update(User)
            .where(User.id == uid)
            .values(ai_quota_used=20, ai_quota_date=today_vn(), chat_quota_used=7, chat_quota_date=today_vn())
        )
        await s.commit()
    assert (await client.get("/api/account", headers=h)).json()["ai_quota_remaining"] == 0

    r = await client.post(f"/api/admin/users/{uid}/reset-quota", headers=admin)
    assert r.status_code == 200
    assert r.json()["ai_used_today"] == 0 and r.json()["chat_used_today"] == 0
    assert r.json()["recent_actions"][0]["detail"] == {"ai_used": 20, "chat_used": 7}
    assert (await client.get("/api/account", headers=h)).json()["ai_quota_remaining"] == 20


async def test_delete_user_removes_data_and_keeps_audit(client, auth):
    admin = await _make_admin(client, auth)
    uid, h = await _make_user(client, auth, email="bye@example.com")
    await upload(client, h, text_pdf(1))

    with patch(DELETE, new=AsyncMock()) as delete:
        r = await client.delete(f"/api/admin/users/{uid}", headers=admin)
    assert r.status_code == 204
    assert delete.await_args.args[1] == uid
    assert (await client.get(f"/api/admin/users/{uid}", headers=admin)).status_code == 404

    log = (await client.get("/api/admin/audit-log", headers=admin, params={"user_id": str(uid)})).json()
    assert log["items"][0]["action"] == "user.delete"
    assert log["items"][0]["target_email"] == "bye@example.com"
    assert log["items"][0]["detail"] == {"document_count": 1}


async def test_unknown_user_is_404(client, auth):
    admin = await _make_admin(client, auth)
    r = await client.post(f"/api/admin/users/{uuid.uuid4()}/reset-quota", headers=admin)
    assert r.status_code == 404


async def test_make_admin_script(client, auth):
    import pytest

    from app.scripts.make_admin import set_role

    _, h = await _make_user(client, auth, email="future.admin@example.com")
    assert "now an admin" in await set_role("Future.Admin@example.com", True)
    assert (await client.get("/api/admin/users", headers=h)).status_code == 200
    await set_role("future.admin@example.com", False)
    assert (await client.get("/api/admin/users", headers=h)).status_code == 403
    with pytest.raises(SystemExit):
        await set_role("nobody@example.com", True)
