"""The admin's traffic, articles and crawler: daily counts, hidden and blocked articles, crawl channels, runs
and settings. The feed keeps only what was published from 2023 on: older articles, and the undated, go."""

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

from alembic import op

revision = "0022"
down_revision = "0021"
branch_labels = None
depends_on = None

JSON = sa.JSON().with_variant(JSONB(), "postgresql")


def upgrade():
    op.add_column("articles", sa.Column("hidden_at", sa.DateTime(timezone=True)))
    op.create_table(
        "blocked_articles",
        sa.Column("url", sa.String(2048), primary_key=True),
        sa.Column("title_key", sa.String(500), nullable=False),
        sa.Column("blocked_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_blocked_articles_title_key", "blocked_articles", ["title_key"])
    op.create_table(
        "crawl_channels",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("source", sa.String(32), nullable=False),
        sa.Column("key", sa.String(300), nullable=False),
        sa.Column("topics", JSON, nullable=False),
        sa.Column("enabled", sa.Boolean(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("source", "key", name="uq_crawl_channels_source_key"),
    )
    op.create_index("ix_crawl_channels_source", "crawl_channels", ["source"])
    op.create_table(
        "crawl_runs",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("trigger", sa.String(16), nullable=False),
        sa.Column("sources", JSON, nullable=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("admin_email", sa.String(255)),
        sa.Column("stats", JSON, nullable=False),
        sa.Column("error", sa.String(500)),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("finished_at", sa.DateTime(timezone=True)),
    )
    op.create_index("ix_crawl_runs_started", "crawl_runs", ["started_at"])
    op.create_table(
        "app_settings",
        sa.Column("key", sa.String(64), primary_key=True),
        sa.Column("value", JSON, nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_table(
        "traffic_daily",
        sa.Column("day", sa.Date(), primary_key=True),
        sa.Column("area", sa.String(24), primary_key=True),
        sa.Column("requests", sa.Integer(), nullable=False),
        sa.Column("errors", sa.Integer(), nullable=False),
        sa.Column("ai_calls", sa.Integer(), nullable=False),
    )
    op.create_table(
        "user_activity_daily",
        sa.Column("day", sa.Date(), primary_key=True),
        sa.Column("user_id", sa.Uuid(), primary_key=True),
    )
    # Guides and short posts written from these go with them (ON DELETE CASCADE). A guide is dated when it
    # was written, so it is kept by its original's date, not its own.
    op.execute(
        "DELETE FROM articles WHERE based_on_id IS NULL "
        "AND (published_at IS NULL OR published_at < '2023-01-01')"
    )


def downgrade():
    op.drop_table("user_activity_daily")
    op.drop_table("traffic_daily")
    op.drop_table("app_settings")
    op.drop_index("ix_crawl_runs_started", "crawl_runs")
    op.drop_table("crawl_runs")
    op.drop_index("ix_crawl_channels_source", "crawl_channels")
    op.drop_table("crawl_channels")
    op.drop_index("ix_blocked_articles_title_key", "blocked_articles")
    op.drop_table("blocked_articles")
    op.drop_column("articles", "hidden_at")
