"""Leave the handbook as the only source: hide every other source's articles and turn their crawl off.

    python -m app.scripts.retire_sources           # hide them and turn the crawl off
    python -m app.scripts.retire_sources --undo    # bring back what this script hid, turn the crawl back on

Nothing is deleted. Articles stay in the database with `hidden_at` set, which takes them out of the feed, the
chat and Explore, as an admin's hide does; users' saved copies (documents) are not touched. The ids it hid and
the sources it turned off are kept in the AppSetting `retire.sources`, so `--undo` brings back only those, not
articles an admin had hidden before. An admin can still turn a source back on in the crawl page.
"""

import argparse
import asyncio
import sys
import uuid

from sqlalchemy import select, update

from app.db.session import SessionLocal, engine
from app.models import Article, utcnow
from app.services import crawler
from app.services.sources import hlb

RECORD_KEY = "retire.sources"


async def retire() -> None:
    others = sorted(s for s in crawler.SOURCES if s != hlb.SOURCE)
    async with SessionLocal() as session:
        record = await crawler.setting(session, RECORD_KEY, {"hidden": [], "disabled": []})
        ids = list(
            await session.scalars(
                select(Article.id).where(Article.source.in_(others), Article.hidden_at.is_(None))
            )
        )
        if ids:
            await session.execute(update(Article).where(Article.id.in_(ids)).values(hidden_at=utcnow()))
        off = await crawler.disabled_sources(session)
        newly_off = [s for s in others if s not in off]
        await crawler.put_setting(session, crawler.SOURCES_KEY, {"disabled": sorted(off | set(others))})
        await crawler.put_setting(
            session,
            RECORD_KEY,
            {
                "hidden": record["hidden"] + [str(i) for i in ids],
                "disabled": sorted(set(record["disabled"]) | set(newly_off)),
            },
        )
        await session.commit()
    print(f"hid {len(ids)} articles from {', '.join(others)}; crawl off for {len(newly_off)} more sources")


async def undo() -> None:
    async with SessionLocal() as session:
        record = await crawler.setting(session, RECORD_KEY, {"hidden": [], "disabled": []})
        ids = [uuid.UUID(i) for i in record["hidden"]]
        if ids:
            await session.execute(update(Article).where(Article.id.in_(ids)).values(hidden_at=None))
        off = await crawler.disabled_sources(session) - set(record["disabled"])
        await crawler.put_setting(session, crawler.SOURCES_KEY, {"disabled": sorted(off)})
        await crawler.put_setting(session, RECORD_KEY, {"hidden": [], "disabled": []})
        await session.commit()
    print(f"showed {len(ids)} articles again; crawl back on for {', '.join(record['disabled']) or 'none'}")


async def main(argv: list[str]) -> None:
    parser = argparse.ArgumentParser(description=f"Leave {hlb.NAME} as the only source of articles.")
    parser.add_argument("--undo", action="store_true", help="bring back what an earlier run hid")
    args = parser.parse_args(argv)
    try:
        await (undo() if args.undo else retire())
    finally:
        await engine.dispose()


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    asyncio.run(main(sys.argv[1:]))
