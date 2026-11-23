# Running evaluations and watching progress

Run these commands from `backend/` in PowerShell. Every evaluation runner supports `-v` / `--verbose`. Progress is flushed immediately to **stderr**, with elapsed seconds, stage starts/ends and per-case results. Final summaries remain on stdout; the scoring criteria do not change. Steps are local instrumentation, not an AI model's private reasoning.

```powershell
# Existing small sample: live embeddings
.\.venv\Scripts\python.exe -X utf8 -m evals.run_retrieval --verbose

# Long PDF: compare 200 / 400 / 800 with live embeddings
.\.venv\Scripts\python.exe -X utf8 -m evals.run_retrieval --dataset long --verbose

# Offline validation only: no API calls
.\.venv\Scripts\python.exe -X utf8 -m evals.run_retrieval --dataset long --dry-run --verbose

# Custom invocation with the previously labelled PDF
.\.venv\Scripts\python.exe -X utf8 -m evals.run_pdf_retrieval "C:/Users/aceto/Downloads/125976903.pdf" --output "../backups/retrieval-125976903" --verbose

# PDF extraction benchmark: no AI
.\.venv\Scripts\python.exe -X utf8 -m evals.run_clean_reader --verbose

# Reader summaries and answers: live model calls
.\.venv\Scripts\python.exe -X utf8 -m evals.run_reader_ai --verbose

# One Reader document only
.\.venv\Scripts\python.exe -X utf8 -m evals.run_reader_ai paper --verbose

# Explore: live intent classification, at most 3 cases
.\.venv\Scripts\python.exe -X utf8 -m evals.run_explore --live --limit 3 --verbose
```

Live AI/embedding runs send inputs to the configured provider, incur charges and overwrite their result files. Clean Reader requires the PDF files specified by its labels; missing PDFs are reported as skipped. `run_long_retrieval` is an internal dataset helper: invoke it through `run_retrieval --dataset long`.

To save terminal progress alongside output:

```powershell
.\.venv\Scripts\python.exe -X utf8 -m evals.run_retrieval --dataset long --verbose 2>&1 | Tee-Object -FilePath ../backups/retrieval-progress.log
```

For pytest tests instead of evaluation scripts:

```powershell
.\.venv\Scripts\python.exe -m pytest --no-cov tests/test_highlights.py -vv -s
# Include fixture setup/teardown:
.\.venv\Scripts\python.exe -m pytest --no-cov tests/test_highlights.py -vv -s --setup-show
```

Pytest `-vv` lists individual test cases; `-s` displays prints already present in the tests. Neither flag prints every Python line. Some tests intentionally mock AI or external transport. These differ from the live evaluations above.
