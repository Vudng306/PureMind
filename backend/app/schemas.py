import math
import uuid
from datetime import datetime
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, computed_field, field_validator, model_validator

from app.models import (
    MAX_CHAT_MESSAGES,
    MAX_CHAT_QUESTION,
    MAX_NOTEBOOK_TOPIC,
    ExtractionStatus,
    SourceType,
)
from app.services import doi as doi_service

HighlightColor = Literal["yellow", "green", "blue", "pink", "purple"]
HighlightCategory = Literal["important", "concept", "question", "example", "review"]
MAX_SELECTION = 5000  # FR-HL-01, MSG-22
MAX_NOTE_TRANSLATION = 12000  # a translation of the longest selection, in the longer of the two languages
MAX_NOTE = 10000  # FR-NOTE-01, MSG-24
ColorLabel = Annotated[str, Field(max_length=24)]


class ColorLabels(BaseModel):
    """What each highlight color means to the user (empty = show the color name)."""

    model_config = ConfigDict(extra="forbid")

    yellow: ColorLabel = ""
    green: ColorLabel = ""
    blue: ColorLabel = ""
    pink: ColorLabel = ""
    purple: ColorLabel = ""


class ReadingPreferences(BaseModel):
    model_config = ConfigDict(extra="forbid")

    theme: Literal["light", "dark", "sepia"] | None = None
    font_size: int | None = Field(default=None, ge=14, le=28)
    line_height: Literal[1.5, 1.65, 1.8] | None = None
    column_width: Literal[600, 680, 780] | None = None
    default_mode: Literal["clean", "original"] | None = None
    color_labels: ColorLabels | None = None
    ai_consent: bool | None = None
    # FR-ACC-04: the language of the interface, so it follows the account to another device.
    language: Literal["vi", "en"] | None = None
    # RD-104: the face the clean text is set in.
    font_family: Literal["serif", "sans"] | None = None
    # RD-105: the page the reader reads on; null follows the theme of the app.
    reading_theme: Literal["light", "sepia", "dark"] | None = None
    # RD-112: show the estimate of the reading time left; it can be turned off.
    time_left: bool | None = None


class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    email: str
    display_name: str | None
    avatar_url: str | None
    reading_preferences: dict
    ai_quota_remaining: int
    chat_quota_remaining: int
    role: Literal["user", "admin"]
    # False until the user accepts the current terms of use (models.TERMS_VERSION).
    terms_accepted: bool
    created_at: datetime
    updated_at: datetime


class TermsAccept(BaseModel):
    """The terms are accepted as a whole; sending content to OpenAI is a choice of its own."""

    ai_consent: bool


class AccountUpdate(BaseModel):
    display_name: str | None = None
    reading_preferences: ReadingPreferences | None = None

    @field_validator("display_name")
    @classmethod
    def strip_name(cls, v: str | None) -> str | None:
        if v is None:
            return v
        v = v.strip()
        if not 1 <= len(v) <= 255:
            raise ValueError("MSG-07")
        return v


def file_type_of(source_type: SourceType, original_filename: str | None) -> Literal["pdf", "epub", "web"]:
    name = (original_filename or "").lower()
    if name.endswith(".epub"):
        return "epub"
    if source_type == SourceType.manual and not name.endswith(".pdf"):
        return "web"
    return "pdf"


class CitationAuthor(BaseModel):
    model_config = ConfigDict(extra="forbid")

    family: str = Field(min_length=1, max_length=200)  # or the whole name of an organisation
    given: str = Field(default="", max_length=200)


class Citation(BaseModel):
    """How a document is cited: what a reference manager needs, and what the BibTeX export writes."""

    model_config = ConfigDict(extra="forbid")

    type: Literal["article", "book", "chapter", "conference", "thesis", "report", "misc"] = "article"
    authors: list[CitationAuthor] = Field(default_factory=list, max_length=100)
    container: str = Field(default="", max_length=500)  # the journal, the book or the proceedings
    publisher: str = Field(default="", max_length=300)
    year: int | None = Field(default=None, ge=1000, le=2100)
    volume: str = Field(default="", max_length=50)
    issue: str = Field(default="", max_length=50)
    pages: str = Field(default="", max_length=50)
    doi: str = Field(default="", max_length=300)

    @field_validator("container", "publisher", "volume", "issue", "pages", mode="before")
    @classmethod
    def one_line(cls, v):
        return " ".join(v.split()) if isinstance(v, str) else v

    @field_validator("doi", mode="before")
    @classmethod
    def bare_doi(cls, v):
        if not isinstance(v, str) or not v.strip():
            return ""
        try:
            return doi_service.parse(v)
        except doi_service.InvalidDoi:
            raise ValueError("invalid DOI") from None


class DocumentListItem(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    title: str
    source_type: SourceType
    url: str | None
    original_filename: str | None
    file_size: int | None
    page_count: int | None
    word_count: int | None
    extraction_status: ExtractionStatus
    extraction_error: str | None
    last_read_page: int | None
    read_fraction: float | None
    is_read: bool
    citation: Citation | None = None
    collection_id: uuid.UUID | None = None
    license: str | None = None
    # The subjects of the article it is a copy of, if it is one; the list fills these in.
    topics: list[str] = []
    created_at: datetime
    updated_at: datetime

    @computed_field
    @property
    def file_type(self) -> Literal["pdf", "epub", "web"]:
        return file_type_of(self.source_type, self.original_filename)

    @computed_field
    @property
    def reading_minutes(self) -> int | None:
        return math.ceil(self.word_count / 230) if self.word_count else None


class ReadPosition(BaseModel):
    """RD-107: the place in the clean text, by the block at the top of the page."""

    model_config = ConfigDict(extra="forbid")

    block_id: str = Field(min_length=1, max_length=64)
    offset: float = Field(default=0, ge=0, le=1)  # how far into the block


class ExtractionIssue(BaseModel):
    """RD-111: something the extraction knows is not in the clean text as text. Only what was measured:
    `scanned_pages` were left out, `ocr_pages` were read from a picture of the page, and the tables and
    equations counted here are shown as pictures."""

    code: Literal["scanned_pages", "ocr_pages", "tables_as_images", "equations_as_images"]
    count: int
    pages: list[int] | None = None


class DocumentOut(DocumentListItem):
    content_clean: str
    note: str
    read_position: ReadPosition | None = None
    extraction_issues: list[ExtractionIssue] | None = None
    # Which clean text this is; a highlight carries the one it was made on (AN-102).
    content_version: str | None = None
    # Clean Reader UC-04: reading the file again — running, done or failed — and what came of it.
    reprocess_state: Literal["running", "done", "failed"] | None = None
    reprocess_report: dict | None = None


class DocumentUpdate(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=500)
    last_read_page: int | None = Field(default=None, ge=1)
    read_fraction: float | None = Field(default=None, ge=0, le=1)
    read_position: ReadPosition | None = None
    is_read: bool | None = None
    note: str | None = Field(default=None, max_length=20000)
    citation: Citation | None = None
    collection_id: uuid.UUID | None = None  # null takes it off its shelf


class DocumentUsage(BaseModel):
    """What else goes, or stays, when a document is removed from the library."""

    highlights: int
    notes: int  # highlights with a note of their own, plus the document's own notes
    has_summary: bool
    notebooks: int
    posts: int


MAX_RECTS = 200


class Rect(BaseModel):
    """A rectangle on a PDF page, as fractions of the page width/height."""

    model_config = ConfigDict(extra="forbid")

    x: float = Field(ge=0, le=1)
    y: float = Field(ge=0, le=1)
    w: float = Field(gt=0, le=1)
    h: float = Field(gt=0, le=1)

    @model_validator(mode="after")
    def inside_page(self):
        if self.x + self.w > 1.001 or self.y + self.h > 1.001:
            raise ValueError("rectangle must lie inside the page")
        return self


class HighlightBase(BaseModel):
    # Clean-text anchor (FR-HL-01 step 2) ...
    block_id: str | None = Field(default=None, min_length=1, max_length=64)
    start_offset: int | None = Field(default=None, ge=0)
    end_offset: int | None = Field(default=None, gt=0)
    # ... and/or the original PDF page.
    rects: list[Rect] | None = Field(default=None, min_length=1, max_length=MAX_RECTS)
    selected_text: str = Field(min_length=1)
    color: HighlightColor = "yellow"
    category: HighlightCategory | None = None
    note: str = ""
    page_number: int | None = Field(default=None, ge=1)
    # The words around the passage in its block (AN-102), to find it again if the text is extracted anew.
    prefix: str | None = Field(default=None, max_length=64)
    suffix: str | None = Field(default=None, max_length=64)

    @field_validator("selected_text")
    @classmethod
    def selection_length(cls, v: str) -> str:
        if len(v) > MAX_SELECTION:
            raise ValueError("MSG-22")
        return v

    @field_validator("note")
    @classmethod
    def note_length(cls, v: str) -> str:
        if len(v) > MAX_NOTE:
            raise ValueError("MSG-24")
        return v

    @model_validator(mode="after")
    def check_anchor(self):
        text = (self.block_id, self.start_offset, self.end_offset)
        if any(v is not None for v in text):
            if any(v is None for v in text):
                raise ValueError("block_id, start_offset and end_offset go together")
            if self.end_offset <= self.start_offset:
                raise ValueError("end_offset must be greater than start_offset")
        elif self.rects is None:
            raise ValueError("a highlight needs a text position or PDF rectangles")
        if self.rects is not None and self.page_number is None:
            raise ValueError("PDF rectangles need page_number")
        return self


class HighlightCreate(HighlightBase):
    document_id: uuid.UUID
    # Clients may pick the id so the highlight can be shown before the request returns.
    id: uuid.UUID | None = None


class HighlightUpdate(BaseModel):
    """FR-HL-03/04: color and category; category null removes it."""

    color: HighlightColor | None = None
    category: HighlightCategory | None = None


class NoteIn(BaseModel):
    content: str = Field(min_length=1)

    @field_validator("content")
    @classmethod
    def content_length(cls, v: str) -> str:
        if len(v) > MAX_NOTE:
            raise ValueError("MSG-24")
        return v


class HighlightOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    document_id: uuid.UUID
    block_id: str | None
    start_offset: int | None
    end_offset: int | None
    rects: list[Rect] | None
    selected_text: str
    color: str
    category: str | None
    note: str
    page_number: int | None
    prefix: str | None = None
    suffix: str | None = None
    # The text of the document it was made on; compare with DocumentOut.content_version.
    content_version: str | None = None
    # Where it stood when the document was last read again: mapped, ambiguous or unresolved (models).
    anchor_status: Literal["mapped", "ambiguous", "unresolved"] | None = None
    created_at: datetime
    updated_at: datetime


class HighlightPage(BaseModel):
    items: list[HighlightOut]
    total: int


class ImportHighlight(HighlightCreate):
    created_at: datetime | None = None


class AnnotationsImport(BaseModel):
    """Data a browser kept locally before annotations were stored on the server."""

    highlights: list[ImportHighlight] = Field(default_factory=list, max_length=5000)
    notes: dict[uuid.UUID, Annotated[str, Field(max_length=20000)]] = Field(default_factory=dict)
    progress: dict[uuid.UUID, Annotated[float, Field(ge=0, le=1)]] = Field(default_factory=dict)


class AnnotationsImportResult(BaseModel):
    highlights: int
    notes: int
    progress: int
    unknown_documents: list[uuid.UUID]


class SummaryCreate(BaseModel):
    """FR-SUM-01 input; the language defaults to the document's main language."""

    language: Literal["vi", "en"] | None = None


class SummaryConcept(BaseModel):
    term: str
    explanation: str


class SummaryOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    document_id: uuid.UUID
    key_points: list[str]
    concepts: list[SummaryConcept]
    conclusion: str
    keywords: list[str]
    language: str
    ai_model: str
    created_at: datetime


class NotebookGenerate(BaseModel):
    """FR-NB-01/02. Counts are checked in the route so the user sees MSG-27/MSG-28."""

    highlight_ids: list[uuid.UUID] = Field(max_length=1000)
    title: str | None = Field(default=None, max_length=1000)
    language: Literal["vi", "en"] | None = None
    # "document": one section per document instead of one per topic
    layout: Literal["topic", "document"] = "topic"


class NotebookUpdate(BaseModel):
    """FR-NB-03/04. Lengths are checked in the route (MSG-29)."""

    title: str | None = Field(default=None, max_length=1000)
    content: str | None = None
    highlight_ids: list[uuid.UUID] | None = Field(default=None, max_length=1000)
    status: Literal["saved"] | None = None  # a saved notebook never goes back to draft
    topic: str | None = Field(default=None, max_length=MAX_NOTEBOOK_TOPIC)  # "" takes it off its topic
    # The model of an AI summary pasted in. Only ever set once: it tells later posts that AI helped.
    ai_model: str | None = Field(default=None, max_length=100)


class NotebookCreate(BaseModel):
    """A notebook started by hand: no AI, and no sources unless a document is given."""

    title: str = Field(min_length=1, max_length=255)
    topic: str | None = Field(default=None, max_length=MAX_NOTEBOOK_TOPIC)
    document_id: uuid.UUID | None = None


class NotebookDocumentLink(BaseModel):
    document_id: uuid.UUID


class NotebookDocumentOut(BaseModel):
    """A document the notebook draws on: linked by hand, through a highlight, or both."""

    id: uuid.UUID
    title: str
    url: str | None
    file_type: Literal["pdf", "epub", "web"]
    license: str | None
    linked: bool  # linked by hand, so it can be unlinked
    highlight_count: int


class NotebookSource(BaseModel):
    position: int
    highlight: HighlightOut
    document_title: str
    file_type: Literal["pdf", "epub", "web"]


class NotebookListItem(BaseModel):
    id: uuid.UUID
    title: str
    status: Literal["draft", "saved"]
    source_count: int
    topic: str | None = None
    document_count: int = 0
    created_at: datetime
    updated_at: datetime


class NotebookVersionItem(BaseModel):
    """FR-NB-03 step 5: one saved snapshot, without its content."""

    id: uuid.UUID
    title: str
    chars: int
    created_at: datetime


class NotebookVersionOut(BaseModel):
    id: uuid.UUID
    title: str
    content: str
    created_at: datetime


class NotebookOut(BaseModel):
    id: uuid.UUID
    title: str
    content: str
    status: Literal["draft", "saved"]
    ai_model: str | None
    topic: str | None = None
    sources: list[NotebookSource]
    documents: list[NotebookDocumentOut] = []
    created_at: datetime
    updated_at: datetime


class ChatAsk(BaseModel):
    """FR-CHAT-02: one question, optionally about a passage the reader selected in the reader."""

    content: str
    quote: str | None = Field(default=None, max_length=MAX_SELECTION)
    # A figure in the document, as written in its clean text: `pm-image:<name>` or the image's URL.
    image: str | None = Field(default=None, max_length=2048)

    @field_validator("content")
    @classmethod
    def check_content(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("MSG-CHAT-EMPTY")
        if len(v) > MAX_CHAT_QUESTION:
            raise ValueError("MSG-CHAT-LONG")
        return v


class ExploreTurn(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(max_length=8000)


class ExploreAsk(BaseModel):
    """A message to the feed's chat, with the earlier turns of the conversation, which the page keeps."""

    content: str
    history: list[ExploreTurn] = Field(default_factory=list, max_length=MAX_CHAT_MESSAGES)
    language: Literal["vi", "en"] = "vi"

    @field_validator("content")
    @classmethod
    def check_content(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("MSG-CHAT-EMPTY")
        if len(v) > MAX_CHAT_QUESTION:
            raise ValueError("MSG-CHAT-LONG")
        return v


class TranslateIn(BaseModel):
    """A passage selected in the reader, to translate from English into Vietnamese."""

    text: str

    @field_validator("text")
    @classmethod
    def check_text(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("MSG-TR-EMPTY")
        if len(v) > MAX_SELECTION:
            raise ValueError("MSG-22")
        return v


class TranslateOut(BaseModel):
    translation: str
    source: str
    target: str


class ChatCitation(BaseModel):
    """A passage the answer was given, kept with the answer so [n] still resolves later."""

    position: int
    page_number: int | None = None
    heading: str | None = None
    text: str


class ChatMessageOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    role: Literal["user", "assistant"]
    content: str
    citations: list[ChatCitation]
    image: str | None = None
    ai_model: str | None
    created_at: datetime


class ChatConversationItem(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    title: str
    language: str
    message_count: int
    created_at: datetime
    updated_at: datetime


class ChatConversationOut(BaseModel):
    id: uuid.UUID
    document_id: uuid.UUID
    title: str
    language: str
    messages: list[ChatMessageOut]
    created_at: datetime
    updated_at: datetime


class ChatAnswerOut(BaseModel):
    """What one question returns: both turns as they were stored, and the questions left today."""

    question: ChatMessageOut
    answer: ChatMessageOut
    chat_quota_remaining: int


# --- Admin page (FR-ADM). Counts and account metadata only: nothing a user wrote is ever returned. ---


class AdminUserItem(BaseModel):
    id: uuid.UUID
    email: str
    display_name: str | None
    role: Literal["user", "admin"]
    created_at: datetime
    last_seen_at: datetime | None
    disabled_at: datetime | None
    document_count: int
    storage_bytes: int
    ai_used_today: int
    chat_used_today: int


class AdminUserPage(BaseModel):
    items: list[AdminUserItem]
    total: int
    page: int
    page_size: int


class AdminAuditEntry(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    admin_email: str
    action: str
    target_user_id: uuid.UUID | None
    target_email: str | None
    detail: dict
    created_at: datetime


class AdminAuditPage(BaseModel):
    items: list[AdminAuditEntry]
    total: int
    page: int
    page_size: int


class AdminUserDetail(AdminUserItem):
    documents_by_status: dict[str, int]
    highlight_count: int
    notebook_count: int
    conversation_count: int
    summary_count: int
    ai_daily_quota: int
    chat_daily_quota: int
    recent_actions: list[AdminAuditEntry]


# --- Notes, the reader's AI sidebar and the notebook by document -------------------------------------------

MAX_NOTE_BODY = 20_000


class NoteCreate(BaseModel):
    # Chosen by the client, so sending the same note again (a retry) gives the note already saved.
    id: uuid.UUID | None = None
    body: str = Field(min_length=1, max_length=MAX_NOTE_BODY)

    @field_validator("body")
    @classmethod
    def not_blank(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("Ghi chú không được để trống.")
        return v


class NoteUpdate(BaseModel):
    body: str = Field(min_length=1, max_length=MAX_NOTE_BODY)

    @field_validator("body")
    @classmethod
    def not_blank(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("Ghi chú không được để trống.")
        return v


class NoteFromAi(BaseModel):
    """Keep a piece of what the AI wrote as a note. Only says which piece: the text and its citations are
    read from the stored result on the server, never taken from the request."""

    source: Literal["artifact", "chat"]
    source_id: uuid.UUID
    # artifact: "all", "tldr", "takeaway:2", "findings:0", "question:1", "node:n4"; chat: "all"
    part: str = Field(default="all", max_length=60, pattern=r"^[a-z]+(:[A-Za-z0-9_-]{1,40})?$")


class NoteFromTranslation(BaseModel):
    """AN-107: keep the translation of a selected passage as a note. The passage itself is kept beside it,
    unchanged; the translation is never written over the document."""

    quote: str = Field(min_length=1, max_length=MAX_SELECTION)
    translation: str = Field(min_length=1, max_length=MAX_NOTE_TRANSLATION)
    target: Literal["vi", "en"]

    @field_validator("quote", "translation")
    @classmethod
    def not_blank(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("MSG-TR-EMPTY")
        return v


class NoteProvenance(BaseModel):
    source: Literal["quick", "deep", "mindmap", "analysis", "chat", "translation"]
    # A translation is not stored anywhere else, so it has no source id.
    source_id: uuid.UUID | None = None
    part: str
    # translation only: the selected passage, as it is in the document.
    quote: str | None = None
    model: str | None = None
    language: str | None = None
    generated_at: datetime | None = None
    citations: list[ChatCitation] = []


class NoteOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    document_id: uuid.UUID
    body: str
    origin: Literal["user", "ai_saved"]
    provenance: NoteProvenance | None
    created_at: datetime
    updated_at: datetime


class ArtifactCreate(BaseModel):
    language: Literal["vi", "en"] | None = None


class ArtifactOut(BaseModel):
    id: uuid.UUID
    document_id: uuid.UUID
    kind: Literal["quick", "deep", "mindmap", "analysis"]
    language: str
    payload: dict
    ai_model: str
    created_at: datetime
    # Made from another text, prompt or model than it would be now; the reader decides whether to make it
    # again. `stale_reason` says which, the text first (AI-107).
    stale: bool
    stale_reason: Literal["content", "prompt", "model"] | None = None
    ai_quota_remaining: int


class NotebookGroup(BaseModel):
    """One document in the notebook: it is there because it has at least one highlight or note."""

    document_id: uuid.UUID
    title: str
    file_type: Literal["pdf", "epub", "web"]
    read_fraction: float | None
    is_read: bool
    highlight_count: int
    # The reader's own notes: those written on a highlight plus the free ones.
    note_count: int
    # Notes saved from the AI.
    insight_count: int
    # With a search: how many of its highlights and notes match.
    match_count: int | None = None
    last_activity_at: datetime


class NotebookGroupPage(BaseModel):
    items: list[NotebookGroup]
    total: int


class NotebookGroupDetail(BaseModel):
    group: NotebookGroup
    highlights: list[HighlightOut]
    notes: list[NoteOut]
