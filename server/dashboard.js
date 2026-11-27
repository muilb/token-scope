"use strict";
/**
 * Server-rendered dashboard (GET /): member × project × day. "Thư mục làm việc"
 * shows the SHORT repo name only (basename), never the full path. Money is shown
 * for API-key usage only; subscription / Teams usage shows tokens and "—".
 */

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtCost(n) {
  return n == null ? "—" : "$" + (Number(n) || 0).toFixed(2);
}

function fmtTokens(n) {
  const v = Number(n) || 0;
  if (v >= 1e9) return (v / 1e9).toFixed(2) + "B";
  if (v >= 1e6) return (v / 1e6).toFixed(2) + "M";
  if (v >= 1e3) return (v / 1e3).toFixed(1) + "K";
  return String(v);
}

/** <option> list; values may be strings or {value,label}. First entry = "all". */
function optionsHtml(values, selected, allLabel) {
  const opts = [`<option value="">${esc(allLabel)}</option>`];
  for (const v of values || []) {
    const value = typeof v === "object" ? v.value : v;
    const label = typeof v === "object" ? v.label : v;
    const sel = String(value) === String(selected ?? "") ? " selected" : "";
    opts.push(`<option value="${esc(value)}"${sel}>${esc(label)}</option>`);
  }
  return opts.join("");
}

const STYLE = `
  body { font: 14px system-ui, sans-serif; margin: 24px; color: #1f2937; background: #f8fafc; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  h2 { font-size: 15px; margin: 22px 0 8px; }
  .meta { color: #4b5563; margin-bottom: 16px; line-height: 1.6; }
  table { border-collapse: collapse; width: 100%; background: #fff; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
  th, td { text-align: left; padding: 7px 10px; border-bottom: 1px solid #eef2f7; }
  th { background: #2563eb; color: #fff; font-weight: 600; font-size: 13px; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .num.tot { font-weight: 600; }
  .proj { font-weight: 600; }
  .dim { color: #9ca3af; font-size: 12px; }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .pill { display: inline-block; padding: 1px 7px; border-radius: 99px; font-size: 11.5px; background: #eef2ff; color: #3730a3; }
  .pill.api { background: #ecfdf5; color: #065f46; }
  a.btn { display: inline-block; margin: 0 6px 12px 0; padding: 6px 12px; background: #2563eb; color: #fff; text-decoration: none; border-radius: 6px; }
  .note { margin-top: 16px; color: #6b7280; font-size: 12px; line-height: 1.5; }
  .filters { display: flex; flex-wrap: wrap; gap: 10px 16px; align-items: end; margin-bottom: 14px; padding: 12px; background: #fff; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
  .filters label { display: flex; flex-direction: column; font-size: 12px; color: #6b7280; gap: 4px; }
  .filters input, .filters select { font: 13px system-ui, sans-serif; padding: 5px 8px; border: 1px solid #d1d5db; border-radius: 6px; background: #fff; }
  .filters button { padding: 6px 14px; background: #2563eb; color: #fff; border: 0; border-radius: 6px; cursor: pointer; font-size: 13px; }
  .filters a.clear { align-self: center; color: #6b7280; font-size: 12px; text-decoration: none; }
  .kpis { display: flex; flex-wrap: wrap; gap: 12px; margin-bottom: 14px; }
  .kpi { background: #fff; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,.08); padding: 10px 14px; min-width: 150px; }
  .kpi b { display: block; font-size: 18px; margin-top: 2px; font-variant-numeric: tabular-nums; }
  .kpi span { color: #6b7280; font-size: 12px; }
`;

function planPill(plan) {
  if (!plan) return "";
  return plan
    .split(", ")
    .map((p) => `<span class="pill${p === "apikey" ? " api" : ""}">${esc(p)}</span>`)
    .join(" ");
}

function kpis(t) {
  return `<div class="kpis">
    <div class="kpi"><span>Tổng token</span><b>${fmtTokens(t.tokens)}</b></div>
    <div class="kpi"><span>Token sub / Teams</span><b>${fmtTokens(t.sub_tokens)}</b></div>
    <div class="kpi"><span>Token API key</span><b>${fmtTokens(t.api_tokens)}</b></div>
    <div class="kpi"><span>Chi phí API key</span><b>${fmtCost(t.cost)}</b></div>
    <div class="kpi"><span>Requests</span><b>${(t.requests || 0).toLocaleString("en-US")}</b></div>
  </div>`;
}

function cacheWriteCell(r) {
  return `<td class="num" title="5 phút: ${r.cache_write_5m.toLocaleString("en-US")} · 1 giờ: ${r.cache_write_1h.toLocaleString("en-US")}">${fmtTokens(r.cache_write)}</td>`;
}

function filterBar(action, f, opts) {
  return `<form class="filters" method="get" action="${action}">
    <label>Từ <input type="date" name="from" value="${esc(f.from || "")}"></label>
    <label>Đến <input type="date" name="to" value="${esc(f.to || "")}"></label>
    <label>Member <select name="member">${optionsHtml(opts.members, f.member, "Tất cả")}</select></label>
    <label>Dự án <select name="project">${optionsHtml(opts.projects, f.project, "Tất cả")}</select></label>
    <label>Loại tài khoản <select name="plan">${optionsHtml(
      [{ value: "subscription", label: "Sub / Teams (mọi gói)" }, { value: "apikey", label: "API key" }, ...(opts.plans || []).filter((p) => p !== "apikey")],
      f.plan,
      "Tất cả",
    )}</select></label>
    <label>Key <select name="key">${optionsHtml(opts.keys, f.key, "Tất cả")}</select></label>
    <button type="submit">Lọc</button>
    <a class="clear" href="${action}?all=1">Xoá lọc (tất cả)</a>
  </form>`;
}

function qsOf(f) {
  const qs = new URLSearchParams();
  for (const k of ["from", "to", "member", "project", "key", "plan"]) if (f[k]) qs.set(k, f[k]);
  return qs.toString() ? "?" + qs.toString() : "";
}

function renderDashboard(rows, f = {}) {
  const opts = f.options || { members: [], projects: [], keys: [], plans: [] };
  const t = f.totals || { tokens: 0, sub_tokens: 0, api_tokens: 0, cost: 0, requests: 0 };
  const range = f.from || f.to ? `${esc(f.from || "…")} → ${esc(f.to || "…")}` : "tất cả thời gian";

  const body = rows.length
    ? rows
        .map(
          (r) => `<tr>
        <td>${esc(r.member_label)}<div class="dim">${esc(r.hostname)}</div></td>
        <td>${planPill(r.plan)}</td>
        <td class="proj">${esc(r.project)}</td>
        <td class="dim" title="${esc(r.repo)}">${esc(r.repoShort)}</td>
        <td>${esc(r.date)}</td>
        <td class="num">${r.requests ? r.requests.toLocaleString("en-US") : "—"}</td>
        <td class="num">${fmtTokens(r.input)}</td>
        <td class="num">${fmtTokens(r.output)}</td>
        <td class="num">${fmtTokens(r.cache_read)}</td>
        ${cacheWriteCell(r)}
        <td class="num tot">${fmtTokens(r.tokens)}</td>
        <td class="num">${fmtCost(r.cost)}</td>
      </tr>`,
        )
        .join("\n")
    : `<tr><td colspan="12" class="dim">Chưa có dữ liệu.</td></tr>`;

  return `<!doctype html>
<html lang="vi"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>CodeTokens — Central Usage</title>
<style>${STYLE}</style></head>
<body>
  <h1>Central Usage — member × dự án × ngày</h1>
  <div class="meta">Khoảng: ${range}</div>
  ${kpis(t)}
  ${filterBar("/", f, opts)}
  <a class="btn" href="/api/v1/breakdown.csv${esc(qsOf(f))}">Export CSV</a>
  <a class="btn" href="/sessions${esc(qsOf(f))}" style="background:#0891b2">Chi tiết theo session</a>
  <a class="btn" href="/admin" style="background:#475569">Quản trị</a>
  <table>
    <thead><tr>
      <th>Member</th><th>Loại TK</th><th>Dự án</th><th>Thư mục làm việc</th><th>Ngày</th>
      <th class="num">Requests</th>
      <th class="num">Input</th><th class="num">Output</th>
      <th class="num">Cache đọc</th><th class="num">Cache ghi</th>
      <th class="num">Tokens</th><th class="num">Chi phí (API key)</th>
    </tr></thead>
    <tbody>
${body}
    </tbody>
  </table>
  <p class="note">"Member" = người dùng: tài khoản Claude/ChatGPT (email) với gói sub/Teams; với API key là email khai trong setting <code>tokenscope.owner</code>, nếu không có thì OS user. Gói sub/Teams là phí cố định nên <b>chỉ thống kê token</b>, cột chi phí để "—". Chi phí API key tính lại từ token thô theo <a href="/admin">bảng giá server</a> (giá niêm yết, không phải hoá đơn). Rê chuột lên "Cache ghi" để xem tách 5 phút / 1 giờ.</p>
</body></html>`;
}

function renderViewKeyPrompt(action) {
  return `<!doctype html>
<html lang="vi"><head><meta charset="utf-8"><title>CodeTokens — cần key</title><style>${STYLE}</style></head>
<body>
  <h1>Nhập VIEW_KEY</h1>
  <form method="get" action="${esc(action || "/")}" class="filters">
    <input type="password" name="vk" placeholder="VIEW_KEY" autofocus style="max-width:320px">
    <button type="submit">Xem</button>
  </form>
  <p class="dim">Trang tổng hợp toàn công ty. PM xem số liệu team mình qua link riêng <code>/team?k=…</code> do quản trị cấp.</p>
</body></html>`;
}

module.exports = { renderDashboard, renderViewKeyPrompt, esc, fmtCost, fmtTokens, optionsHtml, planPill, kpis, cacheWriteCell, filterBar, qsOf, STYLE };
