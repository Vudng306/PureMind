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

    # RD-104, RD-105: the face of the text and the page it is read on follow the account; null hands the
    # page back to the theme of the app.
    prefs = {"font_family": "sans", "reading_theme": "sepia"}
    r = await client.patch("/api/account", headers=h, json={"reading_preferences": prefs})
    assert r.status_code == 200 and r.json()["reading_preferences"] == {
        "theme": "sepia",
        "font_size": 20,
        **prefs,
    }
    r = await client.patch("/api/account", headers=h, json={"reading_preferences": {"reading_theme": None}})
    assert r.json()["reading_preferences"]["reading_theme"] is None
    for bad in ({"font_family": "comic"}, {"reading_theme": "neon"}):
        r = await client.patch("/api/account", headers=h, json={"reading_preferences": bad})
        assert r.status_code == 422, bad


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


async def test_terms_are_accepted_with_a_separate_ai_choice(client, auth):
    from app.models import TERMS_VERSION

    h = auth()
    me = (await client.get("/api/account", headers=h)).json()
    assert me["terms_accepted"] is False and "ai_consent" not in me["reading_preferences"]

    # The terms can be accepted without agreeing to OpenAI, and the choice changed later in the settings.
    r = await client.post("/api/account/terms", headers=h, json={"ai_consent": False})
    assert r.status_code == 200 and r.json()["terms_accepted"] is True
    assert r.json()["reading_preferences"]["ai_consent"] is False
    r = await client.post("/api/account/terms", headers=h, json={"ai_consent": True})
    assert r.json()["reading_preferences"]["ai_consent"] is True
    r = await client.patch("/api/account", headers=h, json={"reading_preferences": {"ai_consent": False}})
    assert r.json()["reading_preferences"]["ai_consent"] is False and r.json()["terms_accepted"] is True
    assert (await client.post("/api/account/terms", headers=h, json={})).status_code == 422

    # Accepted on the sign-up form: the profile starts with the terms and the choice the form recorded.
    meta = {"display_name": "Mới", "terms_version": TERMS_VERSION, "ai_consent": True}
    token = make_token(user_metadata=meta)
    me = (await client.get("/api/account", headers={"Authorization": f"Bearer {token}"})).json()
    assert me["terms_accepted"] is True and me["reading_preferences"]["ai_consent"] is True
    # An older version of the terms is asked again; no recorded choice means no consent.
    token = make_token(user_metadata={"terms_version": "2000-01-01", "ai_consent": True})
    me = (await client.get("/api/account", headers={"Authorization": f"Bearer {token}"})).json()
    assert me["terms_accepted"] is False and "ai_consent" not in me["reading_preferences"]
    token = make_token(user_metadata={"terms_version": TERMS_VERSION})
    me = (await client.get("/api/account", headers={"Authorization": f"Bearer {token}"})).json()
    assert me["terms_accepted"] is True and me["reading_preferences"]["ai_consent"] is False
