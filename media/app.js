// Tokenscope â€” frontend logic
// WebSocket client + SVG chart rendering + i18n (EN / VI / JA)

// ---------------------------------------------------------------------------
// i18n
// ---------------------------------------------------------------------------
const STRINGS = {
  en: {
    subtitle: "Realtime token monitor",
    live: "Live", live2: "live",
    tokensPerMin: "Tokens / min",
    tokensToday: "Tokens today",
    since0000: "since 00:00",
    tokens: "tokens",
    estCostToday: "Est. cost today",
    activeSessions: "Active sessions",
    running: "running",
    sessionSubtitle: "context window usage - live",
    noActiveSessions: "No active sessions",
    toolComparison: "Tool comparison",
    byModel: "By model",
    tokenShareToday: "token share - today",
    cost: "Cost", requests: "Requests", cacheHit: "Cache hit", liveEst: "Live est.",
    liveTokenRate: "Live token rate",
    liveChartSubtitle: "tokens per minute - last 30 min",
    minus30m: "-30m", minus15m: "-15m", now: "now",
    tokenComposition: "Token composition",
    cacheHit2: "cache hit",
    dailyUsage: "Daily usage",
    dailySubtitle: "last 30 days - grouped by tool",
    recentSessions: "Recent sessions",
    recentSubtitle: "today's sessions",
    colTool: "Tool", colSession: "Session", colModel: "Model",
    colProject: "Project", colStatus: "Status", colTokens: "Tokens", colCost: "Cost",
    updatedAgo: (s) => `updated ${s}s ago`,
    runningN: (n) => `${n} running`,
    projOf: "of",
    ctx: "ctx",
    unknown: "unknown",
    cacheReadLabel: "Cache read",
    inputLabel: "Input",
    outputLabel: "Output",
    cacheWriteLabel: "Cache write",
    estMonthly: (v) => `~ ${v} / mo`,
    noData: "No data",
    disconnected: "Reconnecting...",
    ctxWarning: (n, proj) => `\u26a0\ufe0f Context ${n}K tokens \u2014 ${proj}`,
    ctxWarningBody: (n, max) => `${n}K / ${max}K tokens used. Consider starting a new session.`,
    ctxAlertBanner: (n, max, pct, proj) => `\u26a0\ufe0f Context ${n}K / ${max}K (${pct}%) in ${proj}`,
    allowNotify: "Allow notifications to get alerts when context is full",
  },
  vi: {
    subtitle: "Theo d\u00f5i token th\u1eddi gian th\u1ef1c",
    live: "Tr\u1ef1c ti\u1ebfp", live2: "tr\u1ef1c ti\u1ebfp",
    tokensPerMin: "Token / ph\u00fat",
    tokensToday: "Token h\u00f4m nay",
    since0000: "t\u1eeb 00:00",
    tokens: "token",
    estCostToday: "Chi ph\u00ed h\u00f4m nay (\u01b0\u1edbc t\u00ednh)",
    activeSessions: "Phi\u00ean \u0111ang ho\u1ea1t \u0111\u1ed9ng",
    running: "\u0111ang ch\u1ea1y",
    sessionSubtitle: "dung l\u01b0\u1ee3ng context - tr\u1ef1c ti\u1ebfp",
    noActiveSessions: "Kh\u00f4ng c\u00f3 phi\u00ean n\u00e0o \u0111ang ho\u1ea1t \u0111\u1ed9ng",
    toolComparison: "So s\u00e1nh c\u00f4ng c\u1ee5",
    byModel: "Theo model",
    tokenShareToday: "t\u1ef7 l\u1ec7 token - h\u00f4m nay",
    cost: "Chi ph\u00ed", requests: "Y\u00eau c\u1ea7u", cacheHit: "Cache hit",
    liveTokenRate: "T\u1ed1c \u0111\u1ed9 token tr\u1ef1c ti\u1ebfp",
    liveChartSubtitle: "token m\u1ed7i ph\u00fat - 30 ph\u00fat qua",
    minus30m: "-30 ph\u00fat", minus15m: "-15 ph\u00fat", now: "b\u00e2y gi\u1edd",
    tokenComposition: "Ph\u00e2n t\u00edch token",
    cacheHit2: "cache hit",
    dailyUsage: "S\u1eed d\u1ee5ng h\u00e0ng ng\u00e0y",
    dailySubtitle: "30 ng\u00e0y qua - theo nh\u00f3m c\u00f4ng c\u1ee5",
    recentSessions: "Phi\u00ean g\u1ea7n \u0111\u00e2y",
    recentSubtitle: "c\u00e1c phi\u00ean h\u00f4m nay",
    colTool: "C\u00f4ng c\u1ee5", colSession: "Phi\u00ean", colModel: "Model",
    colProject: "D\u1ef1 \u00e1n", colStatus: "Tr\u1ea1ng th\u00e1i", colTokens: "Token", colCost: "Chi ph\u00ed",
    updatedAgo: (s) => `c\u1eadp nh\u1eadt ${s}s tr\u01b0\u1edbc`,
    runningN: (n) => `${n} \u0111ang ch\u1ea1y`,
    projOf: "/",
    ctx: "ctx",
    unknown: "kh\u00f4ng r\u00f5",
    cacheReadLabel: "Cache read",
    inputLabel: "\u0110\u1ea7u v\u00e0o",
    outputLabel: "\u0110\u1ea7u ra",
    cacheWriteLabel: "Cache write",
    estMonthly: (v) => `~ ${v} / th\u00e1ng`,
    noData: "Ch\u01b0a c\u00f3 d\u1eef li\u1ec7u",
    disconnected: "\u0110ang k\u1ebft n\u1ed1i l\u1ea1i...",
    ctxWarning: (n, proj) => `\u26a0\ufe0f Context ${n}K token \u2014 ${proj}`,
    ctxWarningBody: (n, max) => `${n}K / ${max}K token \u0111\u00e3 d\u00f9ng. N\u00ean b\u1eaft \u0111\u1ea7u phi\u00ean m\u1edbi.`,
    ctxAlertBanner: (n, max, pct, proj) => `\u26a0\ufe0f Context ${n}K / ${max}K (${pct}%) trong ${proj}`,
    allowNotify: "Ch\u1ea5p nh\u1eadn th\u00f4ng b\u00e1o \u0111\u1ec3 nh\u1eadn c\u1ea3nh b\u00e1o khi context g\u1ea7n \u0111\u1ea7y",
  },
  ja: {
    subtitle: "\u30ea\u30a2\u30eb\u30bf\u30a4\u30e0\u30c8\u30fc\u30af\u30f3\u30e2\u30cb\u30bf\u30fc",
    live: "\u30e9\u30a4\u30d6", live2: "\u30e9\u30a4\u30d6",
    tokensPerMin: "\u30c8\u30fc\u30af\u30f3 / \u5206",
    tokensToday: "\u672c\u65e5\u306e\u30c8\u30fc\u30af\u30f3",
    since0000: "00:00\u304b\u3089",
    tokens: "\u30c8\u30fc\u30af\u30f3",
    estCostToday: "\u672c\u65e5\u306e\u63a8\u5b9a\u30b3\u30b9\u30c8",
    activeSessions: "\u30a2\u30af\u30c6\u30a3\u30d6\u30bb\u30c3\u30b7\u30e7\u30f3",
    running: "\u5b9f\u884c\u4e2d",
    sessionSubtitle: "\u30b3\u30f3\u30c6\u30ad\u30b9\u30c8\u30a6\u30a3\u30f3\u30c9\u30a6\u4f7f\u7528\u91cf - \u30e9\u30a4\u30d6",
    noActiveSessions: "\u30a2\u30af\u30c6\u30a3\u30d6\u306a\u30bb\u30c3\u30b7\u30e7\u30f3\u306f\u3042\u308a\u307e\u305b\u3093",
    toolComparison: "\u30c4\u30fc\u30eb\u6bd4\u8f03",
    byModel: "\u30e2\u30c7\u30eb\u5225",
    tokenShareToday: "\u30c8\u30fc\u30af\u30f3\u5272\u5408 - \u672c\u65e5",
    cost: "\u30b3\u30b9\u30c8", requests: "\u30ea\u30af\u30a8\u30b9\u30c8", cacheHit: "\u30ad\u30e3\u30c3\u30b7\u30e5\u30d2\u30c3\u30c8",
    liveTokenRate: "\u30e9\u30a4\u30d6\u30c8\u30fc\u30af\u30f3\u30ec\u30fc\u30c8",
    liveChartSubtitle: "\u30c8\u30fc\u30af\u30f3/\u5206 - \u904e\u53bb30\u5206",
    minus30m: "-30\u5206", minus15m: "-15\u5206", now: "\u73fe\u5728",
    tokenComposition: "\u30c8\u30fc\u30af\u30f3\u69cb\u6210",
    cacheHit2: "\u30ad\u30e3\u30c3\u30b7\u30e5\u30d2\u30c3\u30c8",
    dailyUsage: "\u65e5\u6b21\u4f7f\u7528\u91cf",
    dailySubtitle: "\u904e\u53bb30\u65e5\u9593 - \u30c4\u30fc\u30eb\u5225\u30b0\u30eb\u30fc\u30d7",
    recentSessions: "\u6700\u8fd1\u306e\u30bb\u30c3\u30b7\u30e7\u30f3",
    recentSubtitle: "\u672c\u65e5\u306e\u30bb\u30c3\u30b7\u30e7\u30f3",
    colTool: "\u30c4\u30fc\u30eb", colSession: "\u30bb\u30c3\u30b7\u30e7\u30f3", colModel: "\u30e2\u30c7\u30eb",
    colProject: "\u30d7\u30ed\u30b8\u30a7\u30af\u30c8", colStatus: "\u72b6\u614b", colTokens: "\u30c8\u30fc\u30af\u30f3", colCost: "\u30b3\u30b9\u30c8",
    updatedAgo: (s) => `${s}\u79d2\u524d\u306b\u66f4\u65b0`,
    runningN: (n) => `${n}\u4ef6\u5b9f\u884c\u4e2d`,
    projOf: "/",
    ctx: "ctx",
    unknown: "\u4e0d\u660e",
    cacheReadLabel: "\u30ad\u30e3\u30c3\u30b7\u30e5\u8aad\u8fbc",
    inputLabel: "\u5165\u529b",
    outputLabel: "\u51fa\u529b",
    cacheWriteLabel: "\u30ad\u30e3\u30c3\u30b7\u30e5\u66f8\u8fbc",
    estMonthly: (v) => `~ ${v} / \u6708`,
    noData: "\u30c7\u30fc\u30bf\u306a\u3057",
    disconnected: "\u518d\u63a5\u7d9a\u4e2d...",
    ctxWarning: (n, proj) => `\u26a0\ufe0f \u30b3\u30f3\u30c6\u30ad\u30b9\u30c8 ${n}K \u30c8\u30fc\u30af\u30f3 \u2014 ${proj}`,
    ctxWarningBody: (n, max) => `${n}K / ${max}K \u30c8\u30fc\u30af\u30f3\u4f7f\u7528\u4e2d\u3002\u65b0\u3057\u3044\u30bb\u30c3\u30b7\u30e7\u30f3\u3092\u958b\u59cb\u3057\u3066\u304f\u3060\u3055\u3044\u3002`,
    ctxAlertBanner: (n, max, pct, proj) => `\u26a0\ufe0f \u30b3\u30f3\u30c6\u30ad\u30b9\u30c8 ${n}K / ${max}K (${pct}%) \u2014 ${proj}`,
    allowNotify: "\u30b3\u30f3\u30c6\u30ad\u30b9\u30c8\u304c\u6e80\u676f\u306b\u306a\u3063\u305f\u3068\u304d\u901a\u77e5\u3092\u53d7\u3051\u53d6\u308b\u306b\u306f\u8a31\u53ef\u3057\u3066\u304f\u3060\u3055\u3044",
  },
};

let lang = localStorage.getItem("tokenscope-lang") || "en";
const t = (key, ...args) => {
  if (key === "liveEst") {
    const localized = STRINGS[lang]?.[key];
    if (localized != null) return typeof localized === "function" ? localized(...args) : localized;
    return "Live est.";
  }
  const s = STRINGS[lang]?.[key] ?? STRINGS.en[key] ?? key;
  return typeof s === "function" ? s(...args) : s;
};

function applyI18n() {
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    const key = el.dataset.i18n;
    el.textContent = t(key);
  });
  document.querySelectorAll(".lang-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.lang === lang);
  });
}

document.querySelectorAll(".lang-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    lang = btn.dataset.lang;
    localStorage.setItem("tokenscope-lang", lang);
    applyI18n();
    if (_lastState) render(_lastState);
  });
});

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------
// Client-side pricing mirror (input/M, output/M, cache_read ratio, cache_create ratio)
const _PRICING = {
  "claude-sonnet-4-6":  [3.00, 15.00, 0.10, 1.25],
  "claude-sonnet-4-5":  [3.00, 15.00, 0.10, 1.25],
  "claude-haiku-4-5":   [1.00,  5.00, 0.10, 1.25],
  "claude-haiku-4-6":   [1.00,  5.00, 0.10, 1.25],
  "claude-opus-4-8":    [5.00, 25.00, 0.10, 1.25],
  "claude-opus-4-7":    [5.00, 25.00, 0.10, 1.25],
  "claude-opus-4-6":    [5.00, 25.00, 0.10, 1.25],
  "claude-fable-5":    [10.00, 50.00, 0.10, 1.25],
  "gpt-5.5":            [5.00, 30.00, 0.10, 0.00],
  "gpt-5.4-mini":       [0.75,  4.50, 0.10, 0.00],
  "gpt-5.4":            [2.50, 15.00, 0.10, 0.00],
  "gpt-5.3-codex":      [2.50, 15.00, 0.10, 0.00],
  "gpt-5.3":            [2.50, 15.00, 0.10, 0.00],
};

function _getPricing(model) {
  const m = (model || "").toLowerCase();
  let bestKey = "", best = null;
  for (const [k, v] of Object.entries(_PRICING)) {
    if (m.startsWith(k) && k.length > bestKey.length) { bestKey = k; best = v; }
  }
  return best || [0, 0, 0, 0];
}

function _computeCost(inp, out, cr, cc, model) {
  const [inpM, outM, crR, ccR] = _getPricing(model);
  return inp / 1e6 * inpM + out / 1e6 * outM + cr / 1e6 * inpM * crR + cc / 1e6 * inpM * ccR;
}

const fmtTok = (n) => {
  if (!n && n !== 0) return "-";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
  if (n >= 1_000)     return (n / 1_000).toFixed(1) + "K";
  return String(n);
};
const fmtCost = (v) => v == null ? "$-" : `$${v.toFixed(2)}`;
const fmtPct  = (v) => v == null ? "-" : `${v.toFixed(1)}%`;

// ---------------------------------------------------------------------------
// SVG chart helpers
// ---------------------------------------------------------------------------
function sparkline(vals, w = 120, h = 34, pad = 4) {
  if (!vals || vals.length < 2) return { line: "", area: "" };
  const min = Math.min(...vals), max = Math.max(...vals);
  const X = (i) => pad + (i / (vals.length - 1)) * (w - 2 * pad);
  const Y = (v) => h - pad - (max === min ? 0.5 : (v - min) / (max - min)) * (h - 2 * pad);
  const pts = vals.map((v, i) => `${X(i).toFixed(1)},${Y(v).toFixed(1)}`);
  const line = pts.join(" ");
  const area =
    `M${X(0).toFixed(1)},${(h - pad).toFixed(1)} ` +
    vals.map((v, i) => `L${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(" ") +
    ` L${X(vals.length - 1).toFixed(1)},${(h - pad).toFixed(1)} Z`;
  return { line, area };
}

function svgPath(vals, W, H, padL, padR, padT, padB, maxY) {
  if (!vals || vals.length < 2) return { line: "", area: "" };
  const N = vals.length;
  const LX = (i) => padL + (i / (N - 1)) * (W - padL - padR);
  const LY = (v) => H - padB - (v / maxY) * (H - padT - padB);
  const points = vals.map((v, i) => `${i === 0 ? "M" : "L"}${LX(i).toFixed(1)} ${LY(v).toFixed(1)}`);
  const line = points.join(" ");
  const area = `${line} L${LX(N - 1).toFixed(1)} ${H - padB} L${LX(0).toFixed(1)} ${H - padB} Z`;
  return { line, area };
}

// Rolling 30-minute rate history (claude and codex tpm per tick)
const RATE_HISTORY_MAX = 30;
const _claudeRateHist = Array(RATE_HISTORY_MAX).fill(0);
const _codexRateHist  = Array(RATE_HISTORY_MAX).fill(0);

function pushRate(claudeTpm, codexTpm) {
  _claudeRateHist.push(claudeTpm);
  _codexRateHist.push(codexTpm);
  if (_claudeRateHist.length > RATE_HISTORY_MAX) _claudeRateHist.shift();
  if (_codexRateHist.length  > RATE_HISTORY_MAX) _codexRateHist.shift();
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------
let _lastState = null;
let _prevTokensToday = 0;
let _tokenHistory = [];

function render(state) {
  _lastState = state;

  // KPI - tokens/min
  const tpm = state.tokens_per_min || 0;
  document.getElementById("kpi-tpm").textContent = fmtTok(tpm);

  // KPI - tokens today
  const tok = state.tokens_today || 0;
  document.getElementById("kpi-tokens").textContent = fmtTok(tok);
  _tokenHistory.push(tok);
  if (_tokenHistory.length > 10) _tokenHistory.shift();

  // KPI - cost
  const cost = state.cost_today_usd || 0;
  document.getElementById("kpi-cost").textContent = fmtCost(cost);
  const monthly = (cost * 22).toFixed(0);
  document.getElementById("kpi-cost-monthly").textContent = t("estMonthly", `$${monthly}`);

  // KPI - sessions
  const active = state.active_sessions || [];
  const trueActive = active.filter((s) => (s.status || "active") === "active");
  const idleCount  = active.length - trueActive.length;
  const sessCount  = trueActive.length;
  document.getElementById("kpi-sessions").textContent = sessCount;
  const badgeLabel = idleCount > 0
    ? `${t("runningN", sessCount)} · ${idleCount} idle`
    : t("runningN", sessCount);
  document.getElementById("session-count-badge").textContent = badgeLabel;

  // Session badges (active only)
  const ccCount = trueActive.filter((s) => _sessionTool(s) === "claude").length;
  const cxCount = trueActive.filter((s) => _sessionTool(s) === "codex").length;
  const badgesEl = document.getElementById("session-badges");
  badgesEl.innerHTML = "";
  if (ccCount > 0) {
    badgesEl.innerHTML += `<span style="display:inline-flex;align-items:center;gap:5px;font-size:11.5px;font-weight:600;color:#2563eb;background:#eff4ff;padding:4px 9px;border-radius:7px;"><span style="width:6px;height:6px;border-radius:50%;background:#2563eb;"></span>${ccCount} Claude Code</span>`;
  }
  if (cxCount > 0) {
    badgesEl.innerHTML += `<span style="display:inline-flex;align-items:center;gap:5px;font-size:11.5px;font-weight:600;color:#7c3aed;background:#f4efff;padding:4px 9px;border-radius:7px;"><span style="width:6px;height:6px;border-radius:50%;background:#7c3aed;"></span>${cxCount} Codex</span>`;
  }

  // Sparklines
  const spTpm = sparkline(_claudeRateHist);
  document.getElementById("sp-tpm-area").setAttribute("d", spTpm.area);
  document.getElementById("sp-tpm-line").setAttribute("points", spTpm.line);

  const spTok = sparkline(_tokenHistory);
  document.getElementById("sp-tok-area").setAttribute("d", spTok.area);
  document.getElementById("sp-tok-line").setAttribute("points", spTok.line);

  // Active sessions list
  renderSessionList(active);

  // Context window alerts
  checkContextAlerts(active);

  // Tool comparison
  renderToolComparison(state);

  // Live rate chart
  pushRate(
    active
      .filter((s) => _sessionTool(s) === "claude")
      .reduce((sum, x) => sum + (x.tok_per_min || 0), 0),
    active
      .filter((s) => _sessionTool(s) === "codex")
      .reduce((sum, x) => sum + (x.tok_per_min || 0), 0),
  );
  renderLiveChart();
  // Donuts (per tool)
  renderDonut("claude", state.composition_claude || {});
  renderDonut("codex", state.composition_codex || {});

  // Historical
  renderHistorical(state.historical_daily || [], state.codex_historical_daily || [], state.historical_costs || {});

  // Sessions table
  renderSessionsTable(state.active_sessions || [], state.codex_today_sessions || [], state.today_by_model || {});

  // Timestamp
  const now = new Date();
  document.getElementById("last-updated").textContent = t("updatedAgo", "0");
}

function renderSessionList(sessions) {
  const el = document.getElementById("session-list");
  if (!sessions.length) {
    el.innerHTML = `<div style="color:#9b9ba0;font-size:13px;padding:20px 0;">${t("noActiveSessions")}</div>`;
    return;
  }
  el.innerHTML = sessions.slice(0, 6).map((sess, idx) => {
    const isCodex = _sessionTool(sess) === "codex";
    const isIdle  = (sess.status || "active") === "idle";
    const windowSize = _sessionContextWindow(sess);
    const pct = windowSize > 0
      ? Math.min(Math.round((sess.ctx_tokens || 0) / windowSize * 100), 100)
      : 0;

    const color   = isIdle ? "#9b9ba0" : (isCodex ? "#7c3aed" : "#2563eb");
    const badgeBg = isIdle ? "#f5f5f7" : (isCodex ? "#f4efff" : "#eff4ff");
    const badge   = isCodex ? "CX" : "CC";
    const dot     = isIdle
      ? `<span style="width:6px;height:6px;border-radius:50%;background:#d1d1d6;"></span>`
      : `<span style="width:6px;height:6px;border-radius:50%;background:${color};animation:pulse 2s ease-out infinite;"></span>`;

    const detail = `${fmtTok(sess.ctx_tokens || 0)} ${t("projOf")} ${fmtTok(windowSize || 0)}`;
    const last = idx === sessions.length - 1 || idx === 5;

    const rightCol = isIdle
      ? `<div style="flex:0 0 58px;text-align:right;">
           <div style="font-size:11.5px;font-weight:600;color:#9b9ba0;background:#f5f5f7;border-radius:6px;padding:3px 8px;display:inline-block;">idle</div>
           <div style="font-size:11px;color:#b0b0b5;margin-top:3px;">${_agoLabel(sess.last_seen)}</div>
         </div>`
      : `<div style="flex:0 0 58px;text-align:right;">
           <div style="font-size:13px;font-weight:600;color:#1d1d1f;font-variant-numeric:tabular-nums;">${fmtTok(sess.tok_per_min)}</div>
           <div style="font-size:11px;color:#9b9ba0;">tok/min</div>
         </div>`;

    return `
    <div style="display:flex;align-items:center;gap:8px;padding:12px 2px;${last ? "" : "border-bottom:1px solid #f2f2f5;"}${isIdle ? "opacity:.7;" : ""}">
      <span style="display:inline-flex;align-items:center;gap:5px;flex:0 0 auto;padding:4px 7px;border-radius:7px;background:${badgeBg};color:${color};font-size:11px;font-weight:600;justify-content:center;">${dot}${badge}</span>
      <div style="flex:0 0 auto;min-width:64px;">
        <div style="font-family:ui-monospace,'SF Mono',Menlo,monospace;font-size:12px;color:#1d1d1f;font-weight:500;">${(sess.session_id || "").slice(0, 8)}</div>
        ${_sessionModelLabel(sess, color)}
      </div>
      <div style="flex:1 1 auto;min-width:0;">
        <div style="display:flex;justify-content:space-between;align-items:center;font-size:11.5px;margin-bottom:5px;">
          <span style="font-family:ui-monospace,Menlo,monospace;color:#6e6e73;">${detail}</span>
          <span style="font-weight:600;color:${color};">${pct}%</span>
        </div>
        <div style="height:7px;background:#eef0f3;border-radius:99px;overflow:hidden;">
          <div style="height:100%;width:${pct}%;background:${isIdle ? "#d1d1d6" : _ctxBarColor(sess.ctx_tokens || 0)};border-radius:99px;transition:width .4s;"></div>
        </div>
      </div>
      ${rightCol}
    </div>`;
  }).join("");
}

function renderToolComparison(state) {
  const claudeTok = state.claude_tokens_today || 0;
  const codexTok  = state.codex_tokens_today  || 0;
  const total = claudeTok + codexTok || 1;
  const claudePct = Math.round(claudeTok / total * 100);
  const codexPct  = 100 - claudePct;

  document.getElementById("cmp-claude-bar").style.width = claudePct + "%";
  document.getElementById("cmp-codex-bar").style.width  = codexPct  + "%";
  document.getElementById("cmp-claude-pct").textContent = `Claude Code ${claudePct}%`;
  document.getElementById("cmp-codex-pct").textContent  = `Codex ${codexPct}%`;

  document.getElementById("cmp-claude-tokens").textContent = fmtTok(claudeTok);
  document.getElementById("cmp-claude-cost").textContent   = fmtCost(state.claude_cost_today);
  document.getElementById("cmp-claude-req").textContent    = state.claude_requests_today ?? "-";
  document.getElementById("cmp-claude-cache").textContent  = fmtPct(state.claude_cache_hit_pct);

  document.getElementById("cmp-codex-tokens").textContent = fmtTok(codexTok);
  document.getElementById("cmp-codex-cost").textContent   = codexTok ? fmtCost(state.codex_cost_today || 0) : "$0 (n/a)";
  document.getElementById("cmp-codex-req").textContent    = state.codex_requests_today ?? "-";
  document.getElementById("cmp-codex-cache").textContent  = fmtPct(state.codex_cache_hit_pct);

  _bindClaudeModelTooltip(state.today_by_model || {});
}

// Hover tooltip on the Claude card: per-model token + cost breakdown for today.
// Reveals how a mid-session /model switch split the day's spend across models.
function _bindClaudeModelTooltip(byModel) {
  const card = document.getElementById("cmp-claude-card");
  if (!card) return;

  const models = Object.values(byModel)
    .filter((m) => (m.total || 0) > 0)
    .sort((a, b) => (b.cost_usd || 0) - (a.cost_usd || 0));

  let tip = card.querySelector(".cmp-model-tip");
  if (models.length <= 1) {
    if (tip) tip.remove();
    card.style.cursor = "";
    return;
  }

  const rows = models.map((m) => {
    const name = _shortModel(m.model);
    return `<div style="display:flex;justify-content:space-between;gap:14px;padding:3px 0;">
      <span style="color:#1d1d1f;">${name}</span>
      <span style="color:#6e6e73;font-variant-numeric:tabular-nums;">${fmtTok(m.total)} · ${fmtCost(m.cost_usd || 0)}</span>
    </div>`;
  }).join("");

  if (!tip) {
    tip = document.createElement("div");
    tip.className = "cmp-model-tip";
    tip.style.cssText =
      "position:absolute;top:8px;right:8px;z-index:20;min-width:190px;" +
      "background:#fff;border:1px solid #e6e6e9;border-radius:10px;padding:10px 12px;" +
      "box-shadow:0 6px 20px rgba(0,0,0,.12);font-size:12px;display:none;";
    card.appendChild(tip);
    card.addEventListener("mouseenter", () => { tip.style.display = "block"; });
    card.addEventListener("mouseleave", () => { tip.style.display = "none"; });
  }
  card.style.cursor = "default";
  tip.innerHTML =
    `<div style="font-size:11px;color:#9b9ba0;margin-bottom:5px;">${t("byModel", "By model")}</div>` + rows;
}

function renderLiveChart() {
  // Live token rate chart was removed from the layout; skip if absent.
  if (!document.getElementById("live-claude-line")) return;
  const W = 800, H = 220, padL = 14, padR = 14, padT = 16, padB = 26;
  const maxY = Math.max(..._claudeRateHist, ..._codexRateHist, 1000) * 1.15;
  const cl = svgPath(_claudeRateHist, W, H, padL, padR, padT, padB, maxY);
  const cd = svgPath(_codexRateHist,  W, H, padL, padR, padT, padB, maxY);
  document.getElementById("live-claude-line").setAttribute("d", cl.line);
  document.getElementById("live-claude-area").setAttribute("d", cl.area);
  document.getElementById("live-codex-line").setAttribute("d",  cd.line);
  document.getElementById("live-codex-area").setAttribute("d",  cd.area);
  document.getElementById("live-y-max").textContent = fmtTok(maxY);
  document.getElementById("live-y-mid").textContent = fmtTok(maxY / 2);

  const lastClaude = _claudeRateHist[_claudeRateHist.length - 1] || 0;
  const lastCodex  = _codexRateHist[_codexRateHist.length - 1]  || 0;
  document.getElementById("live-claude-tpm").innerHTML = `${fmtTok(lastClaude)}<span style="font-size:11px;color:#9b9ba0;font-weight:500;">/min</span>`;
  document.getElementById("live-codex-tpm").innerHTML  = `${fmtTok(lastCodex)}<span style="font-size:11px;color:#9b9ba0;font-weight:500;">/min</span>`;
}

function renderDonut(toolId, comp) {
  const segs = [
    { label: t("cacheReadLabel"),  value: comp.cache_read   || 0, color: "#14b8a6" },
    { label: t("inputLabel"),       value: comp.input        || 0, color: "#2563eb" },
    { label: t("outputLabel"),      value: comp.output       || 0, color: "#60a5fa" },
    { label: t("cacheWriteLabel"),  value: comp.cache_create || 0, color: "#cbd5e1" },
  ];
  const total = segs.reduce((s, x) => s + x.value, 0) || 1;
  const R = 58, C = 2 * Math.PI * R;
  let acc = 0;
  const segG = document.getElementById(`donut-${toolId}-segs`);
  segG.innerHTML = segs.map((s) => {
    const pct = s.value / total;
    const len = pct * C;
    const dash = `${len.toFixed(2)} ${(C - len).toFixed(2)}`;
    const offset = (-acc).toFixed(2);
    acc += len;
    return `<circle cx="70" cy="70" r="58" fill="none" stroke="${s.color}" stroke-width="17" stroke-dasharray="${dash}" stroke-dashoffset="${offset}" stroke-linecap="butt"></circle>`;
  }).join("");

  document.getElementById(`donut-${toolId}-center-pct`).textContent = fmtPct(comp.cache_hit_pct);
  document.getElementById(`donut-${toolId}-subtitle`).textContent = `today · ${fmtTok(total)} total`;

  const legend = document.getElementById(`donut-${toolId}-legend`);
  legend.innerHTML = segs.map((s) => {
    const pct2 = total > 0 ? Math.round(s.value / total * 100) : 0;
    return `<div style="display:flex;align-items:center;gap:8px;">
      <span style="width:9px;height:9px;border-radius:3px;background:${s.color};flex:0 0 auto;"></span>
      <span style="font-size:12.5px;color:#1d1d1f;flex:1;">${s.label}</span>
      <span style="font-size:12px;color:#86868b;font-variant-numeric:tabular-nums;">${fmtTok(s.value)} · ${pct2}%</span>
    </div>`;
  }).join("");
}

function renderHistorical(claudeDaily, codexDaily, historicalCosts) {
  const costs = historicalCosts || {};
  const byDate = {};

  // Global fallback ratio from today's data for days with no JSONL
  const state = _lastState || {};
  const todayTok = state.claude_tokens_today || 0;
  const todayUSD = state.claude_cost_today || 0;
  const fallbackRatio = todayTok > 0 ? todayUSD / todayTok : 3.0 / 1e6;

  // 1. Seed from stats-cache (output-only, estimated cost)
  claudeDaily.forEach((d) => {
    const tok = Object.values(d.tokens_by_model || {}).reduce((s, v) => s + v, 0);
    byDate[d.date] = { claude: tok, codex: 0, cost: tok * fallbackRatio, estimated: true };
  });

  // 2. Override with JSONL data where available (full breakdown, accurate cost)
  Object.entries(costs).forEach(([day, jsonl]) => {
    const tok = (jsonl.input || 0) + (jsonl.output || 0) + (jsonl.cache_read || 0) + (jsonl.cache_create || 0);
    byDate[day] = { claude: tok, codex: 0, cost: jsonl.cost_usd || 0, estimated: false };
  });
  codexDaily.slice(-30).forEach((d) => {
    if (!byDate[d.date]) byDate[d.date] = { claude: 0, codex: 0, cost: 0, estimated: false };
    byDate[d.date].codex = Object.values(d.tokens_by_model || {}).reduce((sum, usage) => {
      return sum + _codexModelTotal(usage);
    }, 0);
    byDate[d.date].cost = (byDate[d.date].cost || 0) + (d.cost_usd || 0);
  });

  const dates = Object.keys(byDate).sort().slice(-30);
  if (!dates.length) return;

  const HH = 228, hpadT = 14, hpadB = 30, hpadL = 6, hpadR = 6, HW = 1340;
  const base = HH - hpadB, usable = HH - hpadT - hpadB;
  let maxT = 0;
  dates.forEach((d) => { maxT = Math.max(maxT, byDate[d].claude || 0, byDate[d].codex || 0); });
  if (!maxT) maxT = 1;
  const slot = (HW - hpadL - hpadR) / dates.length;
  const groupW = slot * 0.66;
  const gapW = Math.max(1, groupW * 0.12);
  const barW = Math.max(1, (groupW - gapW) / 2);

  // Tooltip element
  let tip = document.getElementById("hist-tooltip");
  if (!tip) {
    tip = document.createElement("div");
    tip.id = "hist-tooltip";
    tip.style.cssText = "position:fixed;pointer-events:none;background:#1d1d1f;color:#fff;border-radius:8px;padding:8px 12px;font-size:12px;line-height:1.7;white-space:nowrap;z-index:999;opacity:0;transition:opacity .1s;box-shadow:0 4px 16px rgba(0,0,0,.2);";
    document.body.appendChild(tip);
  }

  const barsEl = document.getElementById("hist-bars");
  barsEl.innerHTML = dates.map((d, i) => {
    const c = byDate[d].claude || 0, dx = byDate[d].codex || 0;
    const cH = (c / maxT) * usable, dH = (dx / maxT) * usable;
    const groupX = hpadL + i * slot + (slot - groupW) / 2;
    const claudeX = groupX;
    const codexX = groupX + barW + gapW;
    const cY = base - cH, dY = base - dH;
    const totalTokDay = c + dx;
    const costDay = byDate[d].cost || 0;
    const parts = d.split("-");
    const label = `${["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][parseInt(parts[1])-1]} ${parseInt(parts[2])}`;
    const costLabel = byDate[d].estimated ? `~${fmtCost(costDay)} (est.)` : fmtCost(costDay);
    const tipHtml = `<b>${label}</b><br>Claude: ${fmtTok(c)}<br>Codex: ${fmtTok(dx)}<br>Total: ${fmtTok(totalTokDay)}<br>Cost: ${costLabel}`;
    return `<g class="hist-bar-group" data-tip="${encodeURIComponent(tipHtml)}" data-x="${groupX.toFixed(1)}" data-w="${groupW.toFixed(1)}">
              <rect x="${claudeX.toFixed(1)}" y="${cY.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(cH, c > 0 ? 1 : 0).toFixed(1)}" rx="2.5" fill="#2563eb"></rect>
              <rect x="${codexX.toFixed(1)}" y="${dY.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(dH, dx > 0 ? 1 : 0).toFixed(1)}" rx="2.5" fill="#7c3aed"></rect>
              <rect x="${groupX.toFixed(1)}" y="${hpadT}" width="${groupW.toFixed(1)}" height="${(HH - hpadT - hpadB).toFixed(1)}" fill="transparent"></rect>
            </g>`;
  }).join("");

  // Attach tooltip events
  const svg = barsEl.closest("svg");
  svg.querySelectorAll(".hist-bar-group").forEach((g) => {
    g.addEventListener("mouseenter", (e) => {
      tip.innerHTML = decodeURIComponent(g.dataset.tip);
      tip.style.opacity = "1";
    });
    g.addEventListener("mousemove", (e) => {
      tip.style.left = (e.clientX + 14) + "px";
      tip.style.top  = (e.clientY - 10) + "px";
    });
    g.addEventListener("mouseleave", () => { tip.style.opacity = "0"; });
  });

  // Date labels
  const step = Math.max(1, Math.floor(dates.length / 6));
  const datesEl = document.getElementById("hist-dates");
  datesEl.innerHTML = dates.filter((_, i) => i % step === 0 || i === dates.length - 1).map((d) => {
    const parts = d.split("-");
    return `<span>${["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][parseInt(parts[1]) - 1]} ${parseInt(parts[2])}</span>`;
  }).join("");

  // Totals
  const totalTok = dates.reduce((s, d) => s + (byDate[d].claude || 0) + (byDate[d].codex || 0), 0);
  const totalCost = dates.reduce((s, d) => s + (byDate[d].cost || 0), 0);
  document.getElementById("hist-total-tokens").textContent = fmtTok(totalTok);
  document.getElementById("hist-total-cost").textContent = fmtCost(totalCost);
}

function renderSessionsTable(claudeSessions, codexSessions, byModel) {
  // Build per-session cost map from byModel for Claude sessions
  const claudeSessionCost = {};
  Object.values(byModel).forEach((m) => {
    claudeSessionCost._total = (claudeSessionCost._total || 0) + (m.cost_usd || 0);
  });

  const todayStr = new Date().toISOString().slice(0, 10);

  const rows = [
    ...claudeSessions.map((s) => {
      const ctx     = s.ctx_tokens || 0;
      const win     = s.context_window || 200000;
      const ctxPct  = Math.min(Math.round(ctx / win * 100), 100);
      const lastAgo = _agoLabel(s.last_seen);
      const inp = s.input        ?? null;
      const out = s.output       ?? null;
      const cr  = s.cache_read   ?? null;
      const cc  = s.cache_create ?? null;
      const cost = (inp !== null)
        ? _computeCost(inp ?? 0, out ?? 0, cr ?? 0, cc ?? 0, s.model || "")
        : null;
      return {
        tool: "Claude", toolColor: "#2563eb", toolBg: "#eff4ff",
        session_id: s.session_id || "-",
        model: _shortModel(s.model),
        project: _shortCwd(s.cwd || s.project_slug || ""),
        status: "active",
        input: inp, output: out, cache_read: cr, cache_create: cc,
        tokens: ctx, ctxPct, ctxWin: win,
        cost,
        tpm: s.tok_per_min || 0,
        lastAgo,
        _raw: s,
      };
    }),
    ...codexSessions.slice(0, 8).map((s) => {
      const totalInp = s.committed_input  ?? s.input  ?? 0;
      const out      = s.committed_output ?? s.output ?? 0;
      const cr       = s.committed_cached ?? s.cached ?? 0;
      const tot      = s.committed_total  ?? s.total  ?? 0;
      // Codex input_tokens is cumulative (uncached + cached), split it out
      const uncachedInp = Math.max(totalInp - cr, 0);
      const cost = s.cost_usd ?? null;
      const lastAgo = _agoLabel(s.last_seen || s.started_at);
      return {
        tool: "Codex", toolColor: "#7c3aed", toolBg: "#f4efff",
        session_id: s.session_id || "-",
        model: s.model || t("unknown"),
        project: _shortCwd(s.cwd || ""),
        status: s.date === todayStr ? "today" : "past",
        input: uncachedInp,
        output: out,
        cache_read: cr,
        cache_create: 0,
        tokens: tot,
        ctxPct: null,
        ctxWin: null,
        cost,
        tpm: s.tok_per_min || 0,
        lastAgo,
        _raw: s,
      };
    }),
  ].slice(0, 12);

  const tbody = document.getElementById("sessions-table-body");
  if (!rows.length) {
    tbody.innerHTML = `<div style="color:#9b9ba0;font-size:13px;padding:20px 4px;">${t("noData")}</div>`;
    return;
  }

  // Update header columns to match new layout (Context moved to end, before Cost)
  const COL = "54px 70px minmax(80px,130px) 56px 56px 48px 48px 56px 110px 64px";
  const GAP = "6px";
  const header = tbody.previousElementSibling;
  if (header && header.style.display !== undefined) {
    header.style.gridTemplateColumns = COL;
    header.style.gap = GAP;
    const hStyle = "font-size:10.5px;font-weight:600;color:#9b9ba0;text-transform:uppercase;letter-spacing:.03em;";
    header.innerHTML = `
      <span style="${hStyle}">Tool</span>
      <span style="${hStyle}">Session</span>
      <span style="${hStyle}">Model / Project</span>
      <span style="${hStyle};text-align:right;">Input</span>
      <span style="${hStyle};text-align:right;">Output</span>
      <span style="${hStyle};text-align:right;color:#14b8a6;">CR</span>
      <span style="${hStyle};text-align:right;color:#94a3b8;">CW</span>
      <span style="${hStyle};text-align:right;">tok/min</span>
      <span style="${hStyle}">Context</span>
      <span style="${hStyle};text-align:right;">Cost</span>
    `;
  }

  tbody.innerHTML = rows.map((r, i) => {
    const last = i === rows.length - 1;
    const grid = `display:grid;grid-template-columns:${COL};gap:${GAP};`;

    // Context cell
    let ctxCell;
    if (r.ctxPct !== null) {
      const barColor = _ctxBarColor(r.tokens);
      const ctxWarnStyle = r.tokens >= CTX_ALERT_THRESHOLD
        ? "color:#dc2626;font-weight:700;"
        : r.tokens >= CTX_WARN_THRESHOLD
          ? "color:#d97706;font-weight:700;"
          : "color:#1d1d1f;";
      ctxCell = `
        <div>
          <div style="display:flex;justify-content:space-between;font-size:11.5px;margin-bottom:4px;">
            <span style="font-family:ui-monospace,Menlo,monospace;${ctxWarnStyle}">${fmtTok(r.tokens)}</span>
            <span style="font-weight:600;${ctxWarnStyle}">${r.ctxPct}%</span>
          </div>
          <div style="height:5px;background:#eef0f3;border-radius:99px;overflow:hidden;">
            <div style="height:100%;width:${r.ctxPct}%;background:${barColor};border-radius:99px;transition:width .4s;"></div>
          </div>
          <div style="font-size:10.5px;color:#b0b0b5;margin-top:3px;">of ${fmtTok(r.ctxWin)}</div>
        </div>`;
    } else {
      ctxCell = `<span style="color:#9b9ba0;font-size:12px;">${fmtTok(r.tokens)}</span>`;
    }

    // Status badge
    const statusColor = r.status === "active" ? "#15a06a" : "#9b9ba0";
    const statusBg    = r.status === "active" ? "#eafaf2" : "#f5f5f7";
    const statusDot   = r.status === "active"
      ? `<span style="width:5px;height:5px;border-radius:50%;background:#15a06a;animation:pulse 2s ease-out infinite;"></span>` : "";

    return `<div style="${grid}padding:10px 2px;${last ? "" : "border-bottom:1px solid #f4f4f7;"}align-items:center;font-size:12px;">
      <span>
        <span style="display:inline-flex;align-items:center;gap:4px;font-size:11px;font-weight:600;color:${r.toolColor};background:${r.toolBg};padding:3px 7px;border-radius:6px;">${statusDot}${r.tool}</span>
      </span>
      <div>
        <div style="font-family:ui-monospace,'SF Mono',Menlo,monospace;font-size:12px;color:#1d1d1f;font-weight:500;">${r.session_id.slice(0, 8)}</div>
        <div style="font-size:11px;color:#9b9ba0;margin-top:2px;">${r.lastAgo}</div>
      </div>
      <div>
        <div style="color:#1d1d1f;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${r.model}</div>
        <div style="font-size:11px;color:#86868b;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${r.project}">${r.project}</div>
      </div>
      <span style="text-align:right;color:#6e6e73;font-variant-numeric:tabular-nums;">${r.input !== null ? fmtTok(r.input) : "—"}</span>
      <span style="text-align:right;color:#6e6e73;font-variant-numeric:tabular-nums;">${r.output !== null ? fmtTok(r.output) : "—"}</span>
      <span style="text-align:right;color:#14b8a6;font-weight:600;font-variant-numeric:tabular-nums;">${r.cache_read !== null ? fmtTok(r.cache_read) : "—"}</span>
      <span style="text-align:right;color:#94a3b8;font-variant-numeric:tabular-nums;">${r.cache_create !== null ? fmtTok(r.cache_create) : "—"}</span>
      <span style="text-align:right;color:#6e6e73;font-variant-numeric:tabular-nums;">${r.tpm > 0 ? fmtTok(r.tpm) : "—"}</span>
      ${ctxCell}
      <span style="text-align:right;font-weight:600;color:#1d1d1f;font-variant-numeric:tabular-nums;">${r.cost != null ? fmtCost(r.cost) : "—"}</span>
    </div>`;
  }).join("");
}

function _agoLabel(ts) {
  if (!ts) return "—";
  try {
    const dt = new Date(ts.replace("Z", "+00:00"));
    const sec = Math.round((Date.now() - dt.getTime()) / 1000);
    if (sec < 60)  return `${sec}s ago`;
    if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
    return `${Math.floor(sec / 3600)}h ago`;
  } catch { return "—"; }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function _shortModel(m) {
  if (!m) return t("unknown");
  return m
    .replace("claude-", "")
    .replace("-20251001", "").replace("-20250929", "").replace("-20250722", "")
    .replace(/-\d{8}$/, "");
}

// Model label for a session card. Active model (last used) is bold; if the user
// switched models mid-session, prior models are listed below, dimmed, with their
// today token totals — so a Haiku→Opus switch shows both, not just Opus.
function _sessionModelLabel(sess, activeColor) {
  const active = sess.model || "";
  const models = Array.isArray(sess.models) ? sess.models : [];
  const activeLine = `<div style="font-size:11px;color:#9b9ba0;margin-top:2px;">${_shortModel(active)}</div>`;
  if (models.length <= 1) return activeLine;

  const others = models
    .filter((m) => m.model !== active)
    .map((m) =>
      `<div style="font-size:10px;color:#c0c0c5;margin-top:1px;font-variant-numeric:tabular-nums;" title="${m.model}">${_shortModel(m.model)} · ${fmtTok(m.total)}</div>`,
    )
    .join("");
  return `<div style="font-size:11px;color:${activeColor};font-weight:600;margin-top:2px;" title="${active}">${_shortModel(active)}</div>${others}`;
}

function _shortCwd(cwd) {
  if (!cwd) return "-";
  const parts = cwd.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || parts[parts.length - 2] || cwd;
}

function _codexModelTotal(usage) {
  if (typeof usage === "number") return usage;
  if (!usage || typeof usage !== "object") return 0;
  if (typeof usage.total === "number") return usage.total;
  return (usage.input || 0) + (usage.output || 0);
}

function _sessionTool(sess) {
  if (sess?.tool) return sess.tool;
  if ((sess?.session_id || "").startsWith("rollout-")) return "codex";
  return "claude";
}

function _sessionContextWindow(sess) {
  const explicit = sess?.context_window || 0;
  if (explicit > 0) return explicit;
  return _sessionTool(sess) === "codex" ? _codexModelWindow(sess?.model) : 200000;
}

function _codexModelWindow(model) {
  const normalized = (model || "").toLowerCase();
  if (normalized.startsWith("gpt-5.5")) return 1_000_000;
  if (normalized.startsWith("gpt-5.4-mini")) return 400_000;
  if (normalized.startsWith("gpt-5.4")) return 1_000_000;
  return 0;
}

// ---------------------------------------------------------------------------
// Context window alert system
// ---------------------------------------------------------------------------
const CTX_WARN_THRESHOLD  = 70_000;   // yellow
const CTX_ALERT_THRESHOLD = 100_000;  // red + notify

// Track which sessions have already fired a notification — persisted to survive F5
const _NS_KEY = "tokenscope-notified";
const _notifiedSessions = new Set(JSON.parse(localStorage.getItem(_NS_KEY) || "[]"));
function _notifiedAdd(key) {
  _notifiedSessions.add(key);
  localStorage.setItem(_NS_KEY, JSON.stringify([..._notifiedSessions]));
}

// Service Worker registration — required to show notifications when browser is minimized/backgrounded
let _swReg = null;

async function _registerSW() {
  if (!("serviceWorker" in navigator)) return;
  try {
    _swReg = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  } catch (_) {}
}

// Request browser notification permission once on load, then register SW
function requestNotifyPermission() {
  if (!("Notification" in window)) return;
  if (Notification.permission === "granted") {
    _registerSW();
  } else if (Notification.permission === "default") {
    Notification.requestPermission().then((result) => {
      if (result === "granted") _registerSW();
    });
  }
}

function _sendBrowserNotify(title, body, tag) {
  if (!("Notification" in window)) return;
  if (Notification.permission !== "granted") return;

  // Prefer SW path — works even when tab is minimized or browser is in background
  const reg = _swReg || (navigator.serviceWorker && navigator.serviceWorker.controller
    ? { active: navigator.serviceWorker.controller } : null);

  if (reg && reg.active) {
    reg.active.postMessage({ type: "notify", title, body, tag });
  } else if (_swReg) {
    // SW registered but not yet controlling — use showNotification directly on registration
    _swReg.showNotification(title, { body, tag, icon: "", renotify: true });
  } else {
    // Fallback: direct Notification (only works when tab is visible)
    new Notification(title, { body, icon: "", tag });
  }
}

// Inject (or update) the sticky alert banner below the header
function _updateAlertBanner(criticalSessions) {
  let banner = document.getElementById("ctx-alert-banner");

  if (!criticalSessions.length) {
    if (banner) banner.remove();
    return;
  }

  const msgs = criticalSessions.map((s) => {
    const proj = _shortCwd(s.cwd || s.project_slug || "");
    const kTok = Math.round((s.ctx_tokens || 0) / 1000);
    const win = _sessionContextWindow(s) || 0;
    const kMax = Math.round(win / 1000);
    const pct = win > 0 ? Math.min(Math.round((s.ctx_tokens || 0) / win * 100), 100) : 0;
    return t("ctxAlertBanner", kTok, kMax, pct, proj);
  });

  if (!banner) {
    banner = document.createElement("div");
    banner.id = "ctx-alert-banner";
    banner.style.cssText = [
      "position:sticky;top:0;z-index:31;",
      "background:#fff1f2;border-bottom:1.5px solid #fca5a5;",
      "padding:9px 12px;display:flex;align-items:center;gap:10px;flex-wrap:wrap;",
      "font-size:12.5px;font-weight:600;color:#b91c1c;line-height:1.35;",
      "animation:slideDown .25s ease;",
    ].join("");

    // inject slideDown keyframe once
    if (!document.getElementById("ctx-banner-style")) {
      const st = document.createElement("style");
      st.id = "ctx-banner-style";
      st.textContent = `@keyframes slideDown{from{opacity:0;transform:translateY(-8px)}to{opacity:1;transform:translateY(0)}}`;
      document.head.appendChild(st);
    }

    // Insert as the first element inside the content area, just under the header.
    const page = document.querySelector(".page-pad");
    if (page) {
      page.insertBefore(banner, page.firstChild);
      banner.style.margin = "0 0 8px";
      banner.style.borderRadius = "10px";
      banner.style.border = "1px solid #fca5a5";
      banner.style.position = "static";
    } else {
      document.body.prepend(banner);
    }
  }

  banner.innerHTML = msgs.map((m) =>
    `<span style="display:flex;align-items:center;gap:7px;">
      <span style="font-size:16px;">🔴</span>${m}
    </span>`
  ).join(`<span style="color:#fca5a5;margin:0 4px;">|</span>`);
}

// Called every render cycle to check all active sessions
function checkContextAlerts(sessions) {
  const critical = [];

  sessions.forEach((sess) => {
    const ctx = sess.ctx_tokens || 0;
    if (ctx < CTX_ALERT_THRESHOLD) return;

    critical.push(sess);

    // Fire browser notification once per session crossing the threshold
    const key = `${sess.session_id}-${Math.floor(ctx / 20_000)}`;
    if (!_notifiedSessions.has(key)) {
      _notifiedAdd(key);
      const proj = _shortCwd(sess.cwd || sess.project_slug || "");
      const kTok = Math.round(ctx / 1000);
      const maxK = Math.round(_sessionContextWindow(sess) / 1000);
      _sendBrowserNotify(
        t("ctxWarning", kTok, proj),
        t("ctxWarningBody", kTok, maxK),
        `ctx-alert-${sess.session_id}`,
      );
    }
  });

  _updateAlertBanner(critical);
}

// Progress bar color based on ctx usage
function _ctxBarColor(ctx) {
  if (ctx >= CTX_ALERT_THRESHOLD) return "linear-gradient(90deg,#f87171,#dc2626)";
  if (ctx >= CTX_WARN_THRESHOLD)  return "linear-gradient(90deg,#fbbf24,#f59e0b)";
  return "linear-gradient(90deg,#5b9bff,#2563eb)";
}

// ---------------------------------------------------------------------------
// VS Code webview message channel (replaces WebSocket)
// ---------------------------------------------------------------------------
const _vscode = typeof acquireVsCodeApi !== "undefined" ? acquireVsCodeApi() : null;
let _updateTimer = null;

function connectVscode() {
  const live = document.getElementById("live-indicator");
  if (live) live.style.color = "#15a06a";
  startUpdateTimer();

  window.addEventListener("message", (e) => {
    const msg = e.data;
    if (msg && msg.type === "update") {
      render(msg.data);
      startUpdateTimer();
    }
  });
}

// Exposed for a manual refresh button if added later.
function requestRefresh() {
  if (_vscode) _vscode.postMessage({ type: "refresh" });
}

function startUpdateTimer() {
  stopUpdateTimer();
  let sec = 0;
  _updateTimer = setInterval(() => {
    sec++;
    if (document.getElementById("last-updated")) {
      document.getElementById("last-updated").textContent = t("updatedAgo", sec);
    }
  }, 1000);
}

function stopUpdateTimer() {
  if (_updateTimer) { clearInterval(_updateTimer); _updateTimer = null; }
}

// Time filter buttons (visual only for now)
document.querySelectorAll("[data-tf]").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("[data-tf]").forEach((b) => {
      b.style.background = "transparent";
      b.style.color = "#6e6e73";
      b.style.fontWeight = "500";
      b.style.boxShadow = "none";
    });
    btn.style.background = "#fff";
    btn.style.color = "#1d1d1f";
    btn.style.fontWeight = "600";
    btn.style.boxShadow = "0 1px 2px rgba(0,0,0,.13)";
  });
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
applyI18n();
requestNotifyPermission();
connectVscode();

