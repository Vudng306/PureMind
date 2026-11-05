"""Kept translations of catalog articles.

Revision ID: 0025
Revises: 0024
"""

import sqlalchemy as sa

from alembic import op

revision = "0025"
down_revision = "0024"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "content_translations",
        sa.Column("content_id", sa.String(64), primary_key=True),
        sa.Column("language", sa.String(8), primary_key=True),
        sa.Column("content_type", sa.String(16), primary_key=True),
        sa.Column("source_version", sa.String(16), nullable=False),
        sa.Column("translated_text", sa.Text(), nullable=False),
        sa.Column("translation_model", sa.String(64), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("content_translations")
