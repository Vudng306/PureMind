"""Publish flow: a post is written from a notebook or a document, checked, previewed, and only then made public.

Nothing here makes a document public. A post is its own text, with sources the author chose to name.
"""

import uuid
from typing import Literal

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import CurrentUser, SessionDep, SettingsDep
from app.api.routes.summaries import CONSENT_REQUIRED, NOT_CONFIGURED
from app.core.messages import MSG
from app.core.ratelimit import publish_limiter
from app.models import (
    MAX_CARD_BODY,
    MAX_CARD_HEADING,
    MAX_POST_BODY,
    MAX_POST_CARDS,
    MAX_POST_TITLE,
    TOPICS,
    Document,
    Highlight,
    Notebook,
    NotebookDocument,
    NotebookHighlight,
    Post,
    PostSource,
    Summary,
    User,
    utcnow,
)
from app.services import ai_quota, post_checks, post_writer, rights
from app.services.openai_client import AIError
from app.services.summarizer import detect_language

router = APIRouter(prefix="/posts", tags=["posts"])

MAX_MATERIAL_HIGHLIGHTS = 200


class PostCard(BaseModel):
    heading: str = Field(default="", max_length=MAX_CARD_HEADING)
    body: str = Field(default="", max_length=MAX_CARD_BODY)


class PostCreate(BaseModel):
    kind: Literal["summary", "insight", "synthesis", "link"] = "insight"
    notebook_id: uuid.UUID | None = None
    document_id: uuid.UUID | None = None


class PostUpdate(BaseModel):
    kind: Literal["summary", "insight", "synthesis", "link"] | None = None
    title: str | None = Field(default=None, max_length=MAX_POST_TITLE)
    cards: list[PostCard] | None = Field(default=None, max_length=MAX_POST_CARDS)
    body: str | None = Field(default=None, max_length=MAX_POST_BODY)
    topic: str | None = None
    shown_source_ids: list[uuid.UUID] | None = None

    @field_validator("topic")
    @classmethod
    def known_topic(cls, v: str | None) -> str | None:
        if v is not None and v not in TOPICS:
            raise ValueError("unknown topic")
        return v


class PostPublish(BaseModel):
    confirm_rights: bool = False
    confirm_reviewed: bool = False


class PostSourceOut(BaseModel):
    id: uuid.UUID
    document_id: uuid.UUID | None
    title: str
    url: str | None
    credit: str
    license: str | None
    shown: bool
    no_derivatives: bool


class PostOut(BaseModel):
    id: uuid.UUID
    kind: str
    status: str
    title: str
    cards: list[PostCard]
    body: str
    topic: str | None
    ai_assisted: bool
    notebook_id: uuid.UUID | None
    sources: list[PostSourceOut]
    published_at: str | None
    hidden: bool
    created_at: str
    updated_at: str


class IssueOut(BaseModel):
    code: str
    level: Literal["error", "warning"]
    message: str


class CheckOut(BaseModel):
    issues: list[IssueOut]
    can_publish: bool
    needs_review: bool


def post_out(post: Post) -> PostOut:
    return PostOut(
        id=post.id,
        kind=post.kind,
        status=post.status,
        title=post.title,
        cards=post.cards or [],
        body=post.body,
        topic=post.topic,
        ai_assisted=post.ai_assisted,
        notebook_id=post.notebook_id,
        sources=[
            PostSourceOut(
                id=s.id,
                document_id=s.document_id,
                title=s.title,
                url=s.url,
                credit=s.credit,
                license=s.license,
                shown=s.shown,
                no_derivatives=rights.no_derivatives(s.license),
            )
            for s in post.sources
        ],
        published_at=post.published_at.isoformat() if post.published_at else None,
        hidden=post.hidden_at is not None,
        created_at=post.created_at.isoformat(),
        updated_at=post.updated_at.isoformat(),
    )


async def _owned_post(session: AsyncSession, user: User, post_id: uuid.UUID) -> Post:
    post = await session.get(Post, post_id)
    if post is None or post.user_id != user.id:  # NFR-SEC-04
        raise HTTPException(status.HTTP_404_NOT_FOUND, MSG["MSG-POST-404"])
    return post


async def _notebook_documents(session: AsyncSession, notebook_id: uuid.UUID) -> list[Document]:
    linked = select(NotebookDocument.document_id).where(NotebookDocument.notebook_id == notebook_id)
    through = (
        select(Highlight.document_id)
        .join(NotebookHighlight, NotebookHighlight.highlight_id == Highlight.id)
        .where(NotebookHighlight.notebook_id == notebook_id)
    )
    docs = await session.scalars(
        select(Document).where(Document.id.in_(linked.union(through))).order_by(Document.title)
    )
    return list(docs.all())


async def _snapshot(session: AsyncSession, doc: Document, position: int) -> PostSource:
    return PostSource(
        document_id=doc.id,
        position=position,
        title=doc.title[:500],
        url=doc.url,
        credit=rights.credit_of(doc),
        license=await rights.license_of(session, doc),
        # A web source is named by default. An upload stays unnamed until the author says otherwise.
        shown=bool(doc.url),
    )


@router.post("", response_model=PostOut, status_code=status.HTTP_201_CREATED)
async def create_post(payload: PostCreate, user: CurrentUser, session: SessionDep):
    """Start a draft from a notebook or a document. Nothing is public yet."""
    if bool(payload.notebook_id) == bool(payload.document_id):
        raise HTTPException(422, MSG["MSG-POST-NO-SOURCE"])
    notebook: Notebook | None = None
    if payload.notebook_id:
        notebook = await session.get(Notebook, payload.notebook_id)
        if notebook is None or notebook.user_id != user.id:
            raise HTTPException(status.HTTP_404_NOT_FOUND, MSG["MSG-POST-404"])
        docs = await _notebook_documents(session, notebook.id)
    else:
        doc = await session.get(Document, payload.document_id)
        if doc is None or doc.user_id != user.id:
            raise HTTPException(status.HTTP_404_NOT_FOUND, MSG["MSG-19"])
        docs = [doc]
    if payload.kind == "link" and not (docs and docs[0].url):
        raise HTTPException(422, MSG["MSG-POST-LINK-NEEDS-URL"])

    post = Post(
        user_id=user.id,
        notebook_id=notebook.id if notebook else None,
        kind=payload.kind,
        status="draft",
        title=(notebook.title if notebook else docs[0].title)[:MAX_POST_TITLE],
        cards=[{"heading": "", "body": ""}] if payload.kind == "link" else [],
        body="",
        # What an AI notebook says came from the AI, whoever carries it across.
        ai_assisted=bool(notebook and notebook.ai_model),
    )
    post.sources = [await _snapshot(session, d, n) for n, d in enumerate(docs)]
    session.add(post)
    await session.commit()
    await session.refresh(post)
    return post_out(post)


@router.get("", response_model=list[PostOut])
async def list_my_posts(
    user: CurrentUser,
    session: SessionDep,
    post_status: Literal["draft", "published"] | None = None,
    document_id: uuid.UUID | None = None,
):
    """Shared by Me: the user's own posts, with whether an admin hid them."""
    stmt = select(Post).where(Post.user_id == user.id).order_by(Post.updated_at.desc())
    if post_status:
        stmt = stmt.where(Post.status == post_status)
    if document_id:
        stmt = stmt.where(
            Post.id.in_(select(PostSource.post_id).where(PostSource.document_id == document_id))
        )
    return [post_out(p) for p in (await session.scalars(stmt)).all()]


@router.get("/{post_id}", response_model=PostOut)
async def get_post(post_id: uuid.UUID, user: CurrentUser, session: SessionDep):
    return post_out(await _owned_post(session, user, post_id))


@router.patch("/{post_id}", response_model=PostOut)
async def update_post(post_id: uuid.UUID, payload: PostUpdate, user: CurrentUser, session: SessionDep):
    post = await _owned_post(session, user, post_id)
    if post.status != "draft":
        raise HTTPException(status.HTTP_409_CONFLICT, MSG["MSG-POST-PUBLISHED"])
    fields = payload.model_fields_set
    if payload.kind is not None:
        post.kind = payload.kind
    if payload.title is not None:
        post.title = " ".join(payload.title.split())
    if payload.cards is not None:
        post.cards = [c.model_dump() for c in payload.cards]
    if payload.body is not None:
        post.body = payload.body
    if "topic" in fields:
        post.topic = payload.topic
    if payload.shown_source_ids is not None:
        shown = set(payload.shown_source_ids)
        for source in post.sources:
            source.shown = source.id in shown
    await session.commit()
    await session.refresh(post)
    return post_out(post)


@router.delete("/{post_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_post(post_id: uuid.UUID, user: CurrentUser, session: SessionDep):
    """The notebook and documents it came from are not touched."""
    post = await _owned_post(session, user, post_id)
    await session.delete(post)
    await session.commit()


async def _source_texts(session: AsyncSession, post: Post) -> dict:
    ids = [s.document_id for s in post.sources if s.document_id]
    if not ids:
        return {}
    rows = await session.execute(select(Document.id, Document.content_clean).where(Document.id.in_(ids)))
    return {r.id: r.content_clean for r in rows.all()}


async def _issues(session: AsyncSession, post: Post) -> list[post_checks.Issue]:
    return post_checks.check(post, await _source_texts(session, post))


@router.get("/{post_id}/check", response_model=CheckOut)
async def check_post(post_id: uuid.UUID, user: CurrentUser, session: SessionDep):
    post = await _owned_post(session, user, post_id)
    issues = await _issues(session, post)
    return CheckOut(
        issues=[IssueOut(code=i.code, level=i.level, message=i.message) for i in issues],
        can_publish=not any(i.level == "error" for i in issues),
        needs_review=post.ai_assisted,
    )


@router.post("/{post_id}/publish", response_model=PostOut)
async def publish_post(post_id: uuid.UUID, payload: PostPublish, user: CurrentUser, session: SessionDep):
    post = await _owned_post(session, user, post_id)
    if post.hidden_at is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, MSG["MSG-POST-HIDDEN"])
    if post.status == "published":
        return post_out(post)
    if not publish_limiter.hit(str(user.id)):
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, MSG["MSG-POST-LIMIT"])
    errors = [i for i in await _issues(session, post) if i.level == "error"]
    if errors:
        raise HTTPException(422, errors[0].message)
    if not payload.confirm_rights:
        raise HTTPException(422, MSG["CHECK-CONFIRM-RIGHTS"])
    if post.ai_assisted and not payload.confirm_reviewed:
        raise HTTPException(422, MSG["CHECK-CONFIRM-REVIEWED"])
    post.status = "published"
    post.published_at = utcnow()
    await session.commit()
    await session.refresh(post)
    return post_out(post)


@router.post("/{post_id}/unpublish", response_model=PostOut)
async def unpublish_post(post_id: uuid.UUID, user: CurrentUser, session: SessionDep):
    """Back to a private draft, to edit or keep. An admin's hiding cannot be undone this way."""
    post = await _owned_post(session, user, post_id)
    if post.hidden_at is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, MSG["MSG-POST-HIDDEN"])
    post.status = "draft"
    post.published_at = None
    await session.commit()
    await session.refresh(post)
    return post_out(post)


async def _material(session: AsyncSession, post: Post) -> str:
    """The author's own notes and marks from the post's sources, never a whole document."""
    parts: list[str] = []
    if post.notebook_id:
        notebook = await session.get(Notebook, post.notebook_id)
        if notebook is not None and notebook.content.strip():
            parts.append(f"Notebook: {notebook.title}\n{notebook.content}")
    ids = [s.document_id for s in post.sources if s.document_id]
    if ids:
        highlights = await session.scalars(
            select(Highlight)
            .where(Highlight.document_id.in_(ids), Highlight.user_id == post.user_id)
            .order_by(Highlight.created_at)
            .limit(MAX_MATERIAL_HIGHLIGHTS)
        )
        marks = [f"- {h.selected_text}" + (f" (note: {h.note})" if h.note else "") for h in highlights.all()]
        if marks:
            parts.append("Highlights:\n" + "\n".join(marks))
        summaries = await session.scalars(select(Summary).where(Summary.document_id.in_(ids)))
        for s in summaries.all():
            parts.append("Summary:\n" + "\n".join(s.key_points) + f"\n{s.conclusion}")
    return "\n\n".join(parts)


@router.post("/{post_id}/draft", response_model=PostOut)
async def draft_post(post_id: uuid.UUID, user: CurrentUser, session: SessionDep, settings: SettingsDep):
    """One AI call for this one post, at the author's request. They read what comes back before publishing."""
    post = await _owned_post(session, user, post_id)
    if post.status != "draft":
        raise HTTPException(status.HTTP_409_CONFLICT, MSG["MSG-POST-PUBLISHED"])
    if post.kind == "link":
        raise HTTPException(422, MSG["CHECK-LINK-CARD"])
    if any(rights.no_derivatives(s.license) for s in post.sources):
        raise HTTPException(422, MSG["MSG-POST-AI-ND"])
    if not (user.reading_preferences or {}).get("ai_consent"):  # NFR-PRV
        raise HTTPException(status.HTTP_403_FORBIDDEN, CONSENT_REQUIRED)
    if not settings.openai_api_key:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, NOT_CONFIGURED)
    if ai_quota.remaining(user, settings.ai_daily_quota) <= 0:
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, MSG["MSG-25"])
    material = await _material(session, post)
    if not material.strip():
        raise HTTPException(422, MSG["MSG-POST-AI-EMPTY"])
    kind = post.kind
    await session.commit()  # hold no DB connection while the AI works

    try:
        draft = await post_writer.write(settings, kind, material, detect_language(material))
    except AIError:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, MSG["MSG-26"]) from None

    post = await _owned_post(session, user, post_id)
    if post.status != "draft":
        raise HTTPException(status.HTTP_409_CONFLICT, MSG["MSG-POST-PUBLISHED"])
    post.title = draft.title
    post.cards = [c.model_dump() for c in draft.cards]
    post.ai_assisted = True
    ai_quota.consume(user)
    await session.commit()
    await session.refresh(post)
    return post_out(post)
