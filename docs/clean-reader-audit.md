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

## 9. Giai đoạn 3: Reader (16/11/2026)

### 9.1. Đã làm

- **API** (chỉ chủ tài liệu, người khác nhận 404):
  - `GET /api/documents/{id}/aside`: kho phụ, mỗi khối có `id`, kiểu, chữ, trang, ô trên trang, độ chắc chắn và lý do. `classifier` là null khi tài liệu được xử lý trước GĐ2.
  - `POST /api/documents/{id}/extraction-reports`: báo lỗi trích xuất với loại lỗi (thiếu đoạn, sai thứ tự, metadata lẫn vào bài, mất hình/bảng/công thức, lỗi OCR, khối bị ẩn nhầm, khác), trang, khối và mô tả tuỳ chọn. Báo cáo gửi lặp lại chỉ được lưu một lần. Log chỉ ghi loại lỗi, không ghi chữ.
  - Bảng `extraction_reports` (migration `0036`) lưu kèm phiên bản bộ phân loại và kiểu khối lúc báo.
- **Reader**, tab Thông tin:
  - **Thông tin tài liệu**: tác giả, đơn vị, tạp chí/NXB, từ khoá, trang bìa, đúng như PDF in.
  - **Thông tin bổ sung**: lời cảm ơn, tài trợ, xung đột lợi ích, đóng góp, dữ liệu, lời cam đoan, mục lục, phụ lục, tài liệu tham khảo, mỗi phần thu gọn.
  - Mỗi khối có "tr. N": bấm để chuyển sang PDF gốc và tô vị trí của khối.
  - **Nội dung bị ẩn (N)**: danh sách mọi khối đã tách, lọc theo nhóm, kèm loại, trang, độ chắc chắn (lý do khi rê chuột), "Xem trong PDF gốc" và "Báo ẩn nhầm" (TC-19, UC-02).
  - **Báo lỗi trích xuất** (CR-FR-15).
- **Bài đọc**:
  - Dưới tiêu đề: tên tác giả lấy từ kho phụ, kèm liên kết mở Thông tin tài liệu (TC-03).
  - Cuối bài: tài liệu tham khảo, phụ lục, tài trợ… thu gọn, mở được (TC-07). Phần này không thuộc luồng đọc nên không highlight, không tìm kiếm và không vào AI.
- **Test**: `tests/test_clean_reader.py` (quyền truy cập, báo lỗi, chống trùng, dữ liệu sai, tài liệu cũ) và `frontend/src/lib/aside.test.ts`.

### 9.2. Chưa làm

- **"Hiện trong bài đọc"** (CR-FR-19, P1): đưa một khối bị ẩn trở lại luồng đọc theo từng người dùng. Việc này đụng tới `source_map`, anchor của highlight và chunk AI, nên để sau GĐ4. Hiện chỉ có "Báo ẩn nhầm".
- **Trạng thái `REVIEW_REQUIRED` / `READY_WITH_WARNINGS`** theo quality gate (TSD §6): Reader vẫn dùng các cảnh báo có sẵn (trang scan, OCR, bảng/công thức giữ dạng ảnh). Chưa có tín hiệu "ẩn quá nhiều" hay "thứ tự đáng ngờ".
- **Trang quản trị cho báo lỗi**: báo lỗi mới chỉ nằm trong DB.
- **Xử lý lại an toàn** (D9) và AI đọc kho phụ khi được hỏi về tác giả/tài liệu tham khảo: GĐ4.

### 9.3. Thử trên PDF ngoài benchmark (16/11/2026)

Hai PDF do người dùng đưa, chưa có trong `labels.json` (chưa có nhãn nên chưa tính vào số đo):
- `fpsyg-14-1113842.pdf`: Frontiers, 18 trang, 2 cột.
- `125976903.pdf`: Springer/Atlantis, 13 trang.

Lỗi tìm thấy trên bài Frontiers và cách sửa trong `block_roles.py`:
- **Tài liệu tham khảo bị cắt sau 6 khối.** Cột phải trang 15 (đóng góp tác giả, xung đột lợi ích, ghi chú của NXB) nằm giữa hai nửa danh sách, nên phần còn lại (trang 15–18) rơi vào bài đọc.
  - Sửa: khi một phần bổ sung khác đang mở mà gặp khối có dạng mục tham khảo ("Ater, T. (2017).", "[12] …", đoạn URL bị ngắt dòng), thì quay lại phần tài liệu tham khảo.
  - Sau khi sửa: 119 khối, trang 15–18, không còn mục nào trong bài.
- **"Conﬂict of interest" không được nhận ra** vì chữ ghép "ﬂ". Sửa: `_name` chuẩn hoá NFKC và dấu nháy cong.
- **"Ethics statement", "Publisher's note" chưa có kiểu.** Sửa: thêm vào DECLARATION, cùng với informed consent, IRB, generative-AI statement. Nhãn hiển thị đổi thành "Tuyên bố, cam đoan".
- **Cột thông tin bên trái trang 1 bị nhận là tác giả** (OPEN ACCESS, EDITED BY, REVIEWED BY, *CORRESPONDENCE, CITATION, COPYRIGHT).
  - Sửa: các nhãn này thành PUBLISHER_INFO.
  - Tên người biên tập/phản biện ngay dưới nhãn, **cùng cột**, cũng thành PUBLISHER_INFO. Thứ tự đọc có thể chen tên tác giả thật vào giữa, nên phải xét cột.
  - Đoạn ngay dưới CITATION/COPYRIGHT/KEYWORDS thành PUBLISHER_INFO/KEYWORDS.
- **"†These authors have contributed equally…" nằm trong bài.** Sửa: thành AUTHORS.

Reader:
- Dòng tác giả dưới tiêu đề bỏ email, ghi chú và tên lặp, cùng dấu "⁽B⁾" của Springer.
- Các phần bổ sung hiện **khoảng trang** ("tr. 15–18") thay cho số khối, vì một khối có thể chứa cả danh sách hoặc nửa danh sách.

Test và số đo:
- `tests/test_block_roles.py`: 3 test trên khối dựng tay.
- Benchmark không đổi: nội dung chính giữ 100 %, không có gì bị ẩn thêm.

Còn lại, đã có từ trước:
- Tiêu đề lặp lại ở đầu bài đọc dưới dạng heading.
- Tóm tắt của bài Springer mất khoảng trắng ("Gestaltpsychologyisans…"). Đây là lỗi lớp chữ của PDF, nên đưa vào nhãn benchmark.
- Nên gán nhãn hai PDF này vào `evals/clean_reader/labels.json` để các quy tắc mới được đo, không chỉ được thử.

## 10. Giai đoạn 4: Xử lý lại an toàn và AI (16/11/2026)

Phạm vi theo đồ án: không có bảng phiên bản hay job, không có hàng đợi worker. Dùng lại `content_version`, neo prefix/suffix của Reader v2 và cơ chế làm mới cache AI theo `chunks_hash` / `AiArtifact.content_hash`.

### 10.1. Xử lý lại (UC-04)

`POST /api/documents/{id}/reprocess` trả 202 ngay. Việc đọc lại chạy nền:
- Chỉ áp dụng cho tài liệu còn tệp gốc và đã trích xuất xong hoặc lỗi. Không có tệp: 409.
- **Giữ bản đang đọc tới khi bản mới xong.** `extract_file` đọc tệp mà không chạm vào tài liệu. Chỉ khi thành công mới thay `content_clean`, `source_map`, `content_aside`, biểu đồ. Ảnh đặt tên theo hash nội dung nên ảnh mới nằm cạnh ảnh cũ; ảnh không còn dùng được xoá sau cùng. Lỗi: `reprocess_state = failed`, `reprocess_report.error` ghi mã lỗi, văn bản giữ nguyên (TC-14).
- **Bấm hai lần chỉ chạy một lần (TC-20).** Lệnh `UPDATE … WHERE reprocess_state <> 'running' OR reprocess_started_at < now − 15 phút` giữ chỗ nguyên tử. Lần chạy bị cắt ngang bởi khởi động lại sẽ được chạy lại sau 15 phút.
- **Highlight không bao giờ bị xoá (CR-NFR-05).** Mỗi highlight được dò lại trên văn bản mới bằng `services/anchors.py`, cùng quy tắc với `lib/anchor.ts`. Kết quả ghi vào `highlights.anchor_status`:
  - `mapped`: còn nguyên khối; hoặc đoạn trích dài, chỉ có một chỗ; hoặc có một chỗ khớp ngữ cảnh. `content_version` được cập nhật sang bản mới.
  - `ambiguous`: có nhiều chỗ, ngữ cảnh không phân định được.
  - `unresolved`: không tìm thấy. Highlight giữ trích dẫn, ghi chú và phiên bản cũ.
- **Vị trí đọc:** nếu khối đang đọc không còn, `read_position` về null và vị trí cũ được lưu trong báo cáo.
- **Báo cáo:** `reprocess_report = {finished_at, from_version, to_version, anchors: {mapped, ambiguous, unresolved}, read_position?, error?}`. Migration `0037_safe_reprocess`.
- **AI theo bản mới, tự động.** Đoạn chat được dựng lại khi `chunks_hash` khác. Tóm tắt và sơ đồ cũ không khớp `content_hash` nên được tạo lại khi mở. Hình được mô tả lại chỉ khi văn bản đổi.

Reader:
- Tab Thông tin có nút "Xử lý lại tài liệu", kèm hộp xác nhận.
- Hộp "Nội dung bị ẩn" của tài liệu trích xuất trước GĐ2 cũng có nút này.
- Trong khi chạy, trang hỏi lại mỗi 2 giây. Khi xong, mọi dữ liệu dựng từ văn bản cũ được tải lại (side store, source map, biểu đồ, highlight, kết quả AI) và hiện thông báo "Đã xử lý lại: N highlight giữ đúng chỗ, M cần bạn xem lại". Lỗi thì báo bản hiện tại được giữ.

### 10.2. AI chỉ đọc bài, hỏi tác giả thì đọc side store

Mặc định AI chỉ lấy đoạn từ `content_clean` (bài đọc), nên tác giả, header và tài liệu tham khảo không chen vào câu trả lời. Khi câu hỏi nhắc tới các phần ngoài bài, `doc_chat.aside_passages` thêm đoạn tương ứng từ side store, kèm trang để trích dẫn:
- tác giả, đơn vị, tạp chí, từ khoá;
- tài trợ, lời cảm ơn, xung đột lợi ích, đóng góp, dữ liệu, đạo đức;
- tài liệu tham khảo.

Header, footer và số trang không bao giờ được đưa vào.

### 10.3. Kiểm tra

- `tests/test_reprocess.py` (6 test):
  - trạng thái neo và số đếm;
  - lỗi giữ văn bản;
  - bấm hai lần;
  - lần chạy cũ quá hạn;
  - vị trí đọc;
  - thiếu tệp;
  - quy tắc neo.
- `tests/test_clean_reader.py`: AI trả lời "ai viết bài" từ side store, có trích dẫn trang 1, không lẫn header; câu hỏi thường không kèm side store.
- `test_access_sweep.py`: thêm các route mới, gồm reprocess, aside, extraction-reports.
- Toàn bộ: backend 453 test qua (SQLite), vitest 198, tsc và eslint sạch. Benchmark không đổi so với §8.
- Thử trên trình duyệt với tài liệu test 6eef6fa2 (trích xuất trước GĐ2): xử lý lại xong trong khoảng 10 giây, side store được ghi (`rules-1`), 2/2 highlight `mapped`, vị trí đọc giữ nguyên.

Chưa làm:
- Hiện `anchor_status` trên thẻ highlight. Reader vẫn tự dò lại vị trí khi mở, và báo highlight không đặt được (AN-104).
- Test trên PostgreSQL thật (GĐ5).
