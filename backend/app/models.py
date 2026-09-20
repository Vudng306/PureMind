"""ORM models (SRS section 5): users, documents, highlights, summaries, notebooks."""

import enum
import uuid
from datetime import UTC, date, datetime

from sqlalchemy import (
    JSON,
    BigInteger,
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    Enum,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    Uuid,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship

JsonType = JSON().with_variant(JSONB(), "postgresql")


def utcnow() -> datetime:
    return datetime.now(UTC)


class Base(DeclarativeBase):
    pass


class TimestampMixin:
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=utcnow, nullable=False
    )


class User(TimestampMixin, Base):
    """Profile row; `id` equals the Supabase Auth user id (JWT `sub`)."""

    __tablename__ = "users"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True)
    email: Mapped[str] = mapped_column(String(255), unique=True, nullable=False)
    display_name: Mapped[str | None] = mapped_column(String(255))
    avatar_path: Mapped[str | None] = mapped_column(String(1024))
    reading_preferences: Mapped[dict] = mapped_column(JsonType, default=dict, nullable=False)
    ai_quota_used: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    ai_quota_date: Mapped[date | None] = mapped_column(Date)

    documents: Mapped[list["Document"]] = relationship(
        back_populates="user", cascade="all, delete-orphan", passive_deletes=True
    )

    @property
    def avatar_url(self) -> str | None:
        if not self.avatar_path:
            return None
        return f"/api/account/avatar?v={int(self.updated_at.timestamp())}"

    @property
    def ai_quota_remaining(self) -> int:
        from app.core.config import get_settings
        from app.services.ai_quota import remaining

        return remaining(self, get_settings().ai_daily_quota)


class SourceType(str, enum.Enum):
    upload = "upload"
    manual = "manual"


class ExtractionStatus(str, enum.Enum):
    pending = "pending"
    processing = "processing"
    done = "done"
    failed = "failed"


class Document(TimestampMixin, Base):
    __tablename__ = "documents"
    __table_args__ = (
        UniqueConstraint("user_id", "url", name="uq_documents_user_url"),
        Index("ix_documents_user_created", "user_id", "created_at"),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    source_type: Mapped[SourceType] = mapped_column(Enum(SourceType, name="source_type"), nullable=False)
    url: Mapped[str | None] = mapped_column(String(2048))
    title: Mapped[str] = mapped_column(String(500), nullable=False)
    content_clean: Mapped[str] = mapped_column(Text, default="", nullable=False)
    file_storage_path: Mapped[str | None] = mapped_column(String(1024))
    original_filename: Mapped[str | None] = mapped_column(String(500))
    file_size: Mapped[int | None] = mapped_column(BigInteger)
    page_count: Mapped[int | None] = mapped_column(Integer)
    word_count: Mapped[int | None] = mapped_column(Integer)
    extraction_status: Mapped[ExtractionStatus] = mapped_column(
        Enum(ExtractionStatus, name="extraction_status"), default=ExtractionStatus.pending, nullable=False
    )
    extraction_error: Mapped[str | None] = mapped_column(String(500))
    last_read_page: Mapped[int | None] = mapped_column(Integer)
    is_read: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    published_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # Free-form note for the whole document and clean-text scroll position (0..1).
    note: Mapped[str] = mapped_column(Text, default="", nullable=False)
    read_fraction: Mapped[float | None] = mapped_column(Float)

    user: Mapped[User] = relationship(back_populates="documents")


HIGHLIGHT_COLORS = ("yellow", "green", "blue", "pink", "purple")
HIGHLIGHT_CATEGORIES = ("important", "concept", "question", "example", "review")


class Highlight(TimestampMixin, Base):
    """A highlighted passage.

    Anchored in the clean text (block id + [start, end) character offsets), on the original PDF page
    (page_number + rectangles normalised to 0..1 of the page size, FR-HL-01 step 2), or both.
    """

    __tablename__ = "highlights"
    __table_args__ = (
        Index("ix_highlights_document_created", "document_id", "created_at"),
        CheckConstraint(
            "block_id IS NULL OR (start_offset >= 0 AND end_offset > start_offset)",
            name="ck_highlights_offsets",
        ),
        CheckConstraint(
            "(block_id IS NOT NULL AND start_offset IS NOT NULL AND end_offset IS NOT NULL)"
            " OR (rects IS NOT NULL AND page_number IS NOT NULL)",
            name="ck_highlights_anchor",
        ),
        CheckConstraint("color IN ('yellow', 'green', 'blue', 'pink', 'purple')", name="ck_highlights_color"),
        CheckConstraint(
            "category IS NULL OR category IN ('important', 'concept', 'question', 'example', 'review')",
            name="ck_highlights_category",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    document_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("documents.id", ondelete="CASCADE"), nullable=False
    )
    block_id: Mapped[str | None] = mapped_column(String(64))
    start_offset: Mapped[int | None] = mapped_column(Integer)
    end_offset: Mapped[int | None] = mapped_column(Integer)
    # [{x, y, w, h}] on page `page_number` of the original PDF.
    rects: Mapped[list | None] = mapped_column(JsonType)
    selected_text: Mapped[str] = mapped_column(Text, nullable=False)
    color: Mapped[str] = mapped_column(String(16), nullable=False)
    # FR-HL-04: at most one category, independent of the color.
    category: Mapped[str | None] = mapped_column(String(16))
    # FR-NOTE-01: at most one note per highlight; "" = no note.
    note: Mapped[str] = mapped_column(Text, default="", nullable=False)
    page_number: Mapped[int | None] = mapped_column(Integer)


class Summary(Base):
    """FR-SUM-01: the current AI summary of a document (at most one; regenerating replaces it)."""

    __tablename__ = "summaries"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    document_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("documents.id", ondelete="CASCADE"), nullable=False, unique=True
    )
    key_points: Mapped[list] = mapped_column(JsonType, nullable=False)
    # [{term, explanation}]
    concepts: Mapped[list] = mapped_column(JsonType, nullable=False)
    conclusion: Mapped[str] = mapped_column(Text, nullable=False)
    keywords: Mapped[list] = mapped_column(JsonType, nullable=False)
    # All of the above as plain text, for FR-SRCH-01.
    search_text: Mapped[str] = mapped_column(Text, default="", nullable=False)
    language: Mapped[str] = mapped_column(String(5), nullable=False)
    ai_model: Mapped[str] = mapped_column(String(100), nullable=False)
    prompt_tokens: Mapped[int] = mapped_column(Integer, nullable=False)
    completion_tokens: Mapped[int] = mapped_column(Integer, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)


NOTEBOOK_STATUSES = ("draft", "saved")
MAX_NOTEBOOK_CHARS = 200_000  # SRS 5: notebooks.content <= 200,000 characters
MAX_NOTEBOOK_SOURCES = 100  # FR-NB-01
MAX_NOTEBOOK_VERSIONS = 50  # FR-NB-03 step 5: older snapshots are dropped


class Notebook(TimestampMixin, Base):
    """FR-NB-02..05: a Markdown study notebook written by AI from highlights. Starts as a draft; "Lưu" saves it."""

    __tablename__ = "notebooks"
    __table_args__ = (
        Index("ix_notebooks_user_updated", "user_id", "updated_at"),
        CheckConstraint("status IN ('draft', 'saved')", name="ck_notebooks_status"),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    content: Mapped[str] = mapped_column(Text, default="", nullable=False)
    status: Mapped[str] = mapped_column(String(8), default="draft", nullable=False)
    ai_model: Mapped[str | None] = mapped_column(String(100))
    # DR-03: drafts not opened or edited for 30 days are deleted.
    opened_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)

    sources: Mapped[list["NotebookHighlight"]] = relationship(
        cascade="all, delete-orphan", passive_deletes=True, order_by="NotebookHighlight.position"
    )


class NotebookHighlight(Base):
    """A source highlight of a notebook; `position` is its [n] reference number in the content."""

    __tablename__ = "notebook_highlights"
    __table_args__ = (UniqueConstraint("notebook_id", "position", name="uq_notebook_highlights_position"),)

    notebook_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("notebooks.id", ondelete="CASCADE"), primary_key=True
    )
    # Deleting a highlight (or its document) removes the link; the notebook keeps its text (FR-HL-03).
    highlight_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("highlights.id", ondelete="CASCADE"), primary_key=True, index=True
    )
    position: Mapped[int] = mapped_column(Integer, nullable=False)
    added_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)

    highlight: Mapped[Highlight] = relationship(lazy="joined")


class NotebookVersion(Base):
    """FR-NB-03 step 5 (P2): the title and content as they were each time the notebook was saved with "Lưu"."""

    __tablename__ = "notebook_versions"
    __table_args__ = (Index("ix_notebook_versions_notebook_created", "notebook_id", "created_at"),)

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    notebook_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("notebooks.id", ondelete="CASCADE"), nullable=False
    )
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
