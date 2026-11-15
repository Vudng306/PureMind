"""Well-known research papers to discover and add to the library (the arXiv tab of /explore).

The collections are public, like the rest of /explore; searching arXiv, and knowing which papers are in
the library already, needs an account.
"""

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel
from sqlalchemy import select

from app.api.deps import CurrentUser, SessionDep, SettingsDep, get_current_user
from app.core.messages import MSG
from app.core.ratelimit import papers_search_limiter
from app.models import Document, User
from app.services import doi, papers

router = APIRouter(prefix="/papers", tags=["papers"])


async def optional_user(request: Request, session: SessionDep, settings: SettingsDep) -> User | None:
    """The signed-in user, or None for a visitor. A token that is sent must still be valid."""
    if not request.headers.get("Authorization"):
        return None
    return await get_current_user(request, session, settings)


OptionalUser = Annotated[User | None, Depends(optional_user)]


class Paper(BaseModel):
    arxiv_id: str
    doi: str
    title: str
    authors: list[str]
    author_count: int
    year: int | None
    abstract: str
    category: str
    # The user's copy, when the paper is in their library already.
    document_id: str | None = None


class PaperCollection(BaseModel):
    id: str
    papers: list[Paper]


class PaperSearch(BaseModel):
    papers: list[Paper]
    total: int
    page: int
    has_more: bool


async def _with_copies(session: SessionDep, user: User | None, found: list[dict]) -> list[Paper]:
    """The papers, each with the id of the user's copy: one saved from its doi.org link keeps that address."""
    copies: dict[str, str] = {}
    if user is not None and found:
        urls = {doi.url_of(p["doi"]): p["doi"] for p in found}
        rows = await session.execute(
            select(Document.id, Document.url).where(Document.user_id == user.id, Document.url.in_(urls))
        )
        copies = {urls[url]: str(doc_id) for doc_id, url in rows}
    return [Paper(**p, document_id=copies.get(p["doi"])) for p in found]


@router.get("", response_model=list[PaperCollection])
async def list_collections(user: OptionalUser, session: SessionDep):
    """The collections of well-known papers, by field."""
    groups = papers.collections()
    found = await _with_copies(session, user, [p for g in groups for p in g["papers"]])
    by_doi = {p.doi: p for p in found}
    return [PaperCollection(id=g["id"], papers=[by_doi[p["doi"]] for p in g["papers"]]) for g in groups]


@router.get("/search", response_model=PaperSearch)
async def search_papers(
    user: CurrentUser,
    session: SessionDep,
    settings: SettingsDep,
    q: str = Query(min_length=1, max_length=papers.MAX_QUERY),
    category: str | None = None,
    page: int = Query(0, ge=0, lt=papers.MAX_PAGES),
):
    """Papers on arXiv matching the words of `q`, optionally in one field, most relevant first."""
    if category is not None and category not in papers.CATEGORIES:
        raise HTTPException(422, MSG["MSG-INVALID"])
    if not papers.terms(q):
        return PaperSearch(papers=[], total=0, page=page, has_more=False)
    if not papers_search_limiter.hit(str(user.id)):
        raise HTTPException(429, MSG["MSG-PAPERS-LIMIT"])
    try:
        found, total = await papers.search(q, category, page, settings.web_contact)
    except papers.SearchUnavailable:
        raise HTTPException(503, MSG["MSG-PAPERS-UNAVAILABLE"]) from None
    more = (
        len(found) == papers.PAGE_SIZE
        and (page + 1) * papers.PAGE_SIZE < total
        and page + 1 < papers.MAX_PAGES
    )
    return PaperSearch(papers=await _with_copies(session, user, found), total=total, page=page, has_more=more)
