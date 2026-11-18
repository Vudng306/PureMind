"""Fetch new articles for the feed from the open sources, and store each once.

    python -m app.scripts.sync_articles                      # every source switched on
    python -m app.scripts.sync_articles conversation owid    # some of them

The API runs this every day by itself (services/crawler, at the hour set on the admin page), and an admin
can start it from there; this is the same run from a shell. Only what was published from 2023 on is kept.
"""

import argparse
import asyncio
import logging
import sys

from app.db.session import SessionLocal, engine
from app.models import CrawlRun
from app.services import ai_usage, crawler


async def sync(names: list[str] | None) -> None:
    async with SessionLocal() as session:
        try:
            run = await crawler.start(session, "manual", names, None)
        except crawler.CrawlBusy:
            print("a crawl is running already; try again when it is done")
            return
    await crawler.execute(run.id)
    async with SessionLocal() as session:
        run = await session.get(CrawlRun, run.id)
    for name, s in run.stats.items():
        print(
            f"{name}: {s['fetched']} fetched, {s['added']} new, {s['updated']} refreshed, "
            f"{s['duplicates']} already in the feed from another source, {s['too_old']} from before 2023, "
            f"{s['blocked']} deleted by an admin, {s['errors']} errors"
        )
    print(f"run {run.status}" + (f": {run.error}" if run.error else ""))


async def main(argv: list[str]) -> None:
    parser = argparse.ArgumentParser(description="Fetch new articles for the PureMind feed.")
    parser.add_argument("sources", nargs="*", help=f"any of {', '.join(crawler.SOURCES)} (default: all)")
    args = parser.parse_args(argv)
    if unknown := set(args.sources) - set(crawler.SOURCES):
        parser.error(f"unknown source: {', '.join(sorted(unknown))}")
    logging.basicConfig(level=logging.WARNING, format="%(levelname)s %(message)s")
    try:
        await sync(args.sources or None)
    finally:
        await ai_usage.flush()
        await engine.dispose()


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    asyncio.run(main(sys.argv[1:]))
