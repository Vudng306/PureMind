import json
from functools import lru_cache
from pathlib import Path
from typing import Annotated

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict

# Paths are anchored to backend/, whatever the working directory (uvicorn may be started from the repo root).
BACKEND_DIR = Path(__file__).resolve().parents[2]
ENV_FILE = BACKEND_DIR / ".env"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=ENV_FILE, env_file_encoding="utf-8", extra="ignore")

    environment: str = "development"
    log_level: str = "INFO"  # NFR-OBS-01; logs are always JSON on stdout.
    database_url: str = "postgresql+asyncpg://puremind:puremind@localhost:5432/puremind"
    # Comma-separated in env files (e.g. "http://a,http://b"); NoDecode skips JSON parsing.
    cors_origins: Annotated[list[str], NoDecode] = Field(default_factory=lambda: ["http://localhost:3000"])

    # Supabase Auth (SRS CON-08)
    supabase_url: str = ""
    supabase_jwt_secret: str = ""  # only for projects still signing tokens with HS256
    supabase_service_role_key: str = ""
    supabase_jwt_audience: str = "authenticated"

    upload_dir: Path = Path("uploads")  # relative to backend/
    max_upload_bytes: int = 50 * 1024 * 1024  # CON-05
    max_avatar_bytes: int = 2 * 1024 * 1024
    async_extraction_threshold_bytes: int = 10 * 1024 * 1024  # FR-DOC-02 step 6

    # AI (FR-SUM, FR-NB). The key stays on the server (NFR-SEC-01); the model is configurable (NFR-MNT-03).
    openai_api_key: str = ""
    openai_model: str = "gpt-4.1-mini"
    openai_base_url: str = "https://api.openai.com/v1"
    openai_timeout_seconds: float = 90
    ai_daily_quota: int = 20  # BR: 20 AI requests per user per day, reset at 00:00 Vietnam time
    summary_single_request_tokens: int = 100_000  # FR-SUM-01 step 3
    summary_chunk_tokens: int = 8_000

    # Save-by-link (FR-DOC-03): a URL or e-mail put in the User-Agent so sites can reach the operator.
    # Some sites (e.g. Wikipedia) refuse crawlers without one. Empty = the first CORS origin (the app's URL).
    web_fetch_contact: str = ""

    @property
    def web_contact(self) -> str:
        return self.web_fetch_contact.strip() or (self.cors_origins[0] if self.cors_origins else "")

    @field_validator("upload_dir", mode="after")
    @classmethod
    def anchor_upload_dir(cls, v: Path) -> Path:
        return v if v.is_absolute() else BACKEND_DIR / v

    @field_validator("cors_origins", mode="before")
    @classmethod
    def split_origins(cls, v):
        if isinstance(v, str):
            if v.strip().startswith("["):
                return json.loads(v)
            return [o.strip() for o in v.split(",") if o.strip()]
        return v

    @property
    def is_production(self) -> bool:
        return self.environment == "production"

    @property
    def supabase_issuer(self) -> str:
        return f"{self.supabase_url.rstrip('/')}/auth/v1"


@lru_cache
def get_settings() -> Settings:
    return Settings()
