"""Run paid live intent evaluation: python -m evals.run_explore --live [--limit N].

With --discover, also run the complete pipeline for DISCOVERY cases and export results for manual review.
No Library writes. Source relevance, claims and metadata require human review; never infer quality scores
from successful HTTP calls. AI token/search costs are recorded by the existing ai_usage instrumentation.
"""

import argparse
import asyncio
import json
import time
from dataclasses import asdict
from pathlib import Path

from app.core.config import get_settings
from app.services import ai_usage, discover, explore_quality
from app.services.openai_client import AIError, Usage
from evals.progress import Progress

HERE = Path(__file__).parent / "explore"


async def run(args):
    progress = Progress(getattr(args, "verbose", False))
    settings = get_settings()
    cases = json.loads((HERE / "cases.json").read_text(encoding="utf-8"))
    rows = []
    selected = cases[args.start : args.start + args.limit]
    progress.log(f"Loaded explore cases={len(selected)}; discovery={args.discover}")
    for i, case in enumerate(selected, 1):
        started = time.monotonic()
        first_event = len(ai_usage._waiting)
        usage = Usage()
        row = dict(case)
        try:
            with progress.step(f"classify case={i}/{len(selected)}; expected={case['intent']}"):
                intent = await explore_quality.classify(settings, case["query"], case["language"], usage)
            row.update(
                predicted=intent.intent, correct=intent.intent == case["intent"], guidance=intent.guidance
            )
            if args.discover and intent.intent == "DISCOVERY":
                with progress.step(f"search and verify documents; case={i}"):
                    result = await discover.discover(settings, case["query"], case["language"])
                row["documents"] = [asdict(item) for item in result.documents]
                row["evidence"] = [item.notes() for item in result.evidence]
                row["manual_review"] = {
                    "relevant": None,
                    "metadata_verified": None,
                    "unsupported_claims": None,
                    "import_attempts": None,
                    "import_successes": None,
                }
        except AIError as exc:
            row.update(error=str(exc), correct=False)
        row.update(
            seconds=round(time.monotonic() - started, 2),
            intent_prompt_tokens=usage.prompt_tokens,
            intent_completion_tokens=usage.completion_tokens,
        )
        row["ai_calls"] = [
            {
                key: event[key]
                for key in (
                    "purpose",
                    "model",
                    "prompt_tokens",
                    "cached_tokens",
                    "completion_tokens",
                    "web_searches",
                    "cost_usd",
                    "ok",
                    "duration_ms",
                )
            }
            for event in ai_usage._waiting[first_event:]
        ]
        rows.append(row)
        progress.log(f"Score case={i}; correct={row['correct']}; seconds={row['seconds']}")
        print(
            json.dumps(
                {key: row[key] for key in ("query", "predicted", "correct", "seconds", "error") if key in row}
                | {"documents": len(row.get("documents", []))},
                ensure_ascii=True,
            ),
            flush=True,
        )
        # An infrastructure failure should not trigger sixty retries against the same unavailable API.
        if row.get("error"):
            break
    report = {
        "attempted": len(rows),
        "expected": len(selected),
        "intent_accuracy": (
            sum(row["correct"] for row in rows) / len(rows)
            if len(rows) == len(selected) and not any(row.get("error") for row in rows)
            else None
        ),
        "manual_source_review_complete": False,
        "results": rows,
    }
    filename = "results-discovery.json" if args.discover else "results.json"
    (HERE / filename).write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    progress.log(f"Saved {HERE / filename}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--live", action="store_true", help="Make paid model calls using configured credentials"
    )
    parser.add_argument("--discover", action="store_true", help="Also search and verify web documents")
    parser.add_argument("--limit", type=int, default=60)
    parser.add_argument("-v", "--verbose", action="store_true", help="Show classification/search stages")
    parser.add_argument("--start", type=int, default=0, help="Zero-based first case")
    arguments = parser.parse_args()
    if not arguments.live:
        parser.error("Use --live to run paid evaluation")
    if not 1 <= arguments.limit <= 60:
        parser.error("--limit must be between 1 and 60")
    if not 0 <= arguments.start < 60:
        parser.error("--start must be between 0 and 59")
    asyncio.run(run(arguments))
