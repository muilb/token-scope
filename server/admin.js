"use strict";
/**
 * Admin settings page (GET /admin): manage the pricing table used to recompute
 * cost. Protected by ADMIN_KEY (see app.js). Same visual style as the dashboard.
 */

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const STYLE = `
  body { font: 14px system-ui, sans-serif; margin: 24px; color: #1f2937; background: #f8fafc; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  h2 { font-size: 15px; margin: 24px 0 8px; }
  .meta { color: #6b7280; margin-bottom: 16px; }
  table { border-collapse: collapse; width: 100%; background: #fff; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
  th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid #eef2f7; }
  th { background: #2563eb; color: #fff; font-weight: 600; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .dim { color: #9ca3af; font-size: 12px; }
  input[type=text], input[type=number], input[type=password] { font: 13px system-ui, sans-serif; padding: 5px 8px; border: 1px solid #d1d5db; border-radius: 6px; background: #fff; width: 100%; box-sizing: border-box; }
  button { padding: 6px 12px; background: #2563eb; color: #fff; border: 0; border-radius: 6px; cursor: pointer; font-size: 13px; }
  button.danger { background: #dc2626; }
  form.row { margin: 0; }
  a.btn { display: inline-block; margin-bottom: 12px; padding: 6px 12px; background: #2563eb; color: #fff; text-decoration: none; border-radius: 6px; }
  .banner { padding: 10px 12px; border-radius: 6px; margin-bottom: 14px; }
  .banner.ok { background: #dcfce7; color: #166534; }
  .banner.err { background: #fee2e2; color: #991b1b; }
  .unpriced { background: #fff7ed; border: 1px solid #fed7aa; padding: 10px 12px; border-radius: 6px; }
  .keybar { margin-bottom: 14px; }
`;

/** The hidden admin-key field, echoed back on every form so edits stay authorized. */
function keyField(adminKey) {
  return adminKey ? `<input type="hidden" name="key" value="${esc(adminKey)}">` : "";
}

function n(v) {
  return Number(v) || 0;
}

/**
 * Render the admin page.
 *  rows      = pricing rows from listPricing()
 *  unpriced  = model names with no price (isUnpriced)
 *  adminKey  = the key value to echo into forms (so submits carry it)
 *  banner    = { kind:'ok'|'err', text } to show after an action
 */
function renderAdmin(rows, unpriced, { adminKey = "", banner } = {}) {
  const bannerHtml = banner
    ? `<div class="banner ${banner.kind === "err" ? "err" : "ok"}">${esc(banner.text)}</div>`
    : "";

  const unpricedHtml = unpriced && unpriced.length
    ? `<div class="unpriced"><b>Model chưa có giá</b> (đang tính cost = $0): ${unpriced
        .map((m) => `<code>${esc(m)}</code>`)
        .join(", ")}. Thêm giá bên dưới để tính đúng (kể cả usage cũ).</div>`
    : `<div class="dim">Mọi model trong dữ liệu đều đã có giá.</div>`;

  // HTML5 form-association: forms live outside the table; each row's inputs and
  // buttons reference their form by id via form="…". This keeps the markup valid
  // (no <form> wrapping <td>) while still allowing per-row save/delete.
  const forms = [];
  const bodyRows = (rows || [])
    .map((r, i) => {
      const saveId = `save${i}`;
      const delId = `del${i}`;
      forms.push(
        `<form id="${saveId}" method="post" action="/admin/pricing">${keyField(adminKey)}<input type="hidden" name="model_prefix" value="${esc(r.model_prefix)}"></form>`,
        `<form id="${delId}" method="post" action="/admin/pricing/delete" onsubmit="return confirm('Xoá giá ${esc(r.model_prefix)}?')">${keyField(adminKey)}<input type="hidden" name="model_prefix" value="${esc(r.model_prefix)}"></form>`,
      );
      return `<tr>
      <td>${esc(r.model_prefix)}</td>
      <td class="num"><input form="${saveId}" type="number" step="0.01" min="0" name="input_per_m" value="${n(r.input_per_m)}"></td>
      <td class="num"><input form="${saveId}" type="number" step="0.01" min="0" name="output_per_m" value="${n(r.output_per_m)}"></td>
      <td class="num"><input form="${saveId}" type="number" step="0.01" min="0" name="cache_read_ratio" value="${n(r.cache_read_ratio)}"></td>
      <td class="num"><input form="${saveId}" type="number" step="0.01" min="0" name="cache_create_ratio" value="${n(r.cache_create_ratio)}"></td>
      <td class="dim">${esc(r.updated_by || "")}${r.updated_at ? `<br>${esc(String(r.updated_at).slice(0, 10))}` : ""}</td>
      <td><button form="${saveId}" type="submit">Lưu</button> <button form="${delId}" type="submit" class="danger">Xoá</button></td>
    </tr>`;
    })
    .join("\n");

  const addForm = `<form method="post" action="/admin/pricing">
    ${keyField(adminKey)}
    <table><tbody><tr>
      <td><input type="text" name="model_prefix" placeholder="claude-… / gpt-…" required></td>
      <td class="num"><input type="number" step="0.01" min="0" name="input_per_m" value="0" required></td>
      <td class="num"><input type="number" step="0.01" min="0" name="output_per_m" value="0" required></td>
      <td class="num"><input type="number" step="0.01" min="0" name="cache_read_ratio" value="0.1"></td>
      <td class="num"><input type="number" step="0.01" min="0" name="cache_create_ratio" value="1.25"></td>
      <td colspan="2"><button type="submit">Thêm model</button></td>
    </tr></tbody></table>
  </form>`;

  return `<!doctype html>
<html lang="vi"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Admin — Bảng giá</title>
<style>${STYLE}</style></head>
<body>
  <h1>Bảng giá (quản trị)</h1>
  <div class="meta">Cost trên dashboard tính lại từ token thô × bảng giá này. Sửa giá → cả dữ liệu cũ lẫn mới đổi ngay.</div>
  <a class="btn" href="/">← Về dashboard</a>
  ${bannerHtml}
  ${unpricedHtml}
  ${forms.join("")}
  <h2>Giá theo model (prefix, khớp dài nhất thắng)</h2>
  <table>
    <thead><tr>
      <th>Model prefix</th>
      <th class="num">Input $/1M</th><th class="num">Output $/1M</th>
      <th class="num">Cache read ×</th><th class="num">Cache write ×</th>
      <th>Sửa bởi</th><th></th>
    </tr></thead>
    <tbody>
${bodyRows || `<tr><td colspan="7" class="dim">Chưa có giá.</td></tr>`}
    </tbody>
  </table>
  <h2>Thêm model mới</h2>
  ${addForm}
  <p class="dim">Cache read/write là hệ số nhân với giá input. Prefix khớp theo tiền tố, dài nhất thắng (vd <code>claude-opus-4-8</code>).</p>
</body></html>`;
}

/** Minimal login form when ADMIN_KEY is set but not supplied. */
function renderKeyPrompt() {
  return `<!doctype html>
<html lang="vi"><head><meta charset="utf-8"><title>Admin</title><style>${STYLE}</style></head>
<body>
  <h1>Nhập ADMIN_KEY</h1>
  <form method="get" action="/admin" class="keybar">
    <input type="password" name="key" placeholder="ADMIN_KEY" autofocus style="max-width:320px">
    <button type="submit">Vào</button>
  </form>
  <p class="dim">Khoá quản trị bảng giá, khác với X-Ingest-Key của client.</p>
</body></html>`;
}

module.exports = { renderAdmin, renderKeyPrompt, esc };
