import io
import uuid

from fastapi import APIRouter, HTTPException, UploadFile, status
from fastapi.responses import FileResponse
from PIL import Image, UnidentifiedImageError
from sqlalchemy import select
from starlette.concurrency import run_in_threadpool

from app.api.deps import CurrentUser, SessionDep, SettingsDep
from app.core.messages import MSG
from app.models import Document
from app.schemas import AccountUpdate, UserOut
from app.services import storage
from app.services.supabase_admin import SupabaseAdminError, delete_auth_user

router = APIRouter(prefix="/account", tags=["account"])

AVATAR_FORMATS = {"JPEG", "PNG", "WEBP"}
AVATAR_MAX_SIDE = 256


@router.get("", response_model=UserOut)
async def get_account(user: CurrentUser):
    return user


@router.patch("", response_model=UserOut)
async def update_account(payload: AccountUpdate, user: CurrentUser, session: SessionDep):
    if payload.display_name is not None:
        user.display_name = payload.display_name
    if payload.reading_preferences is not None:
        prefs = dict(user.reading_preferences or {})
        prefs.update(payload.reading_preferences.model_dump(exclude_unset=True))
        user.reading_preferences = prefs
    await session.commit()
    await session.refresh(user)
    return user


def _normalize_avatar(raw: bytes) -> bytes:
    try:
        img = Image.open(io.BytesIO(raw))
        if img.format not in AVATAR_FORMATS:
            raise ValueError
        img.load()
    except (UnidentifiedImageError, ValueError, OSError):
        raise HTTPException(422, MSG["MSG-08"]) from None
    img.thumbnail((AVATAR_MAX_SIDE, AVATAR_MAX_SIDE))
    if img.mode not in ("RGB", "RGBA"):
        img = img.convert("RGBA")
    out = io.BytesIO()
    img.save(out, format="WEBP", quality=85)
    return out.getvalue()


@router.put("/avatar", response_model=UserOut)
async def upload_avatar(file: UploadFile, user: CurrentUser, session: SessionDep, settings: SettingsDep):
    raw = await file.read(settings.max_avatar_bytes + 1)
    if len(raw) > settings.max_avatar_bytes:
        raise HTTPException(413, MSG["MSG-09"])
    data = await run_in_threadpool(_normalize_avatar, raw)

    relative = f"avatars/{user.id}_{uuid.uuid4().hex[:12]}.webp"
    target = storage.resolve(settings, relative)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(data)

    old = user.avatar_path
    user.avatar_path = relative
    await session.commit()
    if old and old != relative:
        storage.delete_file(settings, old)
    await session.refresh(user)
    return user


@router.delete("/avatar", response_model=UserOut)
async def delete_avatar(user: CurrentUser, session: SessionDep, settings: SettingsDep):
    old = user.avatar_path
    user.avatar_path = None
    await session.commit()
    storage.delete_file(settings, old)
    await session.refresh(user)
    return user


@router.get("/avatar")
async def get_avatar(user: CurrentUser, settings: SettingsDep):
    if not user.avatar_path:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Chưa có ảnh đại diện.")
    path = storage.resolve(settings, user.avatar_path)
    if not path.is_file():
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Chưa có ảnh đại diện.")
    return FileResponse(path, media_type="image/webp", headers={"Cache-Control": "private, max-age=86400"})


@router.delete("", status_code=status.HTTP_204_NO_CONTENT)
async def delete_account(user: CurrentUser, session: SessionDep, settings: SettingsDep):
    """FR-ACC-05: delete data, files and the Supabase Auth user."""
    paths = (
        await session.scalars(
            select(Document.file_storage_path).where(
                Document.user_id == user.id, Document.file_storage_path.is_not(None)
            )
        )
    ).all()
    document_ids = (await session.scalars(select(Document.id).where(Document.user_id == user.id))).all()
    avatar = user.avatar_path
    user_id = user.id

    # Remove the login first: if Supabase fails we keep all data and report an error.
    try:
        await delete_auth_user(settings, user_id)
    except SupabaseAdminError:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, MSG["MSG-99"]) from None

    await session.delete(user)
    await session.commit()
    for p in [*paths, avatar]:
        storage.delete_file(settings, p)
    for document_id in document_ids:
        storage.delete_dir(settings, storage.images_path(document_id))
