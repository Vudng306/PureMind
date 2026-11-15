"""Notes on a document, and the notebook: the user's highlights and notes, one group per document.

A document is in the notebook as soon as it has one highlight or one note — nothing is copied there, the
notebook reads the same rows the reader writes. What the AI wrote gets in only through `POST /notes/from-ai`,
when the reader asks to keep a piece of it; the text is then read from the stored result, not from the request.
"""

import hashlib
import uuid
from datetime import UTC, datetime
from typing import Literal

from fastapi import APIRouter, HTTPException, Query, Response, status
from sqlalchemy import case, func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import CurrentUser, SessionDep, SettingsDep
from app.api.routes.documents import _owned_document
from app.api.routes.search import _Searcher, _terms, normalize_query
from app.core.messages import MSG
from app.models import (
    MAX_NOTE_BODY,
    MAX_NOTES_PER_DOCUMENT,
    AiArtifact,
    ChatConversation,
    ChatMessage,
    Document,
    Highlight,
    Note,
    User,
)
from app.schemas import (
    NotebookGroup,
    NotebookGroupDetail,
    NotebookGroupPage,
    NoteCreate,
    NoteFromAi,
    NoteFromTranslation,
    NoteOut,
    NoteUpdate,
    file_type_of,
)
from app.services import reader_ai

router = APIRouter(tags=["notes"])

NOT_FOUND = "Không tìm thấy ghi chú."
TOO_MANY = "Tài liệu này đã có quá nhiều ghi chú."
NO_SOURCE = "Không tìm thấy nội dung AI để lưu."
NO_PART = "Phần được chọn không còn trong kết quả AI."
NOT_IN_NOTEBOOK = "Tài liệu này chưa có highlight hay ghi chú nào."


async def _owned_note(session: AsyncSession, user: User, note_id: uuid.UUID) -> Note:
    note = await session.get(Note, note_id)
    if note is None or note.user_id != user.id:  # NFR-SEC-04: someone else's note looks like a missing one
        raise HTTPException(status.HTTP_404_NOT_FOUND, NOT_FOUND)
    return note


async def _room(session: AsyncSession, document_id: uuid.UUID) -> None:
    count = await session.scalar(
        select(func.count()).select_from(Note).where(Note.document_id == document_id)
    )
    if (count or 0) >= MAX_NOTES_PER_DOCUMENT:
        raise HTTPException(422, TOO_MANY)


@router.get("/documents/{document_id}/notes", response_model=list[NoteOut])
async def list_notes(document_id: uuid.UUID, user: CurrentUser, session: SessionDep):
    """The document's notes, oldest first: the reader's own and the ones kept from the AI."""
    doc = await _owned_document(session, user, document_id)
    return (
        await session.scalars(
            select(Note)
            .where(Note.document_id == doc.id, Note.user_id == user.id)
            .order_by(Note.created_at, Note.id)
        )
    ).all()


@router.post("/documents/{document_id}/notes", response_model=NoteOut, status_code=status.HTTP_201_CREATED)
async def create_note(
    document_id: uuid.UUID, payload: NoteCreate, response: Response, user: CurrentUser, session: SessionDep
):
    """A note of the reader's own. Sent again with the same id, it gives the note already saved (200)."""
    doc = await _owned_document(session, user, document_id)
    if payload.id is not None and (existing := await session.get(Note, payload.id)) is not None:
        if existing.user_id != user.id or existing.document_id != doc.id:
            raise HTTPException(status.HTTP_409_CONFLICT, "Ghi chú đã tồn tại.")
        response.status_code = status.HTTP_200_OK
        return existing
    await _room(session, doc.id)
    note = Note(id=payload.id or uuid.uuid4(), user_id=user.id, document_id=doc.id, body=payload.body)
    session.add(note)
    try:
        await session.commit()
    except IntegrityError:  # the same id arrived twice at once
        await session.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, "Ghi chú đã tồn tại.") from None
    await session.refresh(note)
    return note


@router.patch("/notes/{note_id}", response_model=NoteOut)
async def update_note(note_id: uuid.UUID, payload: NoteUpdate, user: CurrentUser, session: SessionDep):
    """Edit the text. A note kept from the AI stays marked as such, with where it came from."""
    note = await _owned_note(session, user, note_id)
    note.body = payload.body
    await session.commit()
    await session.refresh(note)
    return note


@router.delete("/notes/{note_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_note(note_id: uuid.UUID, user: CurrentUser, session: SessionDep):
    note = await _owned_note(session, user, note_id)
    await session.delete(note)
    await session.commit()


@router.post("/notes/from-ai", response_model=NoteOut, status_code=status.HTTP_201_CREATED)
async def save_from_ai(payload: NoteFromAi, response: Response, user: CurrentUser, session: SessionDep):
    """Keep a piece of a summary, a mind-map node or a chat answer as a note.

    The same piece saved twice gives the note already there (200), so a double click makes one note.
    """
    if payload.source == "artifact":
        artifact = await session.get(AiArtifact, payload.source_id)
        doc = await session.get(Document, artifact.document_id) if artifact else None
        if artifact is None or doc is None or doc.user_id != user.id:
            raise HTTPException(status.HTTP_404_NOT_FOUND, NO_SOURCE)
        piece = reader_ai.note_text(artifact.kind, artifact.payload, payload.part, artifact.language)
        if piece is None:
            raise HTTPException(422, NO_PART)
        body, citations = piece
        source, model, language, made = (
            artifact.kind,
            artifact.ai_model,
            artifact.language,
            artifact.created_at,
        )
        document_id = doc.id
    else:
        message = await session.get(ChatMessage, payload.source_id)
        conv = await session.get(ChatConversation, message.conversation_id) if message else None
        if message is None or conv is None or conv.user_id != user.id or message.role != "assistant":
            raise HTTPException(status.HTTP_404_NOT_FOUND, NO_SOURCE)
        if payload.part != "all":
            raise HTTPException(422, NO_PART)
        body, citations = message.content, list(message.citations or [])
        source, model, language, made = "chat", message.ai_model, conv.language, message.created_at
        document_id = conv.document_id

    provenance = {
        "source": source,
        "source_id": str(payload.source_id),
        "part": payload.part,
        "model": model,
        "language": language,
        "generated_at": made.isoformat() if made else None,
        "citations": citations,
    }
    key = f"{source}:{payload.source_id}:{payload.part}"
    return await _keep(session, response, user, document_id, body, provenance, key)


@router.post(
    "/documents/{document_id}/notes/translation", response_model=NoteOut, status_code=status.HTTP_201_CREATED
)
async def save_translation(
    document_id: uuid.UUID,
    payload: NoteFromTranslation,
    response: Response,
    user: CurrentUser,
    session: SessionDep,
    settings: SettingsDep,
):
    """AN-107: keep the translation of a selected passage as a note, marked as the AI's translation, with the
    passage beside it as it is in the document. A translation is not stored on the server, so its text comes
    from the request; it only ever lands in the user's own notes. The same passage and language saved twice
    gives the note already there (200)."""
    doc = await _owned_document(session, user, document_id)
    digest = hashlib.sha256(f"{payload.target}\n{payload.quote}".encode()).hexdigest()[:40]
    provenance = {
        "source": "translation",
        "source_id": None,
        "part": payload.target,
        "quote": payload.quote,
        "model": settings.openai_model,
        "language": payload.target,
        "generated_at": datetime.now(UTC).isoformat(),
        "citations": [],
    }
    key = f"translation:{doc.id}:{digest}"
    return await _keep(session, response, user, doc.id, payload.translation, provenance, key)


async def _keep(
    session: AsyncSession,
    response: Response,
    user: User,
    document_id: uuid.UUID,
    body: str,
    provenance: dict,
    key: str,
) -> Note:
    """Store what the AI wrote as the user's note, once: the same `key` again gives the note already there."""
    saved = select(Note).where(Note.user_id == user.id, Note.source_key == key)
    if (existing := await session.scalar(saved)) is not None:
        response.status_code = status.HTTP_200_OK
        return existing
    await _room(session, document_id)
    note = Note(
        user_id=user.id,
        document_id=document_id,
        body=body[:MAX_NOTE_BODY],
        origin="ai_saved",
        provenance=provenance,
        source_key=key,
    )
    session.add(note)
    try:
        await session.commit()
    except IntegrityError:  # two clicks at once: the other request saved it
        await session.rollback()
        existing = await session.scalar(saved)
        if existing is None:
            raise HTTPException(status.HTTP_409_CONFLICT, MSG["MSG-99"]) from None
        response.status_code = status.HTTP_200_OK
        return existing
    await session.refresh(note)
    return note


# --- The notebook: one group per document -------------------------------------------------------------------


async def _groups(
    session: AsyncSession, user: User, document_id: uuid.UUID | None = None
) -> list[NotebookGroup]:
    """Every document of the user's with at least one highlight or note, most recently worked on first."""
    hl = (
        select(
            Highlight.document_id.label("d"),
            func.count().label("n"),
            func.sum(case((Highlight.note != "", 1), else_=0)).label("noted"),
            func.max(Highlight.updated_at).label("last"),
        )
        .where(Highlight.user_id == user.id)
        .group_by(Highlight.document_id)
        .subquery()
    )
    nt = (
        select(
            Note.document_id.label("d"),
            func.sum(case((Note.origin == "user", 1), else_=0)).label("own"),
            func.sum(case((Note.origin == "ai_saved", 1), else_=0)).label("ai"),
            func.max(Note.updated_at).label("last"),
        )
        .where(Note.user_id == user.id)
        .group_by(Note.document_id)
        .subquery()
    )
    stmt = (
        select(
            Document.id,
            Document.title,
            Document.source_type,
            Document.original_filename,
            Document.read_fraction,
            Document.is_read,
            hl.c.n,
            hl.c.noted,
            hl.c.last.label("hl_last"),
            nt.c.own,
            nt.c.ai,
            nt.c.last.label("nt_last"),
        )
        .outerjoin(hl, hl.c.d == Document.id)
        .outerjoin(nt, nt.c.d == Document.id)
        .where(Document.user_id == user.id, or_(hl.c.d.is_not(None), nt.c.d.is_not(None)))
    )
    if document_id is not None:
        stmt = stmt.where(Document.id == document_id)
    groups = [
        NotebookGroup(
            document_id=r.id,
            title=r.title,
            file_type=file_type_of(r.source_type, r.original_filename),
            read_fraction=r.read_fraction,
            is_read=r.is_read,
            highlight_count=r.n or 0,
            note_count=(r.noted or 0) + (r.own or 0),
            insight_count=r.ai or 0,
            last_activity_at=max(t for t in (r.hl_last, r.nt_last) if t is not None),
        )
        for r in (await session.execute(stmt)).all()
    ]
    return sorted(groups, key=lambda g: g.last_activity_at, reverse=True)


async def _matches(session: AsyncSession, user: User, query: str) -> dict[uuid.UUID, int]:
    """Documents a search finds: by a highlight's text or note, by a note, or by title (0 matches inside)."""
    s = _Searcher(session, query)
    found: dict[uuid.UUID, int] = {}
    titles = select(Document.id).where(Document.user_id == user.id, s.match(Document.title))
    for document_id in (await session.scalars(titles)).all():
        found[document_id] = 0
    counts = (
        select(Highlight.document_id, func.count())
        .where(Highlight.user_id == user.id, or_(s.match(Highlight.selected_text), s.match(Highlight.note)))
        .group_by(Highlight.document_id),
        select(Note.document_id, func.count())
        .where(Note.user_id == user.id, s.match(Note.body))
        .group_by(Note.document_id),
    )
    for stmt in counts:
        for document_id, n in (await session.execute(stmt)).all():
            found[document_id] = found.get(document_id, 0) + n
    return found


@router.get("/notebook/documents", response_model=NotebookGroupPage)
async def notebook_documents(
    user: CurrentUser,
    session: SessionDep,
    q: str = Query("", max_length=200),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
):
    """The notebook's front page. `q` keeps the documents whose title, highlights or notes match."""
    groups = await _groups(session, user)
    query = normalize_query(q)
    if len(query) >= 2 and _terms(query):
        found = await _matches(session, user, query)
        groups = [
            g.model_copy(update={"match_count": found[g.document_id]})
            for g in groups
            if g.document_id in found
        ]
    start = (page - 1) * page_size
    return NotebookGroupPage(items=groups[start : start + page_size], total=len(groups))


def _reading_order(content: str, page_count: int | None, highlights: list[Highlight]) -> list[Highlight]:
    """Highlights in the order their passages come in the document.

    A highlight is anchored to a block of the rendered text or to a PDF page, neither of which says how far
    into the document it is; so each is placed where its first words are found in the text, failing that by
    its page, and failing that at the end, oldest first.
    """
    text = " ".join(content.split()).casefold()

    def place(h: Highlight) -> int:
        words = " ".join(h.selected_text.split()).casefold()
        for size in (60, 24):
            if (needle := words[:size]) and (at := text.find(needle)) >= 0:
                return at
        if h.page_number and page_count:
            return int((h.page_number - 1) / page_count * len(text))
        return len(text)

    return sorted(highlights, key=lambda h: (place(h), h.created_at))


@router.get("/notebook/documents/{document_id}", response_model=NotebookGroupDetail)
async def notebook_document(
    document_id: uuid.UUID,
    user: CurrentUser,
    session: SessionDep,
    sort: Literal["document", "newest"] = "document",
):
    """One document's page of the notebook: its highlights (each with its note) and its notes."""
    doc = await _owned_document(session, user, document_id)
    groups = await _groups(session, user, doc.id)
    if not groups:
        raise HTTPException(status.HTTP_404_NOT_FOUND, NOT_IN_NOTEBOOK)
    highlights = list(
        (
            await session.scalars(
                select(Highlight)
                .where(Highlight.document_id == doc.id, Highlight.user_id == user.id)
                .order_by(Highlight.created_at.desc(), Highlight.id)
            )
        ).all()
    )
    notes = list(
        (
            await session.scalars(
                select(Note)
                .where(Note.document_id == doc.id, Note.user_id == user.id)
                .order_by(Note.created_at, Note.id)
            )
        ).all()
    )
    if sort == "document":
        highlights = _reading_order(doc.content_clean, doc.page_count, highlights)
    else:
        notes.reverse()
    return NotebookGroupDetail(group=groups[0], highlights=highlights, notes=notes)
