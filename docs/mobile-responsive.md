# Mobile responsive — 18/11/2026

Nhánh: `codex/mobile-responsive`, tách từ `feat/admin-page` khi working tree sạch. Giữ web responsive, Admin ngoài phạm vi. Không tạo ứng dụng riêng.

## Quyết định thiết kế

Theo đề xuất ngày 18/11, thay thế quyết định bỏ bottom sheet trong Reader v2. AI/Ghi chú mở dạng sheet không khóa bài đọc, mặc định cao 54% màn hình; kéo tay nắm lên hoặc chạm để mở toàn màn hình, kéo xuống để thu lại rồi đóng. Có nút đóng và điều khiển bằng bàn phím. Desktop giữ panel bên phải.

## Đã triển khai

- Thanh dưới 5 ô: Khám phá, Thư viện, thêm, Sổ tay, Tài khoản. Reader dùng thanh riêng với quay lại, tiến độ, Aa và menu; Mục lục/Ghi chú/AI ở dưới. Thanh tự ẩn khi người dùng cuộn xuống và hiện khi chạm/cuộn lên.
- `dvh`, safe area, VisualViewport cho bàn phím; input mobile 16px. Enter trên mobile xuống dòng; nút gửi mới gửi câu hỏi, xử lý IME không gửi sớm.
- Theo dõi `selectionchange` trong cả bản sạch/PDF; thao tác chọn chữ ở đáy, hai hàng cuộn ngang. Giữ selection khi chạm toolbar và kéo tay nắm native.
- PDF mặc định bản sạch trên mobile khi có (tôn trọng chế độ đã lưu và link highlight), bản gốc fit-width. Điều khiển zoom và trang không bị ẩn; nhập số trang rồi Enter để nhảy. Thêm gesture pinch zoom cho PDF và sơ đồ tư duy; sơ đồ lớn mở toàn màn hình và kéo chuột để di chuyển.
- Thư viện: Đọc tiếp ở trước phân loại; chip phân loại cuộn ngang; bộ sưu tập trong dialog sheet; menu tài liệu ở đáy mobile; thêm tệp/link trong sheet.
- Sổ tay: chip lọc cuộn ngang, sắp xếp trong sheet, khung viết/sửa ghi chú toàn màn hình trên mobile. Bản nháp vẫn giữ khi đóng khung viết.
- Biểu tượng cài đặt 192/512px dựng từ logo hiện có, web manifest và viewport cho chế độ standalone/Add to Home Screen. Chưa tuyên bố hỗ trợ offline; tài liệu riêng tư không được thêm cache.

## Bằng chứng kiểm tra

Kiểm tra bằng trình duyệt trong app trên Windows, viewport hẹp; đây không phải Safari iOS hay Chrome Android trên thiết bị thật.

| Luồng | Kết quả |
| --- | --- |
| Đăng nhập | Người dùng tự đăng nhập trong trình duyệt app |
| Thư viện 320px | Danh mục cuộn trong vùng riêng; không tràn ngang toàn trang; Đọc tiếp trước danh mục |
| Chọn chữ bản sạch | Kéo chọn mở toolbar; Ghi chú → Lưu tạo highlight kèm ghi chú |
| AI 375×812 | Sheet mặc định giữ bài đọc phía trên; mở rộng đo được 812px; toàn trang rộng 375px |
| Hỏi AI | Câu hỏi về liên kết ghi chú với đoạn gốc có trả lời kèm nguồn; lưu vào ghi chú thành công (1 lượt hỏi) |
| Xem lại Sổ tay | Có ghi chú “Kiểm thử mobile 18/11…” và câu trả lời AI cùng nút trích dẫn |
| PDF gốc 320px | Zoom và trang đều hiện trong chiều rộng 320px; nhảy đến trang 4 bằng ô số trang thành công |
| Thêm tài liệu | Tải lại fixture `puremind-reader-test.pdf`, thư viện tăng 5 → 6 tài liệu, trích xuất xong 6 trang |
| Sheet AI 320/375/390/430px | Không tràn ngang; cao 438,5px trong viewport cao 812px |
| Desktop 1280px | Panel bên phải rộng 380px; không tràn ngang |
| Enter mobile | Nhập dòng mới, quota vẫn 49, không gửi câu hỏi |
| Mã nguồn | Production build (standalone), TypeScript, ESLint đều đạt; Vitest 201 đạt / 1 bỏ qua (33 tệp test) |

Dữ liệu QA được giữ để đối chiếu: một bản PDF fixture thêm vào thư viện, highlight/ghi chú thử và một câu trả lời AI đã lưu. Không xóa dữ liệu tài khoản.

## Chưa nghiệm thu trên thiết bị thật

- Ma trận đầy đủ 320/375/390/430px, VI/EN, sáng/tối trên Safari iOS và Chrome Android.
- Nhấn giữ chọn chữ, kéo tay nắm qua nhiều dòng, tương tác cùng menu chọn chữ của hệ điều hành; pinch hai ngón trên PDF/map.
- Bàn phím thật, xoay màn hình, thanh địa chỉ co giãn, vùng an toàn và đóng/mở sheet nhiều lần vẫn giữ vị trí đọc.
- Map có dữ liệu thật, di chuyển đến nguồn; thêm bằng link, EPUB, các màn hình Khám phá/Cài đặt trong cả hai theme.
- Cài lên màn hình chính trên iOS/Android và mở lại phiên standalone. Manifest đã có, cài đặt thực tế chưa kiểm chứng.

Tiêu chí cuối vẫn là trọn luồng thêm → đọc → highlight → ghi chú → hỏi AI có nguồn → Sổ tay trên hai hệ điều hành, không cuộn ngang toàn trang. Các phần đã xem trong browser không được coi là bằng chứng nghiệm thu thiết bị thật.

Phiên xem local: frontend `http://127.0.0.1:3000`, API kiểm thử `127.0.0.1:8001`; chỉ tiến trình frontend này có biến API override. `.env.local` đã khôi phục nguyên giá trị API trước khi kiểm thử. Tiến trình API sẵn có ở 8000 được giữ nguyên.
