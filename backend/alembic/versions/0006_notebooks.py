"""AI notebooks

Revision ID: 0006
Revises: 0005
Create Date: 2026-09-18
"""

import sqlalchemy as sa
from alembic import op

revision = "0006"
down_revision = "0005"
branch_labels = None
depends_on = None

# FR-SRCH-01: notebooks are searchable (same accent-insensitive config as 0003).
SEARCH_INDEXES = {
    "ix_notebooks_title_fts": "title",
    "ix_notebooks_content_fts": "content",
}


def upgrade() -> None:
    op.create_table(
        "notebooks",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("title", sa.String(255), nullable=False),
        sa.Column("content", sa.Text(), nullable=False, server_default=""),
        sa.Column("status", sa.String(8), nullable=False, server_default="draft"),
        sa.Column("ai_model", sa.String(100)),
        sa.Column("opened_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("status IN ('draft', 'saved')", name="ck_notebooks_status"),
    )
    op.create_index("ix_notebooks_user_id", "notebooks", ["user_id"])
    op.create_index("ix_notebooks_user_updated", "notebooks", ["user_id", "updated_at"])

    op.create_table(
        "notebook_highlights",
        sa.Column(
            "notebook_id", sa.Uuid(), sa.ForeignKey("notebooks.id", ondelete="CASCADE"), primary_key=True
        ),
        sa.Column(
            "highlight_id", sa.Uuid(), sa.ForeignKey("highlights.id", ondelete="CASCADE"), primary_key=True
        ),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("added_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("notebook_id", "position", name="uq_notebook_highlights_position"),
    )
    op.create_index("ix_notebook_highlights_highlight_id", "notebook_highlights", ["highlight_id"])

    for name, column in SEARCH_INDEXES.items():
        op.execute(
            f"CREATE INDEX {name} ON notebooks USING gin (to_tsvector('public.pm_unaccent'::regconfig, {column}))"
        )


def downgrade() -> None:
    for name in SEARCH_INDEXES:
        op.execute(f"DROP INDEX IF EXISTS {name}")
    op.drop_table("notebook_highlights")
    op.drop_table("notebooks")
