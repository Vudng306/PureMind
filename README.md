# PureMind

Nền tảng đọc tài liệu và xây dựng kiến thức cá nhân. Đặc tả: [`docs/PureMind_PRD_v1.1.docx`](docs/PureMind_PRD_v1.1.docx), [`docs/PureMind_SRS_v1.1.docx`](docs/PureMind_SRS_v1.1.docx).

| Thành phần | Công nghệ |
|---|---|
| Frontend | Next.js 15, TypeScript, Tailwind CSS, TanStack Query, Zustand, PDF.js, supabase-js |
| Backend | Python 3.12, FastAPI, SQLAlchemy 2 (async), Alembic |
| Cơ sở dữ liệu | PostgreSQL 16 + pgvector |
| Xác thực | Supabase Auth |
| Xử lý PDF | PyMuPDF |
| AI | OpenAI API (Phase 3) |

## Tiến độ

**Phase 1 — Nền tảng đọc** (đã đủ tính năng; chưa chạy thử với Supabase thật)

- [x] Đăng ký, đăng nhập, đăng xuất, tự làm mới phiên (Supabase Auth); backend xác minh JWT, tự tạo hồ sơ
- [x] Hồ sơ: họ tên, ảnh đại diện (resize 256px), xóa tài khoản (dữ liệu + tệp + người dùng Supabase)
- [x] Tùy chọn đọc sáng/tối/sepia, cỡ chữ, đồng bộ theo tài khoản
- [x] Tải PDF/EPUB ≤ 50 MB (kiểm tra chữ ký tệp, làm sạch tên, chống zip bomb)
- [x] Trích xuất PDF bằng PyMuPDF (tiêu đề, in đậm, bảng) và EPUB (theo spine, bỏ mục lục/script)
- [x] Lưu bài viết/PDF bằng link: chặn SSRF (IP nội bộ, chuyển hướng, DNS rebinding), giới hạn 20 s / 20 MB / 5 chuyển hướng
- [x] Thư viện: lọc theo nguồn, sắp xếp, trạng thái rỗng, trạng thái trích xuất, tiến độ đọc, xóa tài liệu
- [x] Trình đọc PDF.js cuộn liên tục, chỉ dựng ±2 trang; chuyển trang, phím tắt, thu phóng giữ vị trí, ghi nhớ trang
- [x] Chế độ văn bản sạch (Source Serif 4, 14–28px, tối đa 760px), nhớ chế độ theo tài liệu
- [x] Tìm trong tài liệu (Ctrl+F), không phân biệt hoa thường và dấu tiếng Việt, tô sáng và nhảy giữa kết quả
- [x] Giới hạn 30 lượt tải lên/lưu link mỗi giờ mỗi người dùng (trong bộ nhớ, một tiến trình)

## Chuẩn bị Supabase

1. Tạo dự án tại <https://supabase.com>.
2. **Authentication → Providers → Email**: bật Email, tắt *Confirm email* (Phase 1, xem PRD Q2); đặt độ dài mật khẩu tối thiểu 8.
3. **Settings → API**: lấy `Project URL`, `anon` key, `service_role` key.

## Chạy bằng Docker

```bash
cp .env.example .env   # điền SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
docker compose up --build
```

Frontend: <http://localhost:3000> · API: <http://localhost:8000/api/docs>

## Phát triển cục bộ

```bash
# Cơ sở dữ liệu
docker compose up -d db

# Backend
cd backend
python -m venv .venv && .venv/Scripts/activate   # macOS/Linux: source .venv/bin/activate
pip install -e ".[dev]"
cp .env.example .env
alembic upgrade head
uvicorn app.main:app --reload

# Frontend
cd frontend
npm install
cp .env.example .env.local
npm run dev
```

## Kiểm thử

```bash
cd backend && pytest          # SQLite tạm, token HS256 giả lập Supabase
cd frontend && npm test && npm run lint && npm run typecheck && npm run build
```
