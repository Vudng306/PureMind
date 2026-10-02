"""Removing an account's data, shared by self-service deletion (FR-ACC-05) and the admin page (FR-ADM-04)."""

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import Settings
from app.models import Document, User
from app.services import storage


async def purge_user(session: AsyncSession, settings: Settings, user: User) -> None:
    """Delete the profile row (its documents, highlights, notebooks and chats cascade) and every file.

    The caller removes the Supabase Auth user first: if that fails, all data is kept.
    """
    paths = (
        await session.scalars(
            select(Document.file_storage_path).where(
                Document.user_id == user.id, Document.file_storage_path.is_not(None)
            )
        )
    ).all()
    document_ids = (await session.scalars(select(Document.id).where(Document.user_id == user.id))).all()
    avatar = user.avatar_path

    await session.delete(user)
    await session.commit()
    for p in [*paths, avatar]:
        storage.delete_file(settings, p)
    for document_id in document_ids:
        storage.delete_dir(settings, storage.images_path(document_id))
