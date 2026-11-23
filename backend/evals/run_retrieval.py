"""Small retrieval-only evaluation using real embeddings and preassigned source spans.

Run from backend: python -m evals.run_retrieval
No answer generation or production database access. Reports raw cosine retrieval;
quote-neighbour injection used by the application is deliberately excluded.
"""

import argparse
import asyncio
import json
from datetime import UTC, datetime
from pathlib import Path

from app.core.config import get_settings
from app.services import doc_chat, embeddings
from app.services.openai_client import Usage
from evals.progress import Progress, embed_with_progress

HERE = Path(__file__).parent / "reader_ai"
KS = (1, 3, 5, 8)


async def main(chunk_tokens=None, verbose=False):
    progress = Progress(verbose)
    progress.log("Load sample dataset and preassigned source labels")
    settings = get_settings()
    if chunk_tokens is not None:
        settings = settings.model_copy(update={"chat_chunk_tokens": chunk_tokens})
    stem = "retrieval_results" if chunk_tokens is None else f"retrieval_results_{chunk_tokens}"
    if not settings.openai_api_key:
        raise RuntimeError("An embedding API key is required")
    documents = json.loads((HERE / "cases.json").read_text(encoding="utf-8"))["documents"]
    labels = json.loads((HERE / "retrieval_gold.json").read_text(encoding="utf-8"))
    inputs, prepared, usage = [], [], Usage()
    for document in documents:
        chunks = doc_chat.split_chunks(
            (HERE / document["file"]).read_text(encoding="utf-8"),
            settings.chat_chunk_tokens,
            document["page_count"],
        )
        progress.log(
            f"Split document={document['id']}; target={settings.chat_chunk_tokens}; chunks={len(chunks)}"
        )
        chunk_start = len(inputs)
        inputs.extend(chunk.labelled() for chunk in chunks)
        for label in labels["cases"]:
            if label["document"] != document["id"]:
                continue
            case = document["questions"][label["question_index"]]
            gold = {c.position for c in chunks if any(span in c.text for span in label["spans"])}
            for span in label["spans"]:
                if not any(span in c.text for c in chunks):
                    raise ValueError(f"Unmatched gold span: {span}")
            query_index = len(inputs)
            inputs.append(f"{case['quote']}\n{case['q']}" if case.get("quote") else case["q"])
            prepared.append((document["id"], case["q"], chunks, gold, chunk_start, query_index))
            progress.log(
                f"Validate document={document['id']}; question={label['question_index'] + 1}; gold={sorted(gold)}"
            )
    vectors = await embed_with_progress(
        settings, inputs, purpose="eval_retrieval", usage=usage, progress=progress
    )
    results = []
    for document, question, chunks, gold, start, query_index in prepared:
        # Same six-decimal storage precision and cosine ranking as the app's Python fallback.
        scored = [
            (
                c.position,
                embeddings.cosine(
                    vectors[query_index], embeddings.decode(embeddings.encode(vectors[start + i]))
                ),
            )
            for i, c in enumerate(chunks)
        ]
        ranked = sorted(scored, key=lambda item: (-item[1], item[0]))
        recalls = {str(k): len(gold & {p for p, _ in ranked[:k]}) / len(gold) for k in KS}
        progress.log(
            f"Score question={len(results) + 1}/{len(prepared)}; document={document}; Recall@8={recalls['8']:.1%}"
        )
        results.append(
            {
                "document": document,
                "question": question,
                "chunk_count": len(chunks),
                "gold_positions": sorted(gold),
                "ranking": ranked,
                "recall": recalls,
            }
        )
    aggregate = {str(k): sum(r["recall"][str(k)] for r in results) / len(results) for k in KS}
    output = {
        "date_utc": datetime.now(UTC).isoformat(),
        "model": settings.openai_embedding_model,
        "dimensions": settings.embedding_dimensions,
        "chunk_tokens_target": settings.chat_chunk_tokens,
        "prompt_tokens": usage.prompt_tokens,
        "label_note": labels["note"],
        "macro_recall": aggregate,
        "results": results,
    }
    (HERE / f"{stem}.json").write_text(json.dumps(output, ensure_ascii=False, indent=2), encoding="utf-8")
    lines = [
        "# Retrieval pilot",
        "",
        f"Model: {output['model']}; chunk target: {settings.chat_chunk_tokens}; questions: {len(results)}.",
        "",
        "| Document | Question | Chunks | Gold chunks | R@1 | R@3 | R@5 | R@8 |",
        "|---|---|---:|---|---:|---:|---:|---:|",
    ]
    for r in results:
        scores = " | ".join(f"{r['recall'][str(k)]:.1%}" for k in KS)
        lines.append(
            f"| {r['document']} | {r['question']} | {r['chunk_count']} | {r['gold_positions']} | {scores} |"
        )
    lines += [
        "",
        "Macro recall: " + ", ".join(f"@{k}={aggregate[str(k)]:.1%}" for k in KS),
        "",
        "Recall denominator is the set of distinct chunks containing the assigned relevant source spans. Duplicate spans in one chunk count once.",
        "Labels were assigned by the coding assistant before retrieval, not independently human-reviewed; relevance labels may be incomplete.",
        "Small synthetic documents; Recall@8 is trivial whenever the document has no more than eight chunks. This does not establish an optimal chunk size or production retrieval quality.",
        "Measures raw semantic retrieval, not answer correctness, pgvector execution, or the app's quote-neighbour augmentation. No answer-generation call was made.",
    ]
    (HERE / f"{stem}.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    progress.log(f"Saved {HERE / stem}.json and .md")
    print(
        json.dumps(
            {
                "macro_recall": aggregate,
                "questions": len(results),
                "embedding_prompt_tokens": usage.prompt_tokens,
            }
        )
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--chunk-tokens", type=int, choices=(200, 400, 800))
    parser.add_argument("--dataset", choices=("sample", "long"), default="sample")
    parser.add_argument(
        "-v", "--verbose", action="store_true", help="Show stages and per-question progress on stderr"
    )
    parser.add_argument(
        "--prepare-pdf", type=Path, help="Import the labelled long PDF into the local dataset"
    )
    parser.add_argument("--dry-run", action="store_true", help="Validate long dataset without calling an API")
    args = parser.parse_args()
    if args.dataset == "long":
        from evals.run_long_retrieval import run

        asyncio.run(run(args.chunk_tokens, args.prepare_pdf, args.dry_run, verbose=args.verbose))
    else:
        if args.prepare_pdf or args.dry_run:
            parser.error("--prepare-pdf and --dry-run require --dataset long")
        asyncio.run(main(args.chunk_tokens, verbose=args.verbose))
