import math
import uuid
from datetime import datetime
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, computed_field, field_validator, model_validator

from app.models import MAX_CHAT_QUESTION, ExtractionStatus, SourceType

HighlightColor = Literal["yellow", "green", "blue", "pink", "purple"]
HighlightCategory = Literal["important", "concept", "question", "example", "review"]
MAX_SELECTION = 5000  # FR-HL-01, MSG-22
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


class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    email: str
    display_name: str | None
    avatar_url: str | None
    reading_preferences: dict
    ai_quota_remaining: int
    chat_quota_remaining: int
    created_at: datetime
    updated_at: datetime


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


class DocumentOut(DocumentListItem):
    content_clean: str
    note: str


class DocumentUpdate(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=500)
    last_read_page: int | None = Field(default=None, ge=1)
    read_fraction: float | None = Field(default=None, ge=0, le=1)
    is_read: bool | None = None
    note: str | None = Field(default=None, max_length=20000)


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


class NotebookUpdate(BaseModel):
    """FR-NB-03/04. Lengths are checked in the route (MSG-29)."""

    title: str | None = Field(default=None, max_length=1000)
    content: str | None = None
    highlight_ids: list[uuid.UUID] | None = Field(default=None, max_length=1000)
    status: Literal["saved"] | None = None  # a saved notebook never goes back to draft


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
    sources: list[NotebookSource]
    created_at: datetime
    updated_at: datetime


class ChatAsk(BaseModel):
    """FR-CHAT-02: one question, optionally about a passage the reader selected in the reader."""

    content: str
    quote: str | None = Field(default=None, max_length=MAX_SELECTION)

    @field_validator("content")
    @classmethod
    def check_content(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("MSG-CHAT-EMPTY")
        if len(v) > MAX_CHAT_QUESTION:
            raise ValueError("MSG-CHAT-LONG")
        return v


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
