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
| `DB_PATH` | `./data/usage.db` | File SQLite (WAL). |

`INGEST_KEY` là token nội bộ do team tự phát/đổi — **KHÔNG** phải secret của Claude/OpenAI.

## Endpoints

- `POST /api/v1/usage` — nhận deltas (idempotent theo `(osUser,hostname,tool,sessionId,seq)`).
- `GET  /api/v1/summary?from=&to=&groupBy=member|project|key` — JSON tổng hợp.
- `GET  /api/v1/summary.csv?...` — Export CSV.
- `GET  /` — dashboard HTML.
- `GET  /healthz` — liveness.

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
