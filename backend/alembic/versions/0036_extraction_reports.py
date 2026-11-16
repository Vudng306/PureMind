"""Clean Reader: the owner's reports that the clean text of a document is wrong (CR-FR-15)

Revision ID: 0036
Revises: 0035
Create Date: 2026-11-16
"""

import sqlalchemy as sa

from alembic import op

revision = "0036"
down_revision = "0035"
branch_labels = None
depends_on = None

ERRORS = (
    "missing_text",
    "wrong_order",
    "metadata_in_body",
    "missing_media",
    "ocr_error",
    "wrongly_hidden",
    "other",
)


def upgrade() -> None:
    op.create_table(
        "extraction_reports",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column(
            "document_id", sa.Uuid(), sa.ForeignKey("documents.id", ondelete="CASCADE"), nullable=False
        ),
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("error_type", sa.String(32), nullable=False),
        sa.Column("page", sa.Integer()),
        sa.Column("block", sa.Integer()),
        sa.Column("block_type", sa.String(32)),
        sa.Column("classifier", sa.String(32)),
        sa.Column("note", sa.Text()),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint(
            "error_type IN (" + ", ".join(f"'{e}'" for e in ERRORS) + ")",
            name="ck_extraction_reports_error_type",
        ),
    )
    op.create_index("ix_extraction_reports_document_id", "extraction_reports", ["document_id"])


def downgrade() -> None:
    op.drop_index("ix_extraction_reports_document_id", "extraction_reports")
    op.drop_table("extraction_reports")
