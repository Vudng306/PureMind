# Retrieval pilot

Model: text-embedding-3-small; chunk target: 800; questions: 8.

| Document | Question | Chunks | Gold chunks | R@1 | R@3 | R@5 | R@8 |
|---|---|---:|---|---:|---:|---:|---:|
| paper | How many adults took part in the study? | 8 | [1, 3] | 50.0% | 100.0% | 100.0% | 100.0% |
| paper | What share of the target words did the spaced retrieval group recall after four weeks? | 8 | [1, 6] | 50.0% | 100.0% | 100.0% | 100.0% |
| paper | What are the study's limitations? | 8 | [7] | 100.0% | 100.0% | 100.0% | 100.0% |
| paper | Explain this passage. | 8 | [5] | 0.0% | 0.0% | 100.0% | 100.0% |
| essay | Bài viết đề xuất những thói quen nào? | 5 | [3] | 100.0% | 100.0% | 100.0% | 100.0% |
| essay | Vì sao theo tác giả đọc nhanh không giúp ta nhớ? | 5 | [2] | 100.0% | 100.0% | 100.0% | 100.0% |
| essay | Giải thích đoạn này. | 5 | [2] | 100.0% | 100.0% | 100.0% | 100.0% |
| partial | How many visits did the library have in 2025? | 4 | [2] | 100.0% | 100.0% | 100.0% | 100.0% |

Macro recall: @1=75.0%, @3=87.5%, @5=100.0%, @8=100.0%

Recall denominator is the set of distinct chunks containing the assigned relevant source spans. Duplicate spans in one chunk count once.
Labels were assigned by the coding assistant before retrieval, not independently human-reviewed; relevance labels may be incomplete.
Small synthetic documents; Recall@8 is trivial whenever the document has no more than eight chunks. This does not establish an optimal chunk size or production retrieval quality.
Measures raw semantic retrieval, not answer correctness, pgvector execution, or the app's quote-neighbour augmentation. No answer-generation call was made.
