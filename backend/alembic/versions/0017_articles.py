"""Openly licensed articles for the feed, and their topics."""

import sqlalchemy as sa

from alembic import op

revision = "0017"
down_revision = "0016"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "articles",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("source", sa.String(32), nullable=False),
        sa.Column("url", sa.String(2048), nullable=False, unique=True),
        sa.Column("title_key", sa.String(500), nullable=False),
        sa.Column("title", sa.String(500), nullable=False),
        sa.Column("authors", sa.String(1000), nullable=False),
        sa.Column("language", sa.String(8), nullable=False),
        sa.Column("kind", sa.String(16), nullable=False),
        sa.Column("license", sa.String(32), nullable=False),
        sa.Column("license_url", sa.String(255), nullable=False),
        sa.Column("credit", sa.String(1000), nullable=False),
        sa.Column("summary", sa.Text(), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("image_url", sa.String(2048)),
        sa.Column("word_count", sa.Integer(), nullable=False),
        sa.Column("doi", sa.String(300)),
        sa.Column("published_at", sa.DateTime(timezone=True)),
        sa.Column("collected_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("rank", sa.Float(), nullable=False),
    )
    op.create_index("ix_articles_source", "articles", ["source"])
    op.create_index("ix_articles_title_key", "articles", ["title_key"])
    op.create_index("ix_articles_rank", "articles", ["rank"])
    op.create_table(
        "article_topics",
        sa.Column(
            "article_id", sa.Uuid(), sa.ForeignKey("articles.id", ondelete="CASCADE"), primary_key=True
        ),
        sa.Column("topic", sa.String(16), primary_key=True),
    )
    op.create_index("ix_article_topics_topic", "article_topics", ["topic"])


def downgrade():
    op.drop_table("article_topics")
    op.drop_table("articles")
