"""Collections in the library, and the licence each document came under.

Revision ID: 0027
Revises: 0026
"""

import sqlalchemy as sa

from alembic import op

revision = "0027"
down_revision = "0026"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "collections",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("name", sa.String(80), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("user_id", "name", name="uq_collections_user_name"),
    )
    op.create_index("ix_collections_user_id", "collections", ["user_id"])
    op.add_column("documents", sa.Column("collection_id", sa.Uuid(), nullable=True))
    op.create_foreign_key(
        "fk_documents_collection", "documents", "collections", ["collection_id"], ["id"], ondelete="SET NULL"
    )
    op.create_index("ix_documents_collection_id", "documents", ["collection_id"])
    op.add_column("documents", sa.Column("license", sa.String(32), nullable=True))
    # A copy of a shared article is known by its address. CC BY-ND is the one that must never be missed.
    op.execute(
        "UPDATE documents SET license = (SELECT articles.license FROM articles WHERE articles.url = documents.url)"
        " WHERE url IS NOT NULL"
    )
    op.execute(
        "UPDATE documents SET license = 'CC BY-ND 4.0' WHERE license IS NULL AND url LIKE '%//theconversation.com/%'"
    )


def downgrade() -> None:
    op.drop_column("documents", "license")
    op.drop_index("ix_documents_collection_id", table_name="documents")
    op.drop_constraint("fk_documents_collection", "documents", type_="foreignkey")
    op.drop_column("documents", "collection_id")
    op.drop_index("ix_collections_user_id", table_name="collections")
    op.drop_table("collections")
