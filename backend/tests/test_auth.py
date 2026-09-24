import time
import uuid

import pytest

from tests.conftest import make_token


async def test_healthz_is_public(client):
    r = await client.get("/api/healthz")
    assert r.status_code == 200 and r.json() == {"status": "ok"}


async def test_missing_token_is_401(client):
    r = await client.get("/api/account")
    assert r.status_code == 401
    assert "hết hạn" in r.json()["detail"]


async def test_first_request_provisions_profile(client, auth):
    uid = uuid.uuid4()
    r = await client.get("/api/account", headers=auth(uid, email="Minh@Example.com"))
    assert r.status_code == 200
    body = r.json()
    assert body["id"] == str(uid)
    assert body["email"] == "minh@example.com"
    assert body["display_name"] == "Người dùng thử"
    assert body["reading_preferences"] == {}

    again = await client.get("/api/account", headers=auth(uid, email="minh@example.com"))
    assert again.json()["created_at"][:26] == body["created_at"][:26]


async def test_rejects_expired_wrong_audience_and_bad_signature(client):
    uid = uuid.uuid4()
    expired = make_token(uid, exp=int(time.time()) - 120)
    wrong_aud = make_token(uid, aud="anon")
    wrong_iss = make_token(uid, iss="https://evil.supabase.co/auth/v1")
    tampered = make_token(uid)[:-4] + "abcd"
    for token in (expired, wrong_aud, wrong_iss, tampered, "not-a-jwt"):
        r = await client.get("/api/account", headers={"Authorization": f"Bearer {token}"})
        assert r.status_code == 401, token


async def test_small_clock_drift_is_tolerated(client):
    # Supabase's clock a few seconds ahead of ours: a token issued "in the future" is still fresh.
    now = int(time.time())
    for token in (make_token(iat=now + 5, nbf=now + 5), make_token(exp=now - 5)):
        r = await client.get("/api/account", headers={"Authorization": f"Bearer {token}"})
        assert r.status_code == 200, r.text


async def test_update_profile_and_preferences(client, auth):
    h = auth()
    r = await client.patch("/api/account", headers=h, json={"display_name": "  Lan  "})
    assert r.status_code == 200 and r.json()["display_name"] == "Lan"

    r = await client.patch("/api/account", headers=h, json={"display_name": "   "})
    assert r.status_code == 422
    assert r.json()["detail"] == "Họ tên không được để trống và tối đa 255 ký tự."

    r = await client.patch("/api/account", headers=h, json={"reading_preferences": {"theme": "sepia"}})
    r = await client.patch("/api/account", headers=h, json={"reading_preferences": {"font_size": 20}})
    assert r.json()["reading_preferences"] == {"theme": "sepia", "font_size": 20}

    r = await client.patch("/api/account", headers=h, json={"reading_preferences": {"font_size": 40}})
    assert r.status_code == 422


def test_settings_parse_comma_separated_cors(monkeypatch):
    from app.core.config import Settings

    monkeypatch.setenv("CORS_ORIGINS", "http://localhost:3000, https://puremind.example")
    assert Settings().cors_origins == ["http://localhost:3000", "https://puremind.example"]
    monkeypatch.setenv("CORS_ORIGINS", '["http://a.example"]')
    assert Settings().cors_origins == ["http://a.example"]


@pytest.mark.parametrize(
    ("header", "expected"),
    [
        (None, "vi"),
        ("en", "en"),
        ("en-GB,en;q=0.9", "en"),
        ("vi-VN,vi;q=0.9,en;q=0.8", "vi"),
        ("fr-FR", "vi"),  # a language PureMind does not speak falls back to Vietnamese
    ],
)
def test_accept_language_is_read(header, expected):
    from app.core.messages import parse_language

    assert parse_language(header) == expected


async def test_errors_come_back_in_the_language_asked_for(client, auth):
    h = auth()
    body = {"display_name": "   "}
    r = await client.patch("/api/account", headers=h, json=body)
    assert r.json()["detail"] == "Họ tên không được để trống và tối đa 255 ký tự."

    r = await client.patch("/api/account", headers={**h, "Accept-Language": "en"}, json=body)
    assert r.json()["detail"] == "A display name is required and can be at most 255 characters."

    # Back to Vietnamese on the next request: the language is per request, not a server-wide setting.
    r = await client.patch("/api/account", headers=h, json=body)
    assert r.json()["detail"] == "Họ tên không được để trống và tối đa 255 ký tự."


async def test_interface_language_is_kept_with_the_account(client, auth):
    h = auth()
    r = await client.patch("/api/account", headers=h, json={"reading_preferences": {"language": "en"}})
    assert r.status_code == 200 and r.json()["reading_preferences"]["language"] == "en"

    r = await client.patch("/api/account", headers=h, json={"reading_preferences": {"language": "de"}})
    assert r.status_code == 422


def test_every_message_is_translated():
    from app.core.messages import EN, VI

    assert set(VI) == set(EN)
