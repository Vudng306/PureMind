import uuid
from pathlib import Path
from typing import Literal

import httpx
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, UploadFile, status
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import defer
from starlette.concurrency import run_in_threadpool

from app.api.deps import CurrentUser, SessionDep, SettingsDep
from app.core.config import Settings
from app.core.messages import MSG
from app.core.ratelimit import upload_limiter
from app.db.session import SessionLocal
from app.models import Document, ExtractionStatus, SourceType, User
from app.schemas import DocumentListItem, DocumentOut, DocumentUpdate
from app.services import storage, web
from app.services.epub import extract_epub, looks_like_epub
from app.services.extraction import ExtractionError, extract_pdf

router = APIRouter(prefix="/documents", tags=["documents"])

MEDIA_TYPES = {".pdf": "application/pdf", ".epub": "application/epub+zip"}
EXTRACTORS = {".pdf": extract_pdf, ".epub": extract_epub}


def rate_limited_upload(user: CurrentUser) -> None:
    """NFR-SEC-07: at most 30 uploads/saved links per user per hour."""
    if not upload_limiter.hit(str(user.id)):
        raise HTTPException(429, "Bạn đã thêm quá nhiều tài liệu trong một giờ. Vui lòng thử lại sau.")


async def _owned_document(session: AsyncSession, user: User, document_id: uuid.UUID) -> Document:
    doc = await session.get(Document, document_id)
    if doc is None or doc.user_id != user.id:  # NFR-SEC-04: other users' data is "not found"
        raise HTTPException(status.HTTP_404_NOT_FOUND, MSG["MSG-19"])
    return doc


@router.get("", response_model=list[DocumentListItem])
async def list_documents(
    user: CurrentUser,
    session: SessionDep,
    source_type: SourceType | None = None,
    sort: Literal["created_desc", "created_asc", "title"] = "created_desc",
):
    order = {
        "created_desc": Document.created_at.desc(),
        "created_asc": Document.created_at.asc(),
        "title": Document.title.asc(),
    }[sort]
    # content_clean is deferred so the list query does not load full texts.
    stmt = select(Document).options(defer(Document.content_clean)).where(Document.user_id == user.id)
    if source_type:
        stmt = stmt.where(Document.source_type == source_type)
    return (await session.scalars(stmt.order_by(order))).all()


async def run_extraction(session: AsyncSession, doc: Document, settings: Settings) -> None:
    """FR-DOC-02. Updates status and content on the given document and commits."""
    doc.extraction_status = ExtractionStatus.processing
    await session.commit()

    path = storage.resolve(settings, doc.file_storage_path)
    fallback_title = Path(doc.original_filename or "Tài liệu").stem
    try:
        extractor = EXTRACTORS[path.suffix.lower()]
        result = await run_in_threadpool(extractor, path, fallback_title)
    except ExtractionError as e:
        doc.extraction_status = ExtractionStatus.failed
        doc.extraction_error = e.code
    except Exception:
        doc.extraction_status = ExtractionStatus.failed
        doc.extraction_error = "MSG-99"
    else:
        doc.title = result.title[:500]
        doc.content_clean = result.content
        doc.page_count = result.page_count
        doc.word_count = result.word_count
        doc.extraction_status = ExtractionStatus.done
        doc.extraction_error = None
    await session.commit()


async def _extract_in_background(document_id: uuid.UUID, settings: Settings) -> None:
    async with SessionLocal() as session:
        doc = await session.get(Document, document_id)
        if doc is not None:
            await run_extraction(session, doc, settings)


@router.post(
    "/upload",
    response_model=DocumentOut,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(rate_limited_upload)],
)
async def upload_document(
    file: UploadFile,
    background: BackgroundTasks,
    user: CurrentUser,
    session: SessionDep,
    settings: SettingsDep,
):
    """FR-DOC-01: PDF or EPUB."""
    filename = storage.sanitize_filename(file.filename)
    suffix = Path(filename).suffix.lower()
    if suffix not in EXTRACTORS:
        raise HTTPException(422, MSG["MSG-10"])

    try:
        relative, size, head = await storage.save_upload(
            file, f"documents/{user.id}", filename, settings.max_upload_bytes, settings
        )
    except storage.FileTooLarge:
        raise HTTPException(413, MSG["MSG-11"]) from None
    except OSError:
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, MSG["MSG-12"]) from None

    signature_ok = head.startswith(b"%PDF") if suffix == ".pdf" else looks_like_epub(head)
    if not signature_ok:
        storage.delete_file(settings, relative)
        raise HTTPException(422, MSG["MSG-10"])

    doc = Document(
        user_id=user.id,
        source_type=SourceType.upload,
        title=Path(filename).stem[:500] or "Tài liệu",
        file_storage_path=relative,
        original_filename=filename[:500],
        file_size=size,
        extraction_status=ExtractionStatus.pending,
    )
    session.add(doc)
    await session.commit()

    if size > settings.async_extraction_threshold_bytes:
        background.add_task(_extract_in_background, doc.id, settings)
    else:
        await run_extraction(session, doc, settings)
    await session.refresh(doc)
    return doc


async def _commit_new_link(session: AsyncSession, doc: Document, user: User, url: str) -> JSONResponse | None:
    """Insert a saved link; if a concurrent request saved the same URL first, return that one (BR-03)."""
    session.add(doc)
    try:
        await session.commit()
        return None
    except IntegrityError:
        await session.rollback()
        existing = await session.scalar(
            select(Document).where(Document.user_id == user.id, Document.url == url)
        )
        if existing is None:
            raise
        return JSONResponse(DocumentOut.model_validate(existing).model_dump(mode="json"), status_code=200)


class SaveUrlIn(BaseModel):
    url: str


@router.post(
    "/save-url",
    response_model=DocumentOut,
    status_code=status.HTTP_201_CREATED,
    responses={200: {"model": DocumentOut, "description": "The link was already saved"}},
)
async def save_url(payload: SaveUrlIn, user: CurrentUser, session: SessionDep, settings: SettingsDep):
    """FR-DOC-03: save a web article or an online PDF."""
    try:
        normalized = str(web.validate_url(payload.url))
    except web.InvalidUrl:
        raise HTTPException(422, MSG["MSG-16"]) from None

    existing = await session.scalar(
        select(Document).where(Document.user_id == user.id, Document.url == normalized)
    )
    if existing is not None:
        return JSONResponse(DocumentOut.model_validate(existing).model_dump(mode="json"), status_code=200)

    rate_limited_upload(user)
    try:
        fetched = await web.fetch_url(normalized, settings.web_contact)
    except web.InvalidUrl:
        raise HTTPException(422, MSG["MSG-16"]) from None
    except web.BlockedAddress:
        raise HTTPException(422, MSG["MSG-17"]) from None
    except web.FetchRefused:
        raise HTTPException(422, MSG["MSG-18-REFUSED"]) from None
    except web.FetchFailed:
        raise HTTPException(422, MSG["MSG-18"]) from None

    if web.is_pdf(fetched):
        if not fetched.body.startswith(b"%PDF"):
            raise HTTPException(422, MSG["MSG-18"])
        name = storage.sanitize_filename(Path(httpx.URL(fetched.url).path).name or "tai-lieu.pdf")
        if not name.lower().endswith(".pdf"):
            name += ".pdf"
        relative = f"documents/{user.id}/{uuid.uuid4().hex}_{name}"
        target = storage.resolve(settings, relative)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(fetched.body)
        doc = Document(
            user_id=user.id,
            source_type=SourceType.manual,
            url=normalized,
            title=Path(name).stem[:500],
            file_storage_path=relative,
            original_filename=name[:500],
            file_size=len(fetched.body),
        )
        if (dup := await _commit_new_link(session, doc, user, normalized)) is not None:
            storage.delete_file(settings, relative)
            return dup
        await run_extraction(session, doc, settings)
    else:
        article = await run_in_threadpool(web.extract_article, fetched.body, fetched.url)
        has_text = bool(article.content.strip())
        doc = Document(
            user_id=user.id,
            source_type=SourceType.manual,
            url=normalized,
            title=article.title or normalized[:500],
            content_clean=article.content,
            word_count=article.word_count,
            published_at=article.published_at,
            extraction_status=ExtractionStatus.done if has_text else ExtractionStatus.failed,
            extraction_error=None if has_text else "MSG-15",
        )
        if (dup := await _commit_new_link(session, doc, user, normalized)) is not None:
            return dup
    await session.refresh(doc)
    return doc


@router.get("/{document_id}", response_model=DocumentOut)
async def get_document(document_id: uuid.UUID, user: CurrentUser, session: SessionDep):
    return await _owned_document(session, user, document_id)


@router.get("/{document_id}/file")
async def get_document_file(
    document_id: uuid.UUID, user: CurrentUser, session: SessionDep, settings: SettingsDep
):
    """FR-DOC-05: original file with HTTP Range support (handled by FileResponse)."""
    doc = await _owned_document(session, user, document_id)
    if not doc.file_storage_path:
        raise HTTPException(status.HTTP_404_NOT_FOUND, MSG["MSG-19"])
    path = storage.resolve(settings, doc.file_storage_path)
    if not path.is_file():
        raise HTTPException(status.HTTP_404_NOT_FOUND, MSG["MSG-19"])
    return FileResponse(
        path,
        media_type=MEDIA_TYPES.get(path.suffix.lower(), "application/octet-stream"),
        headers={"Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff"},
        content_disposition_type="inline",
    )


@router.patch("/{document_id}", response_model=DocumentOut)
async def update_document(
    document_id: uuid.UUID, payload: DocumentUpdate, user: CurrentUser, session: SessionDep
):
    """FR-DOC-07."""
    doc = await _owned_document(session, user, document_id)
    data = payload.model_dump(exclude_unset=True, exclude_none=True)
    if "last_read_page" in data and doc.page_count and data["last_read_page"] > doc.page_count:
        raise HTTPException(422, "Số trang không hợp lệ.")
    if "title" in data:
        data["title"] = " ".join(data["title"].split())
        if not data["title"]:
            raise HTTPException(422, "Tên tài liệu không được để trống.")
    for key, value in data.items():
        setattr(doc, key, value)
    await session.commit()
    await session.refresh(doc)
    return doc


@router.delete("/{document_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_document(
    document_id: uuid.UUID, user: CurrentUser, session: SessionDep, settings: SettingsDep
):
    """FR-DOC-06."""
    doc = await _owned_document(session, user, document_id)
    path = doc.file_storage_path
    await session.delete(doc)
    await session.commit()
    storage.delete_file(settings, path)


@router.post("/{document_id}/retry-extraction", response_model=DocumentOut)
async def retry_extraction(
    document_id: uuid.UUID, user: CurrentUser, session: SessionDep, settings: SettingsDep
):
    """Appendix A.1: failed -> pending, only for system errors."""
    doc = await _owned_document(session, user, document_id)
    if doc.extraction_status != ExtractionStatus.failed or doc.extraction_error != "MSG-99":
        raise HTTPException(status.HTTP_409_CONFLICT, "Không thể thử lại trích xuất cho tài liệu này.")
    doc.extraction_status = ExtractionStatus.pending
    await session.commit()
    await run_extraction(session, doc, settings)
    await session.refresh(doc)
    return doc
