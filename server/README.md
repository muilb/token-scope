# tokenscope-central-server

Server nội bộ (LAN) gộp usage token do các máy chạy **CodeTokens Monitor** đẩy lên:
dashboard chung **member × dự án × ngày**, trang riêng cho **PM theo team**, quản trị
**bảng giá / member / team**.

## Chạy

Server đọc bảng giá gốc từ `../pricing/seed-v2.json` (dùng chung với extension), nên
chạy từ **cả repo**, không copy riêng thư mục `server/`. Nếu bắt buộc tách, đặt
`PRICING_SEED=/đường/dẫn/seed-v2.json`.

```bash
cd server
npm install
INGEST_KEY=<token-cho-client> ADMIN_KEY=<key-quản-trị> VIEW_KEY=<key-xem-tổng-hợp> node server.js
```

Mặc định lắng nghe `http://127.0.0.1:8787`.

### Cấu hình (env)

| Env | Mặc định | Ý nghĩa |
|---|---|---|
| `PORT` | `8787` | Cổng. |
| `HOST` | `127.0.0.1` | Bind address. Chỉ chạy **LAN/VPN**, KHÔNG expose Internet. |
| `INGEST_KEY` | *(rỗng)* | Token client gửi qua `X-Ingest-Key`. Rỗng = **không auth** (chỉ dev). |
| `VIEW_KEY` | *(rỗng)* | Mở dashboard toàn công ty + CSV (`/`, `/sessions`, `/api/v1/summary…`). `ADMIN_KEY` cũng mở được. Cả hai rỗng = **mở cho mọi máy trong mạng** (chỉ dev). |
| `ADMIN_KEY` | *(rỗng)* | Trang `/admin` (bảng giá, member, team). Rỗng = mở (chỉ dev). |
| `DB_PATH` | `./data/usage.db` | File SQLite (WAL). |
| `PRICING_SEED` | `../pricing/seed-v2.json` | Bảng giá gốc. |

Ba key khác nhau, phát cho ba nhóm người: member chỉ cần `INGEST_KEY` (cài trong
extension); quản lý chung dùng `VIEW_KEY`; quản trị dùng `ADMIN_KEY`. PM **không** cần
key nào trong ba key này — họ dùng link team (`/team?k=…`).

Mở dashboard lần đầu bằng `http://server:8787/?vk=<VIEW_KEY>`; trình duyệt nhớ bằng
cookie, các lần sau không cần `?vk=`.

### Chạy cùng Windows (Task Scheduler, không cần admin)

Chạy `npm start` trong terminal hay background task của một phiên chat thì server
**chết theo phiên đó** (đóng VS Code, reboot, phiên chat nghỉ…). Để nó tự sống:

- `start-server.cmd` — launcher: `cd` vào thư mục server, log ra `data\server.log`
  (xoay vòng khi >20 MB lúc khởi động), tự tìm `node`.
- `start-server-hidden.vbs` — bọc `.cmd` để **không hiện cửa sổ console** khi đăng nhập.

Đăng ký task (PowerShell, chạy dưới user thường):

```powershell
$dir = (Resolve-Path .\server).Path      # hoặc đường dẫn tuyệt đối tới server/
$user = "$env:USERDOMAIN\$env:USERNAME"
Register-ScheduledTask -TaskName 'TokenScope Central Server' `
  -Action    (New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "//B //Nologo `"$dir\start-server-hidden.vbs`"" -WorkingDirectory $dir) `
  -Trigger   (New-ScheduledTaskTrigger -AtLogOn -User $user) `
  -Principal (New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited) `
  -Settings  (New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -DontStopOnIdleEnd)
Start-ScheduledTask -TaskName 'TokenScope Central Server'
```

Lưu ý:
- `-ExecutionTimeLimit 0` là **bắt buộc** — mặc định Task Scheduler giết task sau 72 giờ.
- Trigger *At logon* (không phải *At startup*) vì user thường không được tạo task chạy
  khi chưa đăng nhập (S4U bị *Access is denied*). Có admin thì đổi sang `-AtStartup` + `-LogonType S4U`.
- Task ở trạng thái **Ready** ngay sau khi chạy (wscript khởi chạy xong là thoát; node chạy tách rời),
  nên `Stop-ScheduledTask` **không** dừng được server. Dừng server:
  ```powershell
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object CommandLine -like '*server.js*' | ForEach-Object { Stop-Process -Id $_.ProcessId }
  ```
  Khởi động lại: `Start-ScheduledTask -TaskName 'TokenScope Central Server'`. Gọi khi server đang chạy
  thì instance thứ 2 thoát ngay vì trùng cổng (ghi `server exited with code 1` vào log) — vô hại.
- Gỡ: `Unregister-ScheduledTask -TaskName 'TokenScope Central Server' -Confirm:$false`.

## Dữ liệu nhận

Từ 0.8 extension gửi **`usage.v2`**: tổng tuyệt đối theo *bucket*
(member, máy, tool, session, ngày, model, speed, tier, geo, origin). Server **ghi đè**
bucket theo khoá, nên gửi lại / backfill / client gửi trùng đều không cộng đôi.

- **Mọi loại tài khoản** đều được đẩy: API key, Claude sub/Teams (OAuth), ChatGPT.
- **Chỉ usage API key bị tính tiền.** Gói sub/Teams/ChatGPT là phí cố định → dashboard
  và CSV chỉ thống kê token chi tiết, cột tiền để "—" và không cộng vào tổng tiền.
- Member: tài khoản sub/Teams nhận diện bằng **email + account uuid** của tài khoản
  Claude/ChatGPT; API key nhận diện bằng setting `tokenscope.owner` (nên điền email),
  không có thì `OS user @ máy`. Cùng email → tự gộp thành một member; còn lại gộp tay ở
  `/admin?tab=members`.
- Client ≤ 0.6 (`usage.v1`, delta) vẫn được nhận. Khi một máy đã gửi v2 cho một ngày, các
  dòng v1 của máy đó **trong ngày đó** không được tính nữa (tránh cộng đôi sau backfill).

## Endpoints

| | |
|---|---|
| `POST /api/v1/usage` | nhận `usage.v2` (buckets) hoặc `usage.v1` (deltas). `X-Ingest-Key`. |
| `GET /api/v1/pricing` | bảng giá cho extension: v1 mặc định (client cũ), `?schema=v2` cho 0.8+. `X-Ingest-Key`. |
| `GET /` · `GET /sessions` | dashboard member × dự án × ngày · theo session. `VIEW_KEY`. |
| `GET /api/v1/summary[.csv]?groupBy=member\|project\|key\|plan` | JSON/CSV tổng hợp. `VIEW_KEY`. |
| `GET /api/v1/breakdown.csv` · `/api/v1/sessions.csv` | CSV theo bảng. `VIEW_KEY`. |
| `GET /team?k=…` | trang PM: chỉ team của key đó. |
| `GET /api/v1/team/export.csv?k=…&from=&to=&groupBy=` | CSV của team. |
| `GET /admin?tab=pricing\|members\|teams` | quản trị. `ADMIN_KEY`. |
| `GET /healthz` | liveness. |

Bộ lọc chung: `from`, `to` (YYYY-MM-DD), `member` (id), `project`, `key` (key hash),
`plan` (`apikey` / `subscription` / tên gói). CSV có BOM UTF-8 để Excel mở đúng tiếng
Việt/Nhật; chỉ xuất tên thư mục ngắn, không xuất đường dẫn đầy đủ.

## Team / PM

1. `/admin?tab=teams` → **Tạo team + link PM**. Link `…/team?k=…` hiện **một lần** —
   gửi ngay cho PM (server chỉ lưu hash của key).
2. Tick các member của team; tuỳ chọn ghi danh sách dự án (mỗi dòng một tên) nếu team
   chỉ được xem các dự án đó.
3. PM mở link: chọn kỳ (mặc định tháng hiện tại), gom theo member / dự án / model /
   ngày / tháng / member × dự án / member × ngày / member × model, bấm **Xuất CSV**.
4. Mất link hoặc đổi PM → **Tạo key mới** (link cũ hết hiệu lực).

## Bảng giá

- Lưu ở `pricing_v2`: giá **tuyệt đối** USD / 1M token cho từng thành phần — input,
  cache đọc, cache ghi ngắn (Claude 5 phút / OpenAI 30 phút), cache ghi dài (Claude
  1 giờ / OpenAI 12 giờ), output; bậc prompt dài (ngưỡng + giá bậc, xét **từng request**);
  hệ số fast mode. Tham số chung: giá web search / 1.000 lượt, hệ số `inference_geo = us`.
- **Ngày hiệu lực**: thêm dòng giá "hiệu lực từ D" khi hãng đổi giá → chỉ ngày ≥ D tính
  theo giá mới; dòng "gốc" áp cho mọi ngày trước. Sửa một dòng → tính lại các ngày dòng
  đó phủ.
- Seed lấy từ trang giá chính thức (đọc 2026-11-27). Mỗi lần khởi động, prefix nào chưa
  có trong DB thì thêm từ seed; dòng đã có (kể cả admin sửa) **không bị ghi đè**.
- Lần nâng cấp đầu từ bảng v1 (tỉ lệ): model nào seed không có thì được chuyển đổi
  sang giá tuyệt đối, ghi chú "chuyển từ bảng giá v1". Bảng `pricing` cũ giữ nguyên để
  đối chiếu.
- Giá GPT-5.6 Sol trong seed là giá khuyến mãi tới 2026-11-30 — khi OpenAI công bố giá
  sau đó, thêm dòng `gpt-5.6-sol` hiệu lực từ 2026-12-01.

## Nâng cấp từ server 0.1 (client ≤ 0.6)

1. **Backup** `data/usage.db` (+ `-wal`, `-shm`, hoặc `PRAGMA wal_checkpoint` trước).
2. Cập nhật code cả repo, `npm install`, khởi động lại với thêm `VIEW_KEY`.
   Schema mới + view + member + bảng giá v2 tự tạo; dữ liệu v1 giữ nguyên.
3. Cài extension 0.8 cho member. Lần đẩy đầu gửi 30 ngày gần nhất.
4. Vào `/admin?tab=members` gộp các member trùng; tạo team ở `/admin?tab=teams`.

Lưu ý dữ liệu v1 cũ: delta v1 gắn cả lô vào model **cuối** của lô, nên có token bị
gán `<synthetic>` (không có giá). Sau khi máy đó backfill v2, các ngày trong cửa sổ
30 ngày được thay bằng số đúng.

## Server đọc/ghi gì

- **CHỈ** số liệu tổng hợp client gửi và metadata tài khoản (loại, gói, key hash 8 hex,
  org id, với sub/Teams/ChatGPT: email, account uuid, tên hiển thị). **KHÔNG** lưu
  API key, token OAuth/ChatGPT, prompt hay transcript.
- Bucket trông như chứa key/token thật (`sk-ant-…`, `sk-proj-…`, JWT) bị **loại riêng**
  bucket đó.
- Dữ liệu chứa email người dùng → giữ server trong LAN/VPN, đặt đủ `VIEW_KEY` / `ADMIN_KEY`.

## Lưu lịch sử & backup

- Không TTL / tự xoá. Backup = copy `data/usage.db` (cron định kỳ). Nên copy cả
  `.db-wal`/`.db-shm` hoặc `PRAGMA wal_checkpoint` trước khi copy. Server tự checkpoint
  khi tắt bằng Ctrl+C / SIGTERM.

## Test

```bash
npm test   # node:test + fastify inject, không cần chạy server thật
```

Các ca giá trong `../test/fixtures/expected.json` được chạy ở **cả** server lẫn
extension — hai bên phải ra cùng số tiền.
