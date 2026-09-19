"""FR-SRCH-01: keyword search over the user's documents, highlights, notes, AI summaries and notebooks."""

import re
import unicodedata
import uuid
from datetime import datetime
from typing import Literal

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import ColumnElement, Select, func, literal, literal_column, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import CurrentUser, SessionDep
from app.models import Document, Highlight, Notebook, Summary
from app.schemas import HighlightCategory, file_type_of

router = APIRouter(tags=["search"])

PAGE_SIZE = 10
SearchType = Literal["document", "highlight", "note", "summary", "notebook"]
ALL_TYPES: tuple[SearchType, ...] = ("document", "highlight", "note", "summary", "notebook")

# Snippet markers: control characters never appear in extracted text, so the client can split on them safely.
MARK_START, MARK_END = "\x02", "\x03"
HEADLINE_OPTS = f"MaxFragments=1, MaxWords=32, MinWords=12, ShortWord=1, StartSel={MARK_START}, StopSel={MARK_END}"
TS_CONFIG = literal_column("'public.pm_unaccent'::regconfig")
SNIPPET_CHARS = 200
MARKDOWN_SYNTAX = re.compile(r"[#*_`|>]+|\[\d{1,3}\]")  # notebook snippets show plain text


class SearchHit(BaseModel):
    kind: Literal["document", "highlight", "note", "document_note", "summary", "notebook"]
    id: uuid.UUID
    # A notebook hit has no document: `document_title` is then the notebook's title.
    document_id: uuid.UUID | None
    document_title: str
    file_type: Literal["pdf", "epub", "web"] | None
    snippet: str
    highlight_id: uuid.UUID | None = None
    color: str | None = None
    category: str | None = None
    page_number: int | None = None
    created_at: datetime


class SearchGroup(BaseModel):
    items: list[SearchHit]
    total: int


class SearchResults(BaseModel):
    query: str
    documents: SearchGroup
    highlights: SearchGroup
    notes: SearchGroup
    summaries: SearchGroup
    notebooks: SearchGroup


def normalize_query(q: str) -> str:
    return " ".join(q.split())


def _fold(text: str) -> str:
    """Lowercase without Vietnamese diacritics (Python mirror of unaccent, for the fallback path)."""
    text = text.replace("đ", "d").replace("Đ", "D")
    return "".join(c for c in unicodedata.normalize("NFD", text) if unicodedata.category(c) != "Mn").lower()


def _terms(q: str) -> list[str]:
    return [t for t in re.findall(r"\w+", q)][:10]


def _tsquery(q: str) -> str:
    # Every word must match; the last may be a prefix of a longer word ("tổng quá" finds "tổng quát").
    terms = _terms(q)
    return " & ".join(f"{t}:*" if i == len(terms) - 1 else t for i, t in enumerate(terms))


def _plain_snippet(text: str, q: str) -> str:
    """Fallback snippet: ~200 chars around the first term, terms wrapped in markers."""
    folded = _fold(text)
    terms = [_fold(t) for t in _terms(q)]
    pos = min((p for p in (folded.find(t) for t in terms) if p >= 0), default=0)
    start = max(0, pos - 60)
    end = min(len(text), start + SNIPPET_CHARS)
    piece, fpiece = text[start:end], folded[start:end]
    out, i = [], 0
    while i < len(piece):
        hit = next((t for t in terms if t and fpiece.startswith(t, i)), None)
        if hit:
            out.append(f"{MARK_START}{piece[i:i + len(hit)]}{MARK_END}")
            i += len(hit)
        else:
            out.append(piece[i])
            i += 1
    return ("…" if start else "") + "".join(out).strip() + ("…" if end < len(text) else "")


class _Searcher:
    """Builds match / rank / snippet expressions for PostgreSQL, or a LIKE fallback elsewhere (tests)."""

    def __init__(self, session: AsyncSession, q: str):
        self.q = q
        self.pg = session.bind.dialect.name == "postgresql"
        self.tsq = func.to_tsquery(TS_CONFIG, _tsquery(q)) if self.pg else None

    def match(self, column) -> ColumnElement[bool]:
        if self.pg:
            return func.to_tsvector(TS_CONFIG, column).op("@@")(self.tsq)
        # SQLite has no unaccent: good enough for tests with plain words.
        return func.lower(column).contains(self.q.lower())

    def rank(self, column, weight: float = 1.0):
        if self.pg:
            return func.ts_rank(func.to_tsvector(TS_CONFIG, column), self.tsq) * weight
        return literal(0.0)  # a bound value; a bare 0 would mean "column 0" in ORDER BY

    def headline(self, column):
        if self.pg:
            return func.ts_headline(TS_CONFIG, column, self.tsq, HEADLINE_OPTS)
        return column

    def snippet(self, raw: str) -> str:
        if self.pg:
            return raw.strip()
        return _plain_snippet(raw, self.q)


async def _page(session: AsyncSession, stmt: Select, count_stmt: Select, page: int) -> tuple[list, int]:
    total = await session.scalar(count_stmt) or 0
    rows = (await session.execute(stmt.offset((page - 1) * PAGE_SIZE).limit(PAGE_SIZE))).all()
    return rows, total


def _empty() -> SearchGroup:
    return SearchGroup(items=[], total=0)


@router.get("/search", response_model=SearchResults)
async def search(
    user: CurrentUser,
    session: SessionDep,
    q: str = Query(max_length=200),
    types: list[SearchType] = Query(default=list(ALL_TYPES)),
    category: HighlightCategory | None = None,
    page: int = Query(1, ge=1, le=100),
):
    query = normalize_query(q)
    if len(query) < 2 or not _terms(query):
        raise HTTPException(422, "Nhập ít nhất 2 ký tự để tìm kiếm.")
    s = _Searcher(session, query)
    wanted = set(types)
    result = SearchResults(
        query=query, documents=_empty(), highlights=_empty(), notes=_empty(), summaries=_empty(),
        notebooks=_empty(),
    )

    if "document" in wanted:
        cond = [Document.user_id == user.id, or_(s.match(Document.title), s.match(Document.content_clean))]
        rank = s.rank(Document.title, 2.0) + s.rank(Document.content_clean)  # title matches count double
        stmt = (
            select(Document.id, Document.title, Document.source_type, Document.original_filename,
                   Document.created_at, s.headline(Document.content_clean).label("snippet"))
            .where(*cond)
            .order_by(rank.desc(), Document.created_at.desc())
        )
        rows, total = await _page(session, stmt, select(func.count()).select_from(Document).where(*cond), page)
        result.documents = SearchGroup(
            total=total,
            items=[
                SearchHit(
                    kind="document", id=r.id, document_id=r.id, document_title=r.title,
                    file_type=file_type_of(r.source_type, r.original_filename),
                    snippet=s.snippet(r.snippet or ""), created_at=r.created_at,
                )
                for r in rows
            ],
        )

    hl_base = [Highlight.user_id == user.id]
    if category:
        hl_base.append(Highlight.category == category)

    def hl_select(text_col, where):
        return (
            select(Highlight, Document.title, Document.source_type, Document.original_filename,
                   s.headline(text_col).label("snippet"))
            .join(Document, Document.id == Highlight.document_id)
            .where(*where)
            .order_by(s.rank(text_col).desc(), Highlight.created_at.desc())
        )

    def hl_hit(kind, r) -> SearchHit:
        h: Highlight = r[0]
        return SearchHit(
            kind=kind, id=h.id, highlight_id=h.id, document_id=h.document_id, document_title=r.title,
            file_type=file_type_of(r.source_type, r.original_filename), snippet=s.snippet(r.snippet or ""),
            color=h.color, category=h.category, page_number=h.page_number, created_at=h.created_at,
        )

    if "highlight" in wanted:
        where = [*hl_base, s.match(Highlight.selected_text)]
        rows, total = await _page(
            session, hl_select(Highlight.selected_text, where),
            select(func.count()).select_from(Highlight).where(*where), page,
        )
        result.highlights = SearchGroup(total=total, items=[hl_hit("highlight", r) for r in rows])

    if "note" in wanted:
        # Highlight notes; document notes are included when no category filter is set.
        where = [*hl_base, Highlight.note != "", s.match(Highlight.note)]
        rows, total = await _page(
            session, hl_select(Highlight.note, where), select(func.count()).select_from(Highlight).where(*where), page
        )
        items = [hl_hit("note", r) for r in rows]
        if not category:
            dcond = [Document.user_id == user.id, Document.note != "", s.match(Document.note)]
            dstmt = (
                select(Document.id, Document.title, Document.source_type, Document.original_filename,
                       Document.updated_at, s.headline(Document.note).label("snippet"))
                .where(*dcond)
                .order_by(s.rank(Document.note).desc(), Document.updated_at.desc())
            )
            drows, dtotal = await _page(session, dstmt, select(func.count()).select_from(Document).where(*dcond), page)
            total += dtotal
            items += [
                SearchHit(
                    kind="document_note", id=r.id, document_id=r.id, document_title=r.title,
                    file_type=file_type_of(r.source_type, r.original_filename),
                    snippet=s.snippet(r.snippet or ""), created_at=r.updated_at,
                )
                for r in drows
            ]
        result.notes = SearchGroup(total=total, items=items)

    if "summary" in wanted and not category:
        cond = [Document.user_id == user.id, s.match(Summary.search_text)]
        stmt = (
            select(Summary.id, Summary.document_id, Summary.created_at, Document.title, Document.source_type,
                   Document.original_filename, s.headline(Summary.search_text).label("snippet"))
            .join(Document, Document.id == Summary.document_id)
            .where(*cond)
            .order_by(s.rank(Summary.search_text).desc(), Summary.created_at.desc())
        )
        count = select(func.count()).select_from(Summary).join(Document, Document.id == Summary.document_id)
        rows, total = await _page(session, stmt, count.where(*cond), page)
        result.summaries = SearchGroup(
            total=total,
            items=[
                SearchHit(
                    kind="summary", id=r.id, document_id=r.document_id, document_title=r.title,
                    file_type=file_type_of(r.source_type, r.original_filename),
                    snippet=s.snippet(r.snippet or ""), created_at=r.created_at,
                )
                for r in rows
            ],
        )

    if "notebook" in wanted and not category:
        cond = [Notebook.user_id == user.id, or_(s.match(Notebook.title), s.match(Notebook.content))]
        stmt = (
            select(Notebook.id, Notebook.title, Notebook.updated_at, s.headline(Notebook.content).label("snippet"))
            .where(*cond)
            .order_by((s.rank(Notebook.title, 2.0) + s.rank(Notebook.content)).desc(), Notebook.updated_at.desc())
        )
        rows, total = await _page(session, stmt, select(func.count()).select_from(Notebook).where(*cond), page)
        result.notebooks = SearchGroup(
            total=total,
            items=[
                SearchHit(
                    kind="notebook", id=r.id, document_id=None, document_title=r.title, file_type=None,
                    snippet=MARKDOWN_SYNTAX.sub("", s.snippet(r.snippet or "")), created_at=r.updated_at,
                )
                for r in rows
            ],
        )

    return result
