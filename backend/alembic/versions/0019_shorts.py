"""Short posts: one-minute reads written from the feed's articles."""

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "0019"
down_revision = "0018"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "shorts",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column(
            "article_id",
            sa.Uuid(),
            sa.ForeignKey("articles.id", ondelete="CASCADE"),
            nullable=False,
            unique=True,
        ),
        sa.Column("title", sa.String(200), nullable=False),
        sa.Column("hook", sa.Text(), nullable=False),
        sa.Column("points", postgresql.JSONB(), nullable=False),
        sa.Column("takeaway", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )


def downgrade():
    op.drop_table("shorts")
