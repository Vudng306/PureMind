"""Reader v2 phase 4: an AI result may also be a research analysis (AI-111).

Only the check on `ai_artifacts.kind` is widened; no row changes. Going back removes the analyses first, since
the narrower check would not hold them.

Revision ID: 0034
Revises: 0033
"""

from alembic import op

revision = "0034"
down_revision = "0033"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.drop_constraint("ck_ai_artifacts_kind", "ai_artifacts", type_="check")
    op.create_check_constraint(
        "ck_ai_artifacts_kind", "ai_artifacts", "kind IN ('quick', 'deep', 'mindmap', 'analysis')"
    )


def downgrade() -> None:
    op.execute("DELETE FROM ai_artifacts WHERE kind = 'analysis'")
    op.drop_constraint("ck_ai_artifacts_kind", "ai_artifacts", type_="check")
    op.create_check_constraint("ck_ai_artifacts_kind", "ai_artifacts", "kind IN ('quick', 'deep', 'mindmap')")
