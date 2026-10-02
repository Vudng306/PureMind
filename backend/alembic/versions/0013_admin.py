"""Admin page: user role, locked accounts, last activity and the admin audit log

Revision ID: 0013
Revises: 0012
Create Date: 2026-09-30
"""

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "0013"
down_revision = "0012"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("users", sa.Column("role", sa.String(8), nullable=False, server_default="user"))
    op.create_check_constraint("ck_users_role", "users", "role IN ('user', 'admin')")
    op.add_column("users", sa.Column("disabled_at", sa.DateTime(timezone=True)))
    op.add_column("users", sa.Column("last_seen_at", sa.DateTime(timezone=True)))

    op.create_table(
        "admin_audit_log",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("admin_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="SET NULL")),
        sa.Column("admin_email", sa.String(255), nullable=False),
        sa.Column("action", sa.String(32), nullable=False),
        sa.Column("target_user_id", sa.Uuid()),
        sa.Column("target_email", sa.String(255)),
        sa.Column("detail", postgresql.JSONB(), nullable=False, server_default="{}"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_admin_audit_log_created", "admin_audit_log", ["created_at"])
    op.create_index("ix_admin_audit_log_target_user_id", "admin_audit_log", ["target_user_id"])


def downgrade() -> None:
    op.drop_index("ix_admin_audit_log_target_user_id", "admin_audit_log")
    op.drop_index("ix_admin_audit_log_created", "admin_audit_log")
    op.drop_table("admin_audit_log")
    op.drop_column("users", "last_seen_at")
    op.drop_column("users", "disabled_at")
    op.drop_constraint("ck_users_role", "users", type_="check")
    op.drop_column("users", "role")
