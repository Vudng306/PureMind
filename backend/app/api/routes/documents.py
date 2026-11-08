import logging
import re
import uuid
from pathlib import Path
from typing import Literal

import httpx
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, UploadFile, status
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import defer
from starlette.concurrency import run_in_threadpool

from app.api.deps import CurrentUser, SessionDep, SettingsDep
from app.core.config import Settings
from app.core.messages import MSG
from app.core.ratelimit import doi_limiter, upload_limiter
from app.db.session import SessionLocal
from app.models import Article as CatalogArticle
from app.models import (
    ArticleTopic,
    Collection,
    Document,
    ExtractionStatus,
    Highlight,
    NotebookDocument,
    NotebookHighlight,
    Post,
    PostSource,
    SourceType,
    Summary,
    User,
)
from app.schemas import DocumentListItem, DocumentOut, DocumentUpdate, DocumentUsage, DoiLookup
from app.services import doi, equation_ocr, figure_notes, page_ocr, rights, storage, table_ocr, web
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
from app.services.html_markdown import word_count

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
        DocumentListItem.model_validate(d).model_copy(update={"topics": topics.get(d.url or "", [])}) for d in docs
    ]


def ai_consented(user: User | None) -> bool:
    """NFR-PRV: the user agreed to send their content to OpenAI. Until then extraction reads no picture
    (scanned pages, tables, equations, figures): those stay pictures, a scan has no clean text."""
    return bool(user and (user.reading_preferences or {}).get("ai_consent"))


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
    ai = ai_consented(await session.get(User, doc.user_id))

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
            read = await page_ocr.read_pages(settings, path, result.ocr_pages) if ai else {}
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
        if not doc.citation:  # a title that came with the DOI is the publisher's own
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
    work: doi.Work | None = None,
) -> Document | JSONResponse:
    """Keep a PDF fetched from `url` and extract it. `work` is what its DOI says it is, when it came by one."""
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
        title=work.title if work else Path(name).stem[:500],
        file_storage_path=relative,
        original_filename=name[:500],
        file_size=len(fetched.body),
        citation=work.citation if work else None,
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


class DoiIn(BaseModel):
    doi: str


async def _lookup_doi(raw: str, user: User, settings: Settings) -> doi.Work:
    try:
        doi.parse(raw)
    except doi.InvalidDoi:
        raise HTTPException(422, MSG["MSG-DOI-INVALID"]) from None
    if not doi_limiter.hit(str(user.id)):
        raise HTTPException(429, MSG["MSG-DOI-LIMIT"])
    try:
        return await doi.lookup(raw, settings.web_contact)
    except doi.DoiNotFound:
        raise HTTPException(422, MSG["MSG-DOI-NOTFOUND"]) from None


@router.get("/doi-lookup", response_model=DoiLookup)
async def lookup_doi(doi: str, user: CurrentUser, settings: SettingsDep):
    """What a DOI names, to fill in the citation of a document the user already has."""
    work = await _lookup_doi(doi, user, settings)
    return {"title": work.title, "citation": work.citation}


@router.post(
    "/import-doi",
    response_model=DocumentOut,
    status_code=status.HTTP_201_CREATED,
    responses={200: {"model": DocumentOut, "description": "The DOI was already imported"}},
)
async def import_doi(
    payload: DoiIn,
    background: BackgroundTasks,
    user: CurrentUser,
    session: SessionDep,
    settings: SettingsDep,
):
    """Add a work by its DOI: the citation from doi.org, the text from wherever the DOI leads.

    That is the publisher's page, or the PDF itself (for arXiv, always the PDF). A publisher that refuses
    PureMind or shows nothing without a subscription leaves the abstract, if doi.org has one; with no text
    at all nothing is saved, as a document that cannot be read is of no use in the library."""
    try:
        url = doi.url_of(doi.parse(payload.doi))
    except doi.InvalidDoi:
        raise HTTPException(422, MSG["MSG-DOI-INVALID"]) from None
    existing = await session.scalar(select(Document).where(Document.user_id == user.id, Document.url == url))
    if existing is not None:
        return JSONResponse(DocumentOut.model_validate(existing).model_dump(mode="json"), status_code=200)

    work = await _lookup_doi(payload.doi, user, settings)
    rate_limited_upload(user)
    fetched = None
    for source in (*doi.open_pdf_urls(work.doi), url):
        try:
            fetched = await web.fetch_url(source, settings.web_contact)
            break
        except (web.InvalidUrl, web.BlockedAddress, web.FetchFailed):
            continue

    if fetched is not None and fetched.body.startswith(b"%PDF"):
        return await _save_fetched_pdf(fetched, url, user, session, settings, background, work)
    content = ""
    if fetched is not None and not web.is_pdf(fetched):
        content = (await run_in_threadpool(web.extract_article, fetched.body, fetched.url)).content
    if word_count(content) < word_count(work.abstract):
        content = work.abstract  # the page gave less than its own abstract: a paywall, or a cookie notice
    if not content.strip():
        raise HTTPException(422, MSG["MSG-DOI-NOTEXT"])
    doc = Document(
        user_id=user.id,
        source_type=SourceType.manual,
        url=url,
        title=work.title,
        content_clean=content,
        word_count=word_count(content),
        extraction_status=ExtractionStatus.done,
        citation=work.citation,
    )
    if (dup := await _commit_new_link(session, doc, user, url)) is not None:
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
