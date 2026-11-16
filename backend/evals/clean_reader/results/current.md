# Clean Reader benchmark — current

Run 2026-11-16 14:42 UTC with `python -m evals.run_clean_reader --adapter current`. Labels: `evals/clean_reader/labels.json` (drafted by Claude from the PDFs' text layer; a person has not checked them yet). What the scores mean: the docstring of `evals/run_clean_reader.py`.

| Measure | Baseline | Result | Target |
|---|---|---|---|
| Main content kept in the flow | 98.8 % (80/81) | 100.0 % (81/81) | ≥ 99 % CR-NFR-01 |
| Headers, footers, page numbers out of the flow | 78.3 % (18/23) | 91.3 % (21/23) | ≥ 90 % CR-NFR-02 |
| Text inside figures out of the flow | 100.0 % (3/3) | 100.0 % (3/3) |   |
| Metadata out of the flow | 20.7 % (6/29) | 93.1 % (27/29) |   |
| Supplementary parts out of the flow | 0.0 % (0/18) | 100.0 % (18/18) |   |
| Non-main labels still held (flow or side store) | 65.7 % (46/70) | 100.0 % (70/70) | 100 % R1 |
| Reading order pairs right | 100.0 % (34/34) | 100.0 % (34/34) | ≥ 95 % CR-NFR-03 |
| Side-store blocks filed under the right group | — | 100.0 % (66/66) |   |
| Other checks (scanned pages flagged) | 100.0 % (2/2) | 100.0 % (2/2) |   |
| Words broken at a line end shown whole | 0.0 % (0/162) | 99.4 % (161/162) | 100 % TC-11 |

Order pairs with an end not found in the flow: 0.

## Per document

| Document | Group | Lang | Seconds | Flow blocks | Main kept | Noise out | Order | Error |
|---|---|---|---|---|---|---|---|---|
| paper-volume-change | two_column | en | 1.66 | 57 | 100.0 % (15/15) | 100.0 % (9/9) | 100.0 % (6/6) |  |
| paper-soil-water | two_column | en | 3.77 | 71 | 100.0 % (13/13) | 100.0 % (11/11) | 100.0 % (5/5) |  |
| paper-elsevier-separation | media_heavy | en | 3.37 | 171 | 100.0 % (14/14) | 100.0 % (17/17) | 100.0 % (6/6) |  |
| paper-arxiv-ai | two_column | en | 1.43 | 103 | 100.0 % (16/16) | 100.0 % (10/10) | 100.0 % (7/7) |  |
| book-sommerville | unusual_layout | en | 0.37 | 177 | 100.0 % (8/8) | 42.9 % (3/7) | 100.0 % (3/3) |  |
| report-vi-quy-dinh | one_column_report | vi | 5.18 | 492 | 100.0 % (10/10) | 100.0 % (16/16) | 100.0 % (4/4) |  |
| synthetic-reader-test | unusual_layout | en | 0.04 | 35 | 100.0 % (5/5) | — | 100.0 % (3/3) |  |
| scan-paper-volume-change | scan | en | 0.01 | 0 | — | — | — | MSG-15 |

## Misses

Every label in the wrong place and every order pair not right, by document.

### paper-arxiv-ai

- words left split (1 of 89): there-fore

### book-sommerville

- AUTHORS (metadata): “by Ian Sommerville” — in the flow ×1
- WEB_CHROME (furniture): “Comment on this title and you could win free books!” — in the flow ×1
- WEB_CHROME (furniture): “All Product Details” — in the flow ×1
- BIOGRAPHY (metadata): “Ian Sommerville is Professor of Software Engineering at Lancaster University” — in the flow ×1

