"""What each call to OpenAI used and cost, for the admin's cost page

Revision ID: 0038
Revises: 0037
Create Date: 2026-11-18
"""

import sqlalchemy as sa

from alembic import op

revision = "0038"
down_revision = "0037"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "ai_usage_events",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("day", sa.Date(), nullable=False),
        sa.Column("request_id", sa.String(64), nullable=False),
        sa.Column("user_id", sa.Uuid()),
        sa.Column("purpose", sa.String(32), nullable=False),
        sa.Column("model", sa.String(64), nullable=False),
        sa.Column("prompt_tokens", sa.Integer(), nullable=False),
        sa.Column("cached_tokens", sa.Integer(), nullable=False),
        sa.Column("completion_tokens", sa.Integer(), nullable=False),
        sa.Column("web_searches", sa.Integer(), nullable=False),
        sa.Column("cost_usd", sa.Float()),
        sa.Column("ok", sa.Boolean(), nullable=False),
        sa.Column("duration_ms", sa.Integer(), nullable=False),
    )
    op.create_index("ix_ai_usage_events_day", "ai_usage_events", ["day"])
    op.create_index("ix_ai_usage_events_request", "ai_usage_events", ["request_id"])
    op.create_index("ix_ai_usage_events_user", "ai_usage_events", ["user_id"])


def downgrade() -> None:
    op.drop_index("ix_ai_usage_events_user", "ai_usage_events")
    op.drop_index("ix_ai_usage_events_request", "ai_usage_events")
    op.drop_index("ix_ai_usage_events_day", "ai_usage_events")
    op.drop_table("ai_usage_events")
