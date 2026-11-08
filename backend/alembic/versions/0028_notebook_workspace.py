"""A notebook's subject, and the documents it draws on.

Revision ID: 0028
Revises: 0027
"""

import sqlalchemy as sa

from alembic import op

revision = "0028"
down_revision = "0027"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("notebooks", sa.Column("topic", sa.String(80), nullable=True))
    op.create_table(
        "notebook_documents",
        sa.Column("notebook_id", sa.Uuid(), sa.ForeignKey("notebooks.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("document_id", sa.Uuid(), sa.ForeignKey("documents.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("added_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_notebook_documents_document_id", "notebook_documents", ["document_id"])


def downgrade() -> None:
    op.drop_table("notebook_documents")
    op.drop_column("notebooks", "topic")
