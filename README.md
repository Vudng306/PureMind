# PureMind

Không gian đọc tài liệu và xây dựng kiến thức cá nhân cho sinh viên: đọc PDF, EPUB và bài viết web ở chế độ văn bản sạch hoặc bản gốc, highlight, ghi chú, tìm kiếm, và hỏi AI về tài liệu với câu trả lời luôn dẫn về đoạn nguồn.

Tài liệu dự án (trong [`docs/`](docs/)):

| Tài liệu | Tệp |
|---|---|
| Yêu cầu sản phẩm (PRD) | [`PureMind_PRD_v1.5.docx`](docs/PureMind_PRD_v1.5.docx) |
| Đặc tả yêu cầu phần mềm (SRS) | [`PureMind_SRS_v1.5.docx`](docs/PureMind_SRS_v1.5.docx) |
| Sơ đồ thực thể liên kết | [`ERD_PureMind.docx`](docs/ERD_PureMind.docx), [`ERD_PureMind.drawio`](docs/ERD_PureMind.drawio), [`ERD_PureMind.png`](docs/ERD_PureMind.png) |
| Báo cáo đồ án | [`DATN2026-1_CNTT_CNPM_0029968_DuongVanVu_Baocao_20261127_v1.docx`](docs/DATN2026-1_CNTT_CNPM_0029968_DuongVanVu_Baocao_20261127_v1.docx) |
| Nhật ký thực hiện ĐATN | [`DATN2026-1_CNTT_CNPM_0029968_DuongVanVu_Nhatky_20261127_v1.docx`](docs/DATN2026-1_CNTT_CNPM_0029968_DuongVanVu_Nhatky_20261127_v1.docx) |
| Tình trạng Reader v2 | [`reader-v2-release.md`](docs/reader-v2-release.md) |
| Tình trạng Clean Reader | [`clean-reader-release.md`](docs/clean-reader-release.md), nhật ký làm việc [`clean-reader-audit.md`](docs/clean-reader-audit.md) |
| Giao diện điện thoại | [`mobile-responsive.md`](docs/mobile-responsive.md) |
| Nâng cấp Khám phá bằng AI | [`AI_EXPLORE_UPGRADE.md`](docs/AI_EXPLORE_UPGRADE.md) |
| Kiểm thử lại yêu cầu phi chức năng | [`nfr-retest-2026-11-23.md`](docs/nfr-retest-2026-11-23.md) |

`docs/` chỉ giữ bản mới nhất của mỗi tài liệu. Các bản cũ (PRD, SRS v1.1–v1.4, báo cáo v8) vẫn xem được trong lịch sử git.

| Thành phần | Công nghệ |
|---|---|
| Frontend | Next.js 15, React 19, TypeScript, Tailwind CSS, TanStack Query, Zustand, PDF.js, supabase-js |
| Backend | Python 3.11+, FastAPI, SQLAlchemy 2 (async), Alembic |
| Cơ sở dữ liệu | PostgreSQL 16 (image `pgvector/pgvector:pg16`, dùng `unaccent` cho tìm kiếm tiếng Việt) |
| Xác thực | Supabase Auth |
| Xử lý tài liệu | PyMuPDF (PDF, bộ phân loại khối theo quy tắc), BeautifulSoup (EPUB, bài viết web) |
| AI | OpenAI API (tóm tắt, notebook và OCR `gpt-4.1-mini`, hỏi đáp `gpt-4.1`; embedding `text-embedding-3-small` cho hỏi đáp) |
| Hosting | Vercel (frontend), Render (backend, Docker) |

## Tính năng

- **Tài khoản:** đăng ký, đăng nhập, đăng xuất (Supabase Auth); hồ sơ, ảnh đại diện, xóa tài khoản; tùy chọn đọc đồng bộ theo tài khoản; điều khoản sử dụng và lựa chọn đồng ý gửi nội dung tới OpenAI.
- **Khám phá** (`/explore`): người dùng mô tả chủ đề muốn đọc, AI tìm 3–5 tài liệu đáng đọc đầy đủ trên web và kiểm tra từng tài liệu có nhập được vào thư viện không. Bấm thêm là tài liệu được tải về bằng chức năng lưu link của thư viện rồi mở trong trình đọc. Khám phá không lưu gì; trang không cho tải nội dung thì được mở ở trang gốc.
- **Thư viện:** tải PDF/EPUB ≤ 50 MB; lưu bài viết hoặc PDF bằng link (chặn SSRF, lọc quảng cáo và menu); bộ sưu tập; lọc, sắp xếp, đọc tiếp; xóa tài liệu có nêu rõ những gì bị xóa theo. Một link `https://doi.org/…` được lưu như mọi link khác (không còn nhập bằng DOI).
- **Trích dẫn:** sửa thông tin trích dẫn (tác giả, năm, nơi xuất bản…) và xuất BibTeX.
- **Trình đọc (Reader v2, “đọc trước”):** mở bài là đọc ngay, bảng AI chỉ mở khi người dùng bấm. Văn bản sạch hoặc PDF gốc (PDF.js), chuyển qua lại vẫn giữ đúng đoạn; nhớ vị trí đọc theo khối nên đổi cỡ chữ hay độ rộng cột không làm lệch; chế độ tập trung; nền sáng, tối, sepia; tìm trong tài liệu (Ctrl+F, không phân biệt dấu). Khi trích xuất bỏ sót bảng, công thức hoặc trang scan, trình đọc báo và cho mở bản gốc.
- **Clean Reader:** khi trích xuất PDF, bộ phân loại tách khỏi luồng đọc những khối không phải nội dung chính (tác giả, đơn vị, header/footer, số trang, tài liệu tham khảo, tài trợ, lời cảm ơn…) và giữ chúng trong kho phụ, không xóa. Người đọc xem lại các khối đã tách theo nhóm, trang và lý do, mở đúng chỗ trên PDF gốc, gửi báo lỗi trích xuất. Chủ tài liệu có thể **xử lý lại** tệp: văn bản đang dùng được giữ tới khi bản mới xong; mọi highlight được giữ và đánh dấu `mapped` / `ambiguous` / `unresolved`.
- **Highlight và ghi chú:** 5 màu, danh mục (Quan trọng, Khái niệm, Câu hỏi…), ghi chú ngay tại đoạn, highlight trên PDF gốc; mỗi highlight giữ vài từ trước và sau để tìm lại chỗ sau khi văn bản đổi. Ghi chú cho cả tài liệu. Xuất ra Markdown.
- **Notebook:** mỗi tài liệu một nhóm gồm highlight và ghi chú của người đọc, bấm để nhảy về đúng đoạn. Kết quả AI chỉ vào Notebook khi người dùng bấm “Lưu vào ghi chú”. Notebook viết tay có chủ đề, liên kết tài liệu, lịch sử phiên bản. Các notebook AI tổng hợp từ highlight trước đây vẫn đọc được ở `/notebooks/archive`; tạo mới đang tắt (cờ `SYNTHESIS`).
- **Tìm kiếm:** toàn văn trên tài liệu, highlight, ghi chú, kết quả AI và notebook; không phân biệt dấu tiếng Việt.
- **Bảng AI trong trình đọc** (Tóm tắt / Mind Map / Trợ lý đọc):
  - Tóm tắt ba mức Nhanh / Sâu / Nghiên cứu, tiếng Việt hoặc tiếng Anh. Mỗi ý dẫn về đoạn nguồn; khi tài liệu đã đổi kể từ lúc tạo, panel báo “phiên bản cũ hơn”.
  - Mind map, mỗi nút có nguồn.
  - Trợ lý đọc (hỏi đáp với tài liệu): tài liệu được cắt đoạn và nhúng một lần; câu trả lời chỉ dùng các đoạn liên quan nhất và luôn kèm số đoạn [n], bấm để mở đúng chỗ. Câu hỏi không có căn cứ trong tài liệu thì bị từ chối, không trích dẫn. AI chỉ đọc thân bài; hỏi về tác giả, tài trợ hay tài liệu tham khảo thì AI đọc thêm kho phụ của Clean Reader và trích trang.
  - Bôi đen một đoạn để **Dịch** (Việt ↔ Anh, lưu thành ghi chú nếu muốn) hoặc **Giải thích**.
- **Giới hạn AI:** 20 lượt tóm tắt/notebook và 50 câu hỏi mỗi người dùng mỗi ngày (đặt lại lúc 00:00 giờ Việt Nam). Người dùng phải đồng ý trước khi nội dung được gửi tới OpenAI.
- **Trang quản trị** (`/admin`): danh sách người dùng kèm số tài liệu, dung lượng, lượt AI đã dùng; khóa/mở khóa (khóa cả đăng nhập trên Supabase), đặt lại lượt AI, xóa tài khoản; lưu lượng hệ thống; nhật ký mọi thao tác quản trị. Admin chỉ thấy số liệu, không thấy nội dung tài liệu, highlight, ghi chú hay cuộc trò chuyện.

  Cấp quyền admin bằng dòng lệnh (tài khoản phải đăng nhập PureMind ít nhất một lần trước), chạy trong `backend/`:

  ```bash
  python -m app.scripts.make_admin ban@vidu.com
  ```

  Thêm `--revoke` để thu hồi quyền. Với bản production, chạy lệnh này trong tab **Shell** của service backend trên Render (chỉ gói trả phí mới có), hoặc chạy trên máy với `DATABASE_URL` trỏ vào database production.

**Ngoài phạm vi từ v1.5:** Bảng tin, Cộng đồng/Đăng bài và kho bài thu thập (danh mục, trình thu thập, bài ngắn AI) đã được bỏ khỏi giao diện và khỏi phạm vi đồ án. Mã, API và dữ liệu vẫn còn; các cờ trong [`frontend/src/lib/features.ts`](frontend/src/lib/features.ts) (`FEED`, `COMMUNITY`, `CATALOG`) cùng các redirect trong `frontend/next.config.mjs` tắt chúng.

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
   - **secret / service_role key** (`sb_secret_…`): khóa bí mật, **chỉ để ở backend**. Backend chỉ dùng khóa này khi xóa, khóa hoặc mở khóa tài khoản.
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

## Deploy (Vercel + Render)

Bản production chạy tách làm hai nơi:

| Thành phần | Nơi chạy | Domain hiện tại |
|---|---|---|
| Frontend (Next.js) | Vercel | <https://pure-mind-one.vercel.app> |
| Backend (FastAPI, Docker) | Render | `https://puremind-api.onrender.com` |
| Cơ sở dữ liệu | PostgreSQL bất kỳ (Render Postgres, Supabase…) | — |
| Xác thực | Supabase Auth | — |

Cả Vercel và Render đều deploy từ một nhánh GitHub, nên nhánh muốn chạy phải được push trước. Mỗi lần push
lên nhánh đó, hai nơi tự build lại.

### 1. PostgreSQL

Dùng Postgres của Render (**New → Postgres**) hoặc database có sẵn của dự án Supabase đều được. Nếu dùng
Supabase, lấy chuỗi kết nối **Direct connection** hoặc **Session pooler** (cổng 5432); *Transaction pooler*
(cổng 6543) không hợp với asyncpg vì không hỗ trợ prepared statement.

Bản migration đầu tiên cần extension `unaccent` cho tìm kiếm không dấu (FR-SRCH-01). Đây là contrib trusted
nên cả Render lẫn Supabase đều tạo được. `pgvector` là tùy chọn: nếu có, việc xếp hạng đoạn cho tính năng trò
chuyện chạy ngay trong database (`<=>`); nếu không có, backend tính độ tương đồng trong Python trên các đoạn
của đúng tài liệu đó. Migration không fail khi thiếu pgvector.

### 2. Backend trên Render

**New → Web Service**, chọn repo này, rồi đặt:

| Mục | Giá trị |
|---|---|
| Language | Docker |
| Root Directory | `backend` |
| Dockerfile Path | `./Dockerfile` |
| Health Check Path | `/api/healthz` |

Container tự chạy `alembic upgrade head` trước khi khởi động `uvicorn`, nên không cần lệnh migrate riêng.
Không cần đặt `PORT`: Render tự cấp và container dùng đúng biến đó.

Biến môi trường (**Environment**):

| Biến | Giá trị |
|---|---|
| `DATABASE_URL` | chuỗi kết nối Postgres (với Render Postgres, dùng *Internal Database URL*) |
| `ENVIRONMENT` | `production` |
| `CORS_ORIGINS` | domain frontend trên Vercel, ví dụ `https://pure-mind-one.vercel.app` |
| `UPLOAD_DIR` | `/data/uploads` |
| `SUPABASE_URL` | Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | secret key |
| `OPENAI_API_KEY` | khóa OpenAI |
| `WEB_FETCH_CONTACT` | email hoặc URL liên hệ thật |

`DATABASE_URL` của các nhà cung cấp thường ở dạng `postgresql://…`; backend tự đổi sang driver `asyncpg` và
bỏ tham số `sslmode` mà asyncpg không nhận.

**Lưu ý về tệp tải lên:** PDF/EPUB được lưu trên đĩa của container tại `UPLOAD_DIR`. Filesystem của Render
mất sạch sau mỗi lần deploy hoặc khởi động lại, nên phải gắn **Disk** (**Advanced → Add Disk**, mount path
`/data/uploads`). Disk chỉ có ở gói trả phí; ở gói Free, tệp người dùng tải lên sẽ mất trong khi bản ghi
trong cơ sở dữ liệu vẫn còn. Gói Free còn cho service ngủ sau một thời gian không có request, nên request
đầu tiên sau đó có thể mất gần một phút.

### 3. Frontend trên Vercel

**Add New → Project**, import repo này, đặt **Root Directory** là `frontend`. Vercel tự nhận ra Next.js nên
không cần `vercel.json`; Vercel cũng không dùng `frontend/Dockerfile` (file đó chỉ dành cho Docker Compose).

Biến môi trường (**Settings → Environment Variables**):

| Biến | Giá trị |
|---|---|
| `NEXT_PUBLIC_API_URL` | domain backend trên Render, ví dụ `https://puremind-api.onrender.com` |
| `NEXT_PUBLIC_SUPABASE_URL` | Project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | publishable/anon key |

Ba biến này được đọc **lúc build** và nướng thẳng vào JavaScript gửi xuống trình duyệt. Đổi chúng thì phải
**Redeploy** mới có tác dụng. Cũng vì vậy, tuyệt đối không đặt secret vào biến `NEXT_PUBLIC_*`.

Mỗi pull request trên Vercel có một domain preview riêng. Backend chỉ nhận các origin trong `CORS_ORIGINS`,
nên muốn dùng thử bản preview thì thêm domain đó vào `CORS_ORIGINS` (phân tách bằng dấu phẩy).

### 4. Supabase

Trong **Authentication → URL Configuration**, đặt domain Vercel vào *Site URL* và thêm vào *Redirect URLs*.
Thiếu bước này thì đăng nhập (kể cả Google OAuth) sẽ quay về `localhost`.

### 5. Kiểm tra

```bash
curl https://puremind-api.onrender.com/api/healthz
```

Phải trả về `{"status":"ok"}`. Ở `ENVIRONMENT=production`, `/api/docs` trả 404 và phản hồi có thêm
`Strict-Transport-Security` — đó là hành vi đúng, không phải lỗi.

## Biến môi trường

| Biến | File | Bắt buộc | Mô tả |
|---|---|---|---|
| `DATABASE_URL` | `backend/.env` | có | Chuỗi kết nối `postgresql+asyncpg://…`. Docker Compose tự đặt biến này. |
| `CORS_ORIGINS` | `backend/.env`, `.env` | có | Địa chỉ frontend, phân tách bằng dấu phẩy. Mặc định `http://localhost:3000`. |
| `SUPABASE_URL` | `backend/.env`, `.env` | có | Project URL của Supabase. |
| `SUPABASE_SERVICE_ROLE_KEY` | `backend/.env`, `.env` | để xóa tài khoản | Secret key. Chỉ để ở backend. |
| `SUPABASE_JWT_SECRET` | `backend/.env`, `.env` | không | Chỉ cần cho dự án còn ký token HS256. |
| `OPENAI_API_KEY` | `backend/.env`, `.env` | cho tính năng AI | Chỉ để ở backend. |
| `OPENAI_MODEL` | `backend/.env`, `.env` | không | Model viết: tóm tắt, tổng hợp highlight, notebook và OCR. Mặc định `gpt-4.1-mini`. |
| `OPENAI_CHAT_MODEL` | `backend/.env`, `.env` | không | Model trả lời câu hỏi về tài liệu (FR-CHAT). Mặc định `gpt-4.1`. |
| `OPENAI_EMBEDDING_MODEL` | `backend/.env`, `.env` | không | Model nhúng dùng cho trò chuyện. Mặc định `text-embedding-3-small`. Đổi model thì tài liệu sẽ được nhúng lại ở câu hỏi kế tiếp. |
| `CHAT_DAILY_QUOTA` | `backend/.env`, `.env` | không | Số câu hỏi trò chuyện mỗi người mỗi ngày. Mặc định `50`. |
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

Chạy cùng bộ test trên PostgreSQL thật (schema dựng bằng chính các migration). Database này **bị xoá
sạch** trước mỗi lần chạy, nên tên phải kết thúc bằng `_test`; đừng trỏ vào database đang dùng:

```bash
docker compose exec db createdb -U puremind puremind_test
cd backend && TEST_DATABASE_URL=postgresql+asyncpg://puremind:puremind@localhost:5432/puremind_test pytest
```

Đo thời gian các request của trình đọc trên server (NFR-101/103): thêm `READER_TIMING=1` và chạy
`pytest tests/test_reader_timing.py -s`. Bộ đánh giá AI của trình đọc (gọi OpenAI thật):
`python -m evals.run_reader_ai`. Tình trạng Reader v2: [docs/reader-v2-release.md](docs/reader-v2-release.md).

Benchmark Clean Reader (không cần DB hay OpenAI) chạy bộ trích xuất trên 8 PDF đã gán nhãn và so với lần đo
trước khi làm Clean Reader (`results/baseline.json`). PDF không nằm trong git: đặt chúng vào
`backend/evals/clean_reader/pdfs/` theo tên trong `labels.json`; PDF thiếu sẽ bị bỏ qua và được báo lại.

```bash
cd backend && .venv/Scripts/python -X utf8 -m evals.run_clean_reader
```

Kết quả nằm ở `backend/evals/clean_reader/results/current.md`. Tình trạng Clean Reader:
[docs/clean-reader-release.md](docs/clean-reader-release.md).

Lần chạy ngày 16/11/2026: backend 454 test qua, 3 bỏ qua, độ phủ 87,5 %, trên cả SQLite và PostgreSQL 16;
frontend 198 test qua (32 tệp).

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
| Trò chuyện báo hết lượt | Mỗi ngày có 50 câu hỏi, làm mới lúc 00:00 giờ Việt Nam. Đổi `CHAT_DAILY_QUOTA` nếu cần. |
| Tóm tắt AI hoặc notebook AI báo lỗi | Kiểm tra `OPENAI_API_KEY` trong `backend/.env`, rồi khởi động lại backend. Nếu đã dùng hết 20 lượt AI trong ngày thì chờ tới 00:00 giờ Việt Nam. |
| Lưu link báo "không cho phép PureMind tải nội dung" | Trang web chặn bot. Hãy lưu trang thành PDF (Ctrl+P) rồi tải tệp lên. Với Wikipedia, đặt `WEB_FETCH_CONTACT`. |
| Sửa `NEXT_PUBLIC_*` nhưng không thấy thay đổi | Khởi động lại `npm run dev`. Với Docker, build lại bằng `docker compose up --build`. |

## Cấu trúc thư mục

```
backend/
  app/api/routes/   REST API: account, documents (tải lên, lưu link, kho phụ, xử lý lại), highlights, notes,
                    reader_ai (tóm tắt, mind map), chat, translate, search, notebooks, collections, explore, admin
  app/services/     trích xuất PDF/EPUB/web, phân loại khối (block_roles), neo highlight (anchors), OpenAI,
                    embedding, tóm tắt, trò chuyện, lưu trữ tệp
  app/core/         cấu hình, xác thực JWT, thông báo lỗi (SRS Phụ lục B)
  alembic/          migration cơ sở dữ liệu (0001–0037)
  evals/            benchmark Clean Reader, bộ đánh giá AI của trình đọc
  tests/            pytest
frontend/
  src/app/          các trang: khám phá, thư viện, trình đọc, highlight, notebook, tìm kiếm, cài đặt, quản trị
  src/components/   thành phần giao diện
  src/lib/          gọi API, hook dữ liệu, cờ tính năng, Markdown, highlight, xuất file
docs/               PRD, SRS, ERD, báo cáo đồ án, tình trạng phát hành
docker-compose.yml  db + backend + frontend
```
