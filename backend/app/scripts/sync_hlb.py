"""Store the picked entries of Cẩm nang sống thông minh, at the commit data/hlb-picks.json pins.

    python -m app.scripts.sync_hlb             # the articles
    python -m app.scripts.sync_hlb --shorts    # and a short for each picked one that has none

The same as a crawl of the one source, without the chat index (an OpenAI call); the next crawl or a run of
the index embeds them. Running it again updates the same articles. `--shorts` makes one OpenAI call
(openai_guide_model) per short, from the entry's suggested title and the limits the picks file says it must
state; an article that has a short already is skipped. Read the shorts it writes: they show in the feed at once.
"""

import argparse
import asyncio
import sys

from sqlalchemy import select
from sqlalchemy.orm import undefer

from app.core.config import get_settings
from app.db.session import SessionLocal, engine
from app.models import Article, Short
from app.services import articles, crawler, shorts
from app.services.openai_client import AIError
from app.services.sources import hlb


async def sync() -> None:
    pin = hlb.read_pin()
    items = await hlb.collect(crawler.contact())
    async with SessionLocal() as session:
        counts = await crawler.keep(session, items)
    async with SessionLocal() as session:
        await articles.rerank(session)
    print(f"{hlb.NAME} @ {pin.commit[:7]}: {len(pin.picks)} picked, {counts}")


async def write_shorts() -> None:
    settings = get_settings()
    briefs = hlb.read_briefs()
    async with SessionLocal() as session:
        found = list(
            await session.scalars(
                select(Article)
                .where(
                    Article.source == hlb.SOURCE,
                    Article.hidden_at.is_(None),
                    ~select(Short.id).where(Short.article_id == Article.id).exists(),
                )
                .options(undefer(Article.content))
            )
        )
    wanted = [(a, briefs[entry]) for a in found if (entry := hlb.entry_id_in(a.url)) in briefs]
    print(f"{len(wanted)} picked articles without a short")
    written = 0
    for original, brief in wanted:
        try:
            short = await shorts.write(settings, original, brief.title, brief.must_keep)
        except AIError as e:
            print(f"  failed: {original.title} ({e})")
            continue
        async with SessionLocal() as session:
            session.add(short)
            await session.commit()
        written += 1
        print(f"  {short.title}  ← {original.title}")
    print(f"{written} shorts written")


async def main(argv: list[str]) -> None:
    parser = argparse.ArgumentParser(description=f"Store {hlb.NAME}'s picked entries in the feed.")
    parser.add_argument("--shorts", action="store_true", help="also write a short for each picked entry")
    args = parser.parse_args(argv)
    if args.shorts and not get_settings().openai_api_key:
        parser.error("OPENAI_API_KEY is not set")
    try:
        await sync()
        if args.shorts:
            await write_shorts()
    finally:
        await engine.dispose()


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    asyncio.run(main(sys.argv[1:]))
