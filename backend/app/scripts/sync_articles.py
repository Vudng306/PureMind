"""Fetch new articles for the feed from the open sources, and store each once.

    python -m app.scripts.sync_articles                      # every source
    python -m app.scripts.sync_articles conversation owid    # some of them

Run it daily (cron, or Railway's scheduled job): The Conversation and Our World in Data publish every day,
PLOS, eLife and Frontiers for Young Minds change slowly. Articles already stored are refreshed; a work reached again through
another source (the same title) is not added twice.
"""

import argparse
import asyncio
import logging
import sys

from app.core.config import get_settings
from app.db.session import SessionLocal, engine
from app.services import articles, explore_chat
from app.services.openai_client import AIError, Usage
from app.services.sources import Item, conversation, elife, europepmc, frym, owid, plos

# The sources ask a crawler for a way to reach whoever runs it; a local run has only localhost to give.
PROJECT_URL = "https://github.com/Vudng306/PureMind"


async def europepmc_items(contact: str) -> list[Item]:
    return europepmc.items()


SOURCES = {
    "conversation": conversation.collect,
    "owid": owid.collect,
    "plos": plos.collect,
    "europepmc": europepmc_items,
    "elife": elife.collect,
    "frym": frym.collect,
}


def contact() -> str:
    own = get_settings().web_contact
    return own if own and "localhost" not in own and "127.0.0.1" not in own else PROJECT_URL


async def sync(names: list[str]) -> None:
    for name in names:
        items = await SOURCES[name](contact())
        async with SessionLocal() as session:
            stored = await articles.store(session, items)
        print(
            f"{name}: {len(items)} fetched, {stored.added} new, {stored.updated} refreshed, "
            f"{stored.duplicates} already in the feed from another source"
        )
    # The feed's chat searches the articles by meaning; embedding the new ones now spares its first reader.
    settings = get_settings()
    if settings.openai_api_key:
        try:
            print(f"chat index: {await explore_chat.index(settings, Usage())} articles embedded")
        except AIError as e:
            print(f"chat index: skipped ({e}); the chat embeds them on its first message")


async def main(argv: list[str]) -> None:
    parser = argparse.ArgumentParser(description="Fetch new articles for the PureMind feed.")
    parser.add_argument("sources", nargs="*", help=f"any of {', '.join(SOURCES)} (default: all)")
    args = parser.parse_args(argv)
    if unknown := set(args.sources) - set(SOURCES):
        parser.error(f"unknown source: {', '.join(sorted(unknown))}")
    logging.basicConfig(level=logging.WARNING, format="%(levelname)s %(message)s")
    try:
        await sync(args.sources or list(SOURCES))
    finally:
        await engine.dispose()


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    asyncio.run(main(sys.argv[1:]))
