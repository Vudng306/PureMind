"""Reader v2: the place in the clean text by block, and what an extraction left out.

Both are new nullable columns on `documents`: a document read or extracted before this keeps working from
`read_fraction`, and shows no warning until it is extracted again.

Revision ID: 0032
Revises: 0031
"""

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "0032"
down_revision = "0031"
branch_labels = None
depends_on = None

json_type = sa.JSON().with_variant(postgresql.JSONB(), "postgresql")


def upgrade() -> None:
    op.add_column("documents", sa.Column("read_position", json_type, nullable=True))
    op.add_column("documents", sa.Column("extraction_issues", json_type, nullable=True))


def downgrade() -> None:
    op.drop_column("documents", "extraction_issues")
    op.drop_column("documents", "read_position")
