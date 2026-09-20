"""Phase 1 schema: users (Supabase Auth profiles) and documents

Revision ID: 0001
Revises:
Create Date: 2026-09-16
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None

source_type = postgresql.ENUM("upload", "manual", name="source_type", create_type=False)
extraction_status = postgresql.ENUM(
    "pending", "processing", "done", "failed", name="extraction_status", create_type=False
)


def upgrade() -> None:
    # pgvector is kept for the planned semantic search; nothing queries a vector column yet, so a managed
    # Postgres without the extension must not fail the whole migration. unaccent is a trusted contrib
    # module and FR-SRCH-01 does need it, so that one is allowed to fail loudly.
    op.execute(
        "DO $$ BEGIN CREATE EXTENSION IF NOT EXISTS vector; "
        "EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'pgvector unavailable: %', SQLERRM; END $$"
    )
    op.execute("CREATE EXTENSION IF NOT EXISTS unaccent")
    source_type.create(op.get_bind(), checkfirst=True)
    extraction_status.create(op.get_bind(), checkfirst=True)

    op.create_table(
        "users",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("email", sa.String(255), nullable=False, unique=True),
        sa.Column("display_name", sa.String(255)),
        sa.Column("avatar_path", sa.String(1024)),
        sa.Column("reading_preferences", postgresql.JSONB(), nullable=False, server_default="{}"),
        sa.Column("ai_quota_used", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("ai_quota_date", sa.Date()),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )

    op.create_table(
        "documents",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("source_type", source_type, nullable=False),
        sa.Column("url", sa.String(2048)),
        sa.Column("title", sa.String(500), nullable=False),
        sa.Column("content_clean", sa.Text(), nullable=False, server_default=""),
        sa.Column("file_storage_path", sa.String(1024)),
        sa.Column("original_filename", sa.String(500)),
        sa.Column("file_size", sa.BigInteger()),
        sa.Column("page_count", sa.Integer()),
        sa.Column("word_count", sa.Integer()),
        sa.Column("extraction_status", extraction_status, nullable=False, server_default="pending"),
        sa.Column("extraction_error", sa.String(500)),
        sa.Column("last_read_page", sa.Integer()),
        sa.Column("is_read", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("published_at", sa.DateTime(timezone=True)),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint("user_id", "url", name="uq_documents_user_url"),
        sa.CheckConstraint("file_size IS NULL OR file_size <= 52428800", name="ck_documents_file_size"),
        sa.CheckConstraint("last_read_page IS NULL OR last_read_page >= 1", name="ck_documents_last_read_page"),
    )
    op.create_index("ix_documents_user_id", "documents", ["user_id"])
    op.create_index("ix_documents_user_created", "documents", ["user_id", sa.text("created_at DESC")])


def downgrade() -> None:
    op.drop_index("ix_documents_user_created", table_name="documents")
    op.drop_index("ix_documents_user_id", table_name="documents")
    op.drop_table("documents")
    op.drop_table("users")
    extraction_status.drop(op.get_bind(), checkfirst=True)
    source_type.drop(op.get_bind(), checkfirst=True)
