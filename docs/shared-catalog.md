# Kho bài chung (đợt thu thập đầu)

- Trang đọc công khai: http://localhost:3000/explore
- Danh sách: `GET /api/catalog?q=&topic=&kind=&offset=0&limit=24`
- Nội dung bài: `GET /api/catalog/{id}`
- Chạy thu thập từ `backend/`: `.venv\Scripts\python.exe -m app.scripts.collect_catalog`

Nội dung lưu trong `backend/app/data/catalog.json`, báo cáo trong
`backend/app/data/catalog-report.json`. Đây là kho dùng chung bằng tệp của phiên bản
đầu, không thuộc tài khoản người dùng và không phụ thuộc tài liệu tải lên. Khi triển
khai, cần đóng gói tệp cùng backend hoặc chuyển sang cơ sở dữ liệu/kho lưu trữ bền vững.
Không có lịch tự chạy; lệnh thu thập chạy một đợt có giới hạn.

Nguồn nghiên cứu: Europe PMC, chỉ giữ thân bài khi XML chứa liên kết giấy phép CC BY
hoặc CC0 rõ ràng. Giữ tác giả, DOI, ngày xuất bản, giấy phép, URL nguồn và thời điểm
thu thập. Bỏ hình, bảng, tài liệu bổ sung; giao diện thông báo phần lược bỏ và dẫn tới
bản gốc. Nguồn này thiên về khoa học sự sống/y sinh, kể cả khi phân theo các chủ đề
AI, môi trường, giáo dục hoặc kinh tế; chưa đại diện cho mọi lĩnh vực.

Chưa kết nối nguồn tin báo chí. Không gọi AI hoặc tạo embedding trong đợt này.

Chạy lại loại trùng bằng URL nguồn. Mỗi lần lấy thêm tối đa 4 nghiên cứu mới mỗi
chủ đề trong 12 ứng viên đầu tiên; không bảo đảm đủ nếu thiếu toàn văn hoặc giấy phép
phù hợp. Kho bài hiện hỗ trợ đọc/tìm/lọc; ghi chú cá nhân và AI trên bài chung cần tích
hợp thêm vào mô hình tài liệu hiện tại.
