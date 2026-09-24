import logging
from typing import Annotated

from fastapi import Depends, HTTPException, Request, status
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import Settings, get_settings
from app.core.logging import bind_user
from app.core.messages import MSG
from app.core.security import InvalidToken, verify_access_token
from app.db.session import get_session
from app.models import User

log = logging.getLogger("app.auth")

SessionDep = Annotated[AsyncSession, Depends(get_session)]
SettingsDep = Annotated[Settings, Depends(get_settings)]


def _unauthorized() -> HTTPException:
    return HTTPException(
        status.HTTP_401_UNAUTHORIZED, detail=MSG["MSG-06"], headers={"WWW-Authenticate": "Bearer"}
    )


async def get_current_user(request: Request, session: SessionDep, settings: SettingsDep) -> User:
    """FR-AUTH-05: verify the Supabase access token and provision the profile row on first use."""
    auth = request.headers.get("Authorization", "")
    scheme, _, token = auth.partition(" ")
    if scheme.lower() != "bearer" or not token:
        raise _unauthorized()
    try:
        claims = await verify_access_token(token, settings)
    except InvalidToken as e:
        # The reason only (expired, wrong issuer, unknown key…), never the token itself.
        log.warning("access token rejected: %r", e.__cause__ or e)
        raise _unauthorized() from None

    bind_user(request.scope, claims.user_id)  # NFR-OBS-01: the rest of this request logs under the user
    user = await session.get(User, claims.user_id)
    if user is None:
        if not claims.email:
            raise _unauthorized()
        user = User(
            id=claims.user_id,
            email=claims.email,
            display_name=(claims.display_name or "").strip()[:255] or None,
            reading_preferences={},
        )
        session.add(user)
        try:
            await session.commit()
        except IntegrityError:  # concurrent first requests
            await session.rollback()
            user = await session.get(User, claims.user_id)
            if user is None:
                raise _unauthorized() from None
    return user


CurrentUser = Annotated[User, Depends(get_current_user)]
