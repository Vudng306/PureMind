# Reader v2 (Reading First): tình trạng phát hành

Cập nhật 16/11/2026, sau Giai đoạn 5 và các thay đổi ở mục 8. Đối chiếu với `PureMind_Reader_Upgrade_Requirements_SRS_v2.md` (mục 11–14) và
`PureMind_Reader_Upgrade_TSD_v2.md` (mục 9–14). Bằng chứng dưới đây gồm kiểm thử tự động trên SQLite và PostgreSQL cùng kiểm tra giao diện trên máy phát triển.

- **done**: có bằng chứng tự động và/hoặc đã xem trên màn hình đúng như tiêu chí.
- **partial**: chỉ một phần tiêu chí có bằng chứng, hoặc bằng chứng yếu hơn tiêu chí đòi hỏi.
- **unverified**: chưa có bằng chứng.

## 1. Acceptance tests (SRS §12)

| AT | Tình trạng | Bằng chứng |
|---|---|---|
| AT-01 Mở bài, AI không tự mở | done | Màn hình GĐ1 (1440×900); panel AI chỉ mở khi bấm |
| AT-02 Cỡ chữ giữ sau refresh | done | Màn hình GĐ1; `preferences.test.ts`; `reading_preferences` lưu trên tài khoản |
| AT-03 Focus Mode giữ vị trí | done | Màn hình GĐ1 |
| AT-04 Đọc tiếp đúng chỗ | done | Màn hình GĐ1 (`read_position` theo block, migration 0032); `reading.test.ts` |
| AT-05 Clean ↔ Original | done | Màn hình GĐ1 và GĐ5 (chuyển qua lại trên PDF test) |
| AT-06 Cảnh báo trích xuất thiếu | partial | Biến thể OCR xem trên màn hình; biến thể "thiếu bảng/hình" chỉ có unit test. Tài liệu cũ có `extraction_issues = null` cho tới khi trích xuất lại |
| AT-07 Copy không tạo highlight | done | Màn hình GĐ2 |
| AT-08 Highlight còn sau reload | done | Màn hình GĐ2; `test_highlights.py` (idempotent theo id, giữ prefix/suffix) |
| AT-09 Note → Notebook, không trùng nhóm | done | Màn hình GĐ2; `test_reader_notebook.py` |
| AT-10 Từ Notebook nhảy về đoạn | done | Màn hình GĐ2 (cả trường hợp anchor stale → "cần xem lại"); link `?hl=` trong bản xuất (GĐ4) |
| AT-11 Re-extract đổi đoạn gốc | done | Từ Clean Reader GĐ4: `POST /documents/{id}/reprocess`, `test_reprocess.py` (đoạn đổi khối vẫn `mapped`, đoạn mất `unresolved`, không highlight nào bị xoá); thử đầu-cuối trên màn hình (`docs/clean-reader-release.md`) |
| AT-12 Quick Summary có trích dẫn | done | `test_quick_summary_is_made_once_and_cites_real_passages`; eval: 73/73 ý có nguồn |
| AT-13 Deep Summary cho essay không bịa phương pháp | done | Eval `evals/reader_ai` (essay); 0 số liệu bịa |
| AT-14 Deep Summary cho paper | done | Eval (paper: giữ số mẫu 84/81, kết quả 62%) |
| AT-15 Hỏi câu không có căn cứ | done | `test_a_refusal_cites_nothing`; eval 6/6 từ chối, không trích dẫn |
| AT-16 Lỗi provider | done (tự động) | `test_a_failed_answer_is_not_stored_and_costs_nothing`, `test_failed_or_ungrounded_answers_store_nothing`; retry 1 lần ở `openai_client`. Chưa thử ngắt mạng thật trên màn hình |
| AT-17 Lưu takeaway vào Notes | done | `test_ai_output_reaches_the_notebook_only_when_saved`; màn hình GĐ3 |
| AT-18 Mind Map | done | Màn hình GĐ3/GĐ4 (mở màn hình lớn, node có nguồn); `mindmap.test.ts`; cờ `MIND_MAP` |
| AT-19 Mobile: mở/đóng ngăn AI | done (cơ bản) | GĐ5 ở 375×812: cuộn 900 px → mở/đóng AI → vẫn 900 px, không cuộn ngang. Chưa duyệt kỹ giao diện mobile (ưu tiên desktop) |
| AT-20 A mở dữ liệu của B | done | `test_access_sweep.py`: 32 lần thử trên mọi route tài liệu/highlight/ghi chú/AI/chat đều 403/404, không lộ nội dung, dữ liệu A không đổi; chạy trên SQLite và PostgreSQL |
| AT-21 Tài liệu chỉ có metadata | partial | Màn hình GĐ1 chỉ với phản hồi API giả lập trong trình duyệt; `test_a_document_without_text_cannot_be_chatted_with` |
| AT-22 Bàn phím | done | GĐ5: Tab đi qua 20 điểm theo thứ tự hợp lý, điểm nào cũng có viền focus, vòng lại không kẹt; vùng PDF nhận focus và cuộn bằng PageDown |
| AT-23 Dịch/giải thích đoạn chọn | done | Màn hình GĐ4 (nhãn AI, ghi chú dịch giữ đoạn gốc, văn bản tài liệu không đổi); `test_enhanced_reading.py`; eval 2/2 |
| AT-24 Khôi phục khi PDF đổi version | partial | `anchor.test.ts`; xử lý lại cùng tệp (Clean Reader GĐ4) giữ quote và ghi `anchor_status` trên server. Chưa có cách thay bằng một tệp PDF khác |

## 2. NFR (SRS §11, TSD §9.1)

| NFR | Tình trạng | Kết quả đo / bằng chứng |
|---|---|---|
| NFR-101 Reader tương tác p95 < 3 s | partial | Server (PostgreSQL, trong tiến trình): mở tài liệu p95 12,8 ms. Trình duyệt: LCP 2,0–4,7 s (PDF), 2,0–3,0 s (bài web), đo ở **chế độ dev** trong khung trình duyệt chậm; chưa đo bản production |
| NFR-102 Đổi cài đặt tức thời | done | Màn hình GĐ1/GĐ4 (không reload) |
| NFR-103 Lưu highlight/note p95 < 1,5 s | done (server) | `test_reader_timing.py`, 60 lần, PostgreSQL: lưu highlight p95 31,7 ms, lưu note 26,0 ms, lưu vị trí đọc 21,8 ms. Chưa tính mạng thật |
| NFR-104 Khôi phục vị trí > 95% | partial | Unit test anchor; chưa có bộ 100+ vị trí gán nhãn |
| NFR-105 WCAG 2.2 AA | partial | axe-core 4.13 (wcag2a/2aa/21a/21aa/22aa): 0 lỗi trên 9 trạng thái (trình đọc web/PDF/bản gốc, AI tóm tắt/mind map/hỏi đáp, ghi chú, thư viện, notebook) sau khi sửa 3 lỗi. Chưa thử trình đọc màn hình, zoom 400%, giao diện tối |
| NFR-106 Không truy cập chéo | done | `test_access_sweep.py` + các test 404 theo route |
| NFR-107 Lỗi AI không chặn Reader | done (tự động) | Xem AT-16 |
| NFR-108 Partial luôn cảnh báo; AI đúng version | partial | Cảnh báo kèm kết quả AI (GĐ3); `content_hash` + `prompt_revision` → "phiên bản AI cũ hơn" (`test_stale_*`). Xem AT-06 |
| NFR-109 SSRF/XSS | done | `test_epub_web.py`: chặn 127.0.0.1, 169.254.169.254, IPv6-mapped, redirect nội bộ, `javascript:`, `<script>`. Prompt nào cũng coi nội dung tài liệu là dữ liệu, không phải lệnh |

## 3. Definition of Done (SRS §14)

| Mục | Tình trạng |
|---|---|
| Nghiệm thu desktop và mobile | desktop done; mobile partial (chỉ AT-19 và không cuộn ngang ở 375 px) |
| Source fidelity: article, essay, PDF báo cáo, VI/EN | partial: eval có essay VI, paper EN, tài liệu thiếu trang; chưa có PDF thật có bảng/hình |
| Highlight/note không mất | done (AT-08/09/10) |
| AI chỉ nói trong phạm vi chứng cứ | done (eval + test) |
| Bằng chứng tự động + thủ công cho AT và NFR | partial (xem bảng 1–2) |
| Migration trên PostgreSQL thật | done: DB trống → 0034, downgrade về 0031 rồi lên lại; toàn bộ test chạy trên PostgreSQL 16 + pgvector; job CI `backend-postgres` |
| Không đổi Feed/Publishing | done: `FEED`, `COMMUNITY`, `CATALOG`, `SYNTHESIS` vẫn `false`; không sửa file Feed/Post; design token không đổi |
| Bảng done/partial/unverified có bằng chứng | done (tài liệu này) |

## 4. Kết quả kiểm thử GĐ5

- Backend: 443 test đạt trên **cả SQLite và PostgreSQL** (lần chạy cuối 15/11/2026), 3 bỏ qua (2 test catalog vì catalog đã cố ý làm trống, 1 test đo thời gian chỉ chạy khi có `READER_TIMING`), coverage 87,5%. Ruff check và format sạch.
- Frontend: 197 test vitest đạt, `tsc` và `eslint` sạch, `next build` thành công.
- `alembic check`: không lệch bảng/cột/ràng buộc; chỉ báo các index full-text riêng PostgreSQL (tạo bằng migration, cố ý không khai báo trong models) và một index `DESC`, đều có từ trước v2.
- Một test Explore chat (ngoài phạm vi Reader) phụ thuộc thứ tự khi hai bài có độ tương đồng bằng nhau; đã sửa test, không phải lỗi ứng dụng.

## 5. Sửa trong GĐ5

- `reader-panel.tsx`: nút "Đóng bảng" không còn nằm trong `role="tablist"` (WCAG 4.1.2).
- `reader/[id]/page.tsx`: link "Mở bản gốc ↗" có gạch chân, không chỉ khác màu (WCAG 1.4.1).
- `pdf-viewer.tsx`: vùng trang PDF nhận focus (`role="region"`, `tabIndex=0`), cuộn được bằng bàn phím (WCAG 2.1.1).
- `ai-summary-panel.tsx` (cuối GĐ4): lỗi từ chối 422 không còn nút "Thử lại".
- `tests/conftest.py`: `TEST_DATABASE_URL` chạy bộ test trên PostgreSQL với schema từ migration; từ chối database không có đuôi `_test`.

## 6. Cờ tính năng và rollback

Cờ trong `frontend/src/lib/features.ts` (đổi xong cần build lại frontend):

| Cờ | Bật | Tắt thì |
|---|---|---|
| `SELECTION_TRANSLATE` | có | Bỏ nút "Dịch" trong menu chọn chữ |
| `SELECTION_EXPLAIN` | có | Bỏ nút "Giải thích" |
| `MIND_MAP` | có | Bỏ tab Mind Map |
| `RESEARCH_ANALYSIS` | có | Bỏ chế độ "Nghiên cứu" |

Migration Reader v2 (đều thêm, không xoá dữ liệu khi nâng):

| Migration | Nội dung | Downgrade |
|---|---|---|
| 0032 | `documents.read_position`, `documents.extraction_issues` | Bỏ hai cột (mất vị trí đọc theo block; `read_fraction` vẫn còn) |
| 0033 | `highlights.prefix/suffix/content_version` | Bỏ ba cột (highlight vẫn còn, mất ngữ cảnh neo) |
| 0034 | `ai_artifacts.kind` thêm `analysis` | **Xoá các bản phân tích nghiên cứu** rồi khôi phục ràng buộc cũ |

Thứ tự rollback: (1) tắt cờ và deploy lại frontend; (2) nếu cần, revert mã; (3) chỉ khi bắt buộc mới `alembic downgrade 0031`, sau khi đã backup (`pg_dump`) vì bước 0034 xoá dữ liệu phân tích.

## 7. Vấn đề còn mở (không chặn phát hành của đồ án)

1. NFR-101 chưa đo trên bản production; số liệu trình duyệt hiện là chế độ dev.
2. AT-06/AT-21/AT-11/AT-24 thiếu thử đầu-cuối: chưa có route trích xuất lại chung, chưa có PDF thật có bảng/hình trong bộ mẫu.
3. Phân tích nghiên cứu chưa chạy thật trong app trên một bài nghiên cứu (đã có eval 3/3 và test).
4. Highlight chưa lưu được chỉ giữ trong bộ nhớ (mất khi tải lại trang).
5. Nhận diện tiếng Việt theo tỉ lệ chữ có dấu: câu tiếng Anh ngắn có tên riêng tiếng Việt có thể bị dịch sang tiếng Anh.
6. A11y: chưa thử trình đọc màn hình, zoom 400%, giao diện tối. Mobile chỉ kiểm tra cơ bản.
7. Theo phạm vi đồ án, đã thống nhất bỏ: bảng `document_versions`, Trash/GDPR purge, telemetry, signed URL, TTS. Quyết định bỏ bottom sheet mobile được thay thế ngày 18/11/2026 theo kế hoạch responsive; xem `mobile-responsive.md`.

## 8. Thay đổi sau GĐ5

| Commit | Thay đổi | Ghi chú |
|---|---|---|
| `136dfad` | Bỏ chức năng thêm tài liệu bằng DOI: tab "Nhập DOI" trong hộp thêm tài liệu, route `POST /documents/import-doi` | Theo yêu cầu thay đổi "Loại bỏ DOI Search". Link `https://doi.org/…` vẫn lưu được qua "Lưu link" như mọi trang khác. Không có migration; DOI trong `documents.citation` được giữ |
| `285232c` | Bỏ ô DOI và nút "Điền từ DOI" trong hộp Thông tin trích dẫn, route `GET /documents/doi-lookup` | DOI đã lưu vẫn còn sau khi sửa trích dẫn (`test_a_citation_keeps_the_doi_it_was_saved_with`). BibTeX không còn trường `doi`; link của tài liệu (kể cả link doi.org) nằm ở trường `url` |
| `6833ec2` | Bảng AI theo mockup; "Hỏi AI" đổi thành **Trợ lý đọc** | Thanh ba phần Tóm tắt / Mind Map / Trợ lý đọc; thẻ trống có tiêu đề, mô tả, công tắc Tiếng Việt / English, nút tạo rộng hết thẻ; số lượt AI còn lại dưới thẻ. Bỏ lựa chọn ngôn ngữ "Theo tài liệu": mặc định là ngôn ngữ giao diện. Tên mới cũng dùng cho nhãn nguồn của ghi chú và bản xuất Notebook |

Kiểm thử sau các thay đổi này: backend 437 đạt, 3 bỏ qua trên cả SQLite và PostgreSQL (ít hơn mục 4 vì các test nhập/tra cứu DOI đã bỏ); frontend 195 đạt, 1 bỏ qua; `tsc` và `eslint` sạch. Bảng AI đã xem trên màn hình với PDF test: cả ba phần, chuyển English, tiêu đề trống của Trợ lý đọc.
