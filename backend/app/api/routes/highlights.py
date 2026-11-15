import uuid
from typing import Literal

from fastapi import APIRouter, HTTPException, Query, Response, status
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import CurrentUser, SessionDep
from app.api.routes.documents import _owned_document
from app.models import Document, Highlight, Note, User
from app.schemas import (
    AnnotationsImport,
    AnnotationsImportResult,
    HighlightBase,
    HighlightCategory,
    HighlightColor,
    HighlightCreate,
    HighlightOut,
    HighlightPage,
    HighlightUpdate,
    NoteIn,
    file_type_of,
)

router = APIRouter(tags=["highlights"])

MAX_HIGHLIGHTS_PER_DOCUMENT = 2000
NOT_FOUND = "Không tìm thấy highlight."
EXISTS = "Highlight đã tồn tại."


def _position_error(doc: Document, h: HighlightBase) -> str | None:
    """PDF positions only make sense on a PDF, on one of its pages."""
    if h.rects is None:
        return None
    if file_type_of(doc.source_type, doc.original_filename) != "pdf":
        return "Tài liệu này không có bản gốc PDF để highlight."
    if doc.page_count and h.page_number and h.page_number > doc.page_count:
        return "Trang không tồn tại trong tài liệu."
    return None


async def _owned_highlight(session: AsyncSession, user: User, highlight_id: uuid.UUID) -> Highlight:
    hl = await session.get(Highlight, highlight_id)
    if hl is None or hl.user_id != user.id:  # NFR-SEC-04
        raise HTTPException(status.HTTP_404_NOT_FOUND, NOT_FOUND)
    return hl


@router.get("/highlights", response_model=HighlightPage)
async def list_highlights(
    user: CurrentUser,
    session: SessionDep,
    document_id: uuid.UUID | None = None,
    category: HighlightCategory | None = None,
    color: HighlightColor | None = None,
    sort: Literal["newest", "document"] = "newest",
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=500),
):
    """FR-HL-05: the user's highlights, filtered and paged."""
    where = [Highlight.user_id == user.id]
    if document_id:
        where.append(Highlight.document_id == document_id)
    if category:
        where.append(Highlight.category == category)
    if color:
        where.append(Highlight.color == color)

    total = await session.scalar(select(func.count()).select_from(Highlight).where(*where)) or 0
    stmt = select(Highlight).where(*where)
    if sort == "document":
        stmt = stmt.join(Document, Document.id == Highlight.document_id).order_by(
            Document.title, Highlight.page_number.nulls_first(), Highlight.created_at
        )
    else:
        stmt = stmt.order_by(Highlight.created_at.desc(), Highlight.id)
    items = (await session.scalars(stmt.offset((page - 1) * page_size).limit(page_size))).all()
    return HighlightPage(items=items, total=total)


def _saved_already(existing: Highlight, user: User, doc: Document) -> Highlight:
    """AN-105: the id is the client's key for one highlight, so sending it again gives the one saved.
    Someone else's id, or one used on another document, is a conflict and says nothing about that row."""
    if existing.user_id != user.id or existing.document_id != doc.id:
        raise HTTPException(status.HTTP_409_CONFLICT, EXISTS)
    return existing


@router.post("/highlights", response_model=HighlightOut, status_code=status.HTTP_201_CREATED)
async def create_highlight(
    payload: HighlightCreate, response: Response, user: CurrentUser, session: SessionDep
):
    """FR-HL-01. Sent again with the same id (a retry after a lost reply), it gives the highlight already
    saved (200) instead of a second one."""
    doc = await _owned_document(session, user, payload.document_id)
    if payload.id is not None and (existing := await session.get(Highlight, payload.id)) is not None:
        response.status_code = status.HTTP_200_OK
        return _saved_already(existing, user, doc)
    count = await session.scalar(select(func.count()).where(Highlight.document_id == doc.id))
    if (count or 0) >= MAX_HIGHLIGHTS_PER_DOCUMENT:
        raise HTTPException(422, "Tài liệu này đã có quá nhiều highlight.")
    if error := _position_error(doc, payload):
        raise HTTPException(422, error)

    data = payload.model_dump(exclude={"id", "document_id"})
    new_id = payload.id or uuid.uuid4()
    hl = Highlight(
        id=new_id,
        user_id=user.id,
        document_id=doc.id,
        content_version=doc.content_version,  # the server's own reading of which text this is
        **data,
    )
    session.add(hl)
    try:
        await session.commit()
    except IntegrityError:  # the same id arrived twice at once
        await session.rollback()
        existing = await session.get(Highlight, new_id)
        if existing is None:
            raise HTTPException(status.HTTP_409_CONFLICT, EXISTS) from None
        response.status_code = status.HTTP_200_OK
        return _saved_already(existing, user, doc)
    await session.refresh(hl)
    return hl


@router.patch("/highlights/{highlight_id}", response_model=HighlightOut)
async def update_highlight(
    highlight_id: uuid.UUID, payload: HighlightUpdate, user: CurrentUser, session: SessionDep
):
    """FR-HL-03, FR-HL-04."""
    hl = await _owned_highlight(session, user, highlight_id)
    data = payload.model_dump(exclude_unset=True)
    if data.get("color") is not None:
        hl.color = data["color"]
    if "category" in data:
        hl.category = data["category"]
    await session.commit()
    await session.refresh(hl)
    return hl


@router.delete("/highlights/{highlight_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_highlight(highlight_id: uuid.UUID, user: CurrentUser, session: SessionDep):
    hl = await _owned_highlight(session, user, highlight_id)
    await session.delete(hl)
    await session.commit()


@router.put("/highlights/{highlight_id}/note", response_model=HighlightOut)
async def put_note(highlight_id: uuid.UUID, payload: NoteIn, user: CurrentUser, session: SessionDep):
    """FR-NOTE-01: create or replace the highlight's single note."""
    hl = await _owned_highlight(session, user, highlight_id)
    hl.note = payload.content
    await session.commit()
    await session.refresh(hl)
    return hl


@router.delete("/highlights/{highlight_id}/note", status_code=status.HTTP_204_NO_CONTENT)
async def delete_note(highlight_id: uuid.UUID, user: CurrentUser, session: SessionDep):
    hl = await _owned_highlight(session, user, highlight_id)
    hl.note = ""
    await session.commit()


@router.post("/annotations/import", response_model=AnnotationsImportResult)
async def import_annotations(payload: AnnotationsImport, user: CurrentUser, session: SessionDep):
    """One-time move of browser-local data. Idempotent: known ids, existing notes and progress are kept."""
    wanted = {h.document_id for h in payload.highlights} | set(payload.notes) | set(payload.progress)
    docs = (
        {
            d.id: d
            for d in (
                await session.scalars(
                    select(Document).where(Document.user_id == user.id, Document.id.in_(wanted))
                )
            ).all()
        }
        if wanted
        else {}
    )

    ids = [h.id for h in payload.highlights if h.id]
    existing = (
        set((await session.scalars(select(Highlight.id).where(Highlight.id.in_(ids)))).all())
        if ids
        else set()
    )

    added = 0
    for h in payload.highlights:
        if (
            h.document_id not in docs
            or (h.id and h.id in existing)
            or _position_error(docs[h.document_id], h)
        ):
            continue
        data = h.model_dump(exclude={"id", "document_id", "created_at"})
        hl = Highlight(id=h.id or uuid.uuid4(), user_id=user.id, document_id=h.document_id, **data)
        if h.created_at:
            hl.created_at = h.created_at
        session.add(hl)
        if h.id:
            existing.add(h.id)
        added += 1

    # A document's locally kept note becomes its first note, unless it already has one of the reader's own.
    noted = (
        set(
            (
                await session.scalars(
                    select(Note.document_id).where(Note.user_id == user.id, Note.document_id.in_(docs))
                )
            ).all()
        )
        if docs
        else set()
    )
    notes = 0
    for doc_id, text in payload.notes.items():
        doc = docs.get(doc_id)
        if doc and text.strip() and doc_id not in noted:
            session.add(Note(user_id=user.id, document_id=doc_id, body=text))
            notes += 1

    progress = 0
    for doc_id, fraction in payload.progress.items():
        doc = docs.get(doc_id)
        if doc and doc.read_fraction is None:
            doc.read_fraction = fraction
            progress += 1

    await session.commit()
    return AnnotationsImportResult(
        highlights=added,
        notes=notes,
        progress=progress,
        unknown_documents=sorted(wanted - set(docs), key=str),
    )
