"""Admin page (FR-ADM): accounts and the audit log.

An admin sees who uses PureMind and how much, never what they read or wrote: every answer here is built
from counts and account metadata, and no query selects document text, highlights, notes or chats.
"""

import uuid
from typing import Literal

from fastapi import APIRouter, HTTPException, Query, status
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import AdminUser, SessionDep, SettingsDep
from app.core.config import Settings
from app.core.messages import MSG
from app.models import (
    AdminAuditLog,
    ChatConversation,
    Document,
    Highlight,
    Notebook,
    Summary,
    User,
    utcnow,
)
from app.schemas import AdminAuditEntry, AdminAuditPage, AdminUserDetail, AdminUserItem, AdminUserPage
from app.services.accounts import purge_user
from app.services.ai_quota import today_vn
from app.services.supabase_admin import SupabaseAdminError, delete_auth_user, set_auth_user_banned

router = APIRouter(prefix="/admin", tags=["admin"])

UserSort = Literal["newest", "oldest", "last_seen", "email", "documents", "storage"]
UserStatus = Literal["all", "active", "disabled", "admin"]
RECENT_ACTIONS = 10


def _document_count():
    return (
        select(func.count(Document.id)).where(Document.user_id == User.id).correlate(User).scalar_subquery()
    )


def _storage_bytes():
    return (
        select(func.coalesce(func.sum(Document.file_size), 0))
        .where(Document.user_id == User.id)
        .correlate(User)
        .scalar_subquery()
    )


def _item(user: User, document_count: int, storage_bytes: int) -> AdminUserItem:
    today = today_vn()
    return AdminUserItem(
        id=user.id,
        email=user.email,
        display_name=user.display_name,
        role=user.role,
        created_at=user.created_at,
        last_seen_at=user.last_seen_at,
        disabled_at=user.disabled_at,
        document_count=document_count or 0,
        storage_bytes=storage_bytes or 0,
        ai_used_today=user.ai_quota_used if user.ai_quota_date == today else 0,
        chat_used_today=user.chat_quota_used if user.chat_quota_date == today else 0,
    )


async def _target(session: AsyncSession, user_id: uuid.UUID) -> User:
    user = await session.get(User, user_id)
    if user is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, MSG["MSG-ADM-NOT-FOUND"])
    return user


def _protect(target: User) -> None:
    """Admins, the caller included, cannot be locked or deleted here: the role is changed with the CLI."""
    if target.is_admin:
        raise HTTPException(status.HTTP_409_CONFLICT, MSG["MSG-ADM-PROTECTED"])


def _audit(session: AsyncSession, admin: User, action: str, target: User, **detail) -> None:
    session.add(
        AdminAuditLog(
            admin_id=admin.id,
            admin_email=admin.email,
            action=action,
            target_user_id=target.id,
            target_email=target.email,
            detail=detail,
        )
    )


async def _count(session: AsyncSession, stmt) -> int:
    return (await session.scalar(stmt)) or 0


async def _detail(session: AsyncSession, settings: Settings, user: User) -> AdminUserDetail:
    by_status = {
        s.value: n
        for s, n in await session.execute(
            select(Document.extraction_status, func.count())
            .where(Document.user_id == user.id)
            .group_by(Document.extraction_status)
        )
    }
    storage = await _count(
        session, select(func.coalesce(func.sum(Document.file_size), 0)).where(Document.user_id == user.id)
    )
    actions = (
        await session.scalars(
            select(AdminAuditLog)
            .where(AdminAuditLog.target_user_id == user.id)
            .order_by(AdminAuditLog.created_at.desc())
            .limit(RECENT_ACTIONS)
        )
    ).all()
    item = _item(user, sum(by_status.values()), storage)
    return AdminUserDetail(
        **item.model_dump(),
        documents_by_status=by_status,
        highlight_count=await _count(session, select(func.count()).where(Highlight.user_id == user.id)),
        notebook_count=await _count(session, select(func.count()).where(Notebook.user_id == user.id)),
        conversation_count=await _count(
            session, select(func.count()).where(ChatConversation.user_id == user.id)
        ),
        summary_count=await _count(
            session,
            select(func.count())
            .select_from(Summary)
            .join(Document, Summary.document_id == Document.id)
            .where(Document.user_id == user.id),
        ),
        ai_daily_quota=settings.ai_daily_quota,
        chat_daily_quota=settings.chat_daily_quota,
        recent_actions=[AdminAuditEntry.model_validate(a) for a in actions],
    )


@router.get("/users", response_model=AdminUserPage)
async def list_users(
    _: AdminUser,
    session: SessionDep,
    q: str = Query("", max_length=255),
    status_filter: UserStatus = Query("all", alias="status"),
    sort: UserSort = "newest",
    page: int = Query(1, ge=1),
    page_size: int = Query(25, ge=1, le=100),
):
    """FR-ADM-02: accounts with their usage, searchable by email or name."""
    filters = []
    if needle := q.strip().lower():
        filters.append(
            or_(
                func.lower(User.email).contains(needle, autoescape=True),
                func.lower(func.coalesce(User.display_name, "")).contains(needle, autoescape=True),
            )
        )
    if status_filter == "active":
        filters.append(User.disabled_at.is_(None))
    elif status_filter == "disabled":
        filters.append(User.disabled_at.is_not(None))
    elif status_filter == "admin":
        filters.append(User.role == "admin")

    documents = _document_count().label("document_count")
    storage = _storage_bytes().label("storage_bytes")
    order = {
        "newest": [User.created_at.desc()],
        "oldest": [User.created_at.asc()],
        "last_seen": [User.last_seen_at.desc().nulls_last(), User.created_at.desc()],
        "email": [User.email.asc()],
        "documents": [documents.desc(), User.created_at.desc()],
        "storage": [storage.desc(), User.created_at.desc()],
    }[sort]

    total = await _count(session, select(func.count()).select_from(User).where(*filters))
    rows = await session.execute(
        select(User, documents, storage)
        .where(*filters)
        .order_by(*order, User.id)
        .offset((page - 1) * page_size)
        .limit(page_size)
    )
    return AdminUserPage(
        items=[_item(u, d, s) for u, d, s in rows],
        total=total,
        page=page,
        page_size=page_size,
    )


@router.get("/users/{user_id}", response_model=AdminUserDetail)
async def get_user(user_id: uuid.UUID, _: AdminUser, session: SessionDep, settings: SettingsDep):
    return await _detail(session, settings, await _target(session, user_id))


@router.post("/users/{user_id}/disable", response_model=AdminUserDetail)
async def disable_user(user_id: uuid.UUID, admin: AdminUser, session: SessionDep, settings: SettingsDep):
    """FR-ADM-03: lock the account here and ban it in Supabase, so it can neither call the API nor sign in."""
    target = await _target(session, user_id)
    _protect(target)
    if target.disabled_at is None:
        try:
            await set_auth_user_banned(settings, target.id, True)
        except SupabaseAdminError:
            raise HTTPException(status.HTTP_502_BAD_GATEWAY, MSG["MSG-99"]) from None
        target.disabled_at = utcnow()
        _audit(session, admin, "user.disable", target)
        await session.commit()
    return await _detail(session, settings, target)


@router.post("/users/{user_id}/enable", response_model=AdminUserDetail)
async def enable_user(user_id: uuid.UUID, admin: AdminUser, session: SessionDep, settings: SettingsDep):
    target = await _target(session, user_id)
    if target.disabled_at is not None:
        try:
            await set_auth_user_banned(settings, target.id, False)
        except SupabaseAdminError:
            raise HTTPException(status.HTTP_502_BAD_GATEWAY, MSG["MSG-99"]) from None
        target.disabled_at = None
        _audit(session, admin, "user.enable", target)
        await session.commit()
    return await _detail(session, settings, target)


@router.post("/users/{user_id}/reset-quota", response_model=AdminUserDetail)
async def reset_quota(user_id: uuid.UUID, admin: AdminUser, session: SessionDep, settings: SettingsDep):
    """Give back today's AI and chat allowance, e.g. after requests an outage wasted."""
    target = await _target(session, user_id)
    item = _item(target, 0, 0)
    target.ai_quota_used = 0
    target.chat_quota_used = 0
    _audit(
        session, admin, "user.reset_quota", target, ai_used=item.ai_used_today, chat_used=item.chat_used_today
    )
    await session.commit()
    return await _detail(session, settings, target)


@router.delete("/users/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_user(user_id: uuid.UUID, admin: AdminUser, session: SessionDep, settings: SettingsDep):
    """FR-ADM-04: the same deletion as FR-ACC-05, started by an admin."""
    target = await _target(session, user_id)
    _protect(target)
    documents = await _count(session, select(func.count()).where(Document.user_id == target.id))
    # Remove the login first: if Supabase fails we keep all data and report an error.
    try:
        await delete_auth_user(settings, target.id)
    except SupabaseAdminError:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, MSG["MSG-99"]) from None
    _audit(session, admin, "user.delete", target, document_count=documents)
    await purge_user(session, settings, target)  # commits the audit entry with the deletion


@router.get("/audit-log", response_model=AdminAuditPage)
async def audit_log(
    _: AdminUser,
    session: SessionDep,
    user_id: uuid.UUID | None = None,
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
):
    """FR-ADM-05."""
    filters = [AdminAuditLog.target_user_id == user_id] if user_id else []
    total = await _count(session, select(func.count()).select_from(AdminAuditLog).where(*filters))
    rows = (
        await session.scalars(
            select(AdminAuditLog)
            .where(*filters)
            .order_by(AdminAuditLog.created_at.desc(), AdminAuditLog.id)
            .offset((page - 1) * page_size)
            .limit(page_size)
        )
    ).all()
    return AdminAuditPage(
        items=[AdminAuditEntry.model_validate(r) for r in rows], total=total, page=page, page_size=page_size
    )
