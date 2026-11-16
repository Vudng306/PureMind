"""Clean Reader: the blocks taken out of the reading flow (authors, headers, references…), kept on the side

Revision ID: 0035
Revises: 0034
Create Date: 2026-11-16
"""

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "0035"
down_revision = "0034"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("documents", sa.Column("content_aside", postgresql.JSONB()))


def downgrade() -> None:
    op.drop_column("documents", "content_aside")
