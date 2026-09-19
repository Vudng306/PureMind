import os
import shutil
import tempfile
import time
import uuid
from pathlib import Path

import jwt
import pytest

TMP = Path(tempfile.mkdtemp(prefix="puremind-test-"))
os.environ.update(
    DATABASE_URL=f"sqlite+aiosqlite:///{(TMP / 'test.db').as_posix()}",
    SUPABASE_URL="https://test-project.supabase.co",
    SUPABASE_JWT_SECRET="test-secret-" + "x" * 40,
    SUPABASE_SERVICE_ROLE_KEY="service-role-test",
    UPLOAD_DIR=str(TMP / "uploads"),
    ENVIRONMENT="test",
)

import httpx  # noqa: E402
from sqlalchemy import event  # noqa: E402

from app.core.config import get_settings  # noqa: E402
from app.db.session import engine  # noqa: E402
from app.main import app  # noqa: E402
from app.models import Base  # noqa: E402


@event.listens_for(engine.sync_engine, "connect")
def _sqlite_fk(dbapi_conn, _):
    dbapi_conn.execute("PRAGMA foreign_keys=ON")


@pytest.fixture(scope="session", autouse=True)
async def _schema():
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
    from app.core.ratelimit import upload_limiter

    upload_limiter.reset()


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
