"""The terms of use each user accepted, and when

Revision ID: 0015
Revises: 0014
Create Date: 2026-10-19
"""

import sqlalchemy as sa

from alembic import op

revision = "0015"
down_revision = "0014"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("users", sa.Column("terms_version", sa.String(16)))
    op.add_column("users", sa.Column("terms_accepted_at", sa.DateTime(timezone=True)))


def downgrade() -> None:
    op.drop_column("users", "terms_accepted_at")
    op.drop_column("users", "terms_version")
