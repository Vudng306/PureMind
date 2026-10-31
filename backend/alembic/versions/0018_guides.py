"""Guides: Vietnamese articles written from an openly licensed one, which they credit."""

import sqlalchemy as sa

from alembic import op

revision = "0018"
down_revision = "0017"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("articles", sa.Column("based_on_id", sa.Uuid(), nullable=True))
    op.create_foreign_key(
        "fk_articles_based_on_id", "articles", "articles", ["based_on_id"], ["id"], ondelete="CASCADE"
    )
    op.create_index("ix_articles_based_on_id", "articles", ["based_on_id"])


def downgrade():
    op.drop_index("ix_articles_based_on_id", table_name="articles")
    op.drop_constraint("fk_articles_based_on_id", "articles", type_="foreignkey")
    op.drop_column("articles", "based_on_id")
