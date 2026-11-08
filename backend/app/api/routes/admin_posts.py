"""Moderating what users chose to make public: posts and comments.

This is the one place an admin reads user-written text, and only because its author published it. Drafts,
notebooks, documents and unnamed sources never come through here. Every change is in the audit log, by id
alone, so the log never holds what a user wrote.
"""

import uuid
from collections import Counter
from datetime import datetime
from typing import Literal

from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import AdminUser, SessionDep
from app.api.routes.community import PublicAuthor, PublicSource, public_author
from app.api.routes.posts import PostCard
from app.core.messages import MSG
from app.models import AdminAuditLog, CommentReport, Post, PostComment, PostReport, User, utcnow

router = APIRouter(prefix="/admin", tags=["admin"])


async def _audit(session: AsyncSession, admin: User, action: str, author_id: uuid.UUID, **detail) -> None:
    """Moderation lands on someone, so the log names whose post or comment it was, as for account actions."""
    author = await session.get(User, author_id)
    session.add(
        AdminAuditLog(
            admin_id=admin.id,
            admin_email=admin.email,
            target_user_id=author_id,
            target_email=author.email if author else None,
            action=action,
            detail=detail,
        )
    )


class AdminPost(BaseModel):
    id: uuid.UUID
    kind: str
    title: str
    cards: list[PostCard]
    body: str
    topic: str | None
    ai_assisted: bool
    author: PublicAuthor
    sources: list[PublicSource]
    published_at: datetime | None
    hidden: bool
    reports: dict[str, int]


class AdminPostPage(BaseModel):
    items: list[AdminPost]
    total: int
    page: int
    page_size: int


class AdminComment(BaseModel):
    id: uuid.UUID
    post_id: uuid.UUID
    body: str
    author: PublicAuthor
    created_at: datetime
    hidden: bool
    reports: dict[str, int]


async def _published(session: SessionDep, post_id: uuid.UUID) -> Post:
    """A draft is private even if it was once published: to an admin it does not exist."""
    post = await session.get(Post, post_id)
    if post is None or post.status != "published":
        raise HTTPException(status.HTTP_404_NOT_FOUND, MSG["MSG-POST-404"])
    return post


@router.get("/posts", response_model=AdminPostPage)
async def list_posts(
    _: AdminUser,
    session: SessionDep,
    state: Literal["all", "reported", "hidden"] = "all",
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=100),
):
    where = [Post.status == "published"]
    if state == "hidden":
        where.append(Post.hidden_at.is_not(None))
    elif state == "reported":
        where.append(Post.id.in_(select(PostReport.post_id)))
    total = await session.scalar(select(func.count(Post.id)).where(*where)) or 0
    posts = (
        await session.scalars(
            select(Post).where(*where).order_by(Post.published_at.desc()).offset((page - 1) * page_size).limit(page_size)
        )
    ).all()
    tallies: dict[uuid.UUID, Counter] = {p.id: Counter() for p in posts}
    if posts:
        rows = await session.execute(
            select(PostReport.post_id, PostReport.reason).where(PostReport.post_id.in_(list(tallies)))
        )
        for post_id, reason in rows.all():
            tallies[post_id][reason] += 1
    return AdminPostPage(
        items=[
            AdminPost(
                id=p.id,
                kind=p.kind,
                title=p.title,
                cards=p.cards or [],
                body=p.body,
                topic=p.topic,
                ai_assisted=p.ai_assisted,
                author=public_author(p.author),
                sources=[
                    PublicSource(title=s.title, url=s.url, credit=s.credit, license=s.license)
                    for s in p.sources
                    if s.shown
                ],
                published_at=p.published_at,
                hidden=p.hidden_at is not None,
                reports=dict(tallies[p.id]),
            )
            for p in posts
        ],
        total=total,
        page=page,
        page_size=page_size,
    )


@router.post("/posts/{post_id}/hide", status_code=status.HTTP_204_NO_CONTENT)
async def hide_post(post_id: uuid.UUID, admin: AdminUser, session: SessionDep):
    post = await _published(session, post_id)
    post.hidden_at = utcnow()
    await _audit(session, admin, "post.hide", post.user_id, post_id=str(post.id))
    await session.commit()


@router.post("/posts/{post_id}/show", status_code=status.HTTP_204_NO_CONTENT)
async def show_post(post_id: uuid.UUID, admin: AdminUser, session: SessionDep):
    post = await _published(session, post_id)
    post.hidden_at = None
    await _audit(session, admin, "post.show", post.user_id, post_id=str(post.id))
    await session.commit()


@router.delete("/posts/{post_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_post(post_id: uuid.UUID, admin: AdminUser, session: SessionDep):
    """Takes the post, its comments and reports. The author's notebook and documents are not touched."""
    post = await _published(session, post_id)
    await _audit(session, admin, "post.delete", post.user_id, post_id=str(post.id))
    await session.delete(post)
    await session.commit()


@router.get("/comments", response_model=list[AdminComment])
async def list_comments(
    _: AdminUser,
    session: SessionDep,
    state: Literal["reported", "hidden"] = "reported",
    limit: int = Query(default=50, ge=1, le=200),
):
    """Reported or hidden comments on published posts."""
    where = [PostComment.post_id.in_(select(Post.id).where(Post.status == "published"))]
    if state == "hidden":
        where.append(PostComment.hidden_at.is_not(None))
    else:
        where.append(PostComment.id.in_(select(CommentReport.comment_id)))
    comments = (
        await session.scalars(select(PostComment).where(*where).order_by(PostComment.created_at.desc()).limit(limit))
    ).all()
    tallies: dict[uuid.UUID, Counter] = {c.id: Counter() for c in comments}
    if comments:
        rows = await session.execute(
            select(CommentReport.comment_id, CommentReport.reason).where(CommentReport.comment_id.in_(list(tallies)))
        )
        for comment_id, reason in rows.all():
            tallies[comment_id][reason] += 1
    return [
        AdminComment(
            id=c.id,
            post_id=c.post_id,
            body=c.body,
            author=public_author(c.author),
            created_at=c.created_at,
            hidden=c.hidden_at is not None,
            reports=dict(tallies[c.id]),
        )
        for c in comments
    ]


async def _comment(session: SessionDep, comment_id: uuid.UUID) -> PostComment:
    comment = await session.get(PostComment, comment_id)
    if comment is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, MSG["MSG-COMMENT-404"])
    await _published(session, comment.post_id)
    return comment


@router.post("/comments/{comment_id}/hide", status_code=status.HTTP_204_NO_CONTENT)
async def hide_comment(comment_id: uuid.UUID, admin: AdminUser, session: SessionDep):
    comment = await _comment(session, comment_id)
    comment.hidden_at = utcnow()
    await _audit(session, admin, "comment.hide", comment.user_id, comment_id=str(comment.id))
    await session.commit()


@router.post("/comments/{comment_id}/show", status_code=status.HTTP_204_NO_CONTENT)
async def show_comment(comment_id: uuid.UUID, admin: AdminUser, session: SessionDep):
    comment = await _comment(session, comment_id)
    comment.hidden_at = None
    await _audit(session, admin, "comment.show", comment.user_id, comment_id=str(comment.id))
    await session.commit()
