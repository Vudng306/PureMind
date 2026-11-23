# Long-document retrieval environment

Uses the actual PureMind PDF extractor and chunker on the supplied 13-page English PDF, with 12 fixed Vietnamese questions and evidence anchors. Creates 64 / 38 / 30 chunks at targets 200 / 400 / 800; every configuration must have at least 20 chunks. This avoids Recall@8 trivially returning the entire document.

All commands below run from `backend/`. The setup is isolated from the running application's database, users, uploads, and chunk configuration. `backend/.env` supplies the embedding model and key for live runs only.

## Prepare and validate locally (no API, no charge)

```powershell
.\.venv\Scripts\python.exe -X utf8 -m evals.run_retrieval --dataset long --prepare-pdf "C:/Users/aceto/Downloads/125976903.pdf" --dry-run
```

The PDF is copied into `evals/long_retrieval/pdfs/`, excluded from Git. SHA-256 must match `dataset.json`; a different PDF requires its own source labels and manifest. Before any API call, the runner checks minimum chunk count and verifies each evidence anchor is present in every chunk configuration.

## Compare three sizes with real embeddings

```powershell
.\.venv\Scripts\python.exe -X utf8 -m evals.run_retrieval --dataset long
```

This sends extracted PDF text and questions to the configured embedding API and incurs token charges. It does not call an answer-generation model. Previously granted consent must cover the document/destination before an agent executes it.

Run one size:

```powershell
.\.venv\Scripts\python.exe -X utf8 -m evals.run_retrieval --dataset long --chunk-tokens 400
```

The original `python -m evals.run_retrieval` still runs the small three-document sample dataset.

## Outputs

- `results/comparison/validation.json`: source hash, chunk counts and offline label validation; no retrieval scores are generated in dry-run mode.
- `results/comparison/results.md` and `results.json`: live Recall@1/3/5/8, MRR, all rankings, model, timestamp, embedding tokens and total embedding time.
- `results/200/`, `results/400/`, `results/800/`: separate outputs for single-size runs.
- Each output folder includes extracted `clean.md` for inspection. Outputs and PDFs are Git-ignored; reports may be copied to a chosen destination for sharing.

Also reports recall under the same 1,600-token **estimated** context budget: take the ranking prefix, stop before adding a chunk that would exceed the budget. Includes headings; does not truncate or skip a passage. Uses PureMind's character-based estimator, not an exact tokenizer. This complements fixed-k comparisons where larger chunks can consume more context.

## Limits

Evidence anchors were assigned by the assistant before retrieval, not independently human-reviewed, and are not exhaustive relevant-passage judgments. Recall is against distinct chunks containing these anchors; segmentation can change the denominator. MRR refers to the first such chunk. Sources split across a chunk boundary cause validation to fail rather than silently shrinking the gold set.

This measures one-document, cross-language semantic retrieval via the Python cosine fallback, without OCR, pgvector, concurrency, quote-neighbour injection or answer correctness. It does not establish a globally optimal chunk size. Do not choose parameters on these 12 questions and then present the same set as independent validation; add independently labelled documents and held-out questions for that.
