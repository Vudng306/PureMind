# Clean Reader benchmark — baseline

Run 2026-11-16 08:25 UTC with `python -m evals.run_clean_reader --adapter baseline`. Labels: `evals/clean_reader/labels.json` (drafted by Claude from the PDFs' text layer; a person has not checked them yet). What the scores mean: the docstring of `evals/run_clean_reader.py`.

| Measure | Result | Target |
|---|---|---|
| Main content kept in the flow | 98.8 % (80/81) | ≥ 99 % CR-NFR-01 |
| Headers, footers, page numbers out of the flow | 78.3 % (18/23) | ≥ 90 % CR-NFR-02 |
| Text inside figures out of the flow | 100.0 % (3/3) |   |
| Metadata out of the flow | 20.7 % (6/29) |   |
| Supplementary parts out of the flow | 0.0 % (0/18) |   |
| Non-main labels still held (flow or side store) | 65.7 % (46/70) | 100 % R1 |
| Reading order pairs right | 100.0 % (34/34) | ≥ 95 % CR-NFR-03 |
| Side-store blocks filed under the right group | — |   |
| Other checks (scanned pages flagged) | 100.0 % (2/2) |   |
| Words broken at a line end shown whole | 0.0 % (0/162) | 100 % TC-11 |

Order pairs with an end not found in the flow: 0.

## Per document

| Document | Group | Lang | Seconds | Flow blocks | Main kept | Noise out | Order | Error |
|---|---|---|---|---|---|---|---|---|
| paper-volume-change | two_column | en | 1.83 | 62 | 100.0 % (15/15) | 55.6 % (5/9) | 100.0 % (6/6) |  |
| paper-soil-water | two_column | en | 4.45 | 87 | 100.0 % (13/13) | 36.4 % (4/11) | 100.0 % (5/5) |  |
| paper-elsevier-separation | media_heavy | en | 4.1 | 254 | 100.0 % (14/14) | 23.5 % (4/17) | 100.0 % (6/6) |  |
| paper-arxiv-ai | two_column | en | 1.94 | 204 | 93.8 % (15/16) | 50.0 % (5/10) | 100.0 % (7/7) |  |
| book-sommerville | unusual_layout | en | 0.49 | 177 | 100.0 % (8/8) | 42.9 % (3/7) | 100.0 % (3/3) |  |
| report-vi-quy-dinh | one_column_report | vi | 7.29 | 782 | 100.0 % (10/10) | 18.8 % (3/16) | 100.0 % (4/4) |  |
| synthetic-reader-test | unusual_layout | en | 0.06 | 35 | 100.0 % (5/5) | — | 100.0 % (3/3) |  |
| scan-paper-volume-change | scan | en | 0.01 | 0 | — | — | — | MSG-15 |

## Misses

Every label in the wrong place and every order pair not right, by document.

### paper-volume-change

- AUTHORS (metadata): “Misa Hiraga” — in the flow ×1
- AFFILIATIONS (metadata): “The University of Tokyo, Department of Civil Engineering” — in the flow ×1
- REFERENCES (supplementary): “C.D. Curtis, J. Geol. Soc. 147, 351 (1990)” — in the flow ×1
- REFERENCES (supplementary): “H. Komine, Y. Kazuya, S. Murakami” — in the flow ×1

### paper-soil-water

- PUBLISHER_INFO (metadata): “White Rose Research Online URL for this paper” — in the flow ×1
- PUBLISHER_INFO (metadata): “If you consider content in White Rose Research Online to be in breach of UK law” — in the flow ×1
- PUBLISHER_INFO (metadata): “Murison, R.A., Jacobsz, S.W.” — in the flow ×1
- AUTHORS (metadata): “Ruan A. Murison” — in the flow ×1
- AFFILIATIONS (metadata): “University of Pretoria, Department of Civil Engineering, Lynnwood Rd” — in the flow ×1
- FUNDING (supplementary): “The authors would like to express their gratitude to the UK EPSRC Global Challenges Fund” — in the flow ×1
- REFERENCES (supplementary): “T.A.V. Gaspar. Centrifuge modelling of piled foundations” — in the flow ×1

### paper-elsevier-separation

- AUTHORS (metadata): “Ilias-Maximilian Kropik” — in the flow ×2
- AFFILIATIONS (metadata): “Institute of Chemical, Environmental & Bioscience Engineering” — in the flow ×1
- PUBLISHER_INFO (metadata): “Contents lists available at ScienceDirect” — in the flow ×1
- PUBLISHER_INFO (metadata): “journal homepage: www.elsevier.com/locate/seppur” — in the flow ×1
- PUBLISHER_INFO (metadata): “Received 29 July 2025; Received in revised form” — in the flow ×1
- PUBLISHER_INFO (metadata): “Editor name: S Shouliang Yi” — in the flow ×1
- KEYWORDS (metadata): “Keywords: Biochar KOH activation” — in the flow ×1
- AUTHOR_CONTRIBUTIONS (supplementary): “CRediT authorship contribution statement” — in the flow ×1
- CONFLICT_OF_INTEREST (supplementary): “The authors declare that they have no known competing financial interests” — in the flow ×1
- FUNDING (supplementary): “This research was funded by the Austrian Science Fund (FWF)” — in the flow ×1
- DATA_AVAILABILITY (supplementary): “Data will be made available on request.” — in the flow ×1
- REFERENCES (supplementary): “A.N. Shafawi, A.R. Mohamed, P. Lahijani” — in the flow ×1
- REFERENCES (supplementary): “M. Karimi, M. Shirzad” — in the flow ×1
- words left split (73 of 73): Addi-tionally, BEL-MASTER, Com-mercial, Ger-many, Har-asek, Supple-mentary, acti-vated, acti-vation, activa-tion, addi-tional, at-mosphere, avail-able and 61 more

### paper-arxiv-ai

- AUTHORS (metadata): “Philippe Wyder” — in the flow ×1
- AFFILIATIONS (metadata): “Columbia University, New York, NY, USA” — in the flow ×1
- PUBLISHER_INFO (metadata): “Preprint. March 2, 2026.” — in the flow ×1
- ABSTRACT (main): “they often don't seem to agree on its exact definition” — missing from the flow
- REFERENCES (supplementary): “Chollet, F. On the measure of intelligence” — in the flow ×1
- REFERENCES (supplementary): “Legg, S. and Hutter, M. Universal intelligence” — in the flow ×1
- words left split (89 of 89): Ac-cessed, Al-though, As-sel, Com-puter, De-cember, Ecol-ogy, Free-man, Fu-tuyma, Ge-nie, Gen-eral, Has-sabis, Interna-tional and 77 more

### book-sommerville

- AUTHORS (metadata): “by Ian Sommerville” — in the flow ×1
- WEB_CHROME (furniture): “Comment on this title and you could win free books!” — in the flow ×1
- WEB_CHROME (furniture): “All Product Details” — in the flow ×1
- BIOGRAPHY (metadata): “Ian Sommerville is Professor of Software Engineering at Lancaster University” — in the flow ×1

### report-vi-quy-dinh

- PUBLISHER_INFO (metadata): “TRƯỜNG ĐẠI HỌC XÂY DỰNG KHOA CÔNG NGHỆ THÔNG TIN” — in the flow ×1
- PUBLISHER_INFO (metadata): “NGÀNH: CÔNG NGHỆ THÔNG TIN” — in the flow ×2
- DECORATION (furniture): “o0o” — in the flow ×2
- AUTHORS (metadata): “DƯƠNG VĂN VŨ” — in the flow ×3
- AUTHORS (metadata): “ThS. Đào Thị Ngọc Hân” — in the flow ×1
- DECLARATION (supplementary): “Em cam đoan đồ án tốt nghiệp” — in the flow ×1
- ACKNOWLEDGEMENTS (supplementary): “Em xin chân thành cảm ơn ThS. Đào Thị Ngọc Hân” — in the flow ×1
- TABLE_OF_CONTENTS (supplementary): “Lưu tệp song song với dữ liệu quan hệ ....” — in the flow ×1
- TABLE_OF_CONTENTS (supplementary): “Thiết kế truy xuất cho hỏi đáp....” — in the flow ×1
- PAGE_NUMBER (furniture): “ii” — in the flow ×1
- PAGE_NUMBER (furniture): “v” — in the flow ×1
- REFERENCES (supplementary): “RFC Editor. [Online]. Available: https://www.rfc-editor.org/rfc/rfc7519” — in the flow ×1
- APPENDIX (supplementary): “Lệnh tái lập kiểm thử” — in the flow ×2

