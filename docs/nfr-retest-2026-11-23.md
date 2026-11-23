# Kiểm thử lại yêu cầu phi chức năng — 23/11/2026

Kiểm tra mã hiện tại trên máy Windows; dữ liệu giả lập trong SQLite tạm và PostgreSQL 18.4 riêng (`puremind_nfr_test`). Không dùng dữ liệu production, không gọi dịch vụ AI thật. Các lệnh chạy test dùng `--no-cov` vì đây là kiểm tra mục tiêu, không phải đánh giá coverage toàn ứng dụng.

| Chỉ tiêu | Bằng chứng mới | Kết luận |
|---|---|---|
| Lưu highlight p95 < 1,5 giây | 60 mẫu: SQLite 60,9 ms; PostgreSQL 21,5 ms. Các bài đồng bộ highlight hiện tại đạt trên cả hai DB. | Đạt phần API; chưa kiểm chứng toàn trình duyệt, giữ Một phần. |
| Tệp 50 MiB; URL 20 MiB; tối đa 5 chuyển hướng | Kiểm tra đúng giới hạn −1 byte, đúng giới hạn, +1 byte. URL kiểm tra cả có/không Content-Length; 5 chuyển hướng thành công, 6 bị từ chối. Các bài chặn IP nội bộ và chuyển hướng vào nội bộ đạt. | Đạt trong phạm vi kiểm thử tự động. |
| Truy cập chéo bị từ chối | Bài access sweep thực hiện 35 yêu cầu trực tiếp bằng tài khoản khác, kiểm tra danh sách/tìm kiếm/import và xác nhận dữ liệu chủ sở hữu không đổi. Đạt trên SQLite và PostgreSQL. Các bài notebook và highlight liên quan cũng đạt. | Đạt các tình huống đã kiểm thử. |
| AI lỗi không ảnh hưởng đọc và highlight | Ép quick/deep/mindmap báo lỗi nhà cung cấp. Sau mỗi lỗi vẫn mở nội dung, tải PDF, tạo/sửa highlight và đọc notebook được. | Đạt ở API với lỗi AI mô phỏng. |
| Mở tài liệu p95 < 3 giây | 60 mẫu: SQLite 20,0 ms; PostgreSQL 11,1 ms. Bổ sung assertion ngưỡng 3 giây vào benchmark. | Đạt phần API; chưa đo hiển thị trình duyệt, giữ Một phần. |

## Kết quả chạy

- Backend liên quan trên SQLite: **178 passed**, 28,77 giây.
- Kiểm thử biên mới trên SQLite: **12 passed**, 2,00 giây.
- PostgreSQL (benchmark, access sweep, kiểm thử biên/AI lỗi, đồng bộ): **29 passed**, 11,14 giây.
- Frontend Vitest: **213 passed / 31 files**, 4,79 giây; đây là unit test, không phải kiểm thử trình duyệt.
- Ruff check và format check: đạt cho hai tệp test thay đổi.

Số lượng trên thuộc các lượt chạy khác nhau và có các bài trùng nhau; không cộng thành số tình huống độc lập.

## Phương pháp và giới hạn

Benchmark dùng HTTPX ASGITransport đi qua ứng dụng FastAPI và database thật của lượt test, xác thực JWT thử nghiệm, tài liệu PDF tổng hợp 12 trang, 60 lần tuần tự mỗi thao tác. Số đo bao gồm vòng gọi API trong tiến trình, không bao gồm mạng thực, Supabase đăng nhập, dựng trang Next.js, PDF.js hoặc thời gian render trình duyệt. Không phải phép đo tải nhiều người dùng hay hiệu năng production. SQLite được đo trong lúc bộ frontend chạy song song; PostgreSQL là lượt chạy cuối riêng, không nên dùng hai số để kết luận DB nào nhanh hơn.

URL dùng DNS/transport giả lập để kiểm tra bảo mật và giới hạn mà không tải tệp ngoài mạng. Lỗi AI được tiêm tại lớp gọi nhà cung cấp, không tạo sự cố thật. Hai chỉ tiêu tốc độ đầu-cuối vẫn cần bài đo trình duyệt, vì vậy chưa thể công bố cả 5 mục đều đạt hoàn toàn.

## Chạy lại

Trong `backend/`, bằng môi trường `.venv`:

```powershell
$env:READER_TIMING='1'
.\.venv\Scripts\python.exe -m pytest --no-cov -q -s tests/test_reader_timing.py tests/test_access_sweep.py tests/test_documents.py tests/test_epub_web.py tests/test_highlights.py tests/test_highlight_sync.py tests/test_reader_notebook.py tests/test_summaries.py tests/test_chat.py
.\.venv\Scripts\python.exe -m pytest --no-cov -q tests/test_nfr_retest.py
```

Để chạy PostgreSQL, đặt `TEST_DATABASE_URL` tới database riêng có tên kết thúc `_test` trước khi chạy pytest; fixture xóa schema của database test đó. Lượt đã thực hiện dùng PostgreSQL cục bộ riêng và đã dừng sau test.

Trong `frontend/`: `npm test`.

Log và JUnit thô được tạo cục bộ với tiền tố `nfr-retest-` và không được đưa vào Git vì có đường dẫn, cấu hình máy chạy và dung lượng lớn. Báo cáo này giữ các số liệu cần thiết để đối chiếu.
