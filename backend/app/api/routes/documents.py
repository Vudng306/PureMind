import logging
import re
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
from app.services import equation_ocr, figure_notes, page_ocr, storage, table_ocr, web
from app.services.epub import extract_epub, looks_like_epub
from app.services.extraction import (
    IMAGE_NAME,
    OCR_LINE,
    ExtractionError,
    block_key,
    equation_count,
    extract_pdf,
    reader_keys,
    scanned_pages,
)

log = logging.getLogger(__name__)
router = APIRouter(prefix="/documents", tags=["documents"])

MEDIA_TYPES = {".pdf": "application/pdf", ".epub": "application/epub+zip"}
EXTRACTORS = {".pdf": extract_pdf, ".epub": extract_epub}
# Equations the vision model reads, beyond which that takes long enough to go on after the response.
MANY_EQUATIONS = 12


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


def _with_scanned_pages(content: str, source_map: list, read: dict[int, str]) -> tuple[str, list]:
    """Each scan mark replaced by the text read from its page, or dropped when the page could not be read.
    The page's blocks are placed on the whole page: OCR says what a page says, not where."""
    marks = {block_key(m.group(0)): int(m.group(1)) for m in OCR_LINE.finditer(content)}
    content = OCR_LINE.sub(lambda m: read.get(int(m.group(1)), ""), content)
    placed: list = []
    for key, boxes in source_map:
        if (page := marks.get(key)) is None:
            placed.append([key, boxes])
        elif page in read:
            placed += [[k, [[page, 0, 0, 1, 1]]] for k in reader_keys(read[page])]
    return re.sub(r"\n{3,}", "\n\n", content).strip(), placed


async def run_extraction(
    session: AsyncSession, doc: Document, settings: Settings, background: BackgroundTasks | None = None
) -> None:
    """FR-DOC-02. Updates status and content on the given document and commits.

    With `background`, the figures are then described for the AI after the response (describe_figures);
    without it the caller does that itself, or the figures go without descriptions."""
    doc.extraction_status = ExtractionStatus.processing
    await session.commit()

    path = storage.resolve(settings, doc.file_storage_path)
    fallback_title = Path(doc.original_filename or "Tài liệu").stem
    images = storage.images_path(doc.id)
    storage.delete_dir(settings, images)  # a re-extraction starts from no images
    try:
        suffix = path.suffix.lower()
        extractor = EXTRACTORS[suffix]
        args = (path, fallback_title) + ((storage.resolve(settings, images),) if suffix == ".pdf" else ())
        result = await run_in_threadpool(extractor, *args)
    except ExtractionError as e:
        doc.extraction_status = ExtractionStatus.failed
        doc.extraction_error = e.code
        storage.delete_dir(settings, images)
    except Exception:
        doc.extraction_status = ExtractionStatus.failed
        doc.extraction_error = "MSG-99"
        storage.delete_dir(settings, images)
    else:
        content, source_map = result.content, result.source_map
        if result.ocr_pages:
            read = await page_ocr.read_pages(settings, path, result.ocr_pages)
            content, source_map = _with_scanned_pages(content, source_map, read)
        if not re.sub(r"^---$", "", content, flags=re.M).strip():  # a scan that could not be read
            doc.extraction_status = ExtractionStatus.failed
            doc.extraction_error = "MSG-15"
            storage.delete_dir(settings, images)
            await session.commit()
            return
        for name, pictures, transcribe in (
            ("table_ocr", result.table_images, table_ocr.transcribe_tables),
            ("equation_ocr", result.equation_images, equation_ocr.transcribe_equations),
        ):
            if not pictures:
                continue
            try:
                content, replaced = await transcribe(settings, doc.id, content, pictures)
            except Exception:  # OCR is a bonus: the table or equation stays a picture
                log.exception("%s failed document=%s", name, doc.id)
                continue
            # A block read from its picture is a new block: its place on the PDF is the picture's.
            keys = {block_key(old): block_key(new) for old, new in replaced.items()}
            source_map = [[keys.get(key, key), boxes] for key, boxes in source_map]
        doc.title = result.title[:500]
        doc.content_clean = content
        doc.source_map = source_map or None
        doc.figure_notes = None  # the figures of the earlier text, if any, are gone
        doc.chart_data = result.charts or None
        doc.page_count = result.page_count
        doc.word_count = len(re.findall(r"\w+", content))
        doc.extraction_status = ExtractionStatus.done
        doc.extraction_error = None
    await session.commit()
    if background is not None and doc.extraction_status == ExtractionStatus.done:
        background.add_task(describe_figures, doc.id, settings)


async def describe_figures(document_id: uuid.UUID, settings: Settings) -> None:
    """Describe the document's figures for the AI (figure_notes). Seconds per figure, so it runs once the
    reader already has the text; nothing is saved if the text changed meanwhile."""
    async with SessionLocal() as session:
        content = await session.scalar(select(Document.content_clean).where(Document.id == document_id))
    if not content or not figure_notes.figure_names(content):
        return
    try:
        notes = await figure_notes.describe_figures(settings, document_id, content)
    except Exception:  # descriptions are a bonus: the AI reads the text without them
        log.exception("figure_notes failed document=%s", document_id)
        return
    if not notes:
        return
    async with SessionLocal() as session:
        doc = await session.get(Document, document_id)
        if doc is None or doc.content_clean != content:  # deleted or re-extracted meanwhile
            return
        doc.figure_notes = notes
        await session.commit()


async def _takes_long(settings: Settings, doc: Document, size: int) -> bool:
    """A large file, or a PDF the vision model has much to read in (a scan, page by page, or many
    equations): extracted after the response, while the library shows it as processing (FR-DOC-02 step 6)."""
    if size > settings.async_extraction_threshold_bytes:
        return True
    path = storage.resolve(settings, doc.file_storage_path)
    if not settings.openai_api_key or path.suffix.lower() != ".pdf":
        return False
    if await run_in_threadpool(scanned_pages, path):
        return True
    return await run_in_threadpool(equation_count, path) > MANY_EQUATIONS


async def _extract_in_background(document_id: uuid.UUID, settings: Settings) -> None:
    async with SessionLocal() as session:
        doc = await session.get(Document, document_id)
        if doc is None:
            return
        await run_extraction(session, doc, settings)
        done = doc.extraction_status == ExtractionStatus.done
    if done:
        await describe_figures(document_id, settings)


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

    if await _takes_long(settings, doc, size):
        background.add_task(_extract_in_background, doc.id, settings)
    else:
        await run_extraction(session, doc, settings, background)
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
async def save_url(
    payload: SaveUrlIn,
    background: BackgroundTasks,
    user: CurrentUser,
    session: SessionDep,
    settings: SettingsDep,
):
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
        if await _takes_long(settings, doc, len(fetched.body)):
            background.add_task(_extract_in_background, doc.id, settings)
        else:
            await run_extraction(session, doc, settings, background)
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


@router.get("/{document_id}/source-map")
async def get_source_map(document_id: uuid.UUID, user: CurrentUser, session: SessionDep):
    """Where each block of the clean text sits on the original PDF: `[[block key, [[page, x, y, w, h], …]], …]`
    with boxes normalised to the page. Empty for documents that have no PDF (web pages, EPUB)."""
    await _owned_document(session, user, document_id)
    source_map = await session.scalar(select(Document.source_map).where(Document.id == document_id))
    return JSONResponse(source_map or [], headers={"Cache-Control": "private, no-cache"})


@router.get("/{document_id}/charts")
async def get_charts(document_id: uuid.UUID, user: CurrentUser, session: SessionDep):
    """The data points of the document's vector charts, read from their drawing: `{image name: {"panels": […]}}`.
    Empty when no figure is a chart drawn as paths (raster charts are only described, never estimated)."""
    await _owned_document(session, user, document_id)
    charts = await session.scalar(select(Document.chart_data).where(Document.id == document_id))
    return JSONResponse(charts or {}, headers={"Cache-Control": "private, no-cache"})


@router.get("/{document_id}/images/{name}")
async def get_document_image(
    document_id: uuid.UUID, name: str, user: CurrentUser, session: SessionDep, settings: SettingsDep
):
    """An image extracted from the document, referenced in its clean text as `pm-image:<name>`."""
    doc = await _owned_document(session, user, document_id)
    if not IMAGE_NAME.match(name):
        raise HTTPException(status.HTTP_404_NOT_FOUND, MSG["MSG-19"])
    path = storage.resolve(settings, f"{storage.images_path(doc.id)}/{name}")
    if not path.is_file():
        raise HTTPException(status.HTTP_404_NOT_FOUND, MSG["MSG-19"])
    return FileResponse(
        path,
        media_type="image/webp",
        headers={"Cache-Control": "private, max-age=86400", "X-Content-Type-Options": "nosniff"},
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
    path, images = doc.file_storage_path, storage.images_path(doc.id)
    await session.delete(doc)
    await session.commit()
    storage.delete_file(settings, path)
    storage.delete_dir(settings, images)


@router.post("/{document_id}/retry-extraction", response_model=DocumentOut)
async def retry_extraction(
    document_id: uuid.UUID,
    background: BackgroundTasks,
    user: CurrentUser,
    session: SessionDep,
    settings: SettingsDep,
):
    """Appendix A.1: failed -> pending, only for system errors."""
    doc = await _owned_document(session, user, document_id)
    if doc.extraction_status != ExtractionStatus.failed or doc.extraction_error != "MSG-99":
        raise HTTPException(status.HTTP_409_CONFLICT, "Không thể thử lại trích xuất cho tài liệu này.")
    doc.extraction_status = ExtractionStatus.pending
    await session.commit()
    await run_extraction(session, doc, settings, background)
    await session.refresh(doc)
    return doc
