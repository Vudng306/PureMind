"""Notes as records of their own, and what the reader's AI sidebar makes (summaries, mind map).

Every document note written so far (`documents.note`) becomes one row in `notes`; the column stays, so
nothing is lost and the downgrade only has to drop the new tables.

Revision ID: 0031
Revises: 0030
"""

import uuid

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "0031"
down_revision = "0030"
branch_labels = None
depends_on = None

json_type = sa.JSON().with_variant(postgresql.JSONB(), "postgresql")


def upgrade() -> None:
    op.create_table(
        "notes",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column(
            "document_id", sa.Uuid(), sa.ForeignKey("documents.id", ondelete="CASCADE"), nullable=False
        ),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column("origin", sa.String(8), nullable=False, server_default="user"),
        sa.Column("provenance", json_type, nullable=True),
        sa.Column("source_key", sa.String(160), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("user_id", "source_key", name="uq_notes_user_source"),
        sa.CheckConstraint("origin IN ('user', 'ai_saved')", name="ck_notes_origin"),
    )
    op.create_index("ix_notes_user_id", "notes", ["user_id"])
    op.create_index("ix_notes_document_created", "notes", ["document_id", "created_at"])

    op.create_table(
        "ai_artifacts",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column(
            "document_id", sa.Uuid(), sa.ForeignKey("documents.id", ondelete="CASCADE"), nullable=False
        ),
        sa.Column("kind", sa.String(8), nullable=False),
        sa.Column("language", sa.String(5), nullable=False),
        sa.Column("payload", json_type, nullable=False),
        sa.Column("content_hash", sa.String(64), nullable=False),
        sa.Column("ai_model", sa.String(100), nullable=False),
        sa.Column("prompt_revision", sa.Integer(), nullable=False),
        sa.Column("search_text", sa.Text(), nullable=False, server_default=""),
        sa.Column("prompt_tokens", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("completion_tokens", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("document_id", "kind", name="uq_ai_artifacts_document_kind"),
        sa.CheckConstraint("kind IN ('quick', 'deep', 'mindmap')", name="ck_ai_artifacts_kind"),
    )

    # The single note each document could carry becomes that document's first note.
    bind = op.get_bind()
    notes = sa.table(
        "notes",
        sa.column("id", sa.Uuid()),
        sa.column("user_id", sa.Uuid()),
        sa.column("document_id", sa.Uuid()),
        sa.column("body", sa.Text()),
        sa.column("origin", sa.String()),
        sa.column("created_at", sa.DateTime(timezone=True)),
        sa.column("updated_at", sa.DateTime(timezone=True)),
    )
    rows = bind.execute(
        sa.text("SELECT id, user_id, note, updated_at FROM documents WHERE note IS NOT NULL AND note <> ''")
    ).all()
    if rows:
        op.bulk_insert(
            notes,
            [
                {
                    "id": uuid.uuid4(),
                    "user_id": r.user_id,
                    "document_id": r.id,
                    "body": r.note,
                    "origin": "user",
                    "created_at": r.updated_at,
                    "updated_at": r.updated_at,
                }
                for r in rows
            ],
        )


def downgrade() -> None:
    op.drop_table("ai_artifacts")
    op.drop_index("ix_notes_document_created", table_name="notes")
    op.drop_index("ix_notes_user_id", table_name="notes")
    op.drop_table("notes")
