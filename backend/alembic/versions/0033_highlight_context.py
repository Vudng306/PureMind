"""Reader v2: a highlight keeps the words around its passage and which text it was made on.

Three new nullable columns on `highlights`. Highlights made before this have none of them and are placed
as before, by their stored position and then by their text.

Revision ID: 0033
Revises: 0032
"""

import sqlalchemy as sa

from alembic import op

revision = "0033"
down_revision = "0032"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("highlights", sa.Column("prefix", sa.String(64), nullable=True))
    op.add_column("highlights", sa.Column("suffix", sa.String(64), nullable=True))
    op.add_column("highlights", sa.Column("content_version", sa.String(16), nullable=True))


def downgrade() -> None:
    op.drop_column("highlights", "content_version")
    op.drop_column("highlights", "suffix")
    op.drop_column("highlights", "prefix")
