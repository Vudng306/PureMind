import os
import shutil
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path

import jwt
import pytest

TMP = Path(tempfile.mkdtemp(prefix="puremind-test-"))
# By default the suite runs on a throwaway SQLite file. TEST_DATABASE_URL runs it on PostgreSQL instead, with
# the schema built by the migrations themselves; that database is wiped first, so its name must end in _test.
PG_URL = os.environ.get("TEST_DATABASE_URL")
if PG_URL and not PG_URL.rsplit("/", 1)[-1].split("?")[0].endswith("_test"):
    raise RuntimeError("TEST_DATABASE_URL must name a database of its own ending in _test: it is wiped")
os.environ.update(
    DATABASE_URL=PG_URL or f"sqlite+aiosqlite:///{(TMP / 'test.db').as_posix()}",
    SUPABASE_URL="https://test-project.supabase.co",
    SUPABASE_JWT_SECRET="test-secret-" + "x" * 40,
    SUPABASE_SERVICE_ROLE_KEY="service-role-test",
    UPLOAD_DIR=str(TMP / "uploads"),
    ENVIRONMENT="test",
    # Never the key from .env: a test that needs OpenAI sets a fake key and mocks the calls.
    OPENAI_API_KEY="",
)

import httpx  # noqa: E402
from sqlalchemy import event, text  # noqa: E402

from app.core.config import get_settings  # noqa: E402
from app.db.session import engine  # noqa: E402
from app.main import app  # noqa: E402
from app.models import Base  # noqa: E402

if not PG_URL:

    @event.listens_for(engine.sync_engine, "connect")
    def _sqlite_fk(dbapi_conn, _):
        dbapi_conn.execute("PRAGMA foreign_keys=ON")


@pytest.fixture(scope="session", autouse=True)
async def _schema():
    if PG_URL:
        async with engine.begin() as conn:
            await conn.execute(text("DROP SCHEMA public CASCADE"))
            await conn.execute(text("CREATE SCHEMA public"))
        await engine.dispose()
        backend = Path(__file__).resolve().parents[1]
        subprocess.run([sys.executable, "-m", "alembic", "upgrade", "head"], cwd=backend, check=True)
    else:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
    yield
    await engine.dispose()
    shutil.rmtree(TMP, ignore_errors=True)


def make_token(user_id: uuid.UUID | None = None, email: str | None = None, **overrides) -> str:
    settings = get_settings()
    user_id = user_id or uuid.uuid4()
    claims = {
        "sub": str(user_id),
        "email": email or f"{user_id.hex[:8]}@example.com",
        "aud": "authenticated",
        "iss": settings.supabase_issuer,
        "exp": int(time.time()) + 3600,
        "role": "authenticated",
        "user_metadata": {"display_name": "Người dùng thử"},
    }
    claims.update(overrides)
    return jwt.encode(claims, settings.supabase_jwt_secret, algorithm="HS256")


@pytest.fixture(autouse=True)
def _reset_rate_limits():
    from app.core.ratelimit import (
        explore_check_limiter,
        explore_search_limiter,
        translate_day_limiter,
        translate_minute_limiter,
        upload_limiter,
    )

    upload_limiter.reset()
    translate_minute_limiter.reset()
    translate_day_limiter.reset()
    explore_search_limiter.reset()
    explore_check_limiter.reset()


@pytest.fixture
async def client():
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


@pytest.fixture
def auth():
    def _auth(user_id: uuid.UUID | None = None, **kw):
        return {"Authorization": f"Bearer {make_token(user_id, **kw)}"}

    return _auth
