# PureMind

Nền tảng đọc tài liệu và xây dựng kiến thức cá nhân cho sinh viên: đọc PDF, EPUB và bài báo, highlight, ghi chú, tìm kiếm, tóm tắt bằng AI và tạo notebook AI từ highlight.

Đặc tả: [`docs/PureMind_PRD_v1.1.docx`](docs/PureMind_PRD_v1.1.docx), [`docs/PureMind_SRS_v1.1.docx`](docs/PureMind_SRS_v1.1.docx), ERD trong [`docs/`](docs/).

| Thành phần | Công nghệ |
|---|---|
| Frontend | Next.js 15, React 19, TypeScript, Tailwind CSS, TanStack Query, Zustand, PDF.js, supabase-js |
| Backend | Python 3.11+, FastAPI, SQLAlchemy 2 (async), Alembic |
| Cơ sở dữ liệu | PostgreSQL 16 (image `pgvector/pgvector:pg16`, dùng `unaccent` cho tìm kiếm tiếng Việt) |
| Xác thực | Supabase Auth |
| Xử lý tài liệu | PyMuPDF (PDF), BeautifulSoup (EPUB, bài báo web) |
| AI | OpenAI API (mặc định `gpt-4.1-mini`) |

## Tính năng

- **Tài khoản:** đăng ký, đăng nhập, đăng xuất (Supabase Auth); hồ sơ, ảnh đại diện, xóa tài khoản; tùy chọn đọc đồng bộ theo tài khoản.
- **Thư viện:** tải PDF/EPUB ≤ 50 MB; lưu bài báo hoặc PDF bằng link (chặn SSRF, lọc quảng cáo và menu); lọc, sắp xếp, theo dõi tiến độ đọc.
- **Trình đọc:** xem PDF gốc (PDF.js) hoặc văn bản sạch; nền sáng, tối, sepia; cỡ chữ; tìm trong tài liệu (Ctrl+F, không phân biệt dấu).
- **Highlight và ghi chú:** 5 màu, danh mục (Quan trọng, Khái niệm, Câu hỏi…), ghi chú, highlight trên PDF gốc; xuất ra Markdown.
- **Tìm kiếm:** toàn văn trên tài liệu, highlight, ghi chú và notebook; không phân biệt dấu tiếng Việt.
- **Tóm tắt AI:** Ý chính, Khái niệm, Kết luận, Từ khóa; chọn ngôn ngữ; tóm tắt được tài liệu dài.
- **Notebook AI:** chọn tối đa 100 highlight để AI viết notebook Markdown có trích dẫn nguồn [n]; nội dung hiện dần trong lúc AI viết; chỉnh sửa, tự lưu, lịch sử phiên bản.
- **Giới hạn AI:** 20 lượt mỗi người dùng mỗi ngày (đặt lại lúc 00:00 giờ Việt Nam). Người dùng phải đồng ý trước khi nội dung được gửi tới OpenAI.

## Yêu cầu

- [Docker Desktop](https://www.docker.com/products/docker-desktop/), dùng để chạy PostgreSQL hoặc cả hệ thống
- Python 3.11 trở lên và Node.js 20 trở lên (chỉ cần khi chạy trên máy; image Docker dùng Python 3.12 và Node 22)
- Một dự án [Supabase](https://supabase.com) (gói miễn phí là đủ)
- Một OpenAI API key (chỉ cần cho tóm tắt AI và notebook AI; các tính năng khác vẫn chạy khi không có)

## 1. Chuẩn bị Supabase và OpenAI

1. Tạo dự án tại <https://supabase.com/dashboard>.
2. **Authentication → Sign In / Providers → Email**:
   - bật Email;
   - tắt *Confirm email* (theo PRD, không cần xác nhận email);
   - đặt độ dài mật khẩu tối thiểu là 8.
3. **Project Settings → API**, lấy 3 giá trị:
   - `Project URL`, ví dụ `https://abcd1234.supabase.co`;
   - **publishable / anon key** (`sb_publishable_…` hoặc `eyJ…`): khóa công khai, được phép dùng ở frontend;
   - **secret / service_role key** (`sb_secret_…`): khóa bí mật, **chỉ để ở backend**. Backend chỉ dùng khóa này khi xóa tài khoản.
4. Lấy OpenAI API key tại <https://platform.openai.com/api-keys>.

Supabase hiện ký token đăng nhập bằng ES256, và backend tự tải khóa công khai (JWKS) từ `SUPABASE_URL`, nên **không cần** `SUPABASE_JWT_SECRET`. Biến này chỉ dùng cho dự án cũ còn ký token bằng HS256.

> **Bảo mật:** secret key và OpenAI key chỉ được đặt trong các file `.env` (đã nằm trong `.gitignore`). Không đặt chúng trong `.env.example` (file này được commit), cũng không đặt trong biến `NEXT_PUBLIC_*` (các biến này bị đưa lên trình duyệt).

## 2. Chạy bằng Docker (cách nhanh nhất)

```bash
cp .env.example .env
```

Điền vào `.env` các giá trị `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` và `OPENAI_API_KEY`, rồi chạy:

```bash
docker compose up --build
```

- Frontend: <http://localhost:3000>
- API docs (Swagger): <http://localhost:8000/api/docs>

Backend tự chạy migration (`alembic upgrade head`) mỗi khi khởi động. Dữ liệu database và tệp tải lên được lưu trong volume `pgdata` và `uploads`.

Lưu ý:
- Nếu cổng 5432, 8000 hoặc 3000 đã bị chiếm, đặt `POSTGRES_PORT`, `BACKEND_PORT` hoặc `FRONTEND_PORT` trong `.env`. Khi đổi cổng backend hoặc frontend, sửa luôn `NEXT_PUBLIC_API_URL` (ví dụ `http://localhost:8100`) và `CORS_ORIGINS` (ví dụ `http://localhost:3100`) cho khớp.
- Các biến `NEXT_PUBLIC_*` được đóng gói vào frontend lúc build, nên sau khi sửa chúng phải build lại image bằng `docker compose up --build`.

## 3. Chạy trên máy để phát triển

Chạy PostgreSQL bằng Docker, còn backend và frontend chạy trực tiếp trên máy để có hot reload.

### 3.1. Cơ sở dữ liệu

```bash
docker compose up -d db
```

Lệnh này mở PostgreSQL ở cổng `5432`, hoặc ở cổng `POSTGRES_PORT` nếu bạn đặt biến này trong `.env` ở thư mục gốc. User, mật khẩu và tên database đều là `puremind`.

### 3.2. Backend (cổng 8000)

```bash
cd backend
python -m venv .venv
```

Kích hoạt môi trường ảo:

| Hệ điều hành / shell | Lệnh |
|---|---|
| Windows PowerShell | `.venv\Scripts\Activate.ps1` |
| Windows Git Bash | `source .venv/Scripts/activate` |
| macOS / Linux | `source .venv/bin/activate` |

Cài đặt, cấu hình và chạy:

```bash
pip install -e ".[dev]"
cp .env.example .env
```

Điền vào `backend/.env` các giá trị `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` và `OPENAI_API_KEY`. Nếu đã đổi `POSTGRES_PORT`, sửa cả cổng trong `DATABASE_URL` cho khớp. Sau đó chạy:

```bash
alembic upgrade head
uvicorn app.main:app --reload --port 8000
```

Kiểm tra backend đã chạy: <http://localhost:8000/api/healthz> trả về `{"status":"ok"}`.

> Backend luôn đọc `backend/.env`, bất kể bạn chạy `uvicorn` từ thư mục nào. File `.env` ở thư mục gốc chỉ dùng cho Docker Compose.

### 3.3. Frontend (cổng 3000)

Mở terminal khác:

```bash
cd frontend
npm install
cp .env.example .env.local
```

Điền vào `frontend/.env.local`:

```env
NEXT_PUBLIC_API_URL=http://localhost:8000
NEXT_PUBLIC_SUPABASE_URL=https://abcd1234.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=sb_publishable_...
```

Chỉ dùng publishable/anon key ở đây, không bao giờ dùng secret key. Sau đó chạy:

```bash
npm run dev
```

Mở <http://localhost:3000>, đăng ký tài khoản rồi thêm tài liệu đầu tiên.

## Biến môi trường

| Biến | File | Bắt buộc | Mô tả |
|---|---|---|---|
| `DATABASE_URL` | `backend/.env` | có | Chuỗi kết nối `postgresql+asyncpg://…`. Docker Compose tự đặt biến này. |
| `CORS_ORIGINS` | `backend/.env`, `.env` | có | Địa chỉ frontend, phân tách bằng dấu phẩy. Mặc định `http://localhost:3000`. |
| `SUPABASE_URL` | `backend/.env`, `.env` | có | Project URL của Supabase. |
| `SUPABASE_SERVICE_ROLE_KEY` | `backend/.env`, `.env` | để xóa tài khoản | Secret key. Chỉ để ở backend. |
| `SUPABASE_JWT_SECRET` | `backend/.env`, `.env` | không | Chỉ cần cho dự án còn ký token HS256. |
| `OPENAI_API_KEY` | `backend/.env`, `.env` | cho tính năng AI | Chỉ để ở backend. |
| `OPENAI_MODEL` | `backend/.env`, `.env` | không | Mặc định `gpt-4.1-mini`. |
| `WEB_FETCH_CONTACT` | `backend/.env`, `.env` | không | URL hoặc email đưa vào User-Agent khi lưu link. Một số trang như Wikipedia yêu cầu có thông tin này. Để trống thì dùng giá trị đầu tiên của `CORS_ORIGINS`. Khi deploy thật, hãy đặt URL hoặc email liên hệ thật. |
| `LOG_LEVEL` | `backend/.env`, `.env` | không | Mức log, mặc định `INFO`. Log luôn ở dạng JSON. |
| `UPLOAD_DIR` | `backend/.env` | không | Thư mục lưu tệp tải lên. Đường dẫn tương đối được tính từ `backend/`. Mặc định `uploads`. |
| `POSTGRES_PORT`, `BACKEND_PORT`, `FRONTEND_PORT` | `.env` | không | Cổng mà Docker mở ra máy cho PostgreSQL, backend và frontend. Mặc định `5432`, `8000`, `3000`. |
| `SUPABASE_ANON_KEY` | `.env` | có (Docker) | Publishable key, dùng khi build frontend trong Docker. |
| `NEXT_PUBLIC_API_URL` | `frontend/.env.local`, `.env` | có | Địa chỉ backend. Mặc định `http://localhost:8000`. |
| `NEXT_PUBLIC_SUPABASE_URL` | `frontend/.env.local` | có | Giống `SUPABASE_URL`. |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | `frontend/.env.local` | có | Publishable/anon key. |

## Kiểm thử

```bash
cd backend && pytest
```

Test backend dùng SQLite tạm, token Supabase giả lập và OpenAI giả lập, nên không cần mạng hay key thật.
Lệnh trên đo luôn độ bao phủ và **báo lỗi nếu dưới 70%** (NFR-MNT-01).

```bash
cd backend && ruff check app tests && ruff format --check app tests
```

```bash
cd frontend && npm test && npm run lint && npm run typecheck && npm run build
```

> Đừng chạy `npm run build` khi `npm run dev` đang chạy: hai lệnh dùng chung thư mục `.next` và
> server dev sẽ hỏng. Nếu lỡ chạy, xóa `frontend/.next` rồi khởi động lại `npm run dev`.

GitHub Actions chạy đúng các lệnh trên cho mỗi push và pull request — xem
[`.github/workflows/ci.yml`](.github/workflows/ci.yml).

## Log

Backend ghi log dạng JSON, mỗi dòng một object, ra stdout (NFR-OBS-01):

```json
{"ts": "2026-09-20T03:19:36.762+00:00", "level": "INFO", "logger": "app.request", "message": "request",
 "request_id": "960dd5e6...", "method": "GET", "path": "/api/documents", "endpoint": "/api/documents",
 "status": 200, "duration_ms": 984.0, "user_id": "aeb2aa51-..."}
```

Mỗi request có một `request_id`; nếu client gửi header `X-Request-ID` thì giá trị đó được giữ nguyên và
trả lại trong response. Log không bao giờ chứa token, nội dung tài liệu hay query string.
Lệnh gọi OpenAI được ghi kèm model, số token và thời gian, không ghi nội dung (NFR-OBS-02).

## Xử lý sự cố

| Hiện tượng | Nguyên nhân thường gặp và cách xử lý |
|---|---|
| Web báo "Không kết nối được máy chủ" | Backend chưa chạy, hoặc `NEXT_PUBLIC_API_URL` sai cổng. Mở `http://localhost:8000/api/healthz` để kiểm tra. |
| Backend log `password authentication failed for user "puremind"` | `DATABASE_URL` đang trỏ tới một PostgreSQL khác trên máy (thường ở cổng 5432). Đặt `POSTGRES_PORT` khác, rồi sửa cổng trong `DATABASE_URL` cho khớp. |
| Đăng nhập được nhưng mọi request đều trả 401 | `SUPABASE_URL` ở backend và `NEXT_PUBLIC_SUPABASE_URL` ở frontend không cùng một dự án, hoặc máy không truy cập được `https://<project>.supabase.co/auth/v1/.well-known/jwks.json`. |
| Xóa tài khoản bị lỗi | Thiếu `SUPABASE_SERVICE_ROLE_KEY` ở backend. |
| Tóm tắt AI hoặc notebook AI báo lỗi | Kiểm tra `OPENAI_API_KEY` trong `backend/.env`, rồi khởi động lại backend. Nếu đã dùng hết 20 lượt AI trong ngày thì chờ tới 00:00 giờ Việt Nam. |
| Lưu link báo "không cho phép PureMind tải nội dung" | Trang web chặn bot. Hãy lưu trang thành PDF (Ctrl+P) rồi tải tệp lên. Với Wikipedia, đặt `WEB_FETCH_CONTACT`. |
| Sửa `NEXT_PUBLIC_*` nhưng không thấy thay đổi | Khởi động lại `npm run dev`. Với Docker, build lại bằng `docker compose up --build`. |

## Cấu trúc thư mục

```
backend/
  app/api/routes/   REST API: account, documents, highlights, search, summaries, notebooks
  app/services/     trích xuất PDF/EPUB/web, OpenAI, tóm tắt, notebook, lưu trữ tệp
  app/core/         cấu hình, xác thực JWT, thông báo lỗi (SRS Phụ lục B)
  alembic/          migration cơ sở dữ liệu
  tests/            pytest
frontend/
  src/app/          các trang: thư viện, trình đọc, highlight, notebook, tìm kiếm, cài đặt
  src/components/   thành phần giao diện
  src/lib/          gọi API, hook dữ liệu, Markdown, highlight, xuất file
docs/               PRD, SRS, ERD
docker-compose.yml  db + backend + frontend
```
