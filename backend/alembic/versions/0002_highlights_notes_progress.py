"""Highlights, document notes and clean-text reading progress

Revision ID: 0002
Revises: 0001
Create Date: 2026-09-17
"""

import sqlalchemy as sa
from alembic import op

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("documents", sa.Column("note", sa.Text(), nullable=False, server_default=""))
    op.add_column("documents", sa.Column("read_fraction", sa.Float()))
    op.create_check_constraint(
        "ck_documents_read_fraction", "documents", "read_fraction IS NULL OR (read_fraction >= 0 AND read_fraction <= 1)"
    )

    op.create_table(
        "highlights",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("document_id", sa.Uuid(), sa.ForeignKey("documents.id", ondelete="CASCADE"), nullable=False),
        sa.Column("block_id", sa.String(64), nullable=False),
        sa.Column("start_offset", sa.Integer(), nullable=False),
        sa.Column("end_offset", sa.Integer(), nullable=False),
        sa.Column("selected_text", sa.Text(), nullable=False),
        sa.Column("color", sa.String(16), nullable=False),
        sa.Column("note", sa.Text(), nullable=False, server_default=""),
        sa.Column("page_number", sa.Integer()),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.CheckConstraint("start_offset >= 0 AND end_offset > start_offset", name="ck_highlights_offsets"),
        sa.CheckConstraint("color IN ('yellow', 'green', 'blue', 'pink')", name="ck_highlights_color"),
    )
    op.create_index("ix_highlights_user_id", "highlights", ["user_id"])
    op.create_index("ix_highlights_document_created", "highlights", ["document_id", "created_at"])


def downgrade() -> None:
    op.drop_index("ix_highlights_document_created", table_name="highlights")
    op.drop_index("ix_highlights_user_id", table_name="highlights")
    op.drop_table("highlights")
    op.drop_constraint("ck_documents_read_fraction", "documents", type_="check")
    op.drop_column("documents", "read_fraction")
    op.drop_column("documents", "note")
