import logging
import re
import uuid
from dataclasses import dataclass
from datetime import timedelta
from pathlib import Path
from typing import Literal

import httpx
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, UploadFile, status
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, Field
from sqlalchemy import func, or_, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import defer
from starlette.concurrency import run_in_threadpool

from app.api.deps import CurrentUser, SessionDep, SettingsDep
from app.core.config import Settings
from app.core.messages import MSG
from app.core.ratelimit import upload_limiter
from app.db.session import SessionLocal
from app.models import (
    EXTRACTION_ERRORS,
    AiArtifact,
    ArticleTopic,
    Collection,
    Document,
    ExtractionReport,
    ExtractionStatus,
    Highlight,
    Note,
    NotebookDocument,
    NotebookHighlight,
    Post,
    PostSource,
    SourceType,
    Summary,
    User,
    utcnow,
)
from app.models import Article as CatalogArticle
from app.schemas import DocumentListItem, DocumentOut, DocumentUpdate, DocumentUsage
from app.services import (
    anchors,
    equation_ocr,
    figure_notes,
    highlight_sync,
    page_ocr,
    rights,
    storage,
    table_ocr,
    web,
)
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
    docs = (await session.scalars(stmt.order_by(order))).all()
    urls = [d.url for d in docs if d.url]
    topics: dict[str, list[str]] = {}
    if urls:  # a copy of a shared article is on that article's subjects
        rows = await session.execute(
            select(CatalogArticle.url, ArticleTopic.topic)
            .join(ArticleTopic, ArticleTopic.article_id == CatalogArticle.id)
            .where(CatalogArticle.url.in_(urls))
        )
        for url, topic in rows.all():
            topics.setdefault(url, []).append(topic)
    return [
        DocumentListItem.model_validate(d).model_copy(update={"topics": topics.get(d.url or "", [])})
        for d in docs
    ]


def ai_consented(user: User | None) -> bool:
    """NFR-PRV: the user agreed to send their content to OpenAI. Until then extraction reads no picture
    (scanned pages, tables, equations, figures): those stay pictures, a scan has no clean text."""
    return bool(user and (user.reading_preferences or {}).get("ai_consent"))


MAX_ISSUE_PAGES = 50  # page numbers kept with an issue; its count is always the full number


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


@dataclass
class Extracted:
    """What reading a document's file gave, before any of it is put on the document."""

    content: str
    source_map: list
    aside: dict | None
    issues: list[dict]
    title: str
    charts: dict | None
    page_count: int | None


async def extract_file(doc: Document, settings: Settings, ai: bool) -> Extracted | str:
    """Read the document's file into a clean text, or the code of what went wrong. Touches nothing on the
    document; the pictures it finds are written beside those of the text in use (named by their content, so
    the two never clash)."""
    path = storage.resolve(settings, doc.file_storage_path)
    fallback_title = Path(doc.original_filename or "Tài liệu").stem
    images = storage.images_path(doc.id)
    try:
        suffix = path.suffix.lower()
        extractor = EXTRACTORS[suffix]
        args = (path, fallback_title) + ((storage.resolve(settings, images),) if suffix == ".pdf" else ())
        result = await run_in_threadpool(extractor, *args)
    except ExtractionError as e:
        return e.code
    except Exception:
        return "MSG-99"
    content, source_map = result.content, result.source_map
    issues: list[dict] = []  # RD-111: only what is known, never a guess at completeness
    if result.ocr_pages:
        read = await page_ocr.read_pages(settings, path, result.ocr_pages) if ai else {}
        content, source_map = _with_scanned_pages(content, source_map, read)
        for code, pages in (
            ("scanned_pages", [p for p in result.ocr_pages if p not in read]),
            ("ocr_pages", sorted(p for p, text in read.items() if text)),
        ):
            if pages:
                issues.append({"code": code, "count": len(pages), "pages": pages[:MAX_ISSUE_PAGES]})
    if not re.sub(r"^---$", "", content, flags=re.M).strip():  # a scan that could not be read
        return "MSG-15"
    for name, pictures, transcribe in (
        ("table_ocr", result.table_images, table_ocr.transcribe_tables),
        ("equation_ocr", result.equation_images, equation_ocr.transcribe_equations),
    ):
        if not pictures or not ai:
            continue
        try:
            content, replaced = await transcribe(settings, doc.id, content, pictures)
        except Exception:  # OCR is a bonus: the table or equation stays a picture
            log.exception("%s failed document=%s", name, doc.id)
            continue
        # A block read from its picture is a new block: its place on the PDF is the picture's.
        keys = {block_key(old): block_key(new) for old, new in replaced.items()}
        source_map = [[keys.get(key, key), boxes] for key, boxes in source_map]
    # A table or an equation still shown as its picture: the reader sees it, the AI and search do not.
    for code, pictures in (
        ("tables_as_images", result.table_images),
        ("equations_as_images", result.equation_images),
    ):
        left = [name for name in dict.fromkeys(pictures) if f"pm-image:{name}" in content]
        if left:
            issues.append({"code": code, "count": len(left)})
    return Extracted(
        content, source_map, result.aside, issues, result.title, result.charts or None, result.page_count
    )


def apply_extraction(doc: Document, out: Extracted) -> None:
    """Put a new clean text on the document."""
    doc.extraction_issues = out.issues
    if not doc.citation:  # a document with its citation filled in keeps that title
        doc.title = out.title[:500]
    if doc.content_clean != out.content:
        doc.figure_notes = None  # the figures of the earlier text, if any, are gone
    doc.content_clean = out.content
    doc.source_map = out.source_map or None
    doc.content_aside = out.aside
    doc.chart_data = out.charts
    doc.page_count = out.page_count
    doc.word_count = len(re.findall(r"\w+", out.content))
    doc.extraction_status = ExtractionStatus.done
    doc.extraction_error = None


def drop_unused_images(settings: Settings, doc: Document) -> None:
    """The pictures no longer in the document's text: those of an earlier text, or of a failed reading."""
    folder = storage.resolve(settings, storage.images_path(doc.id))
    if not folder.is_dir():
        return
    for file in folder.iterdir():
        if IMAGE_NAME.match(file.name) and f"pm-image:{file.name}" not in doc.content_clean:
            file.unlink(missing_ok=True)


async def run_extraction(
    session: AsyncSession, doc: Document, settings: Settings, background: BackgroundTasks | None = None
) -> None:
    """FR-DOC-02. Updates status and content on the given document and commits.

    With `background`, the figures are then described for the AI after the response (describe_figures);
    without it the caller does that itself, or the figures go without descriptions."""
    doc.extraction_status = ExtractionStatus.processing
    doc.extraction_issues = None  # what the last extraction left out says nothing about this one
    await session.commit()
    ai = ai_consented(await session.get(User, doc.user_id))
    images = storage.images_path(doc.id)
    storage.delete_dir(settings, images)  # a first extraction, or a retry, starts from no images
    out = await extract_file(doc, settings, ai)
    if isinstance(out, str):
        doc.extraction_status = ExtractionStatus.failed
        doc.extraction_error = out
        storage.delete_dir(settings, images)
    else:
        apply_extraction(doc, out)
    await session.commit()
    if background is not None and doc.extraction_status == ExtractionStatus.done:
        background.add_task(describe_figures, doc.id, settings)


async def describe_figures(document_id: uuid.UUID, settings: Settings) -> None:
    """Describe the document's figures for the AI (figure_notes). Seconds per figure, so it runs once the
    reader already has the text; nothing is saved if the text changed meanwhile."""
    async with SessionLocal() as session:
        doc = await session.get(Document, document_id)
        if doc is None or not ai_consented(await session.get(User, doc.user_id)):
            return
        content = doc.content_clean
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


async def _takes_long(settings: Settings, doc: Document, size: int, user: User) -> bool:
    """A large file, or a PDF the vision model has much to read in (a scan, page by page, or many
    equations): extracted after the response, while the library shows it as processing (FR-DOC-02 step 6)."""
    if size > settings.async_extraction_threshold_bytes:
        return True
    path = storage.resolve(settings, doc.file_storage_path)
    if not settings.openai_api_key or not ai_consented(user) or path.suffix.lower() != ".pdf":
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


# A reprocess still `running` after this long was cut off (the server restarted): it may be asked for again.
REPROCESS_STALE = timedelta(minutes=15)


async def reprocess(document_id: uuid.UUID, settings: Settings) -> None:
    """Clean Reader UC-04: read the file again. The text in use stays readable all along and is replaced only
    by a new text that came out whole; then each highlight is checked against it (services/anchors). The
    AI's index and summaries follow the text they were made from (chunks_hash, content_hash), so they are
    made again from the new one when next asked for."""
    async with SessionLocal() as session:
        doc = await session.get(Document, document_id)
        if doc is None:
            return
        ai = ai_consented(await session.get(User, doc.user_id))
        before = doc.content_version
        try:
            out = await extract_file(doc, settings, ai)
        except Exception:  # never leave it `running`
            log.exception("reprocess failed document=%s", document_id)
            out = "MSG-99"
        # The owner may have changed it meanwhile (its citation, the place read) or deleted it.
        doc = await session.get(Document, document_id, populate_existing=True)
        if doc is None:
            return
        report: dict = {"finished_at": utcnow().isoformat(), "from_version": before}
        new_text = not isinstance(out, str) and out.content != doc.content_clean  # its figures to describe
        if isinstance(out, str):
            doc.reprocess_state = "failed"
            report["error"] = out
        else:
            apply_extraction(doc, out)
            blocks = anchors.text_blocks(out.content, out.source_map)
            rows = (
                await session.scalars(
                    select(Highlight).where(Highlight.document_id == doc.id).order_by(Highlight.created_at)
                )
            ).all()
            await session.flush()  # the new text and its source map, which the highlights are placed in
            report["anchors"] = await highlight_sync.recheck(session, settings, doc, list(rows))
            # TSD §9.1 step 6: a place in a block the new text no longer has falls back to the page and the
            # fraction read; the old place is kept in the report.
            place = doc.read_position or {}
            if place.get("block_id") and place["block_id"] not in {b.id for b in blocks}:
                report["read_position"] = place
                doc.read_position = None
            report["to_version"] = doc.content_version
            doc.reprocess_state = "done"
        doc.reprocess_report = report
        drop_unused_images(settings, doc)
        await session.commit()
        done = doc.reprocess_state == "done" and new_text
        log.info("reprocess document=%s state=%s", document_id, doc.reprocess_state)  # no text in the log
    if done:
        await describe_figures(document_id, settings)


@router.post("/{document_id}/reprocess", response_model=DocumentOut, status_code=status.HTTP_202_ACCEPTED)
async def reprocess_document(
    document_id: uuid.UUID,
    background: BackgroundTasks,
    user: CurrentUser,
    session: SessionDep,
    settings: SettingsDep,
):
    """Clean Reader CR-FR-15/16: read the document's file again, after the response. Asked for again while
    it runs (TC-20), it starts nothing new and gives the same state."""
    doc = await _owned_document(session, user, document_id)
    if not doc.file_storage_path:
        raise HTTPException(status.HTTP_409_CONFLICT, "Tài liệu này không có tệp gốc để xử lý lại.")
    if doc.extraction_status not in (ExtractionStatus.done, ExtractionStatus.failed):
        raise HTTPException(status.HTTP_409_CONFLICT, "Tài liệu đang được trích xuất, vui lòng chờ.")
    now = utcnow()
    claimed = await session.execute(
        update(Document)
        .where(
            Document.id == doc.id,
            or_(
                Document.reprocess_state.is_(None),
                Document.reprocess_state != "running",
                Document.reprocess_started_at < now - REPROCESS_STALE,
            ),
        )
        .values(reprocess_state="running", reprocess_started_at=now)
        .execution_options(synchronize_session=False)
    )
    await session.commit()
    if claimed.rowcount:
        background.add_task(reprocess, doc.id, settings)
    await session.refresh(doc)
    return doc


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

    if await _takes_long(settings, doc, size, user):
        background.add_task(_extract_in_background, doc.id, settings)
    else:
        await run_extraction(session, doc, settings, background)
    await session.refresh(doc)
    return doc


async def _commit_new_link(session: AsyncSession, doc: Document, user: User, url: str) -> JSONResponse | None:
    """Insert a saved link; if a concurrent request saved the same URL first, return that one (BR-03)."""
    doc.license = doc.license or await rights.license_of_url(session, url)
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


async def _save_fetched_pdf(
    fetched: web.FetchResult,
    url: str,
    user: User,
    session: AsyncSession,
    settings: Settings,
    background: BackgroundTasks,
) -> Document | JSONResponse:
    """Keep a PDF fetched from `url` and extract it."""
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
        url=url,
        title=Path(name).stem[:500],
        file_storage_path=relative,
        original_filename=name[:500],
        file_size=len(fetched.body),
    )
    if (dup := await _commit_new_link(session, doc, user, url)) is not None:
        storage.delete_file(settings, relative)
        return dup
    if await _takes_long(settings, doc, len(fetched.body), user):
        background.add_task(_extract_in_background, doc.id, settings)
    else:
        await run_extraction(session, doc, settings, background)
    await session.refresh(doc)
    return doc


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
        return await _save_fetched_pdf(fetched, normalized, user, session, settings, background)
    article = await run_in_threadpool(web.extract_article, fetched.body, fetched.url)
    if article.paywalled:
        # What such a page shows is a preview: saving it would pass an abstract or a list of references off
        # as the document.
        raise HTTPException(422, MSG["MSG-18-PAYWALL"])
    if article.word_count < web.MIN_ARTICLE_WORDS:
        # Not a whole article: a teaser, an abstract, a page of links, or one a script fills in. Nothing is
        # kept, so the Library never holds a fragment that passes for the document.
        raise HTTPException(422, MSG["MSG-18-SHORT"])
    doc = Document(
        user_id=user.id,
        source_type=SourceType.manual,
        url=normalized,
        title=article.title or normalized[:500],
        content_clean=article.content,
        word_count=article.word_count,
        published_at=article.published_at,
        extraction_status=ExtractionStatus.done,
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


@router.get("/{document_id}/aside")
async def get_aside(document_id: uuid.UUID, user: CurrentUser, session: SessionDep):
    """Clean Reader (CR-FR-13): the blocks taken out of the reading flow, kept on the side — authors,
    affiliations, the journal's lines, references, funding, running headers, page numbers… —
    `{"classifier", "blocks": [{id, type, text, page, box, confidence, reason}, …]}` in document order, `box`
    as fractions of its page. `classifier` is null for a document extracted before there was one."""
    await _owned_document(session, user, document_id)
    aside = await session.scalar(select(Document.content_aside).where(Document.id == document_id))
    aside = aside or {}
    blocks = [{"id": n, **block} for n, block in enumerate(aside.get("blocks") or [])]
    return JSONResponse(
        {"classifier": aside.get("classifier"), "blocks": blocks},
        headers={"Cache-Control": "private, no-cache"},
    )


class ExtractionReportIn(BaseModel):
    error_type: Literal[EXTRACTION_ERRORS]  # type: ignore[valid-type]
    page: int | None = Field(default=None, ge=1)
    block: int | None = Field(default=None, ge=0)
    note: str | None = Field(default=None, max_length=1000)


class ExtractionReportOut(BaseModel):
    id: uuid.UUID
    error_type: str
    page: int | None
    block: int | None


@router.post("/{document_id}/extraction-reports", status_code=status.HTTP_201_CREATED)
async def report_extraction(
    document_id: uuid.UUID, body: ExtractionReportIn, user: CurrentUser, session: SessionDep
) -> ExtractionReportOut:
    """CR-FR-15: the owner says the clean text is wrong. The same report sent twice is kept once."""
    doc = await _owned_document(session, user, document_id)
    if body.page is not None and doc.page_count and body.page > doc.page_count:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Trang không có trong tài liệu.")
    aside = await session.scalar(select(Document.content_aside).where(Document.id == document_id)) or {}
    blocks = aside.get("blocks") or []
    block_type = None
    if body.block is not None:
        if body.block >= len(blocks):
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Không tìm thấy khối này.")
        block_type = blocks[body.block].get("type")
    note = (body.note or "").strip() or None
    same = await session.scalar(
        select(ExtractionReport).where(
            ExtractionReport.document_id == doc.id,
            ExtractionReport.user_id == user.id,
            ExtractionReport.error_type == body.error_type,
            ExtractionReport.page.is_(None) if body.page is None else ExtractionReport.page == body.page,
            ExtractionReport.block.is_(None) if body.block is None else ExtractionReport.block == body.block,
            ExtractionReport.note.is_(None) if note is None else ExtractionReport.note == note,
            ExtractionReport.classifier.is_(None)
            if aside.get("classifier") is None
            else ExtractionReport.classifier == aside.get("classifier"),
        )
    )
    if same is None:
        same = ExtractionReport(
            document_id=doc.id,
            user_id=user.id,
            error_type=body.error_type,
            page=body.page,
            block=body.block,
            block_type=block_type,
            classifier=aside.get("classifier"),
            note=note,
        )
        session.add(same)
        await session.commit()
    # Only the type is logged: what the reader wrote stays in the database (no document text in logs).
    log.info("extraction report document=%s type=%s", doc.id, body.error_type)
    return ExtractionReportOut(id=same.id, error_type=same.error_type, page=same.page, block=same.block)


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
    if "collection_id" in payload.model_fields_set:  # null is a value here: off the shelf
        if payload.collection_id is not None:
            shelf = await session.get(Collection, payload.collection_id)
            if shelf is None or shelf.user_id != user.id:  # NFR-SEC-04
                raise HTTPException(status.HTTP_404_NOT_FOUND, MSG["MSG-COLLECTION-404"])
        doc.collection_id = payload.collection_id
        data.pop("collection_id", None)
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


@router.get("/{document_id}/usage", response_model=DocumentUsage)
async def document_usage(document_id: uuid.UUID, user: CurrentUser, session: SessionDep):
    """What removing the document affects, so the dialog can say so before anything goes."""
    doc = await _owned_document(session, user, document_id)
    highlights = await session.scalar(select(func.count(Highlight.id)).where(Highlight.document_id == doc.id))
    notes = await session.scalar(
        select(func.count(Highlight.id)).where(
            Highlight.document_id == doc.id, Highlight.note.is_not(None), Highlight.note != ""
        )
    )
    # Notes of the document's own (the reader's and the ones kept from the AI) go with it too.
    free = await session.scalar(select(func.count(Note.id)).where(Note.document_id == doc.id))
    notes = (notes or 0) + (free or 0)
    through = (
        select(NotebookHighlight.notebook_id)
        .join(Highlight, Highlight.id == NotebookHighlight.highlight_id)
        .where(Highlight.document_id == doc.id)
    )
    linked = select(NotebookDocument.notebook_id).where(NotebookDocument.document_id == doc.id)
    notebooks = await session.scalar(select(func.count()).select_from(through.union(linked).subquery()))
    posts = await session.scalar(
        select(func.count(func.distinct(PostSource.post_id)))
        .join(Post, Post.id == PostSource.post_id)
        .where(PostSource.document_id == doc.id, Post.user_id == user.id)
    )
    summary = await session.scalar(select(Summary.id).where(Summary.document_id == doc.id))
    if summary is None:  # the reader's AI sidebar keeps its summaries and mind map with the document too
        summary = await session.scalar(select(AiArtifact.id).where(AiArtifact.document_id == doc.id).limit(1))
    return DocumentUsage(
        highlights=highlights or 0,
        notes=notes or 0,
        has_summary=summary is not None,
        notebooks=notebooks or 0,
        posts=posts or 0,
    )


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
