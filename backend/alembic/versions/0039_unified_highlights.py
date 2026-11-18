"""Unified highlights: one row per passage, placed in the clean text and on the PDF alike.

Adds only: nullable columns on `highlights`, a unique index on the passage, and a log of merged rows. No row
is changed here; `python -m app.scripts.sync_highlights` fills the new columns, and reports first.

Revision ID: 0039
Revises: 0038
Create Date: 2026-11-18
"""

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "0039"
down_revision = "0038"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("highlights", sa.Column("canonical_start", sa.Integer()))
    op.add_column("highlights", sa.Column("canonical_end", sa.Integer()))
    op.add_column("highlights", sa.Column("clean_anchor", postgresql.JSONB(none_as_null=True)))
    op.add_column("highlights", sa.Column("pdf_anchor", postgresql.JSONB(none_as_null=True)))
    op.add_column("highlights", sa.Column("sync_status", sa.String(12)))
    op.create_check_constraint(
        "ck_highlights_canonical",
        "highlights",
        "(canonical_start IS NULL AND canonical_end IS NULL)"
        " OR (canonical_start >= 0 AND canonical_end > canonical_start)",
    )
    op.create_check_constraint(
        "ck_highlights_sync_status",
        "highlights",
        "sync_status IS NULL OR sync_status IN ('synced', 'unsynced', 'ambiguous')",
    )
    op.create_index(
        "uq_highlights_passage",
        "highlights",
        ["user_id", "document_id", "content_version", "canonical_start", "canonical_end"],
        unique=True,
        postgresql_where=sa.text("canonical_start IS NOT NULL"),
    )
    op.create_table(
        "highlight_merges",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("kept_highlight_id", sa.Uuid(), nullable=False, index=True),
        sa.Column("merged_row", postgresql.JSONB(), nullable=False),
        sa.Column("notebook_links", postgresql.JSONB(), nullable=False),
        sa.Column("merged_at", sa.DateTime(timezone=True), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("highlight_merges")
    op.drop_index("uq_highlights_passage", table_name="highlights")
    op.drop_constraint("ck_highlights_sync_status", "highlights", type_="check")
    op.drop_constraint("ck_highlights_canonical", "highlights", type_="check")
    op.drop_column("highlights", "sync_status")
    op.drop_column("highlights", "pdf_anchor")
    op.drop_column("highlights", "clean_anchor")
    op.drop_column("highlights", "canonical_end")
    op.drop_column("highlights", "canonical_start")
