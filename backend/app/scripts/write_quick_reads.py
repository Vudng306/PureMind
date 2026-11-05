"""Write the Quick Reads of the shared catalog's articles (services/quick_reads).

    python -m app.scripts.write_quick_reads                     # every article without one
    python -m app.scripts.write_quick_reads PMC13500329 PMC13596809

Run it after collect_catalog. Each one is a call to the OpenAI API (openai_guide_model) with the article's whole
text; an article that has one already is skipped, so running it again only writes the missing ones, and a
Quick Read whose article has left the catalog is dropped. Only the long papers get one: a short read needs no
summary, and CC BY-ND forbids making one.
"""

import argparse
import asyncio
import logging
import sys

from app.api.routes.catalog import catalog
from app.core.config import get_settings
from app.services import quick_reads
from app.services.openai_client import AIError


async def run(wanted: list[str]) -> None:
    settings = get_settings()
    articles = catalog()["articles"]
    known = {a["id"] for a in articles}
    quick = {k: v for k, v in quick_reads.load().items() if k in known}
    found = [
        a
        for a in articles
        if a["id"] not in quick
        and quick_reads.wanted_for(a)
        and (not wanted or any(a["url"].endswith(f"/{w}") for w in wanted))
    ]
    print(f"{len(found)} articles to write Quick Reads for")
    written = 0
    for article in found:
        try:
            quick[article["id"]] = await quick_reads.write(settings, article)
        except AIError as e:
            print(f"  failed: {article['title']} ({e})")
            continue
        quick_reads.save(quick)
        written += 1
        print(f"  {quick[article['id']]['title']}  ← {article['title']}")
    quick_reads.save(quick)
    print(f"{written} Quick Reads written")


def main(argv: list[str]) -> None:
    parser = argparse.ArgumentParser(description="Write Quick Reads for the shared catalog.")
    parser.add_argument("pmcids", nargs="*", help="only these articles (default: all)")
    args = parser.parse_args(argv)
    if not get_settings().openai_api_key:
        parser.error("OPENAI_API_KEY is not set")
    logging.basicConfig(level=logging.WARNING, format="%(levelname)s %(message)s")
    asyncio.run(run(args.pmcids))


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    main(sys.argv[1:])
