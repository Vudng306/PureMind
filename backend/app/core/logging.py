"""Structured JSON logs (NFR-OBS-01).

Every line is one JSON object on stdout with the time, the request id, the user id, the endpoint, the
status code and the duration, so a log collector can parse it without regexes. Request and user ids travel
through context variables, so any `log.info(...)` inside a request carries them without being passed around.

Never log request bodies, tokens or document content (NFR-PRV-01, NFR-SEC-08).
"""

import json
import logging
import sys
import uuid
from collections.abc import MutableMapping
from contextvars import ContextVar
from datetime import UTC, datetime

request_id_var: ContextVar[str | None] = ContextVar("request_id", default=None)
user_id_var: ContextVar[str | None] = ContextVar("user_id", default=None)

# Attributes every LogRecord carries; anything else came from `extra=` and belongs in the JSON object.
_STANDARD = frozenset(logging.LogRecord("", 0, "", 0, "", None, None).__dict__) | {
    "message",
    "asctime",
    "taskName",
}


def new_request_id() -> str:
    return uuid.uuid4().hex


USER_ID_SCOPE_KEY = "pm_user_id"


def bind_user(scope: MutableMapping, user_id: object) -> None:
    """Called once the token is verified, so the rest of the request logs under that user.

    The value also goes into the ASGI scope: BaseHTTPMiddleware runs the endpoint in its own task, so a
    context variable set there never reaches the access log, while the scope is the same object.
    """
    value = str(user_id)
    user_id_var.set(value)
    scope[USER_ID_SCOPE_KEY] = value


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload: dict = {
            "ts": datetime.fromtimestamp(record.created, UTC).isoformat(timespec="milliseconds"),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
        }
        if request_id := request_id_var.get():
            payload["request_id"] = request_id
        if user_id := user_id_var.get():
            payload["user_id"] = user_id
        payload.update({k: v for k, v in record.__dict__.items() if k not in _STANDARD})
        if record.exc_info:
            payload["exception"] = self.formatException(record.exc_info)
        return json.dumps(payload, ensure_ascii=False, default=str)


def configure(level: str = "INFO") -> None:
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter())
    root = logging.getLogger()
    root.handlers = [handler]
    root.setLevel(level.upper())
    # Uvicorn's own access line would duplicate ours, in a format nothing can parse.
    access = logging.getLogger("uvicorn.access")
    access.handlers = []
    access.propagate = False
