"""Local file storage (SRS 3.3 "Kho tệp"). Files are only served through ownership-checked API routes."""

import contextlib
import re
import shutil
import unicodedata
import uuid
from pathlib import Path

from fastapi import UploadFile

from app.core.config import Settings

CHUNK = 1024 * 1024


class FileTooLarge(Exception):
    pass


def sanitize_filename(name: str | None, fallback: str = "document") -> str:
    name = Path((name or "").replace("\\", "/")).name  # drop any path component
    name = unicodedata.normalize("NFC", name)
    name = "".join(ch for ch in name if unicodedata.category(ch)[0] != "C")
    name = re.sub(r'[<>:"/\\|?*]', "_", name).strip(" .")
    if not name:
        name = fallback
    if len(name) > 200:
        stem, dot, ext = name.rpartition(".")
        name = (stem[: 200 - len(ext) - 1] + dot + ext) if dot and len(ext) <= 10 else name[:200]
    return name


def resolve(settings: Settings, relative: str) -> Path:
    base = settings.upload_dir.resolve()
    path = (base / relative).resolve()
    if base not in path.parents:
        raise ValueError("Path escapes upload dir")
    return path


async def save_upload(file: UploadFile, subdir: str, filename: str, max_bytes: int, settings: Settings):
    """Stream an upload to disk. Returns (relative_path, size, first_bytes)."""
    relative = f"{subdir}/{uuid.uuid4().hex}_{filename}"
    target = resolve(settings, relative)
    target.parent.mkdir(parents=True, exist_ok=True)
    size = 0
    head = b""
    try:
        with target.open("wb") as out:
            while chunk := await file.read(CHUNK):
                size += len(chunk)
                if size > max_bytes:
                    raise FileTooLarge
                if len(head) < 64:
                    head += chunk[: 64 - len(head)]
                out.write(chunk)
    except BaseException:
        target.unlink(missing_ok=True)
        raise
    return relative, size, head


def images_path(document_id: uuid.UUID) -> str:
    """Where a document's extracted images live, relative to the upload dir."""
    return f"images/{document_id}"


def delete_dir(settings: Settings, relative: str) -> None:
    with contextlib.suppress(OSError, ValueError):
        shutil.rmtree(resolve(settings, relative))


def delete_file(settings: Settings, relative: str | None) -> None:
    if not relative:
        return
    with contextlib.suppress(OSError, ValueError):
        resolve(settings, relative).unlink(missing_ok=True)
