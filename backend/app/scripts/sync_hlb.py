"""Store the picked entries of Cẩm nang sống thông minh, at the commit data/hlb-picks.json pins.

    python -m app.scripts.sync_hlb

The same as a crawl of the one source, without the chat index (an OpenAI call); the next crawl or a run of
the index embeds them. Running it again updates the same articles.
"""

import asyncio
import sys

from app.db.session import SessionLocal
from app.services import articles, crawler
from app.services.sources import hlb


async def main() -> None:
    pin = hlb.read_pin()
    items = await hlb.collect(crawler.contact())
    async with SessionLocal() as session:
        counts = await crawler.keep(session, items)
    async with SessionLocal() as session:
        await articles.rerank(session)
    print(f"{hlb.NAME} @ {pin.commit[:7]}: {len(pin.picks)} picked, {counts}")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    asyncio.run(main())
