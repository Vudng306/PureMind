"""Flashcards, review schedules and quiz attempts."""

import sqlalchemy as sa

from alembic import op

revision = "0016"
down_revision = "0015"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "study_sets",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("document_id", sa.Uuid(), sa.ForeignKey("documents.id", ondelete="CASCADE"), nullable=False),
        sa.Column("title", sa.String(500), nullable=False),
        sa.Column("kind", sa.String(12), nullable=False),
        sa.Column("items", sa.JSON(), nullable=False),
        sa.Column("progress", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_study_sets_user_id", "study_sets", ["user_id"])
    op.create_table(
        "study_attempts",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("set_id", sa.Uuid(), sa.ForeignKey("study_sets.id", ondelete="CASCADE"), nullable=False),
        sa.Column("answers", sa.JSON(), nullable=False),
        sa.Column("score", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_study_attempts_set_id", "study_attempts", ["set_id"])


def downgrade():
    op.drop_table("study_attempts")
    op.drop_table("study_sets")
