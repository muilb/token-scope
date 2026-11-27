"use strict";
/**
 * Team page for project managers (GET /team?k=<team key>). The key identifies
 * ONE team; the page shows only that team's members (and only the team's
 * projects when the admin listed any). No access to other teams or to the
 * company-wide dashboard.
 */
const { esc, fmtCost, fmtTokens, planPill, kpis, cacheWriteCell, STYLE } = require("./dashboard");

/** Grouping choices offered to the PM → aggregate() dimensions. */
const TEAM_GROUPS = {
  member: { label: "Theo member", dims: ["member"] },
  project: { label: "Theo dự án", dims: ["project"] },
  model: { label: "Theo model", dims: ["model"] },
  day: { label: "Theo ngày", dims: ["date"] },
  month: { label: "Theo tháng", dims: ["month"] },
  "member-project": { label: "Member × dự án", dims: ["member", "project"] },
  "member-day": { label: "Member × ngày", dims: ["member", "date"] },
  "member-model": { label: "Member × model", dims: ["member", "model"] },
};

const COLS = {
  date: { th: "Ngày", td: (r) => esc(r.date) },
  month: { th: "Tháng", td: (r) => esc(r.month) },
  member: { th: "Member", td: (r) => `${esc(r.member_label)}${r.member_email && r.member_email !== r.member_label ? `<div class="dim">${esc(r.member_email)}</div>` : ""}` },
  project: { th: "Dự án", td: (r) => `<span class="proj">${esc(r.project)}</span>` },
  model: { th: "Model", td: (r) => `<span class="mono">${esc(r.model_name)}</span>` },
};

function sortRows(rows, dims) {
  const first = dims[0];
  return rows.sort((a, b) => {
    if (first === "date" || first === "month") {
      const x = a[first] || "";
      const y = b[first] || "";
      if (x !== y) return x < y ? 1 : -1;
    }
    return b.tokens - a.tokens;
  });
}

function renderTeam(team, rows, o) {
  const g = TEAM_GROUPS[o.groupBy] || TEAM_GROUPS.member;
  const dims = g.dims;
  const t = o.totals;
  const qs = (extra) => {
    const p = new URLSearchParams({ k: o.k, from: o.from || "", to: o.to || "", groupBy: o.groupBy, ...extra });
    return p.toString();
  };
  const groupOpts = Object.entries(TEAM_GROUPS)
    .map(([k, v]) => `<option value="${k}"${k === o.groupBy ? " selected" : ""}>${esc(v.label)}</option>`)
    .join("");
  const body = rows.length
    ? sortRows(rows, dims)
        .map(
          (r) => `<tr>
        ${dims.map((d) => `<td>${COLS[d].td(r)}</td>`).join("")}
        <td>${planPill(r.plan)}</td>
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
    : `<tr><td colspan="${dims.length + 8}" class="dim">Chưa có dữ liệu trong kỳ này.</td></tr>`;

  return `<!doctype html>
<html lang="vi"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Team ${esc(team.name)} — CodeTokens</title>
<style>${STYLE}</style></head>
<body>
  <h1>Team ${esc(team.name)}</h1>
  <div class="meta">${o.memberCount} member${o.projects.length ? ` · chỉ tính dự án: ${o.projects.map(esc).join(", ")}` : " · mọi dự án"} · Kỳ: ${esc(o.from || "…")} → ${esc(o.to || "…")}</div>
  ${kpis(t)}
  <form class="filters" method="get" action="/team">
    <input type="hidden" name="k" value="${esc(o.k)}">
    <label>Từ <input type="date" name="from" value="${esc(o.from || "")}"></label>
    <label>Đến <input type="date" name="to" value="${esc(o.to || "")}"></label>
    <label>Gom nhóm <select name="groupBy">${groupOpts}</select></label>
    <button type="submit">Xem</button>
  </form>
  <a class="btn" href="/api/v1/team/export.csv?${esc(qs({}))}">Xuất CSV (Excel)</a>
  <table>
    <thead><tr>
      ${dims.map((d) => `<th>${COLS[d].th}</th>`).join("")}
      <th>Loại TK</th>
      <th class="num">Requests</th>
      <th class="num">Input</th><th class="num">Output</th>
      <th class="num">Cache đọc</th><th class="num">Cache ghi</th>
      <th class="num">Tokens</th><th class="num">Chi phí (API key)</th>
    </tr></thead>
    <tbody>
${body}
    </tbody>
  </table>
  <p class="note">Gói sub/Teams là phí cố định: chỉ thống kê token, không tính tiền. Chi phí chỉ áp cho usage chạy bằng API key (giá niêm yết, không phải hoá đơn). File CSV mở được bằng Excel (UTF-8). Đường dẫn thư mục đầy đủ không được xuất.</p>
</body></html>`;
}

function renderTeamDenied(hadKey) {
  return `<!doctype html>
<html lang="vi"><head><meta charset="utf-8"><title>Team — CodeTokens</title><style>${STYLE}</style></head>
<body>
  <h1>${hadKey ? "Link team không hợp lệ" : "Cần link team"}</h1>
  <p class="dim">${hadKey ? "Key này không thuộc team nào (có thể quản trị đã tạo key mới). Xin link mới từ quản trị." : "Mở trang này bằng link riêng của team do quản trị cấp (dạng /team?k=…)."}</p>
</body></html>`;
}

module.exports = { renderTeam, renderTeamDenied, TEAM_GROUPS };
