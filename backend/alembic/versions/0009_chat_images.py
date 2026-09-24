"""Chat questions about a figure in the document

Revision ID: 0009
Revises: 0008
Create Date: 2026-09-24
"""

import sqlalchemy as sa

from alembic import op

revision = "0009"
down_revision = "0008"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # The image a question was about, as written in the document's clean text (`pm-image:…` or a URL).
    op.add_column("chat_messages", sa.Column("image", sa.String(2048)))


def downgrade() -> None:
    op.drop_column("chat_messages", "image")
