"""Highlights on the original PDF page

Revision ID: 0004
Revises: 0003
Create Date: 2026-09-18
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # FR-HL-01 step 2: a PDF highlight is page_number + rectangles normalised to the page size.
    op.add_column("highlights", sa.Column("rects", postgresql.JSONB()))
    for column in ("block_id", "start_offset", "end_offset"):
        op.alter_column("highlights", column, nullable=True)
    op.drop_constraint("ck_highlights_offsets", "highlights", type_="check")
    op.create_check_constraint(
        "ck_highlights_offsets", "highlights", "block_id IS NULL OR (start_offset >= 0 AND end_offset > start_offset)"
    )
    op.create_check_constraint(
        "ck_highlights_anchor",
        "highlights",
        "(block_id IS NOT NULL AND start_offset IS NOT NULL AND end_offset IS NOT NULL)"
        " OR (rects IS NOT NULL AND page_number IS NOT NULL)",
    )


def downgrade() -> None:
    # Highlights that exist only on the PDF page cannot be kept without a text position.
    op.execute("DELETE FROM highlights WHERE block_id IS NULL")
    op.drop_constraint("ck_highlights_anchor", "highlights", type_="check")
    op.drop_constraint("ck_highlights_offsets", "highlights", type_="check")
    op.create_check_constraint(
        "ck_highlights_offsets", "highlights", "start_offset >= 0 AND end_offset > start_offset"
    )
    for column in ("block_id", "start_offset", "end_offset"):
        op.alter_column("highlights", column, nullable=False)
    op.drop_column("highlights", "rects")
