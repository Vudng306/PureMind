# Clean Reader: tình trạng phát hành

Cập nhật 16/11/2026, sau Giai đoạn 5. Đối chiếu với `PureMind_Clean_Reader_Upgrade_SRS_v1.md` (PM-CR-SRS-001, mục 5, 8, 9, 10) và `PureMind_Clean_Reader_Upgrade_TSD_v1.md`. Quá trình làm và lỗi tìm thấy ở từng giai đoạn: `docs/clean-reader-audit.md`.

Phạm vi theo đồ án (đã thống nhất từ GĐ1):
- Bộ phân loại theo quy tắc chạy trên PyMuPDF. Không làm PoC Docling/GROBID.
- Không có bảng phiên bản/job, không có hàng đợi worker, không có sandbox, không có QA dashboard.

Trạng thái:
- **done**: có bằng chứng tự động và/hoặc đã xem trên màn hình đúng như tiêu chí.
- **partial**: chỉ một phần tiêu chí có bằng chứng, hoặc làm theo cách đơn giản hơn tiêu chí.
- **not done**: chưa làm.

## 1. Kết quả chính

| | Trước (5987a7a) | Sau |
|---|---|---|
| Nội dung chính còn trong luồng đọc | 98,8 % | **100 %** (81/81) |
| Header, footer, số trang ra khỏi luồng | 78,3 % (bằng cách xoá) | **91,3 %** (21/23), không xoá |
| Metadata ra khỏi luồng | 20,7 % | **93,1 %** (27/29) |
| Phần phụ (references, funding…) ra khỏi luồng | 0 % | **100 %** (18/18) |
| Khối không phải nội dung chính còn được giữ | 65,7 % | **100 %** (70/70) |
| Từ bị ngắt cuối dòng được nối lại | 0 % | **99,4 %** (161/162) |
| Highlight sau khi trích xuất lại | Thư mục ảnh bị xoá trước, lỗi giữa chừng làm hỏng tài liệu | Giữ bản cũ tới khi bản mới xong; mọi highlight còn và có trạng thái neo |
| AI | Đọc cả tác giả, header, references | Chỉ đọc bài. Hỏi về tác giả/tài trợ/references thì đọc thêm phần đã tách, có trích trang |

Bộ đo: 8 PDF, nhãn do Claude soạn, chưa có người kiểm (xem §5).

## 2. Bộ test nghiệm thu (SRS §9)

| TC | Kịch bản | Tình trạng | Bằng chứng |
|---|---|---|---|
| 01 | Paper hai cột | done | Benchmark: 3 PDF hai cột, thứ tự 18/18 cặp đúng. Toàn bộ 34/34 cặp |
| 02 | Header lặp | done | Benchmark: 91,3 % ra khỏi luồng, 100 % vẫn còn trong kho phụ. Màn hình GĐ3: "Nội dung bị ẩn" liệt kê header kèm trang |
| 03 | Tác giả/đơn vị đầu bài | done | Benchmark: metadata 93,1 % ra khỏi luồng, đúng nhóm 100 %. Màn hình GĐ3: Thông tin tài liệu, tên tác giả dưới tiêu đề |
| 04 | Introduction | done | Benchmark: nội dung chính còn 100 % (81/81) |
| 05 | Abstract | partial | Abstract giữ nguyên văn trong bài, kèm heading "Abstract" của PDF. Chưa được tách thành khung riêng (SRS §6.2) |
| 06 | Lời cảm ơn/Tài trợ | done | Benchmark: phần phụ 100 %. Màn hình GĐ3: Thông tin bổ sung |
| 07 | References | done | Thu gọn ở cuối bài và trong Thông tin bổ sung, mở được, giữ nguyên văn. Trên bài Frontiers: 119 khối, trang 15–18 (§9.3 audit) |
| 08 | Hình/bảng không đọc được | done | Cảnh báo `extraction_issues` (bảng, công thức giữ dạng ảnh; trang scan, OCR) kèm "Xem bản gốc" (Reader v2 AT-06); `reading.test.ts` |
| 09 | PDF scan không OCR được | done | `test_documents.py`: `failed`, MSG-15. Tài liệu PDF lỗi vẫn mở được bản gốc (`library.ts`, `discover.test.ts`). Benchmark: scan-paper → MSG-15 |
| 10 | Khối mơ hồ | done | Ngưỡng tự ẩn 0,8: khối dưới ngưỡng ở lại bài. Benchmark: không nhãn nào bị mất (70/70) |
| 11 | Từ/câu ngắt dòng | partial | 161/162. "there-fore" (arXiv) chưa nối vì tài liệu không in "therefore" ở chỗ khác |
| 12 | Bấm highlight/citation | done | Benchmark mới: 73/73 đoạn thân bài mở đúng trang và vùng trên PDF (§4). Khối không có vị trí: Reader báo "không có nguồn" |
| 13 | Xử lý lại thành công | partial | `test_reprocess.py`: văn bản mới, `content_version` mới, báo cáo `from_version`/`to_version`. Không lưu bản cũ thành một phiên bản đọc được (không có bảng version, theo phạm vi). Highlight vẫn ghi phiên bản nó được tạo |
| 14 | Xử lý lại lỗi | done | `test_failed_reprocess_keeps_the_text_in_use`: văn bản và trạng thái giữ nguyên, lỗi ghi vào báo cáo |
| 15 | Highlight không khớp | done | `test_reprocess_checks_every_highlight_and_keeps_them`: 4/4 highlight còn, trạng thái mapped/ambiguous/unresolved, ghi chú không đổi |
| 16 | Hai người dùng | done | `test_access_sweep.py` (gồm aside, extraction-reports, reprocess), `test_side_store_is_the_owners_only`. Chạy trên SQLite và PostgreSQL |
| 17 | Quick/Deep Summary | done | AI lấy chunk từ `content_clean` (chỉ thân bài). Panel tóm tắt báo thiếu bảng/hình theo `extraction_issues`. Trích dẫn: Reader v2 AT-12 |
| 18 | Clean ↔ Original | done | Reader v2 AT-05 (`read_position` theo khối) |
| 19 | Hiện nội dung ẩn | done | Màn hình GĐ3: danh sách khối, lọc theo nhóm, loại, trang, độ chắc chắn, lý do, "Xem trong PDF gốc" |
| 20 | Xử lý lại với request lặp | done | `test_reprocess_asked_twice_runs_once` và `test_reprocess_asked_at_once_runs_once` (5 request cùng lúc → 1 lần đọc; trên PostgreSQL, test này fail nếu bỏ điều kiện giữ chỗ) |

## 3. Yêu cầu phi chức năng (SRS §8)

| ID | Tình trạng | Bằng chứng |
|---|---|---|
| CR-NFR-01 Ẩn nhầm ≤ 1 % | done (trên bộ đo) | 0/81 nhãn nội dung chính bị ẩn |
| CR-NFR-02 Header/footer ẩn ≥ 90 % | done (trên bộ đo) | 91,3 % (21/23). Hai chỗ sót đều ở Sommerville (trang web in ra PDF) |
| CR-NFR-03 Thứ tự ≥ 95 % | done (trên bộ đo) | 100 % (34/34) |
| CR-NFR-04 Provenance ≥ 95 % | done (trên bộ đo) | 100 % (73/73, 3 nhãn PDF search không tìm được nên không tính). Thước đo mới ở GĐ5, chưa có số "trước" |
| CR-NFR-05 Không mất highlight/note | done | `test_reprocess.py`. Thử trên trình duyệt: tài liệu 6eef6fa2, 2/2 highlight `mapped` |
| CR-NFR-06 Không truy cập chéo | done | `test_access_sweep.py` trên SQLite và PostgreSQL |
| CR-NFR-07 Thời gian p50/p95 | done | §4. Chưa đo trên PDF scan có OCR (cần AI) |
| CR-NFR-08 Idempotency | done | TC-20; báo lỗi trích xuất gửi lặp chỉ lưu một lần (`test_report_extraction_error`) |
| CR-NFR-09 Bàn phím, tương phản | partial | Nút và hộp thoại mới dùng `<button>`/`<dialog>` có nhãn, như phần Reader v2 đã kiểm (AT-22). Chưa kiểm riêng các phần mới bằng bàn phím |
| CR-NFR-10 Giới hạn đầu vào, cô lập | partial | Giới hạn 50 MB. Chưa giới hạn số trang, thời gian trích xuất, chưa chạy trong vùng cô lập |

## 4. Benchmark trước/sau

Chạy: `cd backend && .venv/Scripts/python -X utf8 -m evals.run_clean_reader`. Kết quả đầy đủ (mọi chỗ sót): `backend/evals/clean_reader/results/current.md`. "Trước" là `results/baseline.json`, đã chạy và giữ nguyên từ commit 5987a7a.

| Chỉ số | Trước | Sau | Mục tiêu |
|---|---|---|---|
| Nội dung chính còn trong luồng | 98,8 % (80/81) | 100 % (81/81) | ≥ 99 % |
| Header, footer, số trang ra khỏi luồng | 78,3 % (18/23) | 91,3 % (21/23) | ≥ 90 % |
| Chữ trong hình ra khỏi luồng | 100 % (3/3) | 100 % (3/3) | |
| Metadata ra khỏi luồng | 20,7 % (6/29) | 93,1 % (27/29) | |
| Phần phụ ra khỏi luồng | 0 % (0/18) | 100 % (18/18) | |
| Nhãn không phải nội dung chính còn giữ | 65,7 % (46/70) | 100 % (70/70) | 100 % |
| Cặp thứ tự đúng | 100 % (34/34) | 100 % (34/34) | ≥ 95 % |
| Khối kho phụ đúng nhóm | — | 100 % (66/66) | |
| Trang scan được đánh dấu | 100 % (2/2) | 100 % (2/2) | |
| Từ ngắt dòng được nối lại | 0 % (0/162) | 99,4 % (161/162) | 100 % |
| Đoạn thân bài mở đúng chỗ trên PDF | — | 100 % (73/73) | ≥ 95 % |

Thước đo provenance (thêm ở GĐ5):
- Với mỗi nhãn thân bài có trong luồng đọc, so ô mà Reader mở cho khối đó với chỗ PyMuPDF `search_for` tìm thấy các chữ ấy trên PDF. Không cần gán nhãn trang.
- Kiểm tra lại thước đo: khi dịch ô của mỗi khối sang khối kế tiếp, bài soil-water chỉ còn 1/13 đúng.

Thời gian trích xuất (không OCR, không AI), máy phát triển:

| Nhóm | Số PDF | p50 (s) | p95 (s) |
|---|---|---|---|
| Hai cột | 3 | 1,77 | 3,90 |
| Nhiều hình | 1 | 3,81 | 3,81 |
| Bố cục lạ | 2 | 0,05 | 0,38 |
| Báo cáo một cột (tiếng Việt, 492 khối) | 1 | 5,48 | 5,48 |
| Scan | 1 | 0,01 | 0,01 |
| Tất cả | 8 | 1,57 | 5,48 |

Nhóm có 1–3 PDF nên p95 chính là PDF chậm nhất của nhóm. Số đo dao động giữa các lần chạy: lần chạy trước có p95 "Tất cả" là 6,89 s. Xử lý lại tài liệu test 6 trang trên app mất khoảng 10 giây, gồm cả đọc tệp, dò highlight và ghi DB.

## 5. Kiểm thử và migration

| Kiểm tra | Kết quả |
|---|---|
| Backend trên SQLite | 454 passed, 3 skipped, coverage 87,5 % |
| Backend trên **PostgreSQL 16.15** (`TEST_DATABASE_URL`, schema dựng bằng chính các migration) | 454 passed, 3 skipped |
| Test xử lý lại (`test_reprocess.py`, 7 test) | Qua trên cả SQLite và PostgreSQL |
| Rollback migration trên PostgreSQL | `alembic downgrade 0034` (gỡ 0037 → 0036 → 0035) rồi `upgrade head`: sạch, các cột và bảng mới được gỡ rồi tạo lại |
| Migration trên DB dev | 0035–0037 đã chạy. Chỉ thêm cột/bảng, không sửa hay xoá dữ liệu cũ |
| Frontend | vitest 198 passed (1 skipped), `tsc` và `eslint` sạch |
| Ruff | `check` sạch; `format` sạch với mọi tệp của Clean Reader (10 migration cũ có từ trước chưa format) |
| Màn hình | GĐ3: hai PDF của người dùng (Frontiers, Springer). GĐ4: xử lý lại tài liệu test hai lần, thấy hộp xác nhận, trạng thái "Đang xử lý lại…" và thông báo kết quả |

Lệnh chạy trên PostgreSQL (database phải tên `…_test` vì bị xoá sạch trước khi chạy):

```bash
TEST_DATABASE_URL=postgresql+asyncpg://puremind:…@localhost:5440/puremind_test .venv/Scripts/python -m pytest
```

## 6. Yêu cầu chức năng (SRS §5)

| ID | Tình trạng | Ghi chú |
|---|---|---|
| CR-FR-01 PDF gốc bất biến, phiên bản bản trích xuất | partial | Tệp gốc không bao giờ bị ghi đè. Phiên bản chỉ là `content_version` (hash), không có bảng version |
| CR-FR-02 Text-native/scan, OCR fallback | done | Có từ trước. OCR cần người dùng đồng ý dùng AI |
| CR-FR-03 Khối, hình, bảng, công thức có provenance | done | `source_map` theo khối; ô và trang cho từng khối của kho phụ |
| CR-FR-04 Thứ tự đọc một/hai cột | done | 34/34 |
| CR-FR-05 Phân loại có confidence và lý do | done | `block_roles.py` (`rules-1`) |
| CR-FR-06 Header/footer/số trang lặp | done | Gồm số La Mã, header chỉ ở một trang |
| CR-FR-07 Giữ IMRaD trong bài | done | Nội dung chính 100 % |
| CR-FR-08 Tách tác giả, đơn vị, NXB, tuyên bố | done | Còn sót trên trang web in ra PDF (Sommerville) |
| CR-FR-09 References mở rộng được, không xoá | done | |
| CR-FR-10 Render theo thứ tự | done | Có từ Reader v2 |
| CR-FR-11 Cảnh báo mất hình/bảng/công thức | done | `extraction_issues`. Chưa cảnh báo "độ phủ chữ thấp" theo quality gate |
| CR-FR-12 Clean ↔ Original theo anchor | done | |
| CR-FR-13 Xem phần ẩn, Thông tin tài liệu/bổ sung | done | |
| CR-FR-14 Khối không chắc chắn không bị xoá | done | |
| CR-FR-15 Báo lỗi, xử lý lại không nhân bản | done | |
| CR-FR-16 Giữ highlight, note, tiến độ khi xử lý lại | done | Tiến độ: vị trí đọc về đầu nếu khối không còn, vị trí cũ lưu trong báo cáo |
| CR-FR-17 AI chỉ dùng bản đúng phiên bản, dẫn nguồn | done | Cache theo `chunks_hash` / `content_hash` |
| CR-FR-18 Không xoá metadata cần cho citation | done | Metadata nằm ở kho phụ, citation của tài liệu không đổi |
| CR-FR-19 Hiện lại khối bị ẩn (P1) | not done | Chỉ có "Báo ẩn nhầm" |
| CR-FR-20 QA interface (P1) | not done | Báo lỗi chỉ nằm trong DB |
| CR-FR-21 Cấu hình OCR, parser profile (P1) | not done | |
| CR-FR-22 Báo cáo chất lượng theo version/parser (P1) | partial | Benchmark có adapter theo bộ trích xuất, báo cáo ghi `classifier` |

## 7. Vận hành

**Triển khai**
1. `cd backend && .venv/Scripts/alembic upgrade head`: chạy migration 0035 (kho phụ), 0036 (báo lỗi) và 0037 (xử lý lại).
2. Triển khai backend và frontend. Không cần cấu hình mới.

**Tài liệu tải lên trước GĐ2**
- Các tài liệu này có `content_aside` rỗng. Reader ghi "được xử lý trước khi có tính năng làm sạch".
- Chủ tài liệu bấm "Xử lý lại tài liệu" (tab Thông tin, hoặc trong hộp "Nội dung bị ẩn").
- Không có lệnh chạy hàng loạt. Nếu cần, gọi `POST /api/documents/{id}/reprocess` cho từng tài liệu bằng tài khoản chủ.

**Xử lý lại**
- `POST /api/documents/{id}/reprocess` trả 202 và chạy nền. Trạng thái nằm trong `documents.reprocess_state` (running/done/failed) và `reprocess_report`.
- Trả 409 khi tài liệu không còn tệp gốc (trang web, EPUB đã nhập) hoặc đang trích xuất lần đầu.
- Kẹt ở `running` (server tắt giữa chừng): sau 15 phút yêu cầu mới sẽ chạy lại. Không cần sửa DB.
- `failed`: `reprocess_report.error` là mã lỗi (MSG-15: không có chữ; MSG-99: lỗi khác). Văn bản đang dùng không đổi.
- Log chỉ ghi id tài liệu và trạng thái, không ghi nội dung.

**Highlight cần xem lại**
- `highlights.anchor_status` = `ambiguous`/`unresolved` sau lần xử lý lại gần nhất.
- Reader tự dò lại mỗi lần mở và báo highlight không đặt được. Highlight không bao giờ bị xoá.

**Báo lỗi trích xuất**
- Bảng `extraction_reports`, kèm `classifier` và kiểu khối lúc báo. Xem bằng SQL, chưa có trang quản trị.

**Rollback**
- `alembic downgrade 0034` gỡ cả ba migration. Mất kho phụ, báo lỗi, trạng thái neo và báo cáo xử lý lại. Văn bản, highlight và ghi chú không bị ảnh hưởng.
- Code trước GĐ2 vẫn đọc được `content_clean` hiện có. Không có feature flag riêng.

## 8. Còn tồn đọng

1. **Nhãn benchmark chưa có người kiểm, chỉ 8/20 PDF.** Quy tắc được chỉnh trên chính 8 PDF này, nên con số là trên tập đã thấy.
   - Hai PDF của người dùng (Frontiers, Springer) chưa có nhãn.
   - Còn thiếu: 2 paper hai cột, 4 PDF nhiều hình/bảng, 4 báo cáo một cột, 4 PDF scan hoặc bố cục lạ. Người dùng sẽ cung cấp.
2. **Trang web in ra PDF** (Sommerville): tên tác giả, tiểu sử, thanh điều hướng vẫn ở luồng đọc.
3. **Abstract** chưa tách thành khung riêng (TC-05).
4. **Không có phiên bản đọc được của bản cũ** sau xử lý lại (TC-13 partial, theo phạm vi).
5. **CR-FR-19, CR-FR-20, CR-FR-21** (P1) chưa làm. Quality gate `READY_WITH_WARNINGS` / `REVIEW_REQUIRED` chưa có.
6. **CR-NFR-10**: chưa giới hạn số trang, thời gian trích xuất; chưa cô lập bộ đọc PDF.
7. **Chưa hiện `anchor_status` trên thẻ highlight.** Reader dò lại khi mở nên người dùng vẫn được báo, nhưng không qua trạng thái lưu trên server.
8. **"there-fore"**: từ ngắt dòng không có dạng liền ở chỗ khác trong tài liệu thì không nối được.
