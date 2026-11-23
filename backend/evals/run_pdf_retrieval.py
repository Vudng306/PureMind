"""Compare real PDF retrieval at 200/400/800 using fixed, preassigned evidence anchors."""

import argparse
import asyncio
import hashlib
import json
import time
from datetime import UTC, datetime
from pathlib import Path

from app.core.config import get_settings
from app.services import doc_chat, embeddings
from app.services.extraction import extract_pdf
from app.services.openai_client import Usage
from evals.progress import Progress, embed_with_progress

SIZES = (200, 400, 800)
KS = (1, 3, 5, 8)
CONTEXT_BUDGET = 1600  # same application's token estimate for every chunk configuration


def score_ranking(ranked, gold, chunks, budget=CONTEXT_BUDGET):
    """Score all labelled chunks and the prefix that fits a fixed context budget."""
    if not gold:
        raise ValueError("No relevant chunks were labelled")
    positions = [p for p, _ in ranked]
    if not gold.issubset(positions):
        raise ValueError("Relevant chunk missing from ranking")
    costs = {c.position: doc_chat.estimate_tokens(c.labelled()) for c in chunks}
    selected, used = set(), 0
    for position in positions:
        cost = costs[position]
        if used + cost > budget:
            break  # preserve retrieval order, rather than skipping a long high-ranked passage
        selected.add(position)
        used += cost
    return {
        "recall": {str(k): len(gold & set(positions[:k])) / len(gold) for k in KS},
        "first_relevant_rank": next(i for i, p in enumerate(positions, 1) if p in gold),
        "budget_recall": len(gold & selected) / len(gold),
        "budget_chunks": len(selected),
        "budget_used_estimated_tokens": used,
    }


async def main(pdf, output, dry_run, *, labels_path=None, sizes=SIZES, min_chunks=0, verbose=False):
    progress = Progress(verbose)
    progress.log("Load evidence labels and verify PDF")
    output.mkdir(parents=True, exist_ok=True)
    labels_path = labels_path or Path(__file__).with_name("pdf_retrieval_gold.json")
    labels = json.loads(labels_path.read_text(encoding="utf-8"))
    digest = hashlib.sha256(pdf.read_bytes()).hexdigest()
    if labels.get("sha256") and labels["sha256"] != digest:
        raise ValueError("PDF checksum does not match this dataset's labels")
    with progress.step("extract PDF text locally (no OCR/AI)"):
        extracted = extract_pdf(pdf, pdf.stem)
    progress.log(f"Extracted pages={extracted.page_count}; words={extracted.word_count}")
    (output / "clean.md").write_text(extracted.content, encoding="utf-8")
    all_chunks, golds = {}, {}
    for size in sizes:
        chunks = doc_chat.split_chunks(extracted.content, size, extracted.page_count)
        progress.log(f"Split target={size}; chunks={len(chunks)}")
        if len(chunks) < min_chunks:
            raise ValueError(f"Only {len(chunks)} chunks at {size}; dataset requires at least {min_chunks}")
        all_chunks[size] = chunks
        golds[size] = []
        for case in labels["cases"]:
            gold = {c.position for c in chunks if case["span"] in c.text}
            if not gold:
                raise ValueError(f"Anchor absent or split at {size}: {case['span']}")
            golds[size].append(gold)
        progress.log(f"Validated target={size}; questions={len(golds[size])}; all evidence anchors found")
    validation = {
        "source_sha256": digest,
        "pages": extracted.page_count,
        "words": extracted.word_count,
        "chunks": {s: len(c) for s, c in all_chunks.items()},
        "questions": len(labels["cases"]),
        "labels_note": labels["note"],
        "api_called": False,
    }
    (output / "validation.json").write_text(
        json.dumps(validation, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(json.dumps(validation))
    if dry_run:
        progress.log(f"Dry run complete; no API called; validation saved to {output / 'validation.json'}")
        return
    settings, usage = get_settings(), Usage()
    if not settings.openai_api_key:
        raise RuntimeError("Embedding key missing")
    texts = list(
        dict.fromkeys(
            [c.labelled() for chunks in all_chunks.values() for c in chunks]
            + [case["q"] for case in labels["cases"]]
        )
    )
    started = time.perf_counter()
    vectors = await embed_with_progress(
        settings, texts, purpose="eval_pdf_retrieval", usage=usage, progress=progress
    )
    embedding_seconds = time.perf_counter() - started
    indexed = dict(zip(texts, vectors, strict=True))
    results = []
    for size, chunks in all_chunks.items():
        rows = []
        for i, case in enumerate(labels["cases"]):
            query = indexed[case["q"]]
            ranked = sorted(
                [
                    (
                        c.position,
                        embeddings.cosine(query, embeddings.decode(embeddings.encode(indexed[c.labelled()]))),
                    )
                    for c in chunks
                ],
                key=lambda item: (-item[1], item[0]),
            )
            gold = golds[size][i]
            rows.append(
                {
                    "question": case["q"],
                    "anchor": case["span"],
                    "gold_positions": sorted(gold),
                    "ranking": ranked,
                    **score_ranking(ranked, gold, chunks),
                }
            )
            progress.log(
                f"Score target={size}; question={i + 1}/{len(labels['cases'])}; gold={sorted(gold)}; first_rank={rows[-1]['first_relevant_rank']}; Recall@8={rows[-1]['recall']['8']:.1%}"
            )
        results.append(
            {
                "chunk_tokens_target": size,
                "chunk_count": len(chunks),
                "macro_recall": {str(k): sum(r["recall"][str(k)] for r in rows) / len(rows) for k in KS},
                "mrr": sum(1 / r["first_relevant_rank"] for r in rows) / len(rows),
                "budget_macro_recall": sum(r["budget_recall"] for r in rows) / len(rows),
                "questions": rows,
            }
        )
    report = {
        "date_utc": datetime.now(UTC).isoformat(),
        "source": pdf.name,
        "sha256": digest,
        "title": extracted.title,
        "pages": extracted.page_count,
        "word_count": extracted.word_count,
        "model": settings.openai_embedding_model,
        "dimensions": settings.embedding_dimensions,
        "embedding_prompt_tokens": usage.prompt_tokens,
        "embedding_seconds": embedding_seconds,
        "context_budget_estimated_tokens": CONTEXT_BUDGET,
        "labels_note": labels["note"],
        "results": results,
    }
    (output / "results.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    lines = [
        "# PDF retrieval pilot",
        "",
        f"Source: {pdf.name}; {extracted.page_count} pages; {len(labels['cases'])} Vietnamese questions.",
        "",
        "| Target | Chunks | R@1 | R@3 | R@5 | R@8 | MRR | Recall at 1600 estimated tokens |",
        "|---|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for result in results:
        scores = " | ".join(f"{result['macro_recall'][str(k)]:.1%}" for k in KS)
        lines.append(
            f"| {result['chunk_tokens_target']} | {result['chunk_count']} | {scores} | {result['mrr']:.3f} | {result['budget_macro_recall']:.1%} |"
        )
    lines += [
        "",
        "## Per-question first relevant rank",
        "",
        "| Question | " + " | ".join(str(s) for s in sizes) + " |",
        "|---|" + "---:|" * len(sizes),
    ]
    for i, case in enumerate(labels["cases"]):
        lines.append(
            "| "
            + case["q"]
            + " | "
            + " | ".join(str(r["questions"][i]["first_relevant_rank"]) for r in results)
            + " |"
        )
    lines += [
        "",
        "Evidence-anchor labels were assigned before retrieval by the assistant, not independently human-reviewed. Other relevant passages may exist; these are pilot scores against the assigned anchors, not exhaustive relevance judgments.",
        "Same PDF extraction and chunker as PureMind; no OCR/image description, answer generation, database, pgvector or quote augmentation. Questions use Vietnamese against an English paper.",
        "At fixed k, larger chunks have a larger potential context budget. Chunk targets use the application's character-based token estimate. This small single-document experiment does not establish a generally optimal size.",
        "Fixed-budget retrieval uses a ranked prefix, stopping before the first passage that would exceed 1600 estimated tokens, including headings. It does not truncate passages. This estimate is not an exact model tokenizer count. Chunk-recall denominators can also change with segmentation; interpret alongside per-question evidence/ranks.",
    ]
    (output / "results.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    progress.log(f"Saved {output / 'results.json'} and results.md")
    print(json.dumps([{k: v for k, v in r.items() if k != "questions"} for r in results]))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("pdf", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument(
        "-v", "--verbose", action="store_true", help="Show stages and per-question progress on stderr"
    )
    args = parser.parse_args()
    asyncio.run(main(args.pdf, args.output, args.dry_run, verbose=args.verbose))
