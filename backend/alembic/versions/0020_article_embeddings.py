"""The feed's chat finds articles by meaning: each article keeps the embedding of its title and summary."""

import sqlalchemy as sa

from alembic import op

revision = "0020"
down_revision = "0019"
branch_labels = None
depends_on = None


def upgrade():
    # A JSON array of floats, like document_chunks.embedding: PostgreSQL casts it to `vector` with pgvector.
    op.add_column("articles", sa.Column("embedding", sa.Text(), nullable=True))
    op.add_column("articles", sa.Column("embedding_model", sa.String(100), nullable=True))


def downgrade():
    op.drop_column("articles", "embedding_model")
    op.drop_column("articles", "embedding")
