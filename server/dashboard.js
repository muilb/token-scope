"use strict";
/**
 * Server-rendered dashboard (GET /). Main axis = project; "Thư mục làm việc"
 * shows the SHORT repo name only (basename), never the full path — enough for a
 * manager to see whether a member spent tokens on a company project or something
 * personal, without exposing the full directory. Full repo stays in the DB.
 */

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtCost(n) {
  return "$" + (Number(n) || 0).toFixed(2);
}

function fmtTokens(n) {
  const v = Number(n) || 0;
  return v >= 1000 ? (v / 1000).toFixed(0) + "K" : String(v);
}

/** <option> list with the current value pre-selected; first entry = "all". */
function optionsHtml(values, selected, allLabel) {
  const opts = [`<option value="">${esc(allLabel)}</option>`];
  for (const v of values || []) {
    const sel = v === selected ? " selected" : "";
    opts.push(`<option value="${esc(v)}"${sel}>${esc(v)}</option>`);
  }
  return opts.join("");
}

function renderDashboard(rows, { from, to, member, project, key, options } = {}) {
  const opts = options || { members: [], projects: [], keys: [] };
  const total = rows.reduce((a, r) => a + (r.cost || 0), 0);
  const range = from || to ? `${esc(from || "…")} → ${esc(to || "…")}` : "tất cả thời gian";

  const filterBar = `<form class="filters" method="get" action="/">
    <label>Từ <input type="date" name="from" value="${esc(from || "")}"></label>
    <label>Đến <input type="date" name="to" value="${esc(to || "")}"></label>
    <label>Member <select name="member">${optionsHtml(opts.members, member, "Tất cả")}</select></label>
    <label>Dự án <select name="project">${optionsHtml(opts.projects, project, "Tất cả")}</select></label>
    <label>Key <select name="key">${optionsHtml(opts.keys, key, "Tất cả")}</select></label>
    <button type="submit">Lọc</button>
    <a class="clear" href="/?all=1">Xoá lọc (tất cả)</a>
  </form>`;

  const body = rows.length
    ? rows
        .map(
          (r) => `<tr>
        <td>${esc(r.os_user)}<span class="dim"> @ ${esc(r.hostname)}</span></td>
        <td class="proj">${esc(r.project)}</td>
        <td class="dim" title="${esc(r.repo)}">${esc(r.repoShort)}</td>
        <td>${esc(r.date)}</td>
        <td>${esc(r.auth_type)}${r.key_hash ? `<span class="dim"> · ${esc(r.key_hash)}</span>` : ""}</td>
        <td class="num">${fmtTokens(r.input)}</td>
        <td class="num">${fmtTokens(r.output)}</td>
        <td class="num">${fmtTokens(r.cache_read)}</td>
        <td class="num">${fmtTokens(r.cache_write)}</td>
        <td class="num tot">${fmtTokens(r.tokens)}</td>
        <td class="num">${fmtCost(r.cost)}</td>
      </tr>`,
        )
        .join("\n")
    : `<tr><td colspan="11" class="dim">Chưa có dữ liệu.</td></tr>`;

  const qs = new URLSearchParams();
  if (from) qs.set("from", from);
  if (to) qs.set("to", to);
  if (member) qs.set("member", member);
  if (project) qs.set("project", project);
  if (key) qs.set("key", key);
  const csvHref = "/api/v1/breakdown.csv" + (qs.toString() ? "?" + qs.toString() : "");

  return `<!doctype html>
<html lang="vi"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>CodeTokens — Central Usage</title>
<style>
  body { font: 14px system-ui, sans-serif; margin: 24px; color: #1f2937; background: #f8fafc; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .meta { color: #6b7280; margin-bottom: 16px; }
  table { border-collapse: collapse; width: 100%; background: #fff; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
  th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid #eef2f7; }
  th { background: #2563eb; color: #fff; font-weight: 600; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .num.tot { font-weight: 600; }
  .proj { font-weight: 600; }
  .dim { color: #9ca3af; font-size: 12px; }
  a.btn { display: inline-block; margin-bottom: 12px; padding: 6px 12px; background: #2563eb; color: #fff; text-decoration: none; border-radius: 6px; }
  .note { margin-top: 16px; color: #9ca3af; font-size: 12px; }
  .filters { display: flex; flex-wrap: wrap; gap: 10px 16px; align-items: end; margin-bottom: 14px; padding: 12px; background: #fff; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
  .filters label { display: flex; flex-direction: column; font-size: 12px; color: #6b7280; gap: 4px; }
  .filters input, .filters select { font: 13px system-ui, sans-serif; padding: 5px 8px; border: 1px solid #d1d5db; border-radius: 6px; background: #fff; }
  .filters button { padding: 6px 14px; background: #2563eb; color: #fff; border: 0; border-radius: 6px; cursor: pointer; font-size: 13px; }
  .filters a.clear { align-self: center; color: #6b7280; font-size: 12px; text-decoration: none; }
</style></head>
<body>
  <h1>Central Usage — member × dự án</h1>
  <div class="meta">Khoảng: ${range} · Tổng cost: <b>${fmtCost(total)}</b></div>
  ${filterBar}
  <a class="btn" href="${esc(csvHref)}">Export CSV</a>
  <a class="btn" href="/admin" style="background:#475569">Quản trị bảng giá</a>
  <table>
    <thead><tr>
      <th>Member</th><th>Dự án</th><th>Thư mục làm việc</th><th>Ngày</th>
      <th>Auth / Key</th>
      <th class="num">Input</th><th class="num">Output</th>
      <th class="num">Cache R</th><th class="num">Cache W</th>
      <th class="num">Tokens</th><th class="num">Cost</th>
    </tr></thead>
    <tbody>
${body}
    </tbody>
  </table>
  <p class="note">"Member" = OS/máy (không phải email công ty). Cost là <b>ước tính</b>, tính lại từ token thô theo <a href="/admin">bảng giá server</a> (quản trị được), không phải hoá đơn thật. Chỉ chứa usage đẩy khi auth = API key.</p>
</body></html>`;
}

module.exports = { renderDashboard };
