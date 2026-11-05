"""Write the catalog's Vietnamese ahead of time (services/article_translation).

    python -m app.scripts.translate_catalog         # a title and a line for each card, in data/catalog-vi.json
    python -m app.scripts.translate_catalog --text  # and the text of the short reads whose licence allows keeping it

Each is a call to the OpenAI API (openai_model). What is written already is skipped, so running it again only
writes what is missing, and a card whose article has left the catalog is dropped. The text goes to the database
of this environment. CC BY-ND articles are never written here: they are translated for the reader who asks.
"""

import argparse
import asyncio
import logging
import sys

from sqlalchemy import select

from app.api.routes.catalog import VI, catalog
from app.core.config import get_settings
from app.db.session import SessionLocal, engine
from app.models import ContentTranslation
from app.services import article_translation as translation
from app.services import quick_reads
from app.services.openai_client import AIError

PARALLEL = 5


async def write_cards(settings) -> None:
    articles = catalog()["articles"]
    known = {a["id"] for a in articles}
    cards = {k: v for k, v in quick_reads.load(VI).items() if k in known}
    # An article with a Quick Read leads with that.
    found = [a for a in articles if a["id"] not in cards and not a.get("quick")]
    print(f"{len(found)} cards to write")
    gate = asyncio.Semaphore(PARALLEL)

    async def one(article: dict) -> None:
        async with gate:
            try:
                cards[article["id"]] = await translation.write_card(settings, article)
            except AIError as e:
                print(f"  failed: {article['title']} ({e})")
                return
        print(f"  {cards[article['id']]['title']}")

    await asyncio.gather(*(one(article) for article in found))
    quick_reads.save(cards, VI)
    print(f"{len(cards)} cards in {VI.name}")


async def write_texts(settings) -> None:
    articles = [a for a in catalog()["articles"] if translation.may_keep(a) and translation.translatable(a)]
    async with SessionLocal() as session:
        rows = await session.scalars(select(ContentTranslation))
        kept = {(row.content_id, row.source_version) for row in rows}
        found = [a for a in articles if (a["id"], translation.source_version(a)) not in kept]
        print(f"{len(found)} texts to translate")
        for article in found:
            try:
                parts = [part async for part in translation.translate(settings, article["content"])]
            except AIError as e:
                print(f"  failed: {article['title']} ({e})")
                continue
            await session.merge(
                ContentTranslation(
                    content_id=article["id"],
                    language=translation.LANGUAGE,
                    content_type=translation.CONTENT_TYPE,
                    source_version=translation.source_version(article),
                    translated_text="\n\n".join(parts),
                    translation_model=settings.openai_model,
                )
            )
            await session.commit()
            print(f"  {article['title']}")


async def run(texts: bool) -> None:
    settings = get_settings()
    await write_cards(settings)
    if texts:
        await write_texts(settings)
    await engine.dispose()


def main(argv: list[str]) -> None:
    parser = argparse.ArgumentParser(description="Write the shared catalog's Vietnamese.")
    parser.add_argument("--text", action="store_true", help="also translate the texts that may be kept")
    args = parser.parse_args(argv)
    if not get_settings().openai_api_key:
        parser.error("OPENAI_API_KEY is not set")
    logging.basicConfig(level=logging.WARNING, format="%(levelname)s %(message)s")
    asyncio.run(run(args.text))


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    main(sys.argv[1:])
