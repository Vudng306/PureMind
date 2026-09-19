"""AI summaries

Revision ID: 0005
Revises: 0004
Create Date: 2026-09-18
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0005"
down_revision = "0004"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "summaries",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column(
            "document_id",
            sa.Uuid(),
            sa.ForeignKey("documents.id", ondelete="CASCADE"),
            nullable=False,
            unique=True,
        ),
        sa.Column("key_points", postgresql.JSONB(), nullable=False),
        sa.Column("concepts", postgresql.JSONB(), nullable=False),
        sa.Column("conclusion", sa.Text(), nullable=False),
        sa.Column("keywords", postgresql.JSONB(), nullable=False),
        sa.Column("search_text", sa.Text(), nullable=False, server_default=""),
        sa.Column("language", sa.String(5), nullable=False),
        sa.Column("ai_model", sa.String(100), nullable=False),
        sa.Column("prompt_tokens", sa.Integer(), nullable=False),
        sa.Column("completion_tokens", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    # FR-SRCH-01: summaries are searchable like documents and notes (same accent-insensitive config as 0003).
    op.execute(
        "CREATE INDEX ix_summaries_fts ON summaries "
        "USING gin (to_tsvector('public.pm_unaccent'::regconfig, search_text))"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_summaries_fts")
    op.drop_table("summaries")
