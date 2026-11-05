"""Tags on articles, and the kinds the library tells apart (report, book, essay).

Revision ID: 0023
Revises: 0022
"""

import sqlalchemy as sa

from alembic import op

revision = "0023"
down_revision = "0022"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "article_tags",
        sa.Column("article_id", sa.Uuid(), sa.ForeignKey("articles.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("tag", sa.String(48), primary_key=True),
    )
    op.create_index("ix_article_tags_tag", "article_tags", ["tag"])
    op.create_index("ix_articles_kind", "articles", ["kind"])
    # Data articles (Our World in Data) are reports now.
    op.execute("UPDATE articles SET kind = 'report' WHERE kind = 'data'")


def downgrade() -> None:
    op.execute("UPDATE articles SET kind = 'data' WHERE kind = 'report' AND source = 'owid'")
    op.drop_index("ix_articles_kind", table_name="articles")
    op.drop_index("ix_article_tags_tag", table_name="article_tags")
    op.drop_table("article_tags")
