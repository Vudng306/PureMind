"""FR-SUM-01/02: AI summary of a document."""

import uuid

from fastapi import APIRouter, HTTPException, status
from sqlalchemy import select

from app.api.deps import CurrentUser, SessionDep, SettingsDep
from app.api.routes.documents import _owned_document, run_extraction
from app.core.messages import MSG
from app.models import ExtractionStatus, Summary, utcnow
from app.schemas import SummaryCreate, SummaryOut
from app.services import ai_quota
from app.services.openai_client import AIError
from app.services.summarizer import detect_language, summarize

router = APIRouter(prefix="/documents/{document_id}/summary", tags=["summaries"])

CONSENT_REQUIRED = "Bạn cần đồng ý cho phép gửi nội dung tài liệu tới OpenAI trước khi dùng tính năng AI."
NOT_CONFIGURED = "Máy chủ chưa được cấu hình khóa OpenAI (OPENAI_API_KEY)."
IN_PROGRESS = "Bản tóm tắt của tài liệu này đang được tạo."
EXTRACTING = "Tài liệu đang được xử lý. Vui lòng thử lại sau ít phút."

# Documents being summarised by this process, so a double click does not spend two AI requests.
_running: set[uuid.UUID] = set()


@router.get("", response_model=SummaryOut)
async def get_summary(document_id: uuid.UUID, user: CurrentUser, session: SessionDep):
    """FR-SUM-02: the saved summary, or 404 (MSG-33) when there is none yet."""
    doc = await _owned_document(session, user, document_id)
    summary = await session.scalar(select(Summary).where(Summary.document_id == doc.id))
    if summary is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, MSG["MSG-33"])
    return summary


@router.post("", response_model=SummaryOut, status_code=status.HTTP_201_CREATED)
async def create_summary(
    document_id: uuid.UUID,
    user: CurrentUser,
    session: SessionDep,
    settings: SettingsDep,
    payload: SummaryCreate | None = None,
):
    """FR-SUM-01: create (or replace) the summary. Failed requests do not use up the daily AI quota."""
    doc = await _owned_document(session, user, document_id)
    if not (user.reading_preferences or {}).get("ai_consent"):  # NFR-PRV: content leaves only after consent
        raise HTTPException(status.HTTP_403_FORBIDDEN, CONSENT_REQUIRED)

    # Step 1: the summary needs the extracted text.
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
    if doc.id in _running:
        raise HTTPException(status.HTTP_409_CONFLICT, IN_PROGRESS)

    language = (payload.language if payload else None) or detect_language(doc.content_clean)
    title, content = doc.title, doc.content_clean
    await session.commit()  # end the read transaction so no DB connection is held while the AI works
    _running.add(doc.id)
    try:
        content_out, usage = await summarize(settings, title, content, language)
    except AIError:
        # Nothing is saved and no quota is used.
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, MSG["MSG-26"]) from None
    finally:
        _running.discard(doc.id)

    # Step 6: at most one summary per document; regenerating replaces it.
    summary = await session.scalar(select(Summary).where(Summary.document_id == doc.id))
    if summary is None:
        summary = Summary(document_id=doc.id)
        session.add(summary)
    summary.key_points = content_out.key_points
    summary.concepts = [c.model_dump() for c in content_out.concepts]
    summary.conclusion = content_out.conclusion
    summary.keywords = content_out.keywords
    summary.search_text = "\n".join(
        [
            *content_out.key_points,
            *(f"{c.term}: {c.explanation}" for c in content_out.concepts),
            content_out.conclusion,
            ", ".join(content_out.keywords),
        ]
    )
    summary.language = language
    summary.ai_model = settings.openai_model
    summary.prompt_tokens = usage.prompt_tokens
    summary.completion_tokens = usage.completion_tokens
    summary.created_at = utcnow()
    ai_quota.consume(user)  # step 7
    await session.commit()
    await session.refresh(summary)
    return summary
