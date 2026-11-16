"""ORM models (SRS section 5): users, documents, highlights, summaries, notebooks, document chat, feed, posts."""

import enum
import hashlib
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


USER_ROLES = ("user", "admin")
# The version of the terms of use (frontend /terms). Bump it when they change: everyone is asked again.
TERMS_VERSION = "2026-11-05"


class User(TimestampMixin, Base):
    """Profile row; `id` equals the Supabase Auth user id (JWT `sub`)."""

    __tablename__ = "users"
    __table_args__ = (CheckConstraint("role IN ('user', 'admin')", name="ck_users_role"),)

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True)
    email: Mapped[str] = mapped_column(String(255), unique=True, nullable=False)
    display_name: Mapped[str | None] = mapped_column(String(255))
    avatar_path: Mapped[str | None] = mapped_column(String(1024))
    reading_preferences: Mapped[dict] = mapped_column(JsonType, default=dict, nullable=False)
    ai_quota_used: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    ai_quota_date: Mapped[date | None] = mapped_column(Date)
    # FR-CHAT-02: questions have their own daily allowance, reset at 00:00 Vietnam time like the other one.
    chat_quota_used: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    chat_quota_date: Mapped[date | None] = mapped_column(Date)
    # FR-ADM-01: one role besides the default; the first admin is made with `python -m app.scripts.make_admin`.
    role: Mapped[str] = mapped_column(String(8), default="user", server_default="user", nullable=False)
    # FR-ADM-03: set while the account is locked; every request is refused and Supabase bans the login.
    disabled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # Refreshed at most once an hour (api/deps.py), for the admin's user list.
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # The terms of use the user accepted, and when; until it is TERMS_VERSION the app asks first.
    terms_version: Mapped[str | None] = mapped_column(String(16))
    terms_accepted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    documents: Mapped[list["Document"]] = relationship(
        back_populates="user", cascade="all, delete-orphan", passive_deletes=True
    )

    @property
    def terms_accepted(self) -> bool:
        return self.terms_version == TERMS_VERSION

    def accept_terms(self, ai_consent: bool) -> None:
        """Record the current terms, with the separate choice about sending content to OpenAI."""
        self.terms_version = TERMS_VERSION
        self.terms_accepted_at = utcnow()
        self.reading_preferences = {**(self.reading_preferences or {}), "ai_consent": ai_consent}

    @property
    def avatar_url(self) -> str | None:
        if not self.avatar_path:
            return None
        return f"/api/account/avatar?v={int(self.updated_at.timestamp())}"

    @property
    def is_admin(self) -> bool:
        return self.role == "admin"

    @property
    def ai_quota_remaining(self) -> int:
        from app.core.config import get_settings
        from app.services.ai_quota import remaining

        return remaining(self, get_settings().ai_daily_quota)

    @property
    def chat_quota_remaining(self) -> int:
        from app.core.config import get_settings
        from app.services.ai_quota import chat_remaining

        return chat_remaining(self, get_settings().chat_daily_quota)


MAX_COLLECTION_NAME = 80


class Collection(TimestampMixin, Base):
    """A shelf of the user's library, usually a subject. Removing it leaves the documents in the library."""

    __tablename__ = "collections"
    __table_args__ = (UniqueConstraint("user_id", "name", name="uq_collections_user_name"),)

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(String(MAX_COLLECTION_NAME), nullable=False)


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
    # Where the reader stopped in the clean text: {"block_id": the block at the top of the page, "offset":
    # how far into it, 0..1}. It holds when the type size or the column changes, which read_fraction
    # (kept for the progress bars and as the fallback) does not.
    read_position: Mapped[dict | None] = mapped_column(JsonType)
    # What the extraction knows it left out or could not turn into text (schemas.ExtractionIssue): empty
    # when it found nothing of the kind, None for a document extracted before this was recorded.
    extraction_issues: Mapped[list | None] = mapped_column(JsonType)
    # FR-CHAT-01: sha256 of the text the chat index was built from; a re-extraction makes it stale.
    chunks_hash: Mapped[str | None] = mapped_column(String(64))
    chunks_model: Mapped[str | None] = mapped_column(String(100))
    # Where each block of the clean text is on the original PDF: [[block key, [[page, x, y, w, h], …]], …]
    # with the key the reader's block id is made from and boxes as fractions of the page. Loaded on demand.
    source_map: Mapped[list | None] = mapped_column(JsonType, deferred=True)
    # {image name: description} of the document's figures, written by the vision model after extraction so
    # the AI, which reads text only, knows what they show (services/figure_notes). Loaded on demand.
    figure_notes: Mapped[dict | None] = mapped_column(JsonType, deferred=True)
    # {image name: chart} of the charts drawn as vector paths, their data read from the drawing at
    # extraction (services/chart_data): for the reader's data table and the AI. Loaded on demand.
    chart_data: Mapped[dict | None] = mapped_column(JsonType, deferred=True)
    # Clean Reader (CR-FR): the blocks taken out of the reading flow, never deleted — authors, affiliations,
    # running headers, references, funding… as {"classifier": …, "blocks": [{type, text, page, box,
    # confidence, reason}, …]} in document order (services/block_roles). Loaded on demand.
    content_aside: Mapped[dict | None] = mapped_column(JsonType, deferred=True)
    # How to cite the document (schemas.Citation): filled from its DOI or by the user, for BibTeX export.
    citation: Mapped[dict | None] = mapped_column(JsonType)
    # The shelf it is on, if any.
    collection_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("collections.id", ondelete="SET NULL"), index=True
    )
    # The licence it came under, when known (services/rights); None for what the user uploaded or found.
    license: Mapped[str | None] = mapped_column(String(32))

    user: Mapped[User] = relationship(back_populates="documents")

    @property
    def content_version(self) -> str | None:
        """Which clean text this is (AN-102): it changes when the document is extracted again, so a highlight
        made on an earlier text can be told from one made on this one."""
        if not self.content_clean:
            return None
        return hashlib.sha256(self.content_clean.encode()).hexdigest()[:16]


HIGHLIGHT_COLORS = ("yellow", "green", "blue", "pink", "purple")
HIGHLIGHT_CATEGORIES = ("important", "concept", "question", "example", "review")


EXTRACTION_ERRORS = (
    "missing_text", "wrong_order", "metadata_in_body", "missing_media", "ocr_error", "wrongly_hidden", "other",
)  # fmt: skip


class ExtractionReport(Base):
    """Clean Reader (CR-FR-15): the owner saying the clean text of a document is wrong — a paragraph missing,
    the order wrong, metadata left in the body, a block hidden that should not be… With the page and the
    side-store block it is about when known, and the classifier that made the text, so a report can be
    checked against the version it was made on. The text of the document is never copied here."""

    __tablename__ = "extraction_reports"
    __table_args__ = (
        CheckConstraint(
            "error_type IN (" + ", ".join(f"'{e}'" for e in EXTRACTION_ERRORS) + ")",
            name="ck_extraction_reports_error_type",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    document_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("documents.id", ondelete="CASCADE"), nullable=False, index=True
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    error_type: Mapped[str] = mapped_column(String(32), nullable=False)
    page: Mapped[int | None] = mapped_column(Integer)
    # The index of the block in documents.content_aside["blocks"], and its type then.
    block: Mapped[int | None] = mapped_column(Integer)
    block_type: Mapped[str | None] = mapped_column(String(32))
    classifier: Mapped[str | None] = mapped_column(String(32))
    note: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)


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
    # AN-102: the words just before and after the passage in its block, and the text of the document it was
    # made on (Document.content_version at that time). After a new extraction they tell a passage that only
    # moved from one that is now found in several places. None on highlights made before this was kept.
    prefix: Mapped[str | None] = mapped_column(String(64))
    suffix: Mapped[str | None] = mapped_column(String(64))
    content_version: Mapped[str | None] = mapped_column(String(16))


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


NOTE_ORIGINS = ("user", "ai_saved")
MAX_NOTE_BODY = 20_000
MAX_NOTES_PER_DOCUMENT = 500


class Note(TimestampMixin, Base):
    """A note on a document that is not tied to one highlight (a highlight's own note stays on the highlight).

    `origin` says who wrote it first: the reader, or the AI — and then only because the reader pressed
    "save to notes" on a summary, a mind-map node or an answer. Nothing the AI writes is stored here on its
    own. An AI note keeps where it came from in `provenance`, with the passages it cited, so it still shows
    its source after the summary it was taken from has been regenerated or the conversation deleted.
    """

    __tablename__ = "notes"
    __table_args__ = (
        Index("ix_notes_document_created", "document_id", "created_at"),
        # Saving the same AI passage twice (a double click, a retry) gives the note already there.
        UniqueConstraint("user_id", "source_key", name="uq_notes_user_source"),
        CheckConstraint("origin IN ('user', 'ai_saved')", name="ck_notes_origin"),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    document_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("documents.id", ondelete="CASCADE"), nullable=False
    )
    body: Mapped[str] = mapped_column(Text, nullable=False)
    origin: Mapped[str] = mapped_column(String(8), default="user", nullable=False)
    # ai_saved only: {source, source_id, part, model, language, generated_at, citations: [{position, ...}]}
    provenance: Mapped[dict | None] = mapped_column(JsonType)
    # ai_saved only: "<source>:<source id>:<part>"; null for the reader's own notes.
    source_key: Mapped[str | None] = mapped_column(String(160))


AI_ARTIFACT_KINDS = ("quick", "deep", "mindmap", "analysis")


class AiArtifact(Base):
    """What the reader's AI sidebar made for a document: a quick summary, a deep summary, a mind map or a
    research analysis.

    At most one of each kind per document; making it again replaces the row under a new id. `content_hash`
    is the text it was made from, so the reader can be told when the document has changed since.
    """

    __tablename__ = "ai_artifacts"
    __table_args__ = (
        UniqueConstraint("document_id", "kind", name="uq_ai_artifacts_document_kind"),
        CheckConstraint("kind IN ('quick', 'deep', 'mindmap', 'analysis')", name="ck_ai_artifacts_kind"),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    document_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("documents.id", ondelete="CASCADE"), nullable=False
    )
    kind: Mapped[str] = mapped_column(String(8), nullable=False)
    language: Mapped[str] = mapped_column(String(5), nullable=False)
    # The validated answer, with `citations`: [{position, page_number, heading, text}] it points at.
    payload: Mapped[dict] = mapped_column(JsonType, nullable=False)
    content_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    ai_model: Mapped[str] = mapped_column(String(100), nullable=False)
    prompt_revision: Mapped[int] = mapped_column(Integer, nullable=False)
    # The answer as plain text, for FR-SRCH-01.
    search_text: Mapped[str] = mapped_column(Text, default="", nullable=False)
    prompt_tokens: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    completion_tokens: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)


NOTEBOOK_STATUSES = ("draft", "saved")
MAX_NOTEBOOK_CHARS = 200_000  # SRS 5: notebooks.content <= 200,000 characters
MAX_NOTEBOOK_SOURCES = 100  # FR-NB-01
MAX_NOTEBOOK_VERSIONS = 50  # FR-NB-03 step 5: older snapshots are dropped


MAX_NOTEBOOK_TOPIC = 80


class Notebook(TimestampMixin, Base):
    """FR-NB-02..05: a Markdown notebook, started empty or written by AI from highlights. "Lưu" saves it."""

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
    # The subject or project it belongs to, in the user's words: the list is grouped by it.
    topic: Mapped[str | None] = mapped_column(String(MAX_NOTEBOOK_TOPIC))
    # DR-03: AI drafts not opened or edited for 30 days are deleted.
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


class NotebookDocument(Base):
    """A document the notebook draws on. It stays in the library; deleting it there only removes the link."""

    __tablename__ = "notebook_documents"

    notebook_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("notebooks.id", ondelete="CASCADE"), primary_key=True
    )
    document_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("documents.id", ondelete="CASCADE"), primary_key=True, index=True
    )
    added_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)


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


MAX_CHAT_QUESTION = 2000  # FR-CHAT-02: one question, MSG-36
MAX_CHAT_MESSAGES = 200  # FR-CHAT-03: turns kept in one conversation, MSG-38
MAX_CHAT_CONVERSATIONS = 50  # FR-CHAT-03: conversations kept per document; the oldest is dropped
CHAT_ROLES = ("user", "assistant")


class DocumentChunk(Base):
    """FR-CHAT-01: one indexed passage of a document, with its embedding.

    `embedding` holds the vector as a JSON array of floats. On PostgreSQL with pgvector the column casts to
    `vector`, so the ranking runs in the database; everywhere else (SQLite in the tests, a managed Postgres
    without the extension) the same cosine similarity is computed in Python. Passages belong to one document,
    so there are only hundreds of them per search and no ANN index is needed either way.
    """

    __tablename__ = "document_chunks"
    __table_args__ = (
        UniqueConstraint("document_id", "position", name="uq_document_chunks_position"),
        Index("ix_document_chunks_document", "document_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    document_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("documents.id", ondelete="CASCADE"), nullable=False
    )
    position: Mapped[int] = mapped_column(Integer, nullable=False)
    # Where the passage sits in the original: PDF page and the heading it was written under, both optional.
    page_number: Mapped[int | None] = mapped_column(Integer)
    heading: Mapped[str | None] = mapped_column(String(255))
    text: Mapped[str] = mapped_column(Text, nullable=False)
    token_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    embedding: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)


class ChatConversation(TimestampMixin, Base):
    """FR-CHAT-03: one thread of questions about one document. A document may have several."""

    __tablename__ = "chat_conversations"
    __table_args__ = (
        Index("ix_chat_conversations_document_updated", "document_id", "updated_at"),
        Index("ix_chat_conversations_user", "user_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    document_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("documents.id", ondelete="CASCADE"), nullable=False
    )
    # Empty until the first question, which the title is taken from.
    title: Mapped[str] = mapped_column(String(255), default="", nullable=False)
    language: Mapped[str] = mapped_column(String(5), default="vi", nullable=False)

    messages: Mapped[list["ChatMessage"]] = relationship(
        cascade="all, delete-orphan", passive_deletes=True, order_by="ChatMessage.created_at"
    )


class ChatMessage(Base):
    """One turn. An answer keeps the passages it cited, so [n] still resolves when the page is reopened."""

    __tablename__ = "chat_messages"
    __table_args__ = (
        Index("ix_chat_messages_conversation_created", "conversation_id", "created_at"),
        CheckConstraint("role IN ('user', 'assistant')", name="ck_chat_messages_role"),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    conversation_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("chat_conversations.id", ondelete="CASCADE"), nullable=False
    )
    role: Mapped[str] = mapped_column(String(9), nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    # [{position, page_number, heading, text}] — the numbered passages the answer was given (FR-CHAT-02).
    citations: Mapped[list] = mapped_column(JsonType, default=list, nullable=False)
    # A question about a figure: the image as written in the clean text (`pm-image:…` or its URL).
    image: Mapped[str | None] = mapped_column(String(2048))
    ai_model: Mapped[str | None] = mapped_column(String(100))
    prompt_tokens: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    completion_tokens: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)


ADMIN_ACTIONS = (
    "user.disable",
    "user.enable",
    "user.reset_quota",
    "user.delete",
    "article.hide",
    "article.show",
    "article.delete",
    "article.add",
    "crawl.run",
    "crawl.settings",
    "crawl.source",
    "channel.add",
    "channel.update",
    "channel.delete",
    "post.hide",
    "post.show",
    "post.delete",
    "comment.hide",
    "comment.show",
)


class AdminAuditLog(Base):
    """FR-ADM-05: every change an admin makes, kept after the admin or the target account is gone.

    The emails are copied at the time of the action because either account may be deleted later.
    `detail` holds counts and flags only, never anything a user wrote (NFR-PRV-01).
    """

    __tablename__ = "admin_audit_log"
    __table_args__ = (Index("ix_admin_audit_log_created", "created_at"),)

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    admin_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("users.id", ondelete="SET NULL"))
    admin_email: Mapped[str] = mapped_column(String(255), nullable=False)
    action: Mapped[str] = mapped_column(String(32), nullable=False)
    target_user_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, index=True)
    target_email: Mapped[str | None] = mapped_column(String(255))
    detail: Mapped[dict] = mapped_column(JsonType, default=dict, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)


# What an article is (the five kinds of the library, and the AI's own guides); frontend lib/feed.ts names them.
KINDS = ("explainer", "research", "report", "book", "essay", "guide")

# The feed's topics (frontend lib/feed.ts names them); an article has one or more.
TOPICS = (
    "science",
    "technology",
    "health",
    "mind",
    "philosophy",
    "environment",
    "economy",
    "law",
    "society",
    "education",
    "family",
    "history",
    "culture",
    "arts",
    "travel",
    "sports",
)


# A summary, a personal view, a synthesis of several sources, or just the link to an original on the web.
POST_KINDS = ("summary", "insight", "synthesis", "link")
POST_REPORT_REASONS = ("copyright", "inaccurate", "spam", "offensive")
MIN_POST_CARDS = 3
MAX_POST_CARDS = 9
MAX_POST_TITLE = 160
MAX_CARD_HEADING = 120
MAX_CARD_BODY = 600
MAX_POST_BODY = 20_000
MAX_COMMENT_CHARS = 1000


class Post(TimestampMixin, Base):
    """What a user wrote to share: a copy of its own. The notebook and documents it came from stay private, and
    taking the post down touches neither. Others see it only while it is published and not hidden."""

    __tablename__ = "posts"
    __table_args__ = (
        CheckConstraint("status IN ('draft', 'published')", name="ck_posts_status"),
        CheckConstraint("kind IN ('summary', 'insight', 'synthesis', 'link')", name="ck_posts_kind"),
        Index("ix_posts_status_published", "status", "published_at"),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    notebook_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("notebooks.id", ondelete="SET NULL"), index=True
    )
    kind: Mapped[str] = mapped_column(String(16), nullable=False)
    status: Mapped[str] = mapped_column(String(16), default="draft", nullable=False)
    title: Mapped[str] = mapped_column(String(MAX_POST_TITLE), default="", nullable=False)
    # [{heading, body}]: the cards as they read, in order.
    cards: Mapped[list] = mapped_column(JsonType, default=list, nullable=False)
    # The longer text "read on" opens, in Markdown; optional.
    body: Mapped[str] = mapped_column(Text, default="", nullable=False)
    topic: Mapped[str | None] = mapped_column(String(16), index=True)
    # The AI wrote some of it: readers are told, and the author must say they read it through.
    ai_assisted: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    published_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # Set by an admin: out of the community until shown again; the author sees that it was hidden.
    hidden_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    author: Mapped[User] = relationship(lazy="joined")
    sources: Mapped[list["PostSource"]] = relationship(
        cascade="all, delete-orphan", passive_deletes=True, order_by="PostSource.position", lazy="selectin"
    )


class PostSource(Base):
    """A document a post was written from, as it was then, so the post still names it after the document is
    deleted. `shown` is the author's choice to name it publicly; a source left unshown is seen by no one else."""

    __tablename__ = "post_sources"
    __table_args__ = (Index("ix_post_sources_post", "post_id", "position"),)

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    post_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("posts.id", ondelete="CASCADE"), nullable=False
    )
    document_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("documents.id", ondelete="SET NULL"), index=True
    )
    position: Mapped[int] = mapped_column(Integer, nullable=False)
    title: Mapped[str] = mapped_column(String(500), nullable=False)
    url: Mapped[str | None] = mapped_column(String(2048))
    credit: Mapped[str] = mapped_column(String(1000), default="", nullable=False)
    license: Mapped[str | None] = mapped_column(String(32))
    shown: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)


class SavedPost(Base):
    """A post a reader kept to come back to."""

    __tablename__ = "saved_posts"

    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    post_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("posts.id", ondelete="CASCADE"), primary_key=True, index=True
    )
    saved_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)


class PostReport(Base):
    """A reader saying a post should not be there: one per reader and post, the latest reason standing."""

    __tablename__ = "post_reports"

    post_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("posts.id", ondelete="CASCADE"), primary_key=True
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True, index=True
    )
    reason: Mapped[str] = mapped_column(String(16), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)


class PostComment(Base):
    """A reader's comment on a published post, flat: public like the post, and moderated like it."""

    __tablename__ = "post_comments"
    __table_args__ = (Index("ix_post_comments_post_created", "post_id", "created_at"),)

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    post_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("posts.id", ondelete="CASCADE"), nullable=False
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    body: Mapped[str] = mapped_column(Text, nullable=False)
    hidden_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)

    author: Mapped[User] = relationship(lazy="joined")


class CommentReport(Base):
    """A reader reporting a comment, as PostReport does a post."""

    __tablename__ = "comment_reports"

    comment_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("post_comments.id", ondelete="CASCADE"), primary_key=True
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True, index=True
    )
    reason: Mapped[str] = mapped_column(String(16), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)


class Article(Base):
    """An openly licensed article for everyone to discover in the feed (scripts/sync_articles).

    Shared, not owned: reading one copies it into the user's library as a Document, where the reader,
    highlights and the AI work on it like on anything else. `credit` is the line the licence asks to keep
    with the text: who wrote it, where it was first published and under which licence.
    """

    __tablename__ = "articles"
    __table_args__ = (Index("ix_articles_rank", "rank"),)

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    source: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    url: Mapped[str] = mapped_column(String(2048), unique=True, nullable=False)
    # Folded title, so the same work reached from two sources is kept once.
    title_key: Mapped[str] = mapped_column(String(500), nullable=False, index=True)
    title: Mapped[str] = mapped_column(String(500), nullable=False)
    authors: Mapped[str] = mapped_column(String(1000), default="", nullable=False)
    language: Mapped[str] = mapped_column(String(8), nullable=False)
    # What it is (see KINDS): the feed filters by it.
    kind: Mapped[str] = mapped_column(String(16), nullable=False, index=True)
    license: Mapped[str] = mapped_column(String(32), nullable=False)
    license_url: Mapped[str] = mapped_column(String(255), nullable=False)
    credit: Mapped[str] = mapped_column(String(1000), nullable=False)
    summary: Mapped[str] = mapped_column(Text, default="", nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False, deferred=True)
    image_url: Mapped[str | None] = mapped_column(String(2048))
    word_count: Mapped[int] = mapped_column(Integer, nullable=False)
    doi: Mapped[str | None] = mapped_column(String(300))
    published_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    collected_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
    # The feed's order: fresh news first, the rest mixed so no source fills a page (services/articles).
    rank: Mapped[float] = mapped_column(Float, default=0, nullable=False)
    # A guide (services/guides) is written from another article: the work it adapts, whose credit it carries.
    based_on_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("articles.id", ondelete="CASCADE"), index=True
    )
    # The feed's chat finds articles by meaning (services/explore_chat): the embedding of the title, topics
    # and summary as a JSON array of floats, and the model that made it.
    embedding: Mapped[str | None] = mapped_column(Text, deferred=True)
    embedding_model: Mapped[str | None] = mapped_column(String(100))
    # Hidden by an admin: kept, but out of the feed, its chat and its short posts until shown again.
    hidden_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    topics: Mapped[list["ArticleTopic"]] = relationship(
        cascade="all, delete-orphan", passive_deletes=True, lazy="selectin"
    )
    tags: Mapped[list["ArticleTag"]] = relationship(
        cascade="all, delete-orphan", passive_deletes=True, lazy="selectin"
    )
    # join_depth: an eager loader stops at the first self-reference without one.
    based_on: Mapped["Article | None"] = relationship(remote_side=[id], lazy="selectin", join_depth=1)


class ArticleTopic(Base):
    __tablename__ = "article_topics"
    __table_args__ = (Index("ix_article_topics_topic", "topic"),)

    article_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("articles.id", ondelete="CASCADE"), primary_key=True
    )
    topic: Mapped[str] = mapped_column(String(16), primary_key=True)


class ArticleTag(Base):
    """A free-form label from the source (a keyword, a field of study), lowercase: narrower than a topic."""

    __tablename__ = "article_tags"
    __table_args__ = (Index("ix_article_tags_tag", "tag"),)

    article_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("articles.id", ondelete="CASCADE"), primary_key=True
    )
    tag: Mapped[str] = mapped_column(String(48), primary_key=True)


class Short(Base):
    """A one-minute read the AI wrote from an openly licensed article (services/shorts), shown in the feed's
    stream of short posts. It belongs to its article: the topics, order and credit are the article's, and
    "read on" opens the article, or the guide written from it."""

    __tablename__ = "shorts"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    article_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("articles.id", ondelete="CASCADE"), unique=True, nullable=False
    )
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    hook: Mapped[str] = mapped_column(Text, nullable=False)
    points: Mapped[list] = mapped_column(JsonType, nullable=False)
    takeaway: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)

    article: Mapped[Article] = relationship(lazy="selectin")


class ShortState(Base):
    """One user's place in a short: the card they stopped at, whether they reached the last one, and whether they
    said they are not interested, which keeps it out of their feed."""

    __tablename__ = "short_states"

    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    short_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("shorts.id", ondelete="CASCADE"), primary_key=True
    )
    card_index: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    completed: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    dismissed: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)


class ContentTranslation(Base):
    """A translation that may be kept and shown to anyone (services/article_translation). The catalog is a file,
    so `content_id` is its id there. Only a finished, checked one is stored. `source_version` says which text it
    translates, and CC BY-ND articles have no row at all."""

    __tablename__ = "content_translations"

    content_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    language: Mapped[str] = mapped_column(String(8), primary_key=True)
    content_type: Mapped[str] = mapped_column(String(16), primary_key=True)
    source_version: Mapped[str] = mapped_column(String(16), nullable=False)
    translated_text: Mapped[str] = mapped_column(Text, nullable=False)
    translation_model: Mapped[str] = mapped_column(String(64), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)


class QuickReadReport(Base):
    """A reader saying a catalog article's Quick Read (services/quick_reads) is wrong: one per reader and
    article, the latest reason standing. The catalog is a file, so `article_id` is its id there. A fixed
    reason and no free text, as admins see no words a user wrote."""

    __tablename__ = "quick_read_reports"

    article_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    reason: Mapped[str] = mapped_column(String(16), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)


class BlockedArticle(Base):
    """An article an admin deleted: the crawler skips its address and its title from then on, or the next
    run would bring it back."""

    __tablename__ = "blocked_articles"

    url: Mapped[str] = mapped_column(String(2048), primary_key=True)
    title_key: Mapped[str] = mapped_column(String(500), nullable=False, index=True)
    blocked_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)


class CrawlChannel(Base):
    """One place a source is read from, and the feed's topics for what comes from there: a section of The
    Conversation, a PLOS or eLife subject, a Europe PMC search. Seeded from the sources' own lists
    (services/crawler); admins add, switch off and remove them."""

    __tablename__ = "crawl_channels"
    __table_args__ = (UniqueConstraint("source", "key", name="uq_crawl_channels_source_key"),)

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    source: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    key: Mapped[str] = mapped_column(String(300), nullable=False)
    topics: Mapped[list] = mapped_column(JsonType, nullable=False)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)


class CrawlRun(Base):
    """One run of the crawler, on schedule or started by an admin, and what each source brought."""

    __tablename__ = "crawl_runs"
    __table_args__ = (Index("ix_crawl_runs_started", "started_at"),)

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    trigger: Mapped[str] = mapped_column(String(16), nullable=False)  # schedule, manual, link
    sources: Mapped[list] = mapped_column(JsonType, nullable=False)
    status: Mapped[str] = mapped_column(
        String(16), default="running", nullable=False
    )  # running, done, failed
    admin_email: Mapped[str | None] = mapped_column(String(255))
    # {source: {fetched, added, updated, duplicates, too_old, blocked, errors}}
    stats: Mapped[dict] = mapped_column(JsonType, default=dict, nullable=False)
    error: Mapped[str | None] = mapped_column(String(500))
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class AppSetting(Base):
    """Settings admins change at run time (the crawl's schedule, the sources switched off), by key."""

    __tablename__ = "app_settings"

    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    value: Mapped[dict] = mapped_column(JsonType, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)


class TrafficDaily(Base):
    """Requests per day (Vietnam time) and part of the app: counts only, never who or what (services/traffic)."""

    __tablename__ = "traffic_daily"

    day: Mapped[date] = mapped_column(Date, primary_key=True)
    area: Mapped[str] = mapped_column(String(24), primary_key=True)
    requests: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    errors: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    ai_calls: Mapped[int] = mapped_column(Integer, default=0, nullable=False)


class UserActivityDaily(Base):
    """That an account made a request on a day, to count the day's active users; kept 90 days."""

    __tablename__ = "user_activity_daily"

    day: Mapped[date] = mapped_column(Date, primary_key=True)
    user_id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True)
