"""The data of a document's vector charts, read from their drawing

Revision ID: 0012
Revises: 0011
Create Date: 2026-09-24
"""

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "0012"
down_revision = "0011"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("documents", sa.Column("chart_data", postgresql.JSONB()))


def downgrade() -> None:
    op.drop_column("documents", "chart_data")
