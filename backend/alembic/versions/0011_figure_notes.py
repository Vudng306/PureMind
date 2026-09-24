"""Figures of a document described in words for the AI

Revision ID: 0011
Revises: 0010
Create Date: 2026-09-24
"""

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "0011"
down_revision = "0010"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("documents", sa.Column("figure_notes", postgresql.JSONB()))


def downgrade() -> None:
    op.drop_column("documents", "figure_notes")
