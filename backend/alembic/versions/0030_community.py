"""What readers do with published posts: keep them, report them, and comment on them.

Revision ID: 0030
Revises: 0029
"""

import sqlalchemy as sa

from alembic import op

revision = "0030"
down_revision = "0029"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "saved_posts",
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("post_id", sa.Uuid(), sa.ForeignKey("posts.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("saved_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_saved_posts_post_id", "saved_posts", ["post_id"])
    op.create_table(
        "post_reports",
        sa.Column("post_id", sa.Uuid(), sa.ForeignKey("posts.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("reason", sa.String(16), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_post_reports_user_id", "post_reports", ["user_id"])
    op.create_table(
        "post_comments",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("post_id", sa.Uuid(), sa.ForeignKey("posts.id", ondelete="CASCADE"), nullable=False),
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column("hidden_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_post_comments_post_created", "post_comments", ["post_id", "created_at"])
    op.create_index("ix_post_comments_user_id", "post_comments", ["user_id"])
    op.create_table(
        "comment_reports",
        sa.Column("comment_id", sa.Uuid(), sa.ForeignKey("post_comments.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("reason", sa.String(16), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_comment_reports_user_id", "comment_reports", ["user_id"])


def downgrade() -> None:
    op.drop_table("comment_reports")
    op.drop_table("post_comments")
    op.drop_table("post_reports")
    op.drop_table("saved_posts")
