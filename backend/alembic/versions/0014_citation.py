"""What a document is cited as: authors, journal, year, DOI

Revision ID: 0014
Revises: 0013
Create Date: 2026-10-12
"""

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "0014"
down_revision = "0013"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("documents", sa.Column("citation", postgresql.JSONB()))


def downgrade() -> None:
    op.drop_column("documents", "citation")
