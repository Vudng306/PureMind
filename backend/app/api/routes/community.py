"""The community feed: what users chose to publish, for signed-in readers.

Only a post's public text and the sources its author named ever leave here. No email, no private source, no draft.
Authors appear by display name alone. There are no likes, follows or ranking by attention: newest first.
"""

import uuid
from datetime import datetime
from typing import Literal

from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.sql.elements import ColumnElement

from app.api.deps import CurrentUser, SessionDep
from app.api.routes.posts import PostCard
from app.core.messages import MSG
from app.core.ratelimit import comment_limiter, report_limiter
from app.models import (
    MAX_COMMENT_CHARS,
    TOPICS,
    CommentReport,
    Post,
    PostComment,
    PostReport,
    SavedPost,
    User,
)

router = APIRouter(prefix="/community", tags=["community"])

ReportReason = Literal["copyright", "inaccurate", "spam", "offensive"]


class PublicAuthor(BaseModel):
    """A name the author chose; empty when they chose none, and never their email."""

    name: str


class PublicSource(BaseModel):
    title: str
    url: str | None
    credit: str
    license: str | None


class PublicPost(BaseModel):
    id: uuid.UUID
    kind: str
    title: str
    cards: list[PostCard]
    body: str
    topic: str | None
    ai_assisted: bool
    published_at: datetime | None
    author: PublicAuthor
    sources: list[PublicSource]
    saved: bool
    mine: bool
    comment_count: int


class CommunityPage(BaseModel):
    items: list[PublicPost]
    has_more: bool


class ReportIn(BaseModel):
    reason: ReportReason


class CommentIn(BaseModel):
    body: str = Field(max_length=MAX_COMMENT_CHARS * 2)


class CommentOut(BaseModel):
    id: uuid.UUID
    body: str
    author: PublicAuthor
    mine: bool
    created_at: datetime


def public_author(user: User) -> PublicAuthor:
    return PublicAuthor(name=(user.display_name or "").strip())


def is_public() -> list[ColumnElement]:
    """A post others can see: published, not hidden, and its author's account not locked."""
    return [
        Post.status == "published",
        Post.hidden_at.is_(None),
        Post.user_id.in_(select(User.id).where(User.disabled_at.is_(None))),
    ]


async def _public_post(session: AsyncSession, post_id: uuid.UUID) -> Post:
    post = await session.scalar(select(Post).where(Post.id == post_id, *is_public()))
    if post is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, MSG["MSG-POST-404"])
    return post


async def _views(session: AsyncSession, posts: list[Post], user: User) -> list[PublicPost]:
    ids = [p.id for p in posts]
    if not ids:
        return []
    saved = set(
        (
            await session.scalars(
                select(SavedPost.post_id).where(SavedPost.user_id == user.id, SavedPost.post_id.in_(ids))
            )
        ).all()
    )
    counts = dict(
        (
            await session.execute(
                select(PostComment.post_id, func.count(PostComment.id))
                .where(PostComment.post_id.in_(ids), PostComment.hidden_at.is_(None))
                .group_by(PostComment.post_id)
            )
        ).all()
    )
    return [
        PublicPost(
            id=p.id,
            kind=p.kind,
            title=p.title,
            cards=p.cards or [],
            body=p.body,
            topic=p.topic,
            ai_assisted=p.ai_assisted,
            published_at=p.published_at,
            author=public_author(p.author),
            sources=[
                PublicSource(title=s.title, url=s.url, credit=s.credit, license=s.license)
                for s in p.sources
                if s.shown
            ],
            saved=p.id in saved,
            mine=p.user_id == user.id,
            comment_count=counts.get(p.id, 0),
        )
        for p in posts
    ]


@router.get("", response_model=CommunityPage)
async def community_feed(
    user: CurrentUser,
    session: SessionDep,
    topic: str | None = None,
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=20, ge=1, le=50),
):
    stmt = select(Post).where(*is_public())
    if topic in TOPICS:
        stmt = stmt.where(Post.topic == topic)
    stmt = stmt.order_by(Post.published_at.desc(), Post.id).offset(offset).limit(limit + 1)
    posts = list((await session.scalars(stmt)).all())
    return CommunityPage(items=await _views(session, posts[:limit], user), has_more=len(posts) > limit)


@router.get("/saved", response_model=list[PublicPost])
async def saved_posts(user: CurrentUser, session: SessionDep):
    stmt = (
        select(Post)
        .join(SavedPost, SavedPost.post_id == Post.id)
        .where(SavedPost.user_id == user.id, *is_public())
        .order_by(SavedPost.saved_at.desc())
    )
    return await _views(session, list((await session.scalars(stmt)).all()), user)


@router.get("/{post_id}", response_model=PublicPost)
async def read_post(post_id: uuid.UUID, user: CurrentUser, session: SessionDep):
    post = await _public_post(session, post_id)
    return (await _views(session, [post], user))[0]


@router.post("/{post_id}/save", status_code=status.HTTP_204_NO_CONTENT)
async def save_post(post_id: uuid.UUID, user: CurrentUser, session: SessionDep):
    await _public_post(session, post_id)
    if await session.get(SavedPost, (user.id, post_id)) is None:
        session.add(SavedPost(user_id=user.id, post_id=post_id))
        await session.commit()


@router.delete("/{post_id}/save", status_code=status.HTTP_204_NO_CONTENT)
async def unsave_post(post_id: uuid.UUID, user: CurrentUser, session: SessionDep):
    saved = await session.get(SavedPost, (user.id, post_id))
    if saved is not None:
        await session.delete(saved)
        await session.commit()


def _report_allowed(user: User) -> None:
    if not report_limiter.hit(str(user.id)):
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, MSG["MSG-POST-LIMIT"])


@router.post("/{post_id}/report", status_code=status.HTTP_204_NO_CONTENT)
async def report_post(post_id: uuid.UUID, payload: ReportIn, user: CurrentUser, session: SessionDep):
    """A fixed reason and nothing else: admins act on the public text, not on what one reader wrote."""
    _report_allowed(user)
    await _public_post(session, post_id)
    report = await session.get(PostReport, (post_id, user.id))
    if report is None:
        session.add(PostReport(post_id=post_id, user_id=user.id, reason=payload.reason))
    else:
        report.reason = payload.reason
    await session.commit()


# --- Discussion ------------------------------------------------------------------------------------------


def _comment_out(comment: PostComment, user: User) -> CommentOut:
    return CommentOut(
        id=comment.id,
        body=comment.body,
        author=public_author(comment.author),
        mine=comment.user_id == user.id,
        created_at=comment.created_at,
    )


@router.get("/{post_id}/comments", response_model=list[CommentOut])
async def list_comments(post_id: uuid.UUID, user: CurrentUser, session: SessionDep):
    await _public_post(session, post_id)
    stmt = (
        select(PostComment)
        .where(
            PostComment.post_id == post_id,
            PostComment.hidden_at.is_(None),
            PostComment.user_id.in_(select(User.id).where(User.disabled_at.is_(None))),
        )
        .order_by(PostComment.created_at)
    )
    return [_comment_out(c, user) for c in (await session.scalars(stmt)).all()]


@router.post("/{post_id}/comments", response_model=CommentOut, status_code=status.HTTP_201_CREATED)
async def add_comment(post_id: uuid.UUID, payload: CommentIn, user: CurrentUser, session: SessionDep):
    await _public_post(session, post_id)
    body = payload.body.strip()
    if not body or len(body) > MAX_COMMENT_CHARS:
        raise HTTPException(422, MSG["MSG-COMMENT-EMPTY"])
    if not comment_limiter.hit(str(user.id)):
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, MSG["MSG-POST-LIMIT"])
    comment = PostComment(post_id=post_id, user_id=user.id, body=body)
    comment.author = user
    session.add(comment)
    await session.commit()
    return _comment_out(comment, user)


async def _visible_comment(session: AsyncSession, comment_id: uuid.UUID) -> PostComment:
    comment = await session.get(PostComment, comment_id)
    if comment is None or comment.hidden_at is not None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, MSG["MSG-COMMENT-404"])
    return comment


@router.delete("/comments/{comment_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_comment(comment_id: uuid.UUID, user: CurrentUser, session: SessionDep):
    comment = await session.get(PostComment, comment_id)
    if comment is None or comment.user_id != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, MSG["MSG-COMMENT-404"])
    await session.delete(comment)
    await session.commit()


@router.post("/comments/{comment_id}/report", status_code=status.HTTP_204_NO_CONTENT)
async def report_comment(comment_id: uuid.UUID, payload: ReportIn, user: CurrentUser, session: SessionDep):
    _report_allowed(user)
    comment = await _visible_comment(session, comment_id)
    await _public_post(session, comment.post_id)
    report = await session.get(CommentReport, (comment_id, user.id))
    if report is None:
        session.add(CommentReport(comment_id=comment_id, user_id=user.id, reason=payload.reason))
    else:
        report.reason = payload.reason
    await session.commit()
