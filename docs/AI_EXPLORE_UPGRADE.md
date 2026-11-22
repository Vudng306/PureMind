# AI Explore upgrade — implementation and verification

Date: 2026-11-22 (Asia/Bangkok). Scope: P0 pipeline improvements and the UI changes necessary to explain its results. This is not final acceptance of all proposed quality targets.

## Audit

Before: query → mandatory web search → rank search-generated notes → render recommendations → independently check Library importability.

- There was no semantic intent gate, so live-weather queries always triggered document discovery.
- Backend already allowed fewer than three results. The chooser's opening instruction and UI copy nevertheless advertised three to five.
- Candidate URLs came from search citations, but the publisher pages were not independently read before ranking.
- Source, authors, year and descriptions were generated from search notes; no server-side metadata reconciliation existed.
- Import checking was an access check after selection, not evidence of source quality or relevance.

After: query → structured semantic intent → guidance for DIRECT_QUERY/AMBIGUOUS, or web search → SSRF-protected source retrieval → evidence filtering/deduplication → rank zero to five → reconcile observed metadata → render access disclosure → existing Library import check → Library/Reader/Notebook.

## Implemented behavior

- DISCOVERY, DIRECT_QUERY and AMBIGUOUS classification using structured model output, validated by Pydantic. Invalid output fails closed.
- Why/how learning questions remain discovery queries. Broad or contextless queries request clarification. Direct queries receive a deterministic product-scope explanation and a Library link rather than a promise to answer live questions.
- Only cited URLs become search candidates; verified publisher canonical links can normalize the same host/path. Existing public-IP, DNS pinning, redirect, response-size and timeout protections remain in force.
- At most twelve candidates, four concurrent fetches. Each candidate contributes at most 4,000 characters to ranking. PDFs contribute at most ten pages and are marked partial; broken font encodings are not usable evidence.
- Inaccessible pages without verifiable identity/content, duplicate destinations, missing titles and empty evidence are excluded.
- Ranking sees fetched evidence instead of the model's search notes. Academic requests prioritize original papers and institutional reports. Quality and relevance take precedence over importability.
- Displayed source/authors/year come from observed metadata, overriding model guesses. Suspicious author fields containing article leads are omitted; missing metadata stays blank.
- Metadata-only/restricted sources cannot receive generated content summaries. Other summaries are limited by instruction to retrieved excerpts; causal claims are explicitly constrained. This is not a formal guarantee of entailment.
- UI distinguishes retrieved text, partial content, metadata, restricted access and unavailable sources. “Retrieved text” explicitly does not promise that every part of a page was read.
- Guidance and empty results consume no daily AI question. The classifier still has provider token cost; existing rate limits apply. Admin costs include the new intent purpose.
- Existing Explore → Library import checks and Reader/Notebook workflows remain. Pre-verification session-cache entries are invalidated.

## Changed files

| Area | Files |
| --- | --- |
| Pipeline | `backend/app/services/discover.py`, `backend/app/services/explore_quality.py` |
| API | `backend/app/api/routes/explore.py` |
| UI/API types/cache | `frontend/src/components/explore-discover.tsx`, `frontend/src/lib/discover.ts` |
| Copy/cost labels | `frontend/src/lib/i18n.ts`, `frontend/src/lib/admin-costs.ts` |
| Automated tests | `backend/tests/test_explore.py`, `backend/tests/test_explore_quality.py` |
| Live evaluation | `backend/evals/run_explore.py`, `backend/evals/explore/cases.json`, result JSON files in that directory |

## Measured evaluation

The labeled set contains 60 queries: 30 Vietnamese and 30 English, balanced across the three intents. Labels were authored for this change, not independently adjudicated or held out.

- Live classifier evaluation: **59/60 = 98.33%**. Mean classifier latency **1.57 seconds**. Reported token use: **18,113 prompt / 2,111 completion**.
- The incorrect case is “Tìm bài tương tự bài lần trước”: expected AMBIGUOUS, predicted DIRECT_QUERY. Both routes stop web discovery, but the clarification experience differs.
- Raw results: `backend/evals/explore/results.json`. These retain the original model guidance, which exposed inappropriate city/team follow-up questions; final application code replaces DIRECT_QUERY guidance deterministically.
- Three live discovery topics were exercised: weather forecasting, procrastination, reading-habits research. Initial outputs are retained in `results-discovery-initial.json`; `results-discovery.json` contains a later run with fetched evidence and per-call usage/cost estimates from the application's configured price table. These are samples, not a 60-query discovery acceptance run.
- That later run returned 4, 3 and 2 documents, respectively. Measured evaluation times were 28.78s, 28.72s and 120.16s; the last included one ranking-call timeout/retry. Estimated costs were $0.058220, $0.060792 and $0.054626. The evaluation performs one extra intent classification for scoring, so these timings/costs slightly exceed the application pipeline. Estimates use the local pricing snapshot, not an invoice; unavailable provider usage on a timed-out call may be missing. Latency remains an open optimization issue.
- No numerical pre-change baseline was collected. The supplied screenshot is qualitative evidence only.

## Verification and remaining acceptance work

Automated tests cover intent routing without search/quota consumption, invalid classifier output, metadata reconciliation, redirects/deduplication, full/partial/metadata/restricted/unavailable retrieval, SSRF protection, academic search constraints, Library copies and import handling. Backend regression: 315 passed, 1 skipped; coverage 93.65% (required 70%). Frontend: 213 passed. Frontend typechecking/linting and Python linting passed.

Still unverified: independently reviewed Precision@5, factual accuracy of every publisher metadata field, zero unsupported claims across the full acceptance sample, real import success rates by website category, and browser-level visual/interaction acceptance. Passing API/unit regression tests does not establish those outcomes.

Coverage labels are extraction heuristics, not proofs of document completeness. The 4,000-character ranking window can miss later material. Metadata extraction supports common HTML citation/Open Graph fields and PDF metadata, not every publisher format. Fully blocked pages without fetched evidence are conservatively omitted; no attempt is made to bypass restrictions. Source trust and claim entailment still depend in part on model judgment.

Run from `backend`:

```powershell
.venv/Scripts/python.exe -m evals.run_explore --live
.venv/Scripts/python.exe -m evals.run_explore --live --discover --start 40 --limit 3
```

Live evaluation uses configured API credentials and incurs provider charges. Discovery result files include evidence excerpts for manual review. The runner does not save documents to Library or mutate user content.
