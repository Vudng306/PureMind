"""Verification of Supabase Auth access tokens (SRS FR-AUTH-05, NFR-SEC-02)."""

from dataclasses import dataclass
from functools import lru_cache
from uuid import UUID

import jwt
from starlette.concurrency import run_in_threadpool

from app.core.config import Settings

ASYMMETRIC_ALGS = ["ES256", "RS256", "EdDSA"]


class InvalidToken(Exception):
    pass


@dataclass(frozen=True)
class TokenClaims:
    user_id: UUID
    email: str
    display_name: str | None


@lru_cache
def _jwks_client(jwks_url: str) -> jwt.PyJWKClient:
    # Keys are cached; an unknown `kid` triggers a refetch (PyJWKClient behaviour).
    return jwt.PyJWKClient(jwks_url, cache_keys=True, lifespan=600)


async def verify_access_token(token: str, settings: Settings) -> TokenClaims:
    try:
        header = jwt.get_unverified_header(token)
    except jwt.PyJWTError as e:
        raise InvalidToken from e

    alg = header.get("alg")
    options = {"require": ["exp", "sub", "aud"]}
    try:
        if alg == "HS256":
            if not settings.supabase_jwt_secret:
                raise InvalidToken("HS256 tokens are not accepted")
            key = settings.supabase_jwt_secret
            algorithms = ["HS256"]
        elif alg in ASYMMETRIC_ALGS:
            client = _jwks_client(f"{settings.supabase_issuer}/.well-known/jwks.json")
            key = (await run_in_threadpool(client.get_signing_key_from_jwt, token)).key
            algorithms = ASYMMETRIC_ALGS
        else:
            raise InvalidToken(f"Unsupported alg {alg}")

        claims = jwt.decode(
            token,
            key,
            algorithms=algorithms,
            audience=settings.supabase_jwt_audience,
            issuer=settings.supabase_issuer,
            options=options,
        )
        user_id = UUID(claims["sub"])
    except (jwt.PyJWTError, ValueError) as e:
        raise InvalidToken from e

    metadata = claims.get("user_metadata") or {}
    return TokenClaims(
        user_id=user_id,
        email=(claims.get("email") or "").strip().lower(),
        display_name=metadata.get("display_name"),
    )
