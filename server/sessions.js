"use strict";
/**
 * Server-rendered per-session detail page (GET /sessions). One row per session
 * (aggregate of all its deltas), mirroring dashboard.js. Like the main dashboard,
 * "Thư mục" shows the SHORT repo name only — the full path is kept in the DB /
 * cell title, never surfaced as a column. Cost is recomputed from raw tokens.
 */

const { esc, fmtCost, fmtTokens, optionsHtml, STYLE } = require("./dashboard");

const COLSPAN = 14;

/** Compact "MM-DD HH:MM" from an ISO timestamp; falls back to the raw date. */
function fmtWhen(ts, fallbackDate) {
  if (!ts) return esc(fallbackDate || "");
  const s = String(ts);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
  if (m) return `${m[2]}-${m[3]} ${m[4]}:${m[5]}`;
  return esc(fallbackDate || s.slice(0, 16));
}

function renderSessions(rows, { from, to, member, project, key, options } = {}) {
  const opts = options || { members: [], projects: [], keys: [] };
  const total = rows.reduce((a, r) => a + (r.cost || 0), 0);
  const range = from || to ? `${esc(from || "…")} → ${esc(to || "…")}` : "tất cả thời gian";

  const filterBar = `<form class="filters" method="get" action="/sessions">
    <label>Từ <input type="date" name="from" value="${esc(from || "")}"></label>
    <label>Đến <input type="date" name="to" value="${esc(to || "")}"></label>
    <label>Member <select name="member">${optionsHtml(opts.members, member, "Tất cả")}</select></label>
    <label>Dự án <select name="project">${optionsHtml(opts.projects, project, "Tất cả")}</select></label>
    <label>Key <select name="key">${optionsHtml(opts.keys, key, "Tất cả")}</select></label>
    <button type="submit">Lọc</button>
    <a class="clear" href="/sessions?all=1">Xoá lọc (tất cả)</a>
  </form>`;

  const body = rows.length
    ? rows
        .map(
          (r) => `<tr>
        <td class="mono" title="${esc(r.session_id)}">${esc(r.sessionShort)}</td>
        <td>${esc(r.os_user)}<span class="dim"> @ ${esc(r.hostname)}</span></td>
        <td>${esc(r.tool)}</td>
        <td class="proj">${esc(r.project)}</td>
        <td class="dim" title="${esc(r.repo)}">${esc(r.repoShort)}</td>
        <td>${esc(r.auth_type)}${r.key_hash ? `<span class="dim"> · ${esc(r.key_hash)}</span>` : ""}</td>
        <td class="dim">${fmtWhen(r.first_ts, r.first_date)} → ${fmtWhen(r.last_ts, r.last_date)}</td>
        <td class="num">${esc(r.deltas)}</td>
        <td class="num">${fmtTokens(r.input)}</td>
        <td class="num">${fmtTokens(r.output)}</td>
        <td class="num">${fmtTokens(r.cache_read)}</td>
        <td class="num">${fmtTokens(r.cache_write)}</td>
        <td class="num tot">${fmtTokens(r.tokens)}</td>
        <td class="num">${fmtCost(r.cost)}</td>
      </tr>`,
        )
        .join("\n")
    : `<tr><td colspan="${COLSPAN}" class="dim">Chưa có dữ liệu.</td></tr>`;

  const qs = new URLSearchParams();
  if (from) qs.set("from", from);
  if (to) qs.set("to", to);
  if (member) qs.set("member", member);
  if (project) qs.set("project", project);
  if (key) qs.set("key", key);
  const csvHref = "/api/v1/sessions.csv" + (qs.toString() ? "?" + qs.toString() : "");

  return `<!doctype html>
<html lang="vi"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>CodeTokens — Chi tiết theo session</title>
<style>${STYLE}</style></head>
<body>
  <h1>Central Usage — chi tiết theo session</h1>
  <div class="meta">Khoảng: ${range} · Số session: <b>${rows.length}</b> · Tổng cost: <b>${fmtCost(total)}</b></div>
  ${filterBar}
  <a class="btn" href="/" style="background:#475569">← Dashboard</a>
  <a class="btn" href="${esc(csvHref)}">Export CSV</a>
  <table>
    <thead><tr>
      <th>Session</th><th>Member</th><th>Tool</th><th>Dự án</th><th>Thư mục làm việc</th>
      <th>Auth / Key</th><th>Bắt đầu → Kết thúc</th>
      <th class="num">Deltas</th>
      <th class="num">Input</th><th class="num">Output</th>
      <th class="num">Cache R</th><th class="num">Cache W</th>
      <th class="num">Tokens</th><th class="num">Cost</th>
    </tr></thead>
    <tbody>
${body}
    </tbody>
  </table>
  <p class="note">Mỗi dòng = 1 session (gộp toàn bộ delta). "Session" hiển thị id rút gọn (rê chuột để xem đầy đủ). Cost là <b>ước tính</b>, tính lại từ token thô theo <a href="/admin">bảng giá server</a>, không phải hoá đơn thật. Chỉ chứa usage đẩy khi auth = API key.</p>
</body></html>`;
}

module.exports = { renderSessions };
