"""FR-CHAT-01..03: chat with one document.

The document's text is indexed once (passages + embeddings, see `doc_chat` and `embeddings`); every question
is embedded, the closest passages are put in the prompt, and the answer cites them as [n]. A question costs
one of the user's daily chat questions, counted apart from summaries and notebooks.
"""

import hashlib
import json
import logging
import uuid
from collections.abc import AsyncIterator

from fastapi import APIRouter, HTTPException, Request, status
from fastapi.responses import JSONResponse, StreamingResponse
from sqlalchemy import delete, func, select, text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import CurrentUser, SessionDep, SettingsDep
from app.api.routes.documents import _owned_document, run_extraction
from app.api.routes.summaries import CONSENT_REQUIRED, EXTRACTING, NOT_CONFIGURED
from app.core.config import Settings
from app.core.messages import MSG
from app.db.session import SessionLocal
from app.models import (
    MAX_CHAT_CONVERSATIONS,
    MAX_CHAT_MESSAGES,
    ChatConversation,
    ChatMessage,
    Document,
    DocumentChunk,
    ExtractionStatus,
    User,
    utcnow,
)
from app.schemas import ChatAnswerOut, ChatAsk, ChatConversationItem, ChatConversationOut, ChatMessageOut
from app.services import ai_quota, doc_chat, embeddings
from app.services.openai_client import AIError, Usage
from app.services.summarizer import detect_language

router = APIRouter(prefix="/documents/{document_id}/chat", tags=["chat"])
log = logging.getLogger("app.chat")

IN_PROGRESS = "Câu hỏi trước đang được trả lời. Vui lòng đợi."
MAX_CITATION_CHARS = 600  # how much of a passage is kept with the answer for the reader to read

# Users with a question being answered by this process, so a double click does not spend two questions.
_running: set[uuid.UUID] = set()


def _digest(content: str) -> str:
    return hashlib.sha256(content.encode("utf-8")).hexdigest()


async def _owned_conversation(
    session: AsyncSession, user: User, document_id: uuid.UUID, conversation_id: uuid.UUID
) -> ChatConversation:
    conv = await session.get(ChatConversation, conversation_id)
    # NFR-SEC-04: someone else's conversation looks the same as a missing one.
    if conv is None or conv.user_id != user.id or conv.document_id != document_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, MSG["MSG-CHAT-NOT-FOUND"])
    return conv


def _message_out(m: ChatMessage) -> ChatMessageOut:
    return ChatMessageOut.model_validate(m, from_attributes=True)


async def _conversation_out(session: AsyncSession, conv: ChatConversation) -> ChatConversationOut:
    messages = (
        await session.scalars(
            select(ChatMessage)
            .where(ChatMessage.conversation_id == conv.id)
            .order_by(ChatMessage.created_at, ChatMessage.role.desc())
        )
    ).all()
    return ChatConversationOut(
        id=conv.id,
        document_id=conv.document_id,
        title=conv.title,
        language=conv.language,
        messages=[_message_out(m) for m in messages],
        created_at=conv.created_at,
        updated_at=conv.updated_at,
    )


async def _ready_document(
    session: AsyncSession, user: User, document_id: uuid.UUID, settings: Settings
) -> Document:
    """The document to talk about, extracting its text first when that has not happened yet."""
    doc = await _owned_document(session, user, document_id)
    if doc.extraction_status == ExtractionStatus.pending and doc.file_storage_path:
        await run_extraction(session, doc, settings)
    if doc.extraction_status in (ExtractionStatus.pending, ExtractionStatus.processing):
        raise HTTPException(status.HTTP_409_CONFLICT, EXTRACTING)
    if doc.extraction_status == ExtractionStatus.failed or not doc.content_clean.strip():
        raise HTTPException(422, MSG["MSG-CHAT-NO-TEXT"])
    return doc


async def _index(settings: Settings, document_id: uuid.UUID, usage: Usage) -> None:
    """FR-CHAT-01: embed the document's passages, once per text and embedding model.

    Runs on its own sessions: embedding a long document takes seconds, and no database connection is held
    while it does. A document whose text changed (re-extraction) is indexed again.
    """
    async with SessionLocal() as session:
        doc = await session.get(Document, document_id)
        if doc is None:
            return
        if doc.chunks_hash == _digest(doc.content_clean) and doc.chunks_model == (
            settings.openai_embedding_model
        ):
            return
        content, page_count = doc.content_clean, doc.page_count

    chunks = doc_chat.split_chunks(content, settings.chat_chunk_tokens, page_count)
    if not chunks:
        raise HTTPException(422, MSG["MSG-CHAT-NO-TEXT"])
    vectors = await embeddings.embed(
        settings, [c.labelled() for c in chunks], purpose="chat_index", usage=usage
    )

    async with SessionLocal() as session:
        doc = await session.get(Document, document_id)
        if doc is None:  # deleted while it was being indexed
            return
        await session.execute(delete(DocumentChunk).where(DocumentChunk.document_id == document_id))
        session.add_all(
            [
                DocumentChunk(
                    document_id=document_id,
                    position=c.position,
                    page_number=c.page_number,
                    heading=c.heading,
                    text=c.text,
                    token_count=c.token_count,
                    embedding=embeddings.encode(v),
                )
                for c, v in zip(chunks, vectors, strict=True)
            ]
        )
        doc.chunks_hash = _digest(content)
        doc.chunks_model = settings.openai_embedding_model
        await session.commit()


def _as_chunk(row) -> doc_chat.Chunk:
    return doc_chat.Chunk(row.position, row.page_number, row.heading, row.text, row.token_count)


CHUNK_COLUMNS = (
    DocumentChunk.position,
    DocumentChunk.page_number,
    DocumentChunk.heading,
    DocumentChunk.text,
    DocumentChunk.token_count,
)


async def _closest(document_id: uuid.UUID, vector: list[float], limit: int) -> list[doc_chat.Chunk]:
    """The passages nearest the question, handed back in reading order.

    On PostgreSQL with pgvector the ranking is a `<=>` (cosine distance) query. Without the extension — and
    on SQLite in the tests — the same similarity is computed in Python over the document's own passages, of
    which there are only hundreds.
    """
    async with SessionLocal() as session:
        if session.bind.dialect.name == "postgresql":
            try:
                rows = (
                    await session.execute(
                        select(*CHUNK_COLUMNS)
                        .where(DocumentChunk.document_id == document_id)
                        .order_by(text("embedding::vector <=> cast(:query as vector)"))
                        .limit(limit),
                        {"query": embeddings.encode(vector)},
                    )
                ).all()
                return sorted((_as_chunk(r) for r in rows), key=lambda c: c.position)
            except DBAPIError as e:  # pgvector is not installed on this database
                log.warning("pgvector unavailable, ranking passages in Python: %s", e)
                await session.rollback()

        rows = (
            await session.execute(
                select(*CHUNK_COLUMNS, DocumentChunk.embedding).where(
                    DocumentChunk.document_id == document_id
                )
            )
        ).all()

    scored = sorted(
        ((embeddings.cosine(vector, embeddings.decode(r.embedding)), r.position, r) for r in rows),
        key=lambda s: (-s[0], s[1]),
    )
    return sorted((_as_chunk(r) for _, _, r in scored[:limit]), key=lambda c: c.position)


def _source(position: int, chunk: doc_chat.Chunk) -> dict:
    return {
        "position": position,
        "page_number": chunk.page_number,
        "heading": chunk.heading,
        "text": chunk.text[:MAX_CITATION_CHARS],
    }


def _citations(chunks: list[doc_chat.Chunk], answer: str) -> list[dict]:
    """The passages the answer actually cited, numbered as they were numbered in the prompt."""
    used = doc_chat.cited(answer)
    return [_source(n, c) for n, c in enumerate(chunks, 1) if n in used]


async def _save_turn(
    settings: Settings,
    conversation_id: uuid.UUID,
    user_id: uuid.UUID,
    question: str,
    answer: str,
    citations: list[dict],
    usage: Usage,
) -> ChatAnswerOut | None:
    """Store both turns, name a new conversation after its first question and count one question."""
    async with SessionLocal() as session:
        conv = await session.get(ChatConversation, conversation_id)
        if conv is None:  # deleted while the answer was being written
            return None
        asked = ChatMessage(conversation_id=conv.id, role="user", content=question, citations=[])
        replied = ChatMessage(
            conversation_id=conv.id,
            role="assistant",
            content=answer,
            citations=citations,
            ai_model=settings.openai_model,
            prompt_tokens=usage.prompt_tokens,
            completion_tokens=usage.completion_tokens,
        )
        session.add_all([asked, replied])
        if not conv.title:
            conv.title = doc_chat.title_from_question(question)
        conv.updated_at = utcnow()
        user = await session.get(User, user_id)
        if user is not None:
            ai_quota.chat_consume(user)
        await session.commit()
        return ChatAnswerOut(
            question=_message_out(asked),
            answer=_message_out(replied),
            chat_quota_remaining=ai_quota.chat_remaining(user, settings.chat_daily_quota) if user else 0,
        )


def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


@router.post("/conversations", response_model=ChatConversationOut, status_code=status.HTTP_201_CREATED)
async def create_conversation(
    document_id: uuid.UUID, user: CurrentUser, session: SessionDep, settings: SettingsDep
):
    """FR-CHAT-03: an empty thread, named after the first question asked in it."""
    doc = await _ready_document(session, user, document_id, settings)
    old = (
        await session.scalars(
            select(ChatConversation.id)
            .where(ChatConversation.user_id == user.id, ChatConversation.document_id == doc.id)
            .order_by(ChatConversation.updated_at.desc())
            .offset(MAX_CHAT_CONVERSATIONS - 1)
        )
    ).all()
    if old:  # only the newest few are kept per document
        await session.execute(delete(ChatConversation).where(ChatConversation.id.in_(old)))
    conv = ChatConversation(
        user_id=user.id, document_id=doc.id, title="", language=detect_language(doc.content_clean)
    )
    session.add(conv)
    await session.commit()
    await session.refresh(conv)
    return await _conversation_out(session, conv)


@router.get("/conversations", response_model=list[ChatConversationItem])
async def list_conversations(document_id: uuid.UUID, user: CurrentUser, session: SessionDep):
    """FR-CHAT-03: this document's conversations, most recently used first."""
    await _owned_document(session, user, document_id)
    rows = (
        await session.execute(
            select(
                ChatConversation.id,
                ChatConversation.title,
                ChatConversation.language,
                ChatConversation.created_at,
                ChatConversation.updated_at,
                func.count(ChatMessage.id).label("message_count"),
            )
            .outerjoin(ChatMessage, ChatMessage.conversation_id == ChatConversation.id)
            .where(ChatConversation.user_id == user.id, ChatConversation.document_id == document_id)
            .group_by(ChatConversation.id)
            .order_by(ChatConversation.updated_at.desc())
        )
    ).all()
    return [ChatConversationItem.model_validate(r, from_attributes=True) for r in rows]


@router.get("/conversations/{conversation_id}", response_model=ChatConversationOut)
async def get_conversation(
    document_id: uuid.UUID, conversation_id: uuid.UUID, user: CurrentUser, session: SessionDep
):
    conv = await _owned_conversation(session, user, document_id, conversation_id)
    return await _conversation_out(session, conv)


@router.delete("/conversations/{conversation_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_conversation(
    document_id: uuid.UUID, conversation_id: uuid.UUID, user: CurrentUser, session: SessionDep
):
    """FR-CHAT-03: the whole thread, questions and answers."""
    conv = await _owned_conversation(session, user, document_id, conversation_id)
    await session.delete(conv)
    await session.commit()


@router.post("/conversations/{conversation_id}/messages", response_model=ChatAnswerOut)
async def ask(
    document_id: uuid.UUID,
    conversation_id: uuid.UUID,
    payload: ChatAsk,
    request: Request,
    user: CurrentUser,
    session: SessionDep,
    settings: SettingsDep,
):
    """FR-CHAT-02. With `Accept: text/event-stream` the answer is streamed as `delta` events, preceded by
    `sources` and followed by `done` or `error`. A failed answer is not stored and costs no question."""
    doc = await _ready_document(session, user, document_id, settings)
    conv = await _owned_conversation(session, user, document_id, conversation_id)
    if not (user.reading_preferences or {}).get("ai_consent"):  # NFR-PRV: content leaves only after consent
        raise HTTPException(status.HTTP_403_FORBIDDEN, CONSENT_REQUIRED)
    if not settings.openai_api_key:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, NOT_CONFIGURED)
    if ai_quota.chat_remaining(user, settings.chat_daily_quota) <= 0:
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, MSG["MSG-CHAT-QUOTA"])
    if user.id in _running:
        raise HTTPException(status.HTTP_409_CONFLICT, IN_PROGRESS)

    total = await session.scalar(
        select(func.count(ChatMessage.id)).where(ChatMessage.conversation_id == conv.id)
    )
    if (total or 0) >= MAX_CHAT_MESSAGES:
        raise HTTPException(status.HTTP_409_CONFLICT, MSG["MSG-CHAT-FULL"])

    # The last few turns, newest first, reversed below; a question and its answer can share a creation
    # time, so the role breaks the tie — ascending here, because reversing puts "user" back in front.
    recent = (
        await session.execute(
            select(ChatMessage.role, ChatMessage.content)
            .where(ChatMessage.conversation_id == conv.id)
            .order_by(ChatMessage.created_at.desc(), ChatMessage.role.asc())
            .limit(settings.chat_history_messages)
        )
    ).all()
    history = [(r.role, r.content) for r in reversed(recent)]
    question, quote = payload.content, (payload.quote or "").strip() or None
    title, language, user_id = doc.title, conv.language, user.id
    await session.commit()  # hold no database connection while the AI works

    async def work() -> AsyncIterator[tuple[str, dict]]:
        """(event, data) pairs: the passages found, the answer as it is written, then the saved turn."""
        # Embedding tokens are logged on their own; what is stored with the answer is the answer.
        indexing, usage = Usage(), Usage()
        await _index(settings, document_id, indexing)
        vector = (await embeddings.embed(settings, [question], purpose="chat_query", usage=indexing))[0]
        chunks = await _closest(document_id, vector, settings.chat_context_chunks)
        yield "sources", {"sources": [_source(n, c) for n, c in enumerate(chunks, 1)]}

        messages = doc_chat.build_messages(title, question, chunks, history, language, quote)
        parts: list[str] = []
        async for delta in doc_chat.answer(settings, messages, usage):
            parts.append(delta)
            yield "delta", {"text": delta}

        answer = "".join(parts).strip()
        saved = await _save_turn(
            settings, conversation_id, user_id, question, answer, _citations(chunks, answer), usage
        )
        if saved is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, MSG["MSG-CHAT-NOT-FOUND"])
        yield "done", saved.model_dump(mode="json")

    if "text/event-stream" not in request.headers.get("accept", ""):
        _running.add(user_id)
        try:
            done: dict | None = None
            async for event, data in work():
                if event == "done":
                    done = data
        except AIError:
            raise HTTPException(status.HTTP_502_BAD_GATEWAY, MSG["MSG-26"]) from None
        finally:
            _running.discard(user_id)
        return JSONResponse(done)

    async def events() -> AsyncIterator[str]:
        if user_id in _running:
            yield _sse("error", {"detail": IN_PROGRESS})
            return
        _running.add(user_id)
        try:
            async for event, data in work():
                yield _sse(event, data)
        except AIError:
            yield _sse("error", {"detail": MSG["MSG-26"]})
        except HTTPException as e:
            yield _sse("error", {"detail": e.detail})
        except Exception:
            log.exception("chat answer failed")
            yield _sse("error", {"detail": MSG["MSG-99"]})
        finally:
            _running.discard(user_id)

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
