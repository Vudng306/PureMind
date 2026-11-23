# So sánh chunk 200 / 400 / 800 — 23/11/2026

Dùng cùng 3 tài liệu mẫu, 8 câu hỏi và nhãn nguồn đã gán trước; embedding thật `text-embedding-3-small`, cosine similarity theo logic Python của ứng dụng. Chỉ thay mục tiêu kích thước chunk trong script, không đổi cấu hình ứng dụng.

| Mục tiêu token | Recall@1 | Recall@3 | Recall@5 | Recall@8 |
|---|---:|---:|---:|---:|
| 200 | 75% | 87,5% | 100% | 100% |
| 400 | 75% | 87,5% | 100% | 100% |
| 800 | 75% | 87,5% | 100% | 100% |

## Vì sao kết quả giống nhau?

Đã kiểm tra trực tiếp toàn bộ cặp (heading, text) của chunks: cả ba cấu hình tạo **chính xác cùng các chunks**, không chỉ cùng số lượng. `paper` có 8 chunks, `essay` có 5 và `partial` có 4 ở mọi cấu hình.

Hàm chia đoạn tách khi gặp tiêu đề, ngắt trang hoặc vượt giới hạn ước lượng (`max_tokens * 3` ký tự). Với bộ tài liệu ngắn này, các ranh giới có sẵn đã chia nội dung thành những đoạn đủ nhỏ, nên đổi mục tiêu 200/400/800 không làm đổi đầu vào embedding. Mỗi lượt dùng 2.307 prompt tokens cho embedding, không gọi model sinh câu trả lời.

**Kết luận:** phép thử đã chạy thành công nhưng bộ dữ liệu không phân biệt được ba cấu hình; không có bằng chứng rằng 200, 400 hay 800 tốt hơn. Recall@8 là trường hợp lấy toàn bộ chunks của từng tài liệu.

Để so sánh có ý nghĩa, cần tài liệu dài với các đoạn/mục vượt ngưỡng ước lượng, bộ nguồn đúng được kiểm duyệt độc lập và báo cáo cả cùng k lẫn cùng ngân sách ngữ cảnh. Nhãn hiện do trợ lý gán, chưa được người đánh giá độc lập xác nhận. Đây là phép đo truy xuất, không phải độ đúng của câu trả lời hay đo production/pgvector.

Chạy lại từ `backend`:

```powershell
.\.venv\Scripts\python.exe -m evals.run_retrieval --chunk-tokens 200
.\.venv\Scripts\python.exe -m evals.run_retrieval --chunk-tokens 800
```

Chi tiết từng câu và thứ hạng nằm trong `retrieval_results_200.json/.md`, `retrieval_results.json/.md` (400) và `retrieval_results_800.json/.md` cùng thư mục.
