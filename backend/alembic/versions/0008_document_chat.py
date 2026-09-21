"""Chat with a document: indexed passages and conversations

Revision ID: 0008
Revises: 0007
Create Date: 2026-09-21
"""

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "0008"
down_revision = "0007"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # FR-CHAT-02: chat questions are counted apart from summaries and notebooks.
    op.add_column("users", sa.Column("chat_quota_used", sa.Integer(), nullable=False, server_default="0"))
    op.add_column("users", sa.Column("chat_quota_date", sa.Date()))
    # FR-CHAT-01: which text (and which embedding model) the passages below were built from.
    op.add_column("documents", sa.Column("chunks_hash", sa.String(64)))
    op.add_column("documents", sa.Column("chunks_model", sa.String(100)))

    # The embedding is stored as a JSON array of floats in a text column: PostgreSQL casts it to `vector`
    # when pgvector is installed (see the query in api/routes/chat.py) and reads it as text when it is not,
    # so a managed database without the extension still answers questions.
    op.create_table(
        "document_chunks",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column(
            "document_id", sa.Uuid(), sa.ForeignKey("documents.id", ondelete="CASCADE"), nullable=False
        ),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("page_number", sa.Integer()),
        sa.Column("heading", sa.String(255)),
        sa.Column("text", sa.Text(), nullable=False),
        sa.Column("token_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("embedding", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("document_id", "position", name="uq_document_chunks_position"),
    )
    op.create_index("ix_document_chunks_document", "document_chunks", ["document_id"])

    op.create_table(
        "chat_conversations",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column(
            "document_id", sa.Uuid(), sa.ForeignKey("documents.id", ondelete="CASCADE"), nullable=False
        ),
        sa.Column("title", sa.String(255), nullable=False, server_default=""),
        sa.Column("language", sa.String(5), nullable=False, server_default="vi"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_chat_conversations_user", "chat_conversations", ["user_id"])
    op.create_index(
        "ix_chat_conversations_document_updated", "chat_conversations", ["document_id", "updated_at"]
    )

    op.create_table(
        "chat_messages",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column(
            "conversation_id",
            sa.Uuid(),
            sa.ForeignKey("chat_conversations.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("role", sa.String(9), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("citations", sa.JSON().with_variant(postgresql.JSONB(), "postgresql"), nullable=False),
        sa.Column("ai_model", sa.String(100)),
        sa.Column("prompt_tokens", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("completion_tokens", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("role IN ('user', 'assistant')", name="ck_chat_messages_role"),
    )
    op.create_index(
        "ix_chat_messages_conversation_created", "chat_messages", ["conversation_id", "created_at"]
    )


def downgrade() -> None:
    op.drop_table("chat_messages")
    op.drop_table("chat_conversations")
    op.drop_table("document_chunks")
    op.drop_column("documents", "chunks_model")
    op.drop_column("documents", "chunks_hash")
    op.drop_column("users", "chat_quota_date")
    op.drop_column("users", "chat_quota_used")
