"use strict";
/**
 * Admin pages (GET /admin?tab=pricing|members|teams), ADMIN_KEY-gated in app.js.
 *  - pricing: pricing v2 rows (absolute $/1M per component, dated), globals
 *  - members: everyone seen by the server; rename, set email, merge duplicates
 *  - teams:   create teams, pick members/projects, issue the PM link key
 */
const { esc, STYLE } = require("./dashboard");

const ADMIN_STYLE = `
  ${STYLE}
  .tabs { display: flex; gap: 6px; margin: 8px 0 14px; }
  .tabs a { padding: 6px 12px; border-radius: 6px; background: #e5e7eb; color: #111827; text-decoration: none; }
  .tabs a.on { background: #2563eb; color: #fff; }
  input[type=text], input[type=number], input[type=password], input[type=email], input[type=date], textarea, select {
    font: 13px system-ui, sans-serif; padding: 4px 6px; border: 1px solid #d1d5db; border-radius: 6px; background: #fff; box-sizing: border-box; }
  td input[type=number] { width: 74px; }
  td input.wide, textarea { width: 100%; }
  button { padding: 5px 10px; background: #2563eb; color: #fff; border: 0; border-radius: 6px; cursor: pointer; font-size: 12.5px; }
  button.danger { background: #dc2626; }
  button.muted { background: #475569; }
  .banner { padding: 10px 12px; border-radius: 6px; margin-bottom: 14px; }
  .banner.ok { background: #dcfce7; color: #166534; }
  .banner.err { background: #fee2e2; color: #991b1b; }
  .warn { background: #fff7ed; border: 1px solid #fed7aa; padding: 10px 12px; border-radius: 6px; margin-bottom: 12px; }
  .keybox { background: #fefce8; border: 1px solid #fde68a; padding: 12px; border-radius: 6px; margin-bottom: 14px; word-break: break-all; }
  .card { background: #fff; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,.08); padding: 12px 14px; margin-bottom: 12px; }
  .checks { display: flex; flex-wrap: wrap; gap: 4px 14px; max-height: 180px; overflow: auto; padding: 6px 0; }
  .checks label { font-size: 12.5px; white-space: nowrap; }
  th.sub { background: #3b82f6; font-size: 11.5px; }
`;

function keyField(adminKey) {
  return adminKey ? `<input type="hidden" name="key" value="${esc(adminKey)}">` : "";
}

function numVal(v) {
  return v === null || v === undefined ? "" : String(v);
}

const PRICE_NUM_COLS = [
  ["input", "Input"],
  ["cached_input", "Cache đọc"],
  ["cache_write_short", "Cache ghi ngắn"],
  ["cache_write_long", "Cache ghi dài"],
  ["output", "Output"],
  ["fast_multiplier", "Fast ×"],
  ["tier_threshold", "Ngưỡng prompt"],
  ["tier_input", "Input"],
  ["tier_cached_input", "Cache đọc"],
  ["tier_cache_write_short", "Ghi ngắn"],
  ["tier_cache_write_long", "Ghi dài"],
  ["tier_output", "Output"],
];

function pricingTab(o) {
  const forms = [];
  const rows = (o.pricingRows || [])
    .map((r, i) => {
      const save = `ps${i}`;
      const del = `pd${i}`;
      const from = r.effective_from === "0000-00-00" ? "" : r.effective_from;
      forms.push(
        `<form id="${save}" method="post" action="/admin/pricing">${keyField(o.adminKey)}<input type="hidden" name="model_prefix" value="${esc(r.model_prefix)}"><input type="hidden" name="effective_from" value="${esc(from)}"></form>`,
        `<form id="${del}" method="post" action="/admin/pricing/delete" onsubmit="return confirm('Xoá giá ${esc(r.model_prefix)} ${esc(from)}?')">${keyField(o.adminKey)}<input type="hidden" name="model_prefix" value="${esc(r.model_prefix)}"><input type="hidden" name="effective_from" value="${esc(r.effective_from)}"></form>`,
      );
      return `<tr>
        <td><b>${esc(r.model_prefix)}</b><div class="dim">${esc(r.provider || "")}</div></td>
        <td>${from ? esc(from) : '<span class="dim">gốc</span>'}</td>
        ${PRICE_NUM_COLS.map(([c]) => `<td class="num"><input form="${save}" type="number" step="any" min="0" name="${c}" value="${esc(numVal(r[c]))}"></td>`).join("")}
        <td><input form="${save}" type="text" class="wide" name="note" value="${esc(r.note || "")}"><div class="dim">${esc(r.updated_by || "")} ${esc(String(r.updated_at || "").slice(0, 10))}</div></td>
        <td style="white-space:nowrap"><button form="${save}" type="submit">Lưu</button> <button form="${del}" type="submit" class="danger">Xoá</button></td>
      </tr>`;
    })
    .join("\n");

  const g = Object.fromEntries((o.globals || []).map((x) => [x.key, x.value]));
  const unpriced = o.unpriced && o.unpriced.length
    ? `<div class="warn"><b>Model API key chưa có giá</b> (đang tính $0): ${o.unpriced.map((m) => `<code>${esc(m)}</code>`).join(", ")}. Thêm dòng giá bên dưới — cả usage cũ cũng được tính lại.</div>`
    : `<div class="dim" style="margin-bottom:10px">Mọi model API key trong dữ liệu đều đã có giá.</div>`;

  return `
  ${unpriced}
  ${forms.join("")}
  <div class="card">
    <form method="post" action="/admin/globals" style="display:flex;gap:16px;align-items:end;flex-wrap:wrap">
      ${keyField(o.adminKey)}
      <label>Web search ($ / 1.000 lượt)<br><input type="number" step="any" min="0" name="webSearchPer1k" value="${esc(numVal(g.webSearchPer1k))}"></label>
      <label>Hệ số inference_geo = us<br><input type="number" step="any" min="0" name="inferenceGeoUsMultiplier" value="${esc(numVal(g.inferenceGeoUsMultiplier))}"></label>
      <button type="submit">Lưu tham số chung</button>
    </form>
  </div>
  <h2>Giá theo model — USD / 1M token</h2>
  <div style="overflow-x:auto">
  <table>
    <thead>
      <tr><th rowspan="2">Prefix model</th><th rowspan="2">Hiệu lực từ</th><th colspan="6">Giá thường</th><th colspan="6">Bậc prompt dài (theo từng request)</th><th rowspan="2">Ghi chú</th><th rowspan="2"></th></tr>
      <tr>${PRICE_NUM_COLS.map(([, l]) => `<th class="sub num">${esc(l)}</th>`).join("")}</tr>
    </thead>
    <tbody>
${rows || `<tr><td colspan="16" class="dim">Chưa có giá.</td></tr>`}
    </tbody>
  </table>
  </div>
  <h2>Thêm dòng giá (model mới, hoặc giá mới từ một ngày)</h2>
  <form method="post" action="/admin/pricing" class="card">
    ${keyField(o.adminKey)}
    <div style="display:flex;flex-wrap:wrap;gap:10px;align-items:end">
      <label>Provider<br><select name="provider"><option>anthropic</option><option>openai</option><option value="">khác</option></select></label>
      <label>Prefix model<br><input type="text" name="model_prefix" placeholder="claude-… / gpt-…" required></label>
      <label>Hiệu lực từ (trống = gốc)<br><input type="date" name="effective_from"></label>
      ${PRICE_NUM_COLS.map(([c, l]) => `<label>${esc(l)}${c.startsWith("tier_") ? " (bậc)" : ""}<br><input type="number" step="any" min="0" name="${c}"${c === "input" || c === "output" ? " required" : ""}></label>`).join("")}
      <label>Ghi chú<br><input type="text" name="note"></label>
      <button type="submit">Thêm</button>
    </div>
  </form>
  <p class="dim">Khớp theo tiền tố dài nhất (vd <code>claude-opus-5-5</code> thắng <code>claude-opus-5</code>). Một ngày D dùng dòng có "hiệu lực từ" gần nhất ≤ D; dòng "gốc" áp cho mọi ngày trước đó. Ô cache trống: đọc = giá input, ghi ngắn = 1,25×, ghi dài = 2×. Claude: ghi ngắn = cache 5 phút, ghi dài = 1 giờ. Chỉ usage API key bị tính tiền; gói sub/Teams chỉ thống kê token.</p>`;
}

function memberOptions(members, selected) {
  return members
    .map((m) => `<option value="${m.member_id}"${m.member_id === selected ? " selected" : ""}>${esc(m.display_name || m.email || m.keys || "#" + m.member_id)} (#${m.member_id})</option>`)
    .join("");
}

function membersTab(o) {
  const ms = o.members || [];
  const forms = [];
  const rows = ms
    .map((m, i) => {
      const f = `mf${i}`;
      forms.push(`<form id="${f}" method="post" action="/admin/members/update">${keyField(o.adminKey)}<input type="hidden" name="member_id" value="${m.member_id}"></form>`);
      return `<tr>
        <td>#${m.member_id}</td>
        <td><input form="${f}" type="text" class="wide" name="display_name" value="${esc(m.display_name || "")}"></td>
        <td><input form="${f}" type="email" class="wide" name="email" value="${esc(m.email || "")}"></td>
        <td class="dim mono" style="max-width:340px">${esc(m.keys || "")}</td>
        <td class="dim">${esc(m.teams || "")}</td>
        <td class="dim">${esc(m.last_seen || "")}</td>
        <td><button form="${f}" type="submit">Lưu</button></td>
      </tr>`;
    })
    .join("\n");
  return `
  ${forms.join("")}
  <div class="card">
    <form method="post" action="/admin/members/merge" style="display:flex;gap:10px;align-items:end;flex-wrap:wrap" onsubmit="return confirm('Gộp hai member? Không hoàn tác được.')">
      ${keyField(o.adminKey)}
      <label>Gộp member<br><select name="from_id">${memberOptions(ms)}</select></label>
      <label>vào member<br><select name="into_id">${memberOptions(ms)}</select></label>
      <button type="submit" class="muted">Gộp</button>
    </form>
    <p class="dim">Một người có thể xuất hiện nhiều lần (tài khoản Claude, ChatGPT, API key trên từng máy). Server tự gộp khi trùng email; còn lại gộp tay ở đây.</p>
  </div>
  <table>
    <thead><tr><th>ID</th><th>Tên hiển thị</th><th>Email</th><th>Danh tính đã thấy</th><th>Team</th><th>Thấy lần cuối</th><th></th></tr></thead>
    <tbody>
${rows || `<tr><td colspan="7" class="dim">Chưa có member.</td></tr>`}
    </tbody>
  </table>`;
}

function teamsTab(o) {
  const ms = o.members || [];
  const keyBox = o.newTeamKey
    ? `<div class="keybox"><b>Link cho PM của team ${esc(o.newTeamKeyFor)}</b> — chỉ hiện MỘT lần, hãy gửi ngay:<br><code>/team?k=${esc(o.newTeamKey)}</code><br><span class="dim">Ghép với địa chỉ server, vd <code>http://server-noi-bo:8787/team?k=${esc(o.newTeamKey)}</code>. Mất link thì bấm "Tạo key mới".</span></div>`
    : "";
  const cards = (o.teams || [])
    .map(
      (t) => `<div class="card">
      <form method="post" action="/admin/teams/update">
        ${keyField(o.adminKey)}
        <input type="hidden" name="team_id" value="${t.team_id}">
        <div style="display:flex;gap:10px;align-items:end;flex-wrap:wrap">
          <label>Tên team<br><input type="text" name="name" value="${esc(t.name)}"></label>
          <button type="submit">Lưu team</button>
        </div>
        <div style="margin-top:8px"><b>Member</b> (${t.member_ids.length})</div>
        <div class="checks">${ms
          .map(
            (m) => `<label><input type="checkbox" name="member_ids" value="${m.member_id}"${t.member_ids.includes(m.member_id) ? " checked" : ""}> ${esc(m.display_name || m.email || m.keys || "#" + m.member_id)}</label>`,
          )
          .join("")}</div>
        <div style="margin-top:6px"><b>Chỉ tính các dự án</b> <span class="dim">(để trống = mọi dự án của member; mỗi dòng một tên)</span></div>
        <textarea name="projects" rows="2" list="known-projects">${esc(t.projects.join("\n"))}</textarea>
      </form>
      <div style="margin-top:8px;display:flex;gap:8px">
        <form method="post" action="/admin/teams/rekey" onsubmit="return confirm('Tạo key mới? Link cũ của PM sẽ hết hiệu lực.')">${keyField(o.adminKey)}<input type="hidden" name="team_id" value="${t.team_id}"><button type="submit" class="muted">Tạo key mới (link PM)</button></form>
        <form method="post" action="/admin/teams/delete" onsubmit="return confirm('Xoá team ${esc(t.name)}?')">${keyField(o.adminKey)}<input type="hidden" name="team_id" value="${t.team_id}"><button type="submit" class="danger">Xoá team</button></form>
      </div>
    </div>`,
    )
    .join("\n");
  return `
  ${keyBox}
  <div class="card">
    <form method="post" action="/admin/teams/create" style="display:flex;gap:10px;align-items:end">
      ${keyField(o.adminKey)}
      <label>Team mới<br><input type="text" name="name" placeholder="Tên team / dự án" required></label>
      <button type="submit">Tạo team + link PM</button>
    </form>
  </div>
  <datalist id="known-projects">${(o.projects || []).map((p) => `<option value="${esc(p)}">`).join("")}</datalist>
  <p class="dim">Dự án đang có trong dữ liệu: ${(o.projects || []).map((p) => `<code>${esc(p)}</code>`).join(" ") || "—"}</p>
  ${cards || `<div class="dim">Chưa có team.</div>`}`;
}

function renderAdmin(o) {
  const tab = ["pricing", "members", "teams"].includes(o.tab) ? o.tab : "pricing";
  const k = o.adminKey ? `&key=${encodeURIComponent(o.adminKey)}` : "";
  const banner = o.banner ? `<div class="banner ${o.banner.kind === "err" ? "err" : "ok"}">${esc(o.banner.text)}</div>` : "";
  const content = tab === "members" ? membersTab(o) : tab === "teams" ? teamsTab(o) : pricingTab(o);
  return `<!doctype html>
<html lang="vi"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Admin — CodeTokens</title>
<style>${ADMIN_STYLE}</style></head>
<body>
  <h1>Quản trị</h1>
  <a class="btn" href="/">← Dashboard</a>
  <div class="tabs">
    <a href="/admin?tab=pricing${k}" class="${tab === "pricing" ? "on" : ""}">Bảng giá</a>
    <a href="/admin?tab=members${k}" class="${tab === "members" ? "on" : ""}">Member</a>
    <a href="/admin?tab=teams${k}" class="${tab === "teams" ? "on" : ""}">Team / PM</a>
  </div>
  ${banner}
  ${content}
</body></html>`;
}

function renderKeyPrompt() {
  return `<!doctype html>
<html lang="vi"><head><meta charset="utf-8"><title>Admin</title><style>${ADMIN_STYLE}</style></head>
<body>
  <h1>Nhập ADMIN_KEY</h1>
  <form method="get" action="/admin">
    <input type="password" name="key" placeholder="ADMIN_KEY" autofocus style="max-width:320px">
    <button type="submit">Vào</button>
  </form>
  <p class="dim">Khoá quản trị, khác X-Ingest-Key của client và VIEW_KEY của trang tổng hợp.</p>
</body></html>`;
}

module.exports = { renderAdmin, renderKeyPrompt, esc };
