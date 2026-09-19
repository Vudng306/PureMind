"""Supabase Auth Admin API calls that require the service role key (server side only)."""

import logging
import uuid

import httpx

from app.core.config import Settings

log = logging.getLogger(__name__)


class SupabaseAdminError(Exception):
    pass


async def delete_auth_user(settings: Settings, user_id: uuid.UUID) -> None:
    """FR-ACC-05 step 3. A user that no longer exists in Supabase counts as deleted."""
    if not settings.supabase_url or not settings.supabase_service_role_key:
        raise SupabaseAdminError("Supabase admin credentials are not configured")
    key = settings.supabase_service_role_key
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.delete(
            f"{settings.supabase_issuer}/admin/users/{user_id}",
            headers={"apikey": key, "Authorization": f"Bearer {key}"},
        )
    if resp.status_code not in (200, 204, 404):
        log.error("supabase admin delete failed", extra={"status": resp.status_code, "user_id": str(user_id)})
        raise SupabaseAdminError(f"Supabase returned {resp.status_code}")
