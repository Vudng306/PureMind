"""NFR-OBS-01: one parsable JSON line per request, with the id, the user and the timing."""

import json
import logging
import uuid

import pytest

from app.core.logging import JsonFormatter, request_id_var, user_id_var


@pytest.fixture
def lines(monkeypatch):
    """Capture what the access logger writes, formatted exactly as it is on stdout."""
    written: list[str] = []
    formatter = JsonFormatter()
    logger = logging.getLogger("app.request")

    class Collect(logging.Handler):
        def emit(self, record):
            written.append(formatter.format(record))

    handler = Collect()
    logger.addHandler(handler)
    monkeypatch.setattr(logger, "propagate", False)
    yield written
    logger.removeHandler(handler)


async def test_every_request_logs_one_json_line(client, lines):
    r = await client.get("/api/healthz")
    assert r.status_code == 200

    assert len(lines) == 1
    entry = json.loads(lines[0])  # fails loudly if the line is not valid JSON
    assert entry["level"] == "INFO"
    assert entry["method"] == "GET"
    assert entry["path"] == "/api/healthz"
    assert entry["endpoint"] == "/api/healthz"
    assert entry["status"] == 200
    assert entry["duration_ms"] >= 0
    assert entry["ts"].endswith("+00:00")
    assert entry["request_id"] == r.headers["X-Request-ID"]
    assert "user_id" not in entry  # nobody was authenticated


async def test_request_id_from_the_caller_is_kept(client, lines):
    given = uuid.uuid4().hex
    r = await client.get("/api/healthz", headers={"X-Request-ID": given})

    assert r.headers["X-Request-ID"] == given
    assert json.loads(lines[0])["request_id"] == given


async def test_authenticated_request_logs_the_user_and_the_route_template(client, auth, lines):
    user_id = uuid.uuid4()
    r = await client.get("/api/account", headers=auth(user_id))
    assert r.status_code == 200

    entry = json.loads(lines[0])
    assert entry["user_id"] == str(user_id)
    assert entry["endpoint"] == "/api/account"
    assert entry["status"] == 200


async def test_a_rejected_request_is_logged_with_its_status(client, lines):
    await client.get("/api/account")  # no token
    assert json.loads(lines[0])["status"] == 401


async def test_nothing_from_the_request_body_or_the_token_reaches_the_log(client, auth, lines):
    token = auth()["Authorization"]
    await client.patch("/api/account", headers={"Authorization": token}, json={"display_name": "Bí mật"})

    line = lines[0]
    assert "Bí mật" not in line
    assert token.split(" ")[1] not in line


def test_extra_fields_and_context_end_up_in_the_object():
    request_id_var.set("rid-1")
    user_id_var.set("uid-1")
    record = logging.LogRecord("app.ai", logging.INFO, "x.py", 1, "openai call ok", None, None)
    record.__dict__["prompt_tokens"] = 12

    entry = json.loads(JsonFormatter().format(record))
    assert entry["logger"] == "app.ai"
    assert entry["message"] == "openai call ok"
    assert entry["request_id"] == "rid-1"
    assert entry["user_id"] == "uid-1"
    assert entry["prompt_tokens"] == 12
