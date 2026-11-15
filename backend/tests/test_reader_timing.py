"""NFR-101/103: how long the reader's own requests take on the server (no network, no AI).

Off by default; `READER_TIMING=1 TEST_DATABASE_URL=… pytest tests/test_reader_timing.py -s` runs it on
PostgreSQL and prints p50/p95 per request. Only the server's time is measured here: the browser adds the
network and the drawing of the page.
"""

import os
import statistics
import time

import pytest

from tests.pdfs import text_pdf
from tests.test_highlights import create as create_highlight
from tests.test_summaries import new_doc

pytestmark = pytest.mark.skipif(not os.environ.get("READER_TIMING"), reason="set READER_TIMING=1 to measure")

RUNS = 60
SAVE_P95_S = 1.5  # NFR-103


def p95(samples: list[float]) -> float:
    return statistics.quantiles(samples, n=20)[-1]


async def test_reader_requests_are_quick(client, auth):
    h = auth()
    doc = await new_doc(client, h, text_pdf(12))
    times: dict[str, list[float]] = {}

    async def timed(name, call):
        started = time.perf_counter()
        r = await call()
        times.setdefault(name, []).append(time.perf_counter() - started)
        assert r.status_code < 300, f"{name}: {r.status_code} {r.text[:200]}"
        return r

    for i in range(RUNS):
        await timed("open document", lambda: client.get(f"/api/documents/{doc}", headers=h))
        await timed("list highlights", lambda: client.get(f"/api/highlights?document_id={doc}", headers=h))
        await timed(
            "save highlight", lambda i=i: create_highlight(client, h, doc, start_offset=i, end_offset=i + 8)
        )
        await timed(
            "save note",
            lambda i=i: client.post(f"/api/documents/{doc}/notes", headers=h, json={"body": f"Ghi chú {i}"}),
        )
        await timed(
            "save reading place",
            lambda i=i: client.patch(
                f"/api/documents/{doc}",
                headers=h,
                json={"read_fraction": i / RUNS, "read_position": {"block_id": "b3", "offset": 0.5}},
            ),
        )
        await timed("open notebook", lambda: client.get(f"/api/notebook/documents/{doc}", headers=h))

    print()
    for name, samples in times.items():
        ms = [s * 1000 for s in samples]
        print(f"{name:20} p50 {statistics.median(ms):7.1f} ms   p95 {p95(ms):7.1f} ms   n={len(ms)}")
    for name in ("save highlight", "save note", "save reading place"):
        assert p95(times[name]) < SAVE_P95_S
