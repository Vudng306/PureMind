"""Posts users write to share, and the sources each was written from.

Revision ID: 0029
Revises: 0028
"""

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "0029"
down_revision = "0028"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "posts",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("notebook_id", sa.Uuid(), sa.ForeignKey("notebooks.id", ondelete="SET NULL"), nullable=True),
        sa.Column("kind", sa.String(16), nullable=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("title", sa.String(160), nullable=False),
        sa.Column("cards", postgresql.JSONB(), nullable=False),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column("topic", sa.String(16), nullable=True),
        sa.Column("ai_assisted", sa.Boolean(), nullable=False),
        sa.Column("published_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("hidden_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("status IN ('draft', 'published')", name="ck_posts_status"),
        sa.CheckConstraint("kind IN ('summary', 'insight', 'synthesis', 'link')", name="ck_posts_kind"),
    )
    op.create_index("ix_posts_user_id", "posts", ["user_id"])
    op.create_index("ix_posts_notebook_id", "posts", ["notebook_id"])
    op.create_index("ix_posts_topic", "posts", ["topic"])
    op.create_index("ix_posts_status_published", "posts", ["status", "published_at"])
    op.create_table(
        "post_sources",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("post_id", sa.Uuid(), sa.ForeignKey("posts.id", ondelete="CASCADE"), nullable=False),
        sa.Column("document_id", sa.Uuid(), sa.ForeignKey("documents.id", ondelete="SET NULL"), nullable=True),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("title", sa.String(500), nullable=False),
        sa.Column("url", sa.String(2048), nullable=True),
        sa.Column("credit", sa.String(1000), nullable=False),
        sa.Column("license", sa.String(32), nullable=True),
        sa.Column("shown", sa.Boolean(), nullable=False),
    )
    op.create_index("ix_post_sources_post", "post_sources", ["post_id", "position"])
    op.create_index("ix_post_sources_document_id", "post_sources", ["document_id"])


def downgrade() -> None:
    op.drop_table("post_sources")
    op.drop_table("posts")
