"""Clean Reader: reprocess a document without losing the text it has, and where its highlights stand after

Revision ID: 0037
Revises: 0036
Create Date: 2026-11-16
"""

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "0037"
down_revision = "0036"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("documents", sa.Column("reprocess_state", sa.String(16)))
    op.add_column("documents", sa.Column("reprocess_started_at", sa.DateTime(timezone=True)))
    op.add_column("documents", sa.Column("reprocess_report", postgresql.JSONB()))
    op.create_check_constraint(
        "ck_documents_reprocess_state",
        "documents",
        "reprocess_state IS NULL OR reprocess_state IN ('running', 'done', 'failed')",
    )
    op.add_column("highlights", sa.Column("anchor_status", sa.String(12)))
    op.create_check_constraint(
        "ck_highlights_anchor_status",
        "highlights",
        "anchor_status IS NULL OR anchor_status IN ('mapped', 'ambiguous', 'unresolved')",
    )


def downgrade() -> None:
    op.drop_constraint("ck_highlights_anchor_status", "highlights", type_="check")
    op.drop_column("highlights", "anchor_status")
    op.drop_constraint("ck_documents_reprocess_state", "documents", type_="check")
    op.drop_column("documents", "reprocess_report")
    op.drop_column("documents", "reprocess_started_at")
    op.drop_column("documents", "reprocess_state")
