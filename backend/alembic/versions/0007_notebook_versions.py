"""Notebook version history

Revision ID: 0007
Revises: 0006
Create Date: 2026-09-19
"""

import sqlalchemy as sa
from alembic import op

revision = "0007"
down_revision = "0006"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "notebook_versions",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("notebook_id", sa.Uuid(), sa.ForeignKey("notebooks.id", ondelete="CASCADE"), nullable=False),
        sa.Column("title", sa.String(255), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_notebook_versions_notebook_created", "notebook_versions", ["notebook_id", "created_at"])


def downgrade() -> None:
    op.drop_table("notebook_versions")
