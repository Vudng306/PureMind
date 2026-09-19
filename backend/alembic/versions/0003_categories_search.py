"""Highlight categories, purple color and full-text search

Revision ID: 0003
Revises: 0002
Create Date: 2026-09-18
"""

import sqlalchemy as sa
from alembic import op

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None

# FR-SRCH-01: accent-insensitive search. The config runs unaccent before the simple dictionary,
# so to_tsvector/to_tsquery/ts_headline all ignore Vietnamese diacritics.
SEARCH_INDEXES = {
    "ix_documents_title_fts": ("documents", "title"),
    "ix_documents_content_fts": ("documents", "content_clean"),
    "ix_documents_note_fts": ("documents", "note"),
    "ix_highlights_text_fts": ("highlights", "selected_text"),
    "ix_highlights_note_fts": ("highlights", "note"),
}


def upgrade() -> None:
    op.add_column("highlights", sa.Column("category", sa.String(16)))
    op.create_check_constraint(
        "ck_highlights_category",
        "highlights",
        "category IS NULL OR category IN ('important', 'concept', 'question', 'example', 'review')",
    )
    op.drop_constraint("ck_highlights_color", "highlights", type_="check")
    op.create_check_constraint(
        "ck_highlights_color", "highlights", "color IN ('yellow', 'green', 'blue', 'pink', 'purple')"
    )

    op.execute("CREATE EXTENSION IF NOT EXISTS unaccent")
    op.execute("DROP TEXT SEARCH CONFIGURATION IF EXISTS public.pm_unaccent")
    op.execute("CREATE TEXT SEARCH CONFIGURATION public.pm_unaccent (COPY = pg_catalog.simple)")
    op.execute(
        "ALTER TEXT SEARCH CONFIGURATION public.pm_unaccent "
        "ALTER MAPPING FOR hword, hword_part, word WITH unaccent, simple"
    )
    for name, (table, column) in SEARCH_INDEXES.items():
        op.execute(
            f"CREATE INDEX {name} ON {table} USING gin (to_tsvector('public.pm_unaccent'::regconfig, {column}))"
        )


def downgrade() -> None:
    for name in SEARCH_INDEXES:
        op.execute(f"DROP INDEX IF EXISTS {name}")
    op.execute("DROP TEXT SEARCH CONFIGURATION IF EXISTS public.pm_unaccent")
    op.drop_constraint("ck_highlights_color", "highlights", type_="check")
    op.execute("UPDATE highlights SET color = 'yellow' WHERE color = 'purple'")
    op.create_check_constraint("ck_highlights_color", "highlights", "color IN ('yellow', 'green', 'blue', 'pink')")
    op.drop_constraint("ck_highlights_category", "highlights", type_="check")
    op.drop_column("highlights", "category")
