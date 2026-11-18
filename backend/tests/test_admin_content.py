from app.services import traffic
from tests.test_admin import _make_admin, _make_user


async def test_regular_user_cannot_reach_the_traffic(client, auth):
    _, h = await _make_user(client, auth)
    assert (await client.get("/api/admin/traffic", headers=h)).status_code == 403


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
