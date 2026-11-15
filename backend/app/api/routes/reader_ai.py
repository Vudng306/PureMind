"""The reader's AI sidebar: quick summary, deep summary and mind map of a document (`services/reader_ai`).

One result of each kind is kept per document, so opening the sidebar again costs nothing. A result is made
only when the reader asks for it, counts as one of the day's AI requests when it succeeds, and is returned
with `stale` once the document's text is no longer the text it was made from.
"""

import uuid

from fastapi import APIRouter, HTTPException, status
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import CurrentUser, SessionDep, SettingsDep
from app.api.routes.chat import _digest
from app.api.routes.documents import _owned_document, run_extraction
from app.api.routes.summaries import CONSENT_REQUIRED, EXTRACTING, NOT_CONFIGURED
from app.core.config import Settings
from app.core.messages import MSG
from app.models import AiArtifact, Document, ExtractionStatus, User
from app.schemas import ArtifactCreate, ArtifactOut
from app.services import ai_quota, doc_chat, reader_ai
from app.services.openai_client import AIError
from app.services.summarizer import detect_language

router = APIRouter(prefix="/documents/{document_id}/ai", tags=["reader-ai"])

NOT_MADE = "Tài liệu này chưa có kết quả AI loại này."
IN_PROGRESS = "Kết quả này đang được tạo. Vui lòng đợi."
NOT_RESEARCH = (
    "Phân tích nghiên cứu chỉ dành cho bài nghiên cứu hoặc báo cáo; tài liệu này thuộc loại khác. "
    "Hãy dùng tóm tắt chuyên sâu."
)
TOO_SHORT = "Tài liệu quá ngắn để phân tích như một nghiên cứu."

# (document, kind) being made by this process, so a double click does not spend two AI requests.
_running: set[tuple[uuid.UUID, str]] = set()


async def _figures(session: AsyncSession, doc: Document) -> tuple[dict | None, dict | None]:
    """Figure descriptions and chart data: part of the text the AI reads, loaded on demand."""
    row = (
        await session.execute(select(Document.figure_notes, Document.chart_data).where(Document.id == doc.id))
    ).one()
    return row[0], row[1]


def stale_reason(artifact: AiArtifact, digest: str, settings: Settings) -> str | None:
    """AI-107: what a stored result was made from that is not what it would be made from now. The text
    comes first: a result on another text is wrong in places, one from an older prompt or model only dated."""
    if artifact.content_hash != digest:
        return "content"
    if artifact.prompt_revision != reader_ai.PROMPT_REVISION:
        return "prompt"
    if artifact.ai_model != settings.openai_model:
        return "model"
    return None


def _out(artifact: AiArtifact, digest: str, user: User, settings: Settings) -> ArtifactOut:
    reason = stale_reason(artifact, digest, settings)
    return ArtifactOut(
        id=artifact.id,
        document_id=artifact.document_id,
        kind=artifact.kind,
        language=artifact.language,
        payload=artifact.payload,
        ai_model=artifact.ai_model,
        created_at=artifact.created_at,
        stale=reason is not None,
        stale_reason=reason,
        ai_quota_remaining=ai_quota.remaining(user, settings.ai_daily_quota),
    )


@router.get("/{kind}", response_model=ArtifactOut)
async def get_artifact(
    document_id: uuid.UUID,
    kind: reader_ai.Kind,
    user: CurrentUser,
    session: SessionDep,
    settings: SettingsDep,
):
    """The stored result, or 404 when none has been made yet. Costs nothing."""
    doc = await _owned_document(session, user, document_id)
    artifact = await session.scalar(
        select(AiArtifact).where(AiArtifact.document_id == doc.id, AiArtifact.kind == kind)
    )
    if artifact is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, NOT_MADE)
    notes, charts = await _figures(session, doc)
    return _out(artifact, _digest(doc.content_clean, notes, charts), user, settings)


@router.post("/{kind}", response_model=ArtifactOut, status_code=status.HTTP_201_CREATED)
async def create_artifact(
    document_id: uuid.UUID,
    kind: reader_ai.Kind,
    user: CurrentUser,
    session: SessionDep,
    settings: SettingsDep,
    payload: ArtifactCreate | None = None,
):
    """Make the result, replacing the one before. A failed request stores nothing and uses no quota."""
    doc = await _owned_document(session, user, document_id)
    if not (user.reading_preferences or {}).get("ai_consent"):  # NFR-PRV: content leaves only after consent
        raise HTTPException(status.HTTP_403_FORBIDDEN, CONSENT_REQUIRED)

    if doc.extraction_status == ExtractionStatus.pending and doc.file_storage_path:
        await run_extraction(session, doc, settings)
    if doc.extraction_status in (ExtractionStatus.pending, ExtractionStatus.processing):
        raise HTTPException(status.HTTP_409_CONFLICT, EXTRACTING)
    if doc.extraction_status == ExtractionStatus.failed or not doc.content_clean.strip():
        raise HTTPException(422, MSG["MSG-15"])

    if not settings.openai_api_key:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, NOT_CONFIGURED)
    if ai_quota.remaining(user, settings.ai_daily_quota) <= 0:
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, MSG["MSG-25"])
    key = (doc.id, kind)
    if key in _running:
        raise HTTPException(status.HTTP_409_CONFLICT, IN_PROGRESS)

    notes, charts = await _figures(session, doc)
    digest = _digest(doc.content_clean, notes, charts)
    chunks = doc_chat.split_chunks(
        doc.content_clean, settings.chat_chunk_tokens, doc.page_count, notes, charts
    )
    if not chunks:
        raise HTTPException(422, MSG["MSG-15"])
    if kind == "analysis":
        # AI-111: a study or a report with enough text. A deep summary already made says what the document
        # is; one that found an essay keeps the analysis from being asked for at all.
        if len(chunks) < reader_ai.MIN_ANALYSIS_CHUNKS:
            raise HTTPException(422, TOO_SHORT)
        deep = await session.scalar(
            select(AiArtifact).where(AiArtifact.document_id == doc.id, AiArtifact.kind == "deep")
        )
        if deep is not None and deep.payload.get("document_type") not in reader_ai.RESEARCH_TYPES:
            raise HTTPException(422, NOT_RESEARCH)
    language = (payload.language if payload else None) or detect_language(doc.content_clean)
    title, coverage = doc.title, doc_chat.coverage_note(doc.extraction_issues)
    await session.commit()  # end the read transaction so no DB connection is held while the AI works
    _running.add(key)
    try:
        result, usage = await reader_ai.generate(settings, kind, title, chunks, language, coverage)
    except reader_ai.NotResearch:
        raise HTTPException(422, NOT_RESEARCH) from None
    except AIError:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, MSG["MSG-26"]) from None
    finally:
        _running.discard(key)

    # A new row under a new id: a note saved from the result before keeps saying what it was saved from.
    await session.execute(delete(AiArtifact).where(AiArtifact.document_id == doc.id, AiArtifact.kind == kind))
    artifact = AiArtifact(
        document_id=doc.id,
        kind=kind,
        language=language,
        payload=result,
        content_hash=digest,
        ai_model=settings.openai_model,
        prompt_revision=reader_ai.PROMPT_REVISION,
        search_text=reader_ai.search_text(kind, result),
        prompt_tokens=usage.prompt_tokens,
        completion_tokens=usage.completion_tokens,
    )
    session.add(artifact)
    ai_quota.consume(user)
    await session.commit()
    await session.refresh(artifact)
    return _out(artifact, digest, user, settings)
