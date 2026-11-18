"""Place the highlights saved before the two views shared them, and join the ones sure to be the same passage.

    python -m app.scripts.sync_highlights            # says what it would do, changes nothing
    python -m app.scripts.sync_highlights --apply

Two rows are joined only when one was made on the PDF and the other in the clean text, both are placed on
exactly the same passage, they have the same color, and no notebook cites both (its [n] references would
break). The older row stays, with the earlier date, both notes and the notebook links of both; the other is
kept whole in `highlight_merges`. Everything else keeps its row and is listed. The report has ids and counts
only, no text of the user's.
"""

import argparse
import asyncio
import uuid
from collections import defaultdict
from datetime import datetime

from sqlalchemy import delete, select, update

from app.core.config import get_settings
from app.db.session import SessionLocal
from app.models import Document, Highlight, HighlightMerge, NotebookHighlight
from app.services import highlight_sync

COLUMNS = [c.name for c in Highlight.__table__.columns]


def _jsonable(value):
    if isinstance(value, uuid.UUID):
        return str(value)
    if isinstance(value, datetime):
        return value.isoformat()
    return value


def snapshot(row: Highlight) -> dict:
    return {name: _jsonable(getattr(row, name)) for name in COLUMNS}


def joined_note(kept: str, other: str) -> str:
    if not other.strip() or other in kept:
        return kept
    return f"{kept}\n\n{other}" if kept.strip() else other


async def _links(session, ids: list[uuid.UUID]) -> dict[uuid.UUID, list[NotebookHighlight]]:
    out: dict[uuid.UUID, list[NotebookHighlight]] = defaultdict(list)
    rows = await session.scalars(select(NotebookHighlight).where(NotebookHighlight.highlight_id.in_(ids)))
    for link in rows.unique():
        out[link.highlight_id].append(link)
    return out


async def run(apply: bool) -> dict:
    settings = get_settings()
    report = {"documents": 0, "highlights": 0, "synced": 0, "unsynced": 0, "ambiguous": 0}
    merges, held = [], []
    async with SessionLocal() as session:
        ids = (await session.scalars(select(Highlight.document_id).distinct())).all()
        for doc_id in ids:
            doc = await session.get(Document, doc_id)
            rows = list(
                (
                    await session.scalars(
                        select(Highlight)
                        .where(Highlight.document_id == doc_id)
                        .order_by(Highlight.created_at)
                    )
                ).all()
            )
            report["documents"] += 1
            index = await highlight_sync.index_of(session, settings, doc)
            places = {row.id: await highlight_sync.place_in(index, row) for row in rows}
            groups: dict[tuple, list[Highlight]] = defaultdict(list)
            for row in rows:
                where = places[row.id]
                if where.start is not None:
                    groups[(row.user_id, where.start, where.end)].append(row)
            links = await _links(session, [r.id for r in rows])
            for group in groups.values():
                if len(group) < 2:
                    continue
                names = [str(r.id)[:8] for r in group]
                made_on_pdf = [r for r in group if r.block_id is None]
                made_in_text = [r for r in group if r.block_id is not None]
                if len(group) != 2 or len(made_on_pdf) != 1 or len(made_in_text) != 1:
                    held.append({"highlights": names, "why": "not one row from each view"})
                    continue
                kept, other = group  # oldest first
                shared = {x.notebook_id for x in links[kept.id]} & {x.notebook_id for x in links[other.id]}
                if kept.color != other.color:
                    held.append({"highlights": names, "why": "different colors"})
                    continue
                if shared:
                    held.append({"highlights": names, "why": "both cited by one notebook"})
                    continue
                merges.append({"kept": str(kept.id)[:8], "merged": str(other.id)[:8]})
                if not apply:
                    continue
                moved = links[other.id]
                session.add(
                    HighlightMerge(
                        user_id=kept.user_id,
                        kept_highlight_id=kept.id,
                        merged_row=snapshot(other),
                        notebook_links=[
                            {"notebook_id": str(x.notebook_id), "position": x.position} for x in moved
                        ],
                    )
                )
                kept.note = joined_note(kept.note, other.note)
                kept.category = kept.category or other.category
                kept.created_at = min(kept.created_at, other.created_at)
                await session.flush()
                for x in moved:
                    notebook_id = x.notebook_id
                    session.expunge(x)  # its key changes below
                    await session.execute(
                        update(NotebookHighlight)
                        .where(
                            NotebookHighlight.notebook_id == notebook_id,
                            NotebookHighlight.highlight_id == other.id,
                        )
                        .values(highlight_id=kept.id)
                    )
                await session.execute(delete(Highlight).where(Highlight.id == other.id))
                rows.remove(other)
            await highlight_sync.recheck(session, settings, doc, rows, statuses=False)
            await session.flush()
            for row in rows:
                report["highlights"] += 1
                report[row.sync_status] += 1
        report["merged" if apply else "would_merge"] = merges
        report["left_for_review"] = held
        if apply:
            await session.commit()
        else:
            await session.rollback()
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--apply", action="store_true", help="write the changes; without it nothing is changed"
    )
    args = parser.parse_args()
    report = asyncio.run(run(args.apply))
    print("APPLIED" if args.apply else "REPORT ONLY: nothing was changed")
    for key, value in report.items():
        print(f"{key}: {value}")


if __name__ == "__main__":
    main()
