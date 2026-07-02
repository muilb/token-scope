# tokenscope-central-server

Server nội bộ (LAN) gộp usage token/cost do các máy chạy **CodeTokens Monitor**
đẩy lên, hiển thị **dashboard chung member × dự án**. Thiết kế: [../../improve/08](../../improve/08-central-usage-server.md).

## Chạy (1 lệnh)

```bash
cd server
npm install
INGEST_KEY=<shared-token-noi-bo> node server.js
```

Mặc định lắng nghe `http://127.0.0.1:8787`. Dashboard: mở `/` trên trình duyệt.

### Cấu hình (env)

| Env | Mặc định | Ý nghĩa |
|---|---|---|
| `PORT` | `8787` | Cổng. |
| `HOST` | `127.0.0.1` | Bind address. Chỉ chạy **LAN/VPN**, KHÔNG expose Internet. |
| `INGEST_KEY` | *(rỗng)* | Shared token client gửi qua header `X-Ingest-Key`. Rỗng = **không auth** (chỉ dev). |
| `ADMIN_KEY` | *(rỗng)* | Bảo vệ trang quản trị bảng giá (`/admin`) và sửa giá. **Khác** `INGEST_KEY`. Rỗng = admin **mở** (chỉ dev/LAN kín). |
| `DB_PATH` | `./data/usage.db` | File SQLite (WAL). |

`INGEST_KEY` là token nội bộ do team tự phát/đổi — **KHÔNG** phải secret của Claude/OpenAI.
`ADMIN_KEY` chỉ phát cho người quản trị (đừng đưa cho member) — member chỉ cần `INGEST_KEY`.

## Endpoints

- `POST /api/v1/usage` — nhận deltas (idempotent theo `(osUser,hostname,tool,sessionId,seq)`).
- `GET  /api/v1/summary?from=&to=&groupBy=member|project|key` — JSON tổng hợp.
- `GET  /api/v1/summary.csv?...` / `GET /api/v1/breakdown.csv?...` — Export CSV.
- `GET  /api/v1/pricing` — bảng giá hiện tại (extension kéo về để sync). Gated bằng `X-Ingest-Key`.
- `GET  /` — dashboard HTML.
- `GET  /admin` — trang quản trị bảng giá (gated bằng `ADMIN_KEY`).
- `POST /admin/pricing`, `POST /admin/pricing/delete` — thêm/sửa/xoá giá (gated bằng `ADMIN_KEY`).
- `GET  /healthz` — liveness.

## Bảng giá (quản trị)

Cost trên dashboard được **tính lại từ token thô** theo bảng giá lưu trong DB, **không**
dùng cost client gửi. Do đó:

- Sửa/thêm giá ở `/admin` → **cả dữ liệu cũ lẫn mới đổi ngay** (không cần build lại client).
- Model mới ra liên tục: chỉ cần thêm 1 dòng giá; usage của model đó (đang tính $0 vì chưa có giá)
  sẽ được tính đúng lại. Model chưa có giá hiển thị ở đầu trang `/admin`.
- Lần đầu mở DB, bảng giá được **seed** từ bảng mặc định; sau đó restart **không ghi đè** giá đã sửa.

Extension bật Central usage sẽ tự kéo bảng giá này về (hoặc chạy lệnh *"Sync pricing from central
server"*) để cost dashboard local khớp server.

## Server đọc/ghi gì

- **CHỈ** ghi số liệu đã tổng hợp client gửi (token counts, cost ước tính, metadata auth
  đã rút gọn: `authType`, `keyHash` 8 hex, `orgShort`). **KHÔNG** đọc bất kỳ file secret nào,
  **KHÔNG** lưu full token/API key, **KHÔNG** lưu prompt/transcript.
- Payload chứa chuỗi giống full key/token (`sk-ant-`, `sk-proj-…`) bị **từ chối (422)** trước khi ghi DB.

## Lưu lịch sử & backup

- Dữ liệu tích luỹ **từ lúc bật**, không TTL/auto-delete (xem 08 §5.2b).
- Backup = **copy file** `data/usage.db` (khuyến nghị cron định kỳ). Restore = copy lại về `DB_PATH`.
  Nên copy cả `.db-wal`/`.db-shm` nếu có, hoặc chạy `PRAGMA wal_checkpoint` trước khi copy.

## Test

```bash
npm test   # node:test + fastify inject, không cần chạy server thật
```
