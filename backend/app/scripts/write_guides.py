"""Write Vietnamese guides for the feed from its openly licensed articles (services/guides).

    python -m app.scripts.write_guides                          # 2 per topic
    python -m app.scripts.write_guides --per-topic 1 health mind

Run it after sync_articles. Each guide is one call to the OpenAI API (openai_guide_model); an article that
has a guide already is skipped, so running it again only writes the missing ones.
"""

import argparse
import asyncio
import logging
import sys

from app.core.config import get_settings
from app.db.session import SessionLocal, engine
from app.models import TOPICS
from app.services import ai_usage, articles, guides
from app.services.openai_client import AIError


async def run(topics: list[str], per_topic: int) -> None:
    settings = get_settings()
    async with SessionLocal() as session:
        found = await guides.originals(session, per_topic, topics)
    print(f"{len(found)} articles to write guides from")
    written = 0
    for original in found:
        try:
            item = await guides.write(settings, original)
        except AIError as e:
            print(f"  failed: {original.title} ({e})")
            continue
        async with SessionLocal() as session:
            await articles.store(session, [item])
        written += 1
        print(f"  {item.title}  ← {original.title}")
    print(f"{written} guides written")


async def main(argv: list[str]) -> None:
    parser = argparse.ArgumentParser(description="Write Vietnamese guides for the PureMind feed.")
    parser.add_argument("topics", nargs="*", help=f"any of {', '.join(TOPICS)} (default: all)")
    parser.add_argument("--per-topic", type=int, default=2)
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
