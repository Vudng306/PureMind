"""Write the feed's short posts from its openly licensed articles (services/shorts).

    python -m app.scripts.write_shorts                          # 3 per topic
    python -m app.scripts.write_shorts --per-topic 1 health mind

Run it after sync_articles. Each short is one call to the OpenAI API (openai_guide_model); an article that
has a short already is skipped, so running it again only writes the missing ones.
"""

import argparse
import asyncio
import logging
import sys

from app.core.config import get_settings
from app.db.session import SessionLocal, engine
from app.models import TOPICS
from app.services import ai_usage, shorts
from app.services.openai_client import AIError


async def run(topics: list[str], per_topic: int) -> None:
    settings = get_settings()
    async with SessionLocal() as session:
        found = await shorts.originals(session, per_topic, topics)
    print(f"{len(found)} articles to write shorts from")
    written = 0
    for original in found:
        try:
            short = await shorts.write(settings, original)
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
    parser = argparse.ArgumentParser(description="Write short posts for the PureMind feed.")
    parser.add_argument("topics", nargs="*", help=f"any of {', '.join(TOPICS)} (default: all)")
    parser.add_argument("--per-topic", type=int, default=3)
    args = parser.parse_args(argv)
    if unknown := set(args.topics) - set(TOPICS):
        parser.error(f"unknown topic: {', '.join(sorted(unknown))}")
    if not get_settings().openai_api_key:
        parser.error("OPENAI_API_KEY is not set")
    logging.basicConfig(level=logging.WARNING, format="%(levelname)s %(message)s")
    try:
        await run(args.topics or list(TOPICS), args.per_topic)
    finally:
        await ai_usage.flush()
        await engine.dispose()


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    asyncio.run(main(sys.argv[1:]))
