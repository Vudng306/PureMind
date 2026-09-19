"""FR-NB-01..05: AI notebooks built from highlights."""

import json
import logging
import uuid
from collections.abc import AsyncIterator
from datetime import timedelta

from fastapi import APIRouter, HTTPException, Request, status
from fastapi.responses import JSONResponse, StreamingResponse
from sqlalchemy import delete, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import CurrentUser, SessionDep, SettingsDep
from app.api.routes.highlights import NOT_FOUND as HIGHLIGHT_NOT_FOUND
from app.api.routes.summaries import CONSENT_REQUIRED, NOT_CONFIGURED
from app.core.config import Settings
from app.core.messages import MSG
from app.db.session import SessionLocal
from app.models import (
    MAX_NOTEBOOK_CHARS,
    MAX_NOTEBOOK_SOURCES,
    MAX_NOTEBOOK_VERSIONS,
    Document,
    Highlight,
    Notebook,
    NotebookHighlight,
    NotebookVersion,
    User,
    utcnow,
)
from app.schemas import (
    HighlightOut,
    NotebookGenerate,
    NotebookListItem,
    NotebookOut,
    NotebookSource,
    NotebookUpdate,
    NotebookVersionItem,
    NotebookVersionOut,
    file_type_of,
)
from app.services import ai_quota, notebook_writer
from app.services.openai_client import AIError, Usage
from app.services.summarizer import detect_language

router = APIRouter(prefix="/notebooks", tags=["notebooks"])
log = logging.getLogger("app.notebooks")

NOT_FOUND = "Không tìm thấy notebook."
VERSION_NOT_FOUND = "Không tìm thấy phiên bản."
EMPTY_TITLE = "Tiêu đề không được để trống."
IN_PROGRESS = "Một notebook đang được tạo. Vui lòng đợi xong."
DRAFT_DAYS = 30  # DR-03

# Users with a notebook being written by this process, so a double click does not spend two AI requests.
_running: set[uuid.UUID] = set()


def _unique(ids: list[uuid.UUID]) -> list[uuid.UUID]:
    return list(dict.fromkeys(ids))


def _check_count(ids: list[uuid.UUID], *, allow_empty: bool = False) -> None:
    if not ids and not allow_empty:
        raise HTTPException(422, MSG["MSG-27"])
    if len(ids) > MAX_NOTEBOOK_SOURCES:
        raise HTTPException(422, MSG["MSG-28"])


def _clean_title(title: str) -> str:
    title = " ".join(title.split())
    if not title:
        raise HTTPException(422, EMPTY_TITLE)
    if len(title) > notebook_writer.MAX_TITLE:
        raise HTTPException(422, MSG["MSG-29"])
    return title


async def _owned_highlights(session: AsyncSession, user_id: uuid.UUID, ids: list[uuid.UUID]) -> list[tuple]:
    """(Highlight, Document) for every id, in the given order; 404 if any is missing or not the user's."""
    if not ids:
        return []
    rows = (
        await session.execute(
            select(Highlight, Document)
            .join(Document, Document.id == Highlight.document_id)
            .where(Highlight.id.in_(ids), Highlight.user_id == user_id)
        )
    ).all()
    if len(rows) != len(ids):  # NFR-SEC-04: someone else's highlight looks the same as a missing one
        raise HTTPException(status.HTTP_404_NOT_FOUND, HIGHLIGHT_NOT_FOUND)
    by_id = {h.id: (h, d) for h, d in rows}
    return [by_id[i] for i in ids]


async def _owned_notebook(session: AsyncSession, user: User, notebook_id: uuid.UUID) -> Notebook:
    nb = await session.get(Notebook, notebook_id)
    if nb is None or nb.user_id != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, NOT_FOUND)
    return nb


async def _out(session: AsyncSession, nb: Notebook) -> NotebookOut:
    rows = (
        await session.execute(
            select(NotebookHighlight.position, Highlight, Document.title, Document.source_type,
                   Document.original_filename)
            .join(Highlight, Highlight.id == NotebookHighlight.highlight_id)
            .join(Document, Document.id == Highlight.document_id)
            .where(NotebookHighlight.notebook_id == nb.id)
            .order_by(NotebookHighlight.position)
        )
    ).all()
    return NotebookOut(
        id=nb.id, title=nb.title, content=nb.content, status=nb.status, ai_model=nb.ai_model,
        created_at=nb.created_at, updated_at=nb.updated_at,
        sources=[
            NotebookSource(
                position=r.position, highlight=HighlightOut.model_validate(r.Highlight, from_attributes=True),
                document_title=r.title, file_type=file_type_of(r.source_type, r.original_filename),
            )
            for r in rows
        ],
    )


def _sources(rows: list[tuple]) -> tuple[list[uuid.UUID], list[notebook_writer.Source]]:
    """Number the highlights by document, then position in the document (FR-NB-02 step 2)."""
    rows = sorted(
        rows,
        key=lambda r: (r[1].title.lower(), str(r[1].id), r[0].page_number or 0, r[0].created_at),
    )
    return [h.id for h, _ in rows], [
        notebook_writer.Source(text=h.selected_text, category=h.category, note=h.note, document_title=d.title,
                               page=h.page_number)
        for h, d in rows
    ]


async def _save_draft(
    settings: Settings, user_id: uuid.UUID, title: str | None, content: str, ids: list[uuid.UUID]
) -> NotebookOut:
    """FR-NB-02 steps 5–6: store the draft with its sources and count one AI request."""
    content = notebook_writer.clean_output(content)[:MAX_NOTEBOOK_CHARS]
    title = title or notebook_writer.title_from(content) or f"Notebook {utcnow().astimezone(ai_quota.VN):%d/%m/%Y}"
    async with SessionLocal() as session:
        # A highlight deleted while the AI was writing is simply not linked.
        alive = set((await session.scalars(select(Highlight.id).where(Highlight.id.in_(ids)))).all())
        nb = Notebook(user_id=user_id, title=title, content=content, status="draft", ai_model=settings.openai_model)
        nb.sources = [
            NotebookHighlight(highlight_id=hid, position=n) for n, hid in enumerate(ids, 1) if hid in alive
        ]
        session.add(nb)
        user = await session.get(User, user_id)
        if user is not None:
            ai_quota.consume(user)
        await session.commit()
        return await _out(session, nb)


async def _snapshot(session: AsyncSession, nb: Notebook) -> None:
    """FR-NB-03 step 5: keep what "Lưu" saved, unless it is the same as the last snapshot; keep the newest few."""
    versions = (
        await session.scalars(
            select(NotebookVersion)
            .where(NotebookVersion.notebook_id == nb.id)
            .order_by(NotebookVersion.created_at.desc())
        )
    ).all()
    if versions and versions[0].title == nb.title and versions[0].content == nb.content:
        return
    session.add(NotebookVersion(notebook_id=nb.id, title=nb.title, content=nb.content))
    for old in versions[MAX_NOTEBOOK_VERSIONS - 1:]:
        await session.delete(old)


def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


@router.post("/generate", response_model=NotebookOut, status_code=status.HTTP_201_CREATED)
async def generate_notebook(
    payload: NotebookGenerate, request: Request, user: CurrentUser, session: SessionDep, settings: SettingsDep
):
    """FR-NB-02. With `Accept: text/event-stream` the Markdown is streamed as `delta` events, followed by `done`
    (the saved draft) or `error`. Nothing is saved and no quota is used when the AI fails."""
    ids = _unique(payload.highlight_ids)
    _check_count(ids)
    rows = await _owned_highlights(session, user.id, ids)
    title = _clean_title(payload.title) if payload.title and payload.title.strip() else None
    if not (user.reading_preferences or {}).get("ai_consent"):  # NFR-PRV
        raise HTTPException(status.HTTP_403_FORBIDDEN, CONSENT_REQUIRED)
    if not settings.openai_api_key:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, NOT_CONFIGURED)
    if ai_quota.remaining(user, settings.ai_daily_quota) <= 0:
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, MSG["MSG-25"])
    if user.id in _running:
        raise HTTPException(status.HTTP_409_CONFLICT, IN_PROGRESS)

    ordered, sources = _sources(rows)
    language = payload.language or detect_language(" ".join(s.text for s in sources))
    user_id = user.id
    await session.commit()  # hold no DB connection while the AI works

    if "text/event-stream" not in request.headers.get("accept", ""):
        _running.add(user_id)
        try:
            usage = Usage()
            content = "".join([d async for d in notebook_writer.write(settings, sources, language, usage)])
        except AIError:
            raise HTTPException(status.HTTP_502_BAD_GATEWAY, MSG["MSG-26"]) from None
        finally:
            _running.discard(user_id)
        out = await _save_draft(settings, user_id, title, content, ordered)
        return JSONResponse(out.model_dump(mode="json"), status_code=status.HTTP_201_CREATED)

    async def events() -> AsyncIterator[str]:
        if user_id in _running:
            yield _sse("error", {"detail": IN_PROGRESS})
            return
        _running.add(user_id)
        try:
            parts: list[str] = []
            usage = Usage()
            async for delta in notebook_writer.write(settings, sources, language, usage):
                parts.append(delta)
                yield _sse("delta", {"text": delta})
            out = await _save_draft(settings, user_id, title, "".join(parts), ordered)
            yield _sse("done", out.model_dump(mode="json"))
        except AIError:
            yield _sse("error", {"detail": MSG["MSG-26"]})
        except Exception:
            log.exception("notebook generation failed")
            yield _sse("error", {"detail": MSG["MSG-99"]})
        finally:
            _running.discard(user_id)

    return StreamingResponse(
        events(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}
    )


@router.get("", response_model=list[NotebookListItem])
async def list_notebooks(user: CurrentUser, session: SessionDep, highlight_id: uuid.UUID | None = None):
    """FR-NB-05: newest first. `highlight_id` lists only the notebooks that cite that highlight (FR-HL-03)."""
    cutoff = utcnow() - timedelta(days=DRAFT_DAYS)
    stale = (
        await session.scalars(
            select(Notebook.id).where(Notebook.user_id == user.id, Notebook.status == "draft",
                                      Notebook.opened_at < cutoff, Notebook.updated_at < cutoff)
        )
    ).all()
    if stale:  # DR-03, done lazily when the list is opened
        await session.execute(delete(Notebook).where(Notebook.id.in_(stale)))
        await session.commit()

    count = func.count(NotebookHighlight.highlight_id)
    stmt = (
        select(Notebook.id, Notebook.title, Notebook.status, Notebook.created_at, Notebook.updated_at,
               count.label("source_count"))
        .outerjoin(NotebookHighlight, NotebookHighlight.notebook_id == Notebook.id)
        .where(Notebook.user_id == user.id)
        .group_by(Notebook.id)
        .order_by(Notebook.updated_at.desc())
    )
    if highlight_id:
        cites = select(NotebookHighlight.notebook_id).where(NotebookHighlight.highlight_id == highlight_id)
        stmt = stmt.where(Notebook.id.in_(cites))
    return [NotebookListItem.model_validate(r, from_attributes=True) for r in (await session.execute(stmt)).all()]


@router.get("/{notebook_id}", response_model=NotebookOut)
async def get_notebook(notebook_id: uuid.UUID, user: CurrentUser, session: SessionDep):
    nb = await _owned_notebook(session, user, notebook_id)
    # Opening keeps a draft alive (DR-03) without counting as an edit.
    now = utcnow()
    await session.execute(
        update(Notebook).where(Notebook.id == nb.id).values(opened_at=now, updated_at=Notebook.updated_at)
    )
    await session.commit()
    return await _out(session, nb)


@router.patch("/{notebook_id}", response_model=NotebookOut)
async def update_notebook(notebook_id: uuid.UUID, payload: NotebookUpdate, user: CurrentUser, session: SessionDep):
    """FR-NB-03/04: edit the title, content and sources; `status: "saved"` saves a draft."""
    nb = await _owned_notebook(session, user, notebook_id)
    if payload.title is not None:
        nb.title = _clean_title(payload.title)
    if payload.content is not None:
        if len(payload.content) > MAX_NOTEBOOK_CHARS:
            raise HTTPException(422, MSG["MSG-29"])
        nb.content = payload.content
    if payload.highlight_ids is not None:
        ids = _unique(payload.highlight_ids)
        _check_count(ids, allow_empty=True)  # every source may have been deleted with its document
        await _owned_highlights(session, user.id, ids)
        links = (await session.scalars(select(NotebookHighlight).where(NotebookHighlight.notebook_id == nb.id))).all()
        kept = {link.highlight_id: link for link in links}
        for link in links:
            if link.highlight_id not in ids:
                await session.delete(link)
        # New sources get numbers never used before, so an old [n] in the text cannot point at them.
        nxt = max([0, *(link.position for link in links), *notebook_writer.cited(nb.content)]) + 1
        for hid in ids:
            if hid not in kept:
                session.add(NotebookHighlight(notebook_id=nb.id, highlight_id=hid, position=nxt))
                nxt += 1
    if payload.status:
        nb.status = payload.status
        await _snapshot(session, nb)
    nb.opened_at = utcnow()
    nb.updated_at = utcnow()
    await session.commit()
    await session.refresh(nb)
    return await _out(session, nb)


@router.delete("/{notebook_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_notebook(notebook_id: uuid.UUID, user: CurrentUser, session: SessionDep):
    """FR-NB-05: the source highlights are not touched."""
    nb = await _owned_notebook(session, user, notebook_id)
    await session.delete(nb)
    await session.commit()


@router.get("/{notebook_id}/versions", response_model=list[NotebookVersionItem])
async def list_versions(notebook_id: uuid.UUID, user: CurrentUser, session: SessionDep):
    """FR-NB-03 step 5: saved snapshots, newest first."""
    nb = await _owned_notebook(session, user, notebook_id)
    rows = (
        await session.execute(
            select(NotebookVersion.id, NotebookVersion.title, NotebookVersion.created_at,
                   func.length(NotebookVersion.content).label("chars"))
            .where(NotebookVersion.notebook_id == nb.id)
            .order_by(NotebookVersion.created_at.desc())
        )
    ).all()
    return [NotebookVersionItem.model_validate(r, from_attributes=True) for r in rows]


@router.get("/{notebook_id}/versions/{version_id}", response_model=NotebookVersionOut)
async def get_version(notebook_id: uuid.UUID, version_id: uuid.UUID, user: CurrentUser, session: SessionDep):
    """A snapshot's content. Restoring it is done in the editor, which then saves as usual."""
    nb = await _owned_notebook(session, user, notebook_id)
    version = await session.get(NotebookVersion, version_id)
    if version is None or version.notebook_id != nb.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, VERSION_NOT_FOUND)
    return version
