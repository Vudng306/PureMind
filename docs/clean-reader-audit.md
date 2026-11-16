# Clean Reader: audit pipeline trích xuất hiện tại (Giai đoạn 1)

Cập nhật 16/11/2026. Đối chiếu với `PureMind_Clean_Reader_Upgrade_SRS_v1.md` (PM-CR-SRS-001) và `PureMind_Clean_Reader_Upgrade_TSD_v1.md` (PM-CR-TSD-001). Đây là bước P0-A của SRS §10: vẽ lại pipeline, lập benchmark, đo lỗi hiện tại. Chưa đổi gì ở parser production.

Số liệu ở §4 lấy từ `backend/evals/clean_reader/results/baseline.md`. Bộ benchmark mới có 8 PDF (SRS cần 20). Nhãn do Claude soạn và **chưa có người kiểm**, nên các con số chỉ là mốc để so trước/sau, chưa phải kết quả nghiệm thu.

## 1. Pipeline hiện tại

### 1.1 Từ lúc tải lên tới `content_clean`

`run_extraction` ([documents.py:131](../backend/app/api/routes/documents.py#L131)):

1. Đặt `extraction_status = processing`, xoá `extraction_issues`, rồi commit.
2. **Xoá thư mục ảnh của tài liệu trước khi trích xuất** (dòng 146).
3. Gọi `extract_pdf` trong threadpool.
4. Nếu lỗi: trạng thái thành `failed`, kèm MSG-13 / MSG-14 / MSG-15 hoặc MSG-99, và thư mục ảnh lại bị xoá. `content_clean` cũ không bị ghi đè, nhưng tài liệu đã ở trạng thái `failed`.
5. Nếu thành công:
   - Trang scan: chỉ OCR khi người dùng đã đồng ý dùng AI (`ai_consent`). Nếu chưa đồng ý, trang đó được ghi vào `extraction_issues.scanned_pages`.
   - Nếu không còn chữ nào thì trạng thái là `failed` với MSG-15.
   - Bảng và công thức cũng chỉ được OCR khi có `ai_consent`.
   - Cuối cùng **ghi đè tại chỗ** `content_clean`, `source_map`, `chart_data`, `page_count`, `word_count`; `figure_notes` bị đặt về `None`.

`retry-extraction` ([documents.py:578](../backend/app/api/routes/documents.py#L578)) chỉ dùng được khi tài liệu `failed` với MSG-99. Hiện chưa có route xử lý lại cho tài liệu đã `done`.

### 1.2 `extract_pdf`

`extract_pdf` nằm ở [extraction.py:1267](../backend/app/services/extraction.py#L1267) và dùng PyMuPDF:

1. Đánh dấu trang scan (`needs_ocr`: có dưới 20 ký tự, hoặc ảnh phủ từ 50% trang). Trang scan được thay bằng dấu `<!--pm-ocr:N-->`.
2. Lấy cỡ chữ thân bài: trung vị cỡ chữ, tính theo từng ký tự.
3. `_page_items` xử lý từng trang:
   - tạo đoạn văn, heading (theo cỡ chữ, `NUMBERED_HEADING`, `NAMED_HEADINGS`), list, bảng có kẻ, hình vector, ảnh, công thức (ảnh 300 dpi) và chú thích;
   - **xoá** dòng bản quyền ở lề (`BOILERPLATE`);
   - **xoá** footnote liên hệ (`CONTACT`) và câu "Correspondence to: … <email>" (`CONTACT_SENTENCE`).
4. `_drop_running_text` ([:1087](../backend/app/services/extraction.py#L1087)) **xoá**:
   - dòng ở 10% trên hoặc dưới trang lặp lại trên từ 3 trang (chữ số bị che khi so);
   - số trang dạng chữ số Ả Rập.
5. `_reading_order` ([:1042](../backend/app/services/extraction.py#L1042)): khối trải qua giữa trang cắt trang thành các dải; trong mỗi dải, cột trái được đọc trước cột phải.
6. `_carried_over` nối đoạn văn bị ngắt sang trang sau.
7. Ghép các trang bằng `---`. Mỗi khối có `source_map` (khoá khối → các ô trên trang PDF). Tiêu đề lấy từ metadata của PDF, không có thì lấy tên tệp.

Khi nối dòng, `_markdown_runs` ([:328](../backend/app/services/extraction.py#L328)) **giữ dấu gạch nối** ở cuối dòng: "water-" + "saturated" thành "water-saturated". Đây là chủ ý cho từ ghép, nhưng làm hỏng mọi từ bị ngắt chỉ vì xuống dòng (xem lỗi D4).

### 1.3 Phía sau `content_clean`

- **Reader:** hiển thị `content_clean` dạng Markdown. Mỗi khối có id từ `reader_keys`, và `source_map` nối khối đó về trang PDF gốc.
- **Highlight:** lưu `block_id` và offset, cùng `prefix`, `suffix` và `content_version` (hash của `content_clean`). Phía client (`anchor.ts`) dùng các trường này để tìm lại đoạn sau khi trích xuất lại, hoặc báo "cần xem lại".
- **AI và chat:** chia `content_clean` thành chunk ([chat.py:129](../backend/app/api/routes/chat.py#L129)) và đánh index lại khi `chunks_hash` đổi. AI đọc **toàn bộ** `content_clean`, gồm cả tác giả, tài liệu tham khảo và lời cảm ơn.
- **Citation:** lưu riêng trong `documents.citation`, không phụ thuộc vào văn bản trích xuất.

## 2. Đối chiếu yêu cầu

- **có**: đã đáp ứng.
- **một phần**: đáp ứng một phần, xem cột ghi chú.
- **chưa**: chưa đáp ứng.

### 2.1 Yêu cầu chức năng (SRS §5)

| Mã | Tình trạng | Ghi chú |
|---|---|---|
| CR-FR-01 PDF gốc bất biến, phiên bản bản trích xuất | một phần | PDF gốc không bị sửa. Bản trích xuất bị ghi đè tại chỗ, không có phiên bản; ảnh bị xoá trước khi trích xuất lại |
| CR-FR-02 Phát hiện scan, OCR fallback | một phần | Phát hiện trang scan và OCR khi có `ai_consent`. Nếu không có `ai_consent`, PDF scan toàn bộ bị `failed` MSG-15 |
| CR-FR-03 Tách text/hình/bảng/công thức có provenance | có | `source_map`, ảnh hình, bảng, công thức |
| CR-FR-04 Thứ tự đọc 1 và 2 cột | có | 34/34 cặp đúng trên benchmark (§4) |
| CR-FR-05 Phân loại theo ontology, có confidence | chưa | Không có kiểu khối, không có confidence hay lý do |
| CR-FR-06 Header, footer, số trang | một phần | Có phát hiện, nhưng **xoá** thay vì ẩn. Số trang La Mã, header chỉ xuất hiện một lần và thanh điều hướng web vẫn lọt vào luồng đọc |
| CR-FR-07 Giữ Introduction, Methods… | có | Giữ 80/81 nhãn chính. Nhãn bị trượt là do lỗi gạch nối, không phải do bị xoá |
| CR-FR-08 Tách tác giả, đơn vị, thông tin NXB, lời cam đoan | chưa | 23/29 nhãn metadata nằm trong luồng đọc; 6 nhãn còn lại bị xoá |
| CR-FR-09 References thu gọn được, không xoá | một phần | Không bị xoá nhưng nằm trong luồng đọc như thân bài |
| CR-FR-10 Render heading, đoạn, list, bảng, chú thích theo thứ tự | có | Lỗi nhỏ: "1. Introduction" bị viết thành "1 Introduction" |
| CR-FR-11 Cảnh báo mất hình/bảng/công thức, text coverage thấp | một phần | Có `extraction_issues`: `scanned_pages`, `ocr_pages`, `tables_as_images`, `equations_as_images`. Chưa đo text coverage |
| CR-FR-12 Chuyển Clean ↔ Original, mở theo anchor | có | Reader v2 |
| CR-FR-13 Xem phần ẩn, Document Info, Additional Info | chưa | |
| CR-FR-14 Khối không chắc chắn không bị xoá | chưa | Các quy tắc ở §1.2 xoá luôn, không có mức chắc chắn |
| CR-FR-15 Báo lỗi trích xuất, retry hoặc reprocess | một phần | Chỉ retry cho MSG-99. Chưa có nút báo lỗi, chưa xử lý lại được tài liệu `done` |
| CR-FR-16 Giữ highlight, note, tiến độ khi xử lý lại | một phần | Có `prefix`/`suffix`/`content_version` và trạng thái "cần xem lại" ở client. Chưa có luồng xử lý lại để kiểm từ đầu đến cuối |
| CR-FR-17 AI dùng đúng phiên bản, dẫn nguồn | một phần | Đúng phiên bản nhờ `chunks_hash`. Nhưng AI đọc cả metadata và references (R5) |
| CR-FR-18 Không xoá metadata cần cho citation | có | `citation` lưu riêng |
| CR-FR-19…21 (P1) | chưa | Ngoài phạm vi đề xuất |
| CR-FR-22 Đo, xuất báo cáo chất lượng theo parser | một phần | Bộ chạy benchmark ở §3 |

### 2.2 Ca kiểm thử (SRS §9)

| TC | Tình trạng | Ghi chú |
|---|---|---|
| 01 Hai cột | đạt | |
| 02 Header lặp | một phần | Đã ẩn khỏi Clean View nhưng không còn trong source |
| 03 Tác giả, đơn vị | không đạt | |
| 04 Introduction | đạt | |
| 05 Abstract | một phần | Còn trong luồng đọc, chưa hiện riêng |
| 06 Lời cảm ơn, tài trợ | không đạt | |
| 07 References | không đạt | |
| 08 Hình hoặc bảng không đọc được | một phần | |
| 09 Scan không OCR được | một phần | Có lỗi MSG-15 rõ ràng. Chưa kiểm PDF gốc có còn mở được không khi tài liệu `failed` |
| 10 Khối mơ hồ | không đạt | Bị xoá âm thầm |
| 11 Ngắt dòng | không đạt | Lỗi D4 |
| 12 Highlight mở đúng chỗ | đạt | Từ Reader v2 |
| 13, 14, 20 Reprocess | không đạt | |
| 15 Highlight không map được | một phần | |
| 16 Truy cập chéo | đạt | Từ các test hiện có |
| 17 Summary | một phần | |
| 18 Clean ↔ Original | đạt | |
| 19 Hiện nội dung ẩn | không đạt | |

## 3. Benchmark

### 3.1 Cách chạy

```bash
cd backend
.venv/Scripts/python -X utf8 -m evals.run_clean_reader --dump
```

- Mã chạy benchmark: [`backend/evals/run_clean_reader.py`](../backend/evals/run_clean_reader.py).
- Nhãn: [`backend/evals/clean_reader/labels.json`](../backend/evals/clean_reader/labels.json).
- Kết quả: `backend/evals/clean_reader/results/<adapter>.md` và `.json`.
- PDF nằm ở `backend/evals/clean_reader/pdfs/`, không đưa vào git. Mỗi tệp được kiểm bằng 10 ký tự đầu của SHA-256.
- `--dump` ghi luồng đọc của từng PDF ra `pdfs/_flows/`, cũng không vào git.
- Không cần database hay OpenAI. Vì vậy trang scan không được OCR, đúng như với người dùng chưa đồng ý dùng AI.
- Muốn so một bộ trích xuất mới, thêm hàm của nó vào `ADAPTERS` rồi chạy với `--adapter NAME`. Báo cáo sẽ có thêm cột Baseline để so.

### 3.2 Nhãn

Mỗi nhãn là một đoạn ngắn chép từ lớp chữ của PDF, kèm kiểu khối theo TSD §4.2. Các kiểu được gộp thành năm nhóm:

- **MAIN**: tiêu đề, abstract, heading, thân bài, list, chú thích…
- **METADATA**: tác giả, đơn vị, từ khoá, thông tin nhà xuất bản, tiểu sử.
- **SUPPLEMENTARY**: references, lời cảm ơn, tài trợ, COI, CRediT, data availability, lời cam đoan, mục lục, phụ lục.
- **FURNITURE**: header, footer, số trang, watermark, thanh điều hướng web, ký tự trang trí.
- **FIGURE_TEXT**: chữ vẽ trong hình.

Ngoài nhãn còn có:

- **Cặp thứ tự `[a, b]`**: a phải đứng trước b. Cặp `[a, b, "next"]` chặt hơn: b phải nối ngay sau a.
- **Kỳ vọng `expect`**: các trang phải được đánh dấu là scan.

So khớp chạy trên văn bản đã chuẩn hoá (NFKC, chữ thường, bỏ dấu Markdown, bỏ gạch mềm, bỏ dấu chấm sau số mục). Cách so này chỉ là cận dưới: tìm thấy nhãn nghĩa là các từ có mặt ở đúng chỗ, chưa nói được khối chứa nó đúng.

### 3.3 Bộ PDF hiện có

| Tài liệu | Nhóm | Ngôn ngữ | Nhãn | Cặp thứ tự |
|---|---|---|---|---|
| paper-volume-change (E3S 2019) | hai cột | en | 24 | 6 |
| paper-soil-water (E3S 2023, kèm trang bìa White Rose) | hai cột | en | 27 | 5 |
| paper-arxiv-ai (arXiv 2602.23643) | hai cột | en | 26 | 7 |
| paper-elsevier-separation (Sep. Purif. Technol. 2026) | nhiều hình/bảng | en | 31 | 6 |
| report-vi-quy-dinh (báo cáo đồ án, xuất từ Word) | báo cáo một cột | vi | 26 | 4 |
| book-sommerville (trang sản phẩm in từ trình duyệt) | layout bất thường | en | 15 | 3 |
| synthetic-reader-test (PDF test của Reader v2, trang 3 là scan) | layout bất thường | en | 5 | 3 |
| scan-paper-volume-change (paper-volume-change chuyển hết thành ảnh) | scan | en | — | — |

So với SRS §9, bộ PDF còn thiếu **12 PDF**:

| Nhóm | Hiện có | SRS cần |
|---|---|---|
| Paper hai cột | 3 | 5 |
| Nhiều hình/bảng/công thức | 1 | 5 |
| Báo cáo/essay một cột | 1 | 5 |
| Scan hoặc layout bất thường | 3 | 5 |

Hiện chỉ có 1 tài liệu tiếng Việt. Người dùng sẽ tự cung cấp thêm PDF.

## 4. Kết quả baseline (16/11/2026)

| Chỉ số | Kết quả | Mục tiêu |
|---|---|---|
| Nội dung chính còn trong luồng đọc | 98,8 % (80/81) | ≥ 99 % (CR-NFR-01) |
| Header, footer, số trang ra khỏi luồng | 78,3 % (18/23) | ≥ 90 % (CR-NFR-02) |
| Chữ trong hình ra khỏi luồng | 100 % (3/3) | |
| Metadata ra khỏi luồng | 20,7 % (6/29) | |
| Phần phụ ra khỏi luồng | 0 % (0/18) | |
| Nhãn không phải nội dung chính vẫn còn giữ (trong luồng hoặc kho phụ) | 65,7 % (46/70) | 100 % (R1) |
| Cặp thứ tự đúng | 100 % (34/34) | ≥ 95 % (CR-NFR-03) |
| Từ bị ngắt cuối dòng được nối lại | **0 % (0/162)** | 100 % (TC-11) |
| Trang scan được đánh dấu | 2/2 | |

Thời gian xử lý mỗi tài liệu từ 0,13 đến 9,2 giây trên máy phát triển. Báo cáo tiếng Việt chậm nhất.

Hai con số "ra khỏi luồng" có nghĩa khác nhau:

- Header và footer ra khỏi luồng (78 %) là vì **bị xoá**. Đó là lý do chỉ số "còn giữ" chỉ đạt 65,7 %.
- Metadata ra khỏi luồng (6/29) cũng là vì bị xoá: các dòng email và "Corresponding author".

Thứ tự đọc đạt 100 % vì các cặp hiện có khá dễ. Cần thêm cặp `"next"` ở chỗ chuyển cột và chuyển trang để phép đo chặt hơn.

## 5. Lỗi tìm thấy

| # | Lỗi | Ví dụ | Liên quan |
|---|---|---|---|
| D1 | Metadata đầu bài nằm trong luồng đọc | Tên tác giả thành heading `###`. Có cả đơn vị, "Contents lists available at ScienceDirect", "journal homepage", "Received…", "Editor name", Keywords, "Preprint. March 2, 2026", trang bìa White Rose, "by Ian Sommerville" | CR-FR-08, TC-03 |
| D2 | Phần phụ nằm trong luồng đọc như thân bài | References, CRediT, COI, Funding, Data availability. Báo cáo tiếng Việt còn có lời cam đoan, lời cảm ơn, mục lục có dấu chấm dẫn và phụ lục | CR-FR-09, TC-06/07 |
| D3 | Xoá thay vì ẩn | Header và footer lặp, số trang, dòng ©/giấy phép, footnote "Corresponding author: …@…", câu "Correspondence to: … <email>". 24/70 nhãn không phải nội dung chính bị mất hẳn | R1, CR-FR-14, TC-02/10 |
| D4 | Từ bị ngắt cuối dòng không được nối lại | arXiv: 89/89 từ, như "defi-nition", "in-telligence", "spe-cialized", "hu-man", "De-cember". Elsevier: 73/73 từ, như "acti-vated", "addi-tional", "avail-able", với gạch mềm U+00AD còn kẹt giữa từ (58 dòng). Cụm "agree on its exact definition" của abstract arXiv vì thế không tìm thấy | R2, TC-11 |
| D5 | Lọt "đồ đạc" trang | Số trang La Mã "ii" và "v" (`PAGE_NUMBER` chỉ nhận chữ số). "-------------o0o-------------" bị biến thành heading. Header tạp chí chỉ có ở trang 1 Elsevier. Thanh điều hướng web ("Comment on this title…", "All Product Details") | CR-FR-06, CR-NFR-02 |
| D6 | Phần đầu báo cáo tiếng Việt | Bìa xuất hiện hai lần (bìa ngoài và bìa trong). Các dòng bìa thành heading ("TRƯỜNG ĐẠI HỌC XÂY DỰNG KHOA CÔNG NGHỆ THÔNG TIN", "DƯƠNG VĂN VŨ"). 228 khối (bìa, cam đoan, cảm ơn, mục lục, các danh mục) đứng trước heading "MỞ ĐẦU" | CR-FR-08 |
| D7 | Heading đánh số bị sửa | "1. Introduction" thành "1 Introduction", "3.1. A Survey…" thành "3.1 A Survey…" | R2 (nhẹ) |
| D8 | PDF scan khi chưa đồng ý dùng AI | Cả tài liệu thành `failed` MSG-15 | CR-FR-02, TC-09 |
| D9 | Trích xuất lại không an toàn | Thư mục ảnh bị xoá trước khi chạy. Lỗi giữa chừng làm tài liệu thành `failed` dù bản cũ vẫn còn | CR-FR-01/15, TC-13/14 |
| D10 | AI đọc cả metadata và references | Hệ quả của D1 và D2: `content_clean` là nguồn duy nhất cho chunk | R5, CR-FR-17 |

## 6. Hạn chế của bộ đo

- **Nhãn chưa có người kiểm.** Đã sửa 4 nhãn sai sau khi đọc luồng đọc thực tế:
  - nhãn trường của báo cáo tiếng Việt trùng với câu trong lời cam đoan;
  - header chạy của báo cáo tiếng Việt trùng với tên đề tài được trích dẫn;
  - một cặp thứ tự khớp nhầm vào abstract;
  - các heading có dấu chấm sau số mục.

  Có thể vẫn còn nhãn sai.
- **Chỉ có 8 PDF**, phần lớn tiếng Anh, chỉ một PDF thật sự nhiều hình/bảng. Chưa nên dùng các con số để kết luận theo nhóm.
- **So khớp bằng chữ.** Một đoạn bị trộn với khối khác vẫn được tính là "còn". Chỉ số từ bị ngắt chỉ đếm những từ mà chính PDF có in nguyên ở chỗ khác, nên là cận dưới.
- **Chưa có thước đo** cho CR-NFR-04 (provenance) và độ đúng của kiểu khối. Kiểu khối sẽ đo được khi có kho phụ: chỉ số "Side-store blocks filed under the right group".

## 7. Đề xuất cho Giai đoạn 2

1. **Lớp phân loại trên PyMuPDF.**
   - Các bước đang xoá ở §1.2 (bước 3 và 4) chuyển sang **gán kiểu + confidence + lý do**.
   - Thân bài vẫn ở `content_clean`, để highlight, `source_map`, AI và Reader không phải đổi.
   - Các khối còn lại vào một cột JSON mới, gồm kiểu, chữ, trang, ô trên trang, confidence và lý do. Không xoá khối nào.
   - Khối không chắc chắn được giữ ở thân bài (R3).
2. **Quy tắc theo thứ tự ưu tiên** (từ D1–D6):
   - Vùng trước Abstract hoặc heading đầu tiên ở trang 1: tác giả (có dấu chỉ đơn vị hoặc email), đơn vị, dòng tạp chí/NXB, "A R T I C L E I N F O", Received, Editor, Keywords.
   - Phần cuối bài, nhận theo tên heading (cả tiếng Anh và tiếng Việt): References/Tài liệu tham khảo, Acknowledgements/Lời cảm ơn, Funding, CRediT, Declaration of competing interest, Data availability, Appendix/Phụ lục.
   - Phần đầu báo cáo tiếng Việt, trước "MỞ ĐẦU" hoặc "Chương 1": bìa, LỜI CAM ĐOAN, LỜI CẢM ƠN, MỤC LỤC (dòng có dấu chấm dẫn và số trang), các danh mục.
   - Trang bìa của kho lưu trữ (White Rose…) và thanh điều hướng web.
   - Header, footer, số trang: giữ cách phát hiện hiện có, chuyển vào kho phụ thay vì xoá. Thêm số La Mã. Thêm header chỉ có ở một trang nhưng giống header các trang khác sau khi che chữ số.
3. **Nối từ bị ngắt dòng** (D4).
   - Luôn bỏ U+00AD.
   - Với dấu "-" ở cuối dòng: nối thành một từ nếu dạng liền đã có ở chỗ khác trong tài liệu hoặc có trong từ điển nhỏ; không thì giữ dấu gạch.
   - Ghi lại các chỗ đã nối để kiểm chứng được (R2).
4. **Giữ heading đúng như PDF** (D7).
5. **Đo lại**: thêm adapter mới vào `ADAPTERS` và so với baseline. Mục tiêu đề xuất trên bộ đo này:

   | Chỉ số | Mục tiêu |
   |---|---|
   | Nội dung chính còn trong luồng | ≥ 99 % |
   | Header, footer, số trang ra khỏi luồng | ≥ 90 % |
   | Metadata ra khỏi luồng | ≥ 80 % |
   | Phần phụ ra khỏi luồng | ≥ 90 % |
   | Nhãn không phải nội dung chính còn giữ | 100 % |
   | Từ bị ngắt được nối lại | ≥ 95 % |
   | Cặp thứ tự đúng | Không giảm |

D8 và D9 thuộc Giai đoạn 4 (xử lý lại an toàn). D10 thuộc Giai đoạn 4, khi AI chỉ đọc thân bài.

## 8. Kết quả Giai đoạn 2 (16/11/2026)

### 8.1. Đã làm

- **Lớp phân loại** `backend/app/services/block_roles.py` (`rules-1`), chạy sau `_reading_order`:
  - Mỗi khối có thể nhận **kiểu + confidence + lý do**.
  - Khối có confidence ≥ 0,8 ra khỏi luồng đọc. Khối dưới ngưỡng ở lại thân bài (R3).
  - Phần đầu bài báo (D1): tiêu đề, tác giả, đơn vị, dòng tạp chí/NXB, Keywords, ghi chú chân trang 1, trang bìa kho lưu trữ.
  - Phần đầu báo cáo tiếng Việt (D6): bìa, lời cam đoan, lời cảm ơn, mục lục, các danh mục, trước "MỞ ĐẦU"/"Chương 1".
  - Phần phụ (D2): References, Acknowledgements, Funding, COI, CRediT, Data availability, Appendix, cả tiếng Anh và tiếng Việt. Câu cảm ơn không có heading đứng ngay trước References cũng được nhận.
  - Dòng trang trí ("-----o0o-----").
- **Không xoá nữa** (D3). `extraction.py` đánh dấu header, footer, số trang (thêm số La Mã, D5), dòng giấy phép, chữ xoay ở lề (arXiv) và câu liên hệ, thay vì bỏ đi.
- **Kho phụ**: `ExtractionResult.aside` = `{"classifier", "blocks": [{type, text, page, box, confidence, reason}]}` theo thứ tự tài liệu.
  - Lưu ở cột mới `documents.content_aside` (JSONB, tải khi cần), migration `0035`.
  - `content_clean`, `source_map`, highlight, chunk và AI không phải đổi.
- **Nối từ bị ngắt dòng** (D4), hàm `_rejoin`. Chỗ khác với đề xuất §7:
  - Dấu "-" cuối dòng chỉ được nối khi dạng liền có in ở chỗ khác trong chính tài liệu. Không dùng từ điển.
  - U+00AD không phải lúc nào cũng bỏ. PDF in từ trình duyệt (Chrome) dùng nó cho mọi dấu gạch nhìn thấy được: nếu tài liệu có U+00AD giữa dòng, nó được coi là dấu "-".
  - Chưa ghi lại danh sách các chỗ đã nối.
- **Heading giữ dấu chấm** (D7): "1. Introduction" vẫn là "1. Introduction".
- **Tiêu đề**: khi metadata PDF không có tiêu đề hoặc là tên tệp ("….docx", "Microsoft Word - …"), dùng tiêu đề tìm được ở trang 1. Chỉ tìm khi trang 1 có abstract hoặc heading mục đầu tiên, để heading chương không thành tiêu đề.

### 8.2. Số đo (adapter `current`, so với baseline)

| Chỉ số | Baseline | GĐ2 | Mục tiêu |
|---|---|---|---|
| Nội dung chính còn trong luồng | 98,8 % | **100 %** (81/81) | ≥ 99 % |
| Header, footer, số trang ra khỏi luồng | 78,3 % | **91,3 %** (21/23) | ≥ 90 % |
| Metadata ra khỏi luồng | 20,7 % | **93,1 %** (27/29) | ≥ 80 % |
| Phần phụ ra khỏi luồng | 0 % | **100 %** (18/18) | ≥ 90 % |
| Nhãn không phải nội dung chính còn giữ | 65,7 % | **100 %** (70/70) | 100 % |
| Cặp thứ tự đúng | 100 % | 100 % (34/34) | ≥ 95 % |
| Khối kho phụ đúng nhóm | — | 100 % (66/66) | |
| Từ bị ngắt cuối dòng được nối lại | 0 % | **99,4 %** (161/162) | 100 % |

Còn sót:

- "there-fore" (arXiv) không được nối vì tài liệu không in "therefore" ở chỗ khác.
- Sommerville: "by Ian Sommerville", tiểu sử tác giả và 2 dòng thanh điều hướng web vẫn ở luồng đọc. Chưa có quy tắc cho trang web in ra PDF.

### 8.3. Lưu ý quan trọng

- **Các quy tắc được chỉnh trên chính 8 PDF này**, với nhãn do Claude soạn. Con số trên là kết quả trên tập "đã thấy", không phải độ chính xác thật. Các PDF người dùng đưa thêm sẽ là tập kiểm tra thật: cần chấm chúng **trước** khi sửa quy tắc theo chúng.
- Tài liệu đã tải lên trước GĐ2 có `content_aside` rỗng và vẫn mang luồng đọc cũ cho tới khi được trích xuất lại. Trích xuất lại an toàn (D9) thuộc GĐ4.
- API và Reader chưa đọc `content_aside`. Hiển thị (Thông tin tài liệu, Thông tin bổ sung, References thu gọn, danh sách khối ẩn) thuộc GĐ3.
- D10 đã đỡ phần lớn: chunk cho AI lấy từ `content_clean`, nay chỉ còn thân bài. Nhưng vì thế AI không còn thấy tác giả và References: câu hỏi "ai viết bài này?" cần đọc thêm kho phụ (GĐ4).
- D8 (scan khi chưa đồng ý AI) và D9 chưa làm.
