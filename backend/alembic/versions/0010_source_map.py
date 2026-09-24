"""Where each block of a PDF's clean text is on its pages ("view in the original PDF")

Revision ID: 0010
Revises: 0009
Create Date: 2026-09-24
"""

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "0010"
down_revision = "0009"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("documents", sa.Column("source_map", postgresql.JSONB()))


def downgrade() -> None:
    op.drop_column("documents", "source_map")
