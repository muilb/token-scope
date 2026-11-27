"use strict";
/**
 * Server-rendered per-session page (GET /sessions). One row per session; the
 * short repo name only (full path in the cell title). Money for API-key usage
 * only.
 */
const { esc, fmtCost, fmtTokens, planPill, kpis, cacheWriteCell, filterBar, qsOf, STYLE } = require("./dashboard");

/** Compact "MM-DD HH:MM" from an ISO timestamp. */
function fmtWhen(ts) {
  if (!ts) return "";
  const m = String(ts).match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
  return m ? `${m[2]}-${m[3]} ${m[4]}:${m[5]}` : esc(String(ts).slice(0, 16));
}

function renderSessions(rows, f = {}) {
  const opts = f.options || { members: [], projects: [], keys: [], plans: [] };
  const t = f.totals || { tokens: 0, sub_tokens: 0, api_tokens: 0, cost: 0, requests: 0 };
  const range = f.from || f.to ? `${esc(f.from || "…")} → ${esc(f.to || "…")}` : "tất cả thời gian";

  const body = rows.length
    ? rows
        .map(
          (r) => `<tr>
        <td class="mono" title="${esc(r.session_id)}">${esc(r.sessionShort)}</td>
        <td>${esc(r.member_label)}<div class="dim">${esc(r.hostname)}</div></td>
        <td>${esc(r.tool)}</td>
        <td>${planPill(r.plan)}</td>
        <td class="proj">${esc(r.project)}</td>
        <td class="dim" title="${esc(r.repo)}">${esc(r.repoShort)}</td>
        <td class="dim">${fmtWhen(r.first_ts)} → ${fmtWhen(r.last_ts)}</td>
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
    : `<tr><td colspan="14" class="dim">Chưa có dữ liệu.</td></tr>`;

  return `<!doctype html>
<html lang="vi"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>CodeTokens — Chi tiết theo session</title>
<style>${STYLE}</style></head>
<body>
  <h1>Central Usage — chi tiết theo session</h1>
  <div class="meta">Khoảng: ${range} · Số session: <b>${rows.length}</b></div>
  ${kpis(t)}
  ${filterBar("/sessions", f, opts)}
  <a class="btn" href="/${esc(qsOf(f))}" style="background:#475569">← Dashboard</a>
  <a class="btn" href="/api/v1/sessions.csv${esc(qsOf(f))}">Export CSV</a>
  <table>
    <thead><tr>
      <th>Session</th><th>Member</th><th>Tool</th><th>Loại TK</th><th>Dự án</th><th>Thư mục làm việc</th>
      <th>Bắt đầu → Kết thúc</th>
      <th class="num">Requests</th>
      <th class="num">Input</th><th class="num">Output</th>
      <th class="num">Cache đọc</th><th class="num">Cache ghi</th>
      <th class="num">Tokens</th><th class="num">Chi phí (API key)</th>
    </tr></thead>
    <tbody>
${body}
    </tbody>
  </table>
  <p class="note">Mỗi dòng = 1 session (gồm cả subagent của session đó). Gói sub/Teams chỉ thống kê token; chi phí chỉ tính cho API key theo <a href="/admin">bảng giá server</a>.</p>
</body></html>`;
}

module.exports = { renderSessions };
