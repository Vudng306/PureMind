# Reader v2 — AI evaluation results

Run 2026-11-15 03:23 UTC · summaries `gpt-4.1-mini` · answers `gpt-4.1` · prompt revision 2 · 24 AI requests · 25139 prompt + 4878 completion tokens · 65 s

Produced by `evals/run_reader_ai.py` from `evals/reader_ai/cases.json`; every output is in `results.json`. The checks are mechanical (see the script's docstring), so they are a floor. The number check was re-scored on the same outputs after it learned Vietnamese number words ("mười phút" = 10 minutes).

## Summaries

| Document | Result | Points | With a source | Supported (≥40% words) | Numbers not in the document | Type / disclosure |
|---|---|---|---|---|---|---|
| paper | quick | 6 | 6 | 6/6 | none | — |
| paper | deep | 4 | 4 | 4/4 | none | type `research` ok |
| paper | mindmap | 15 | 15 | 12/15 | none | — |
| paper | analysis | 13 | 13 | 13/13 | none | data has 84/eighty-four/81 ok, findings has 62 ok, limitations has single college/one teacher/four weeks ok; type `research` ok |
| essay | quick | 6 | 6 | 6/6 | none | — |
| essay | deep | 7 | 7 | 7/7 | none | type `essay` ok |
| essay | analysis | — | — | — | — | refused: type `other` ok |
| partial | quick | 6 | 6 | 5/6 | none | — |
| partial | deep | 10 | 10 | 10/10 | none | gap named by the AI: no (shown, not scored) |
| partial | analysis | 6 | 6 | 6/6 | none | findings has 212,000/212000 ok, method left empty ok, limitations left empty ok; type `report` ok |

## Questions

| Document | Question | Expected | Result | Detail |
|---|---|---|---|---|
| paper | How many adults took part in the study? | answer | pass | fact found, cites its passage |
| paper | What share of the target words did the spaced retrieval group recall after four weeks? | answer | pass | fact found, cites its passage |
| paper | What are the study's limitations? | answer | pass | fact found, cites its passage |
| paper | Who funded this study? | abstain | pass | refused, no citation |
| paper | Did the learners improve their speaking skills? | abstain | pass | refused, no citation |
| paper | Explain this passage. | answer | pass | fact found, cites its passage |
| essay | Bài viết đề xuất những thói quen nào? | answer | pass | fact found, cites its passage |
| essay | Vì sao theo tác giả đọc nhanh không giúp ta nhớ? | answer | pass | fact found, cites its passage |
| essay | Bài viết đã khảo sát bao nhiêu người? | abstain | pass | refused, no citation |
| essay | Tác giả của bài viết sinh năm nào? | abstain | pass | refused, no citation |
| essay | Giải thích đoạn này. | answer | pass | fact found, cites its passage |
| partial | How many visits did the library have in 2025? | answer | pass | fact found, cites its passage |
| partial | What was the library's total budget in 2025? | abstain | pass | refused, no citation (model cited before the guard); gap named |
| partial | How many staff did the library employ? | abstain | pass | refused, no citation; gap named |

## Totals

- Answerable questions answered with the fact and its passage: 8/8
- Unanswerable questions refused without a citation: 6/6 (model cited before the guard: 1)
- Summary points with a source: 73/73; of those supported by the cited passage's words: 69/73
- Numbers written that the document does not contain: 0
- Research analysis right for the document type (made with the expected fields, or refused): 3/3
- Selections explained from a passage that holds them: 2/2
- Missing page named by the AI's own text (shown, not scored): summaries 0/1, answers 2/2
