/**
 * Builds the dashboard state posted to the webview. Every number — KPIs, the
 * per-model and per-project breakdowns, the session table, the history — comes
 * from ONE de-duplicated request store (src/core/usageStore.ts), recomputed on
 * each refresh. The old model (scan for sessions, then add file-event deltas to
 * separate today_by_model counters) let the two drift: the 15 s poll advanced
 * file offsets without adding the new bytes to the totals.
 */
import { round, getContextWindow, CLAUDE_HOME, CODEX_HOME } from "./pricing";
import { readStatsCache } from "./readers/claudeStats";
import { slugToCwd } from "./readers/claudeLive";
import { todayIso, isoDaysAgo, tsAge } from "./util";
import { UsageStore, Entry, FileInfo } from "./core/usageStore";
import { totalTokens } from "./core/usageRecord";
import {
  Totals,
  sessionSummaries,
  modelTotals,
  dailyTotals,
  sumTotals,
  zeroTotals,
  addRecord,
  SessionSummary,
} from "./core/aggregate";

const ACTIVE_WINDOW_SECONDS = 1800;
const IDLE_THRESHOLD_SECONDS = 300;
const STATS_TTL = 60_000; // ms

interface ModelEntry {
  model: string;
  input: number;
  output: number;
  cache_read: number;
  cache_create: number;
  total: number;
  cost_usd: number;
  request_count: number;
}

export interface SessionRow {
  tool: "claude" | "codex";
  session_id: string;
  project_slug: string;
  cwd: string;
  model: string;
  models: { model: string; total: number; cost_usd: number }[];
  input: number;
  output: number;
  cache_read: number;
  cache_create: number;
  total: number;
  cost_usd: number;
  requests: number;
  subagent_tokens: number;
  tok_per_min: number;
  ctx_tokens: number;
  context_window: number;
  last_seen: string;
  status: "active" | "idle" | "done";
}

export interface DashboardState {
  last_updated: number;
  day: string;
  tokens_today: number;
  cost_today_usd: number;
  active_session_count: number;
  tokens_per_min: number;
  claude_tokens_today: number;
  claude_cost_today: number;
  claude_requests_today: number;
  claude_cache_hit_pct: number;
  codex_tokens_today: number;
  codex_cost_today: number;
  codex_requests_today: number;
  codex_cache_hit_pct: number;
  today_by_model: Record<string, ModelEntry>;
  today_by_project: Record<string, any>;
  /** Sessions with activity in the last 30 minutes (context-window panel). */
  active_sessions: SessionRow[];
  /** Every session with usage today, most recent first (session table). */
  today_sessions: SessionRow[];
  composition_claude: Record<string, any>;
  composition_codex: Record<string, any>;
  historical_daily: any[];
  historical_last_computed: string | null;
  historical_costs: Record<string, any>;
  codex_today_sessions: SessionRow[];
  codex_historical_daily: any[];
}

function newState(): DashboardState {
  return {
    last_updated: Date.now() / 1000,
    day: todayIso(),
    tokens_today: 0,
    cost_today_usd: 0,
    active_session_count: 0,
    tokens_per_min: 0,
    claude_tokens_today: 0,
    claude_cost_today: 0,
    claude_requests_today: 0,
    claude_cache_hit_pct: 0,
    codex_tokens_today: 0,
    codex_cost_today: 0,
    codex_requests_today: 0,
    codex_cache_hit_pct: 0,
    today_by_model: {},
    today_by_project: {},
    active_sessions: [],
    today_sessions: [],
    composition_claude: {},
    composition_codex: {},
    historical_daily: [],
    historical_last_computed: null,
    historical_costs: {},
    codex_today_sessions: [],
    codex_historical_daily: [],
  };
}

let _state: DashboardState = newState();
let _lastStatsRefresh = 0;
let _ctxWindowOverride = 0;
const _live = new UsageStore(CLAUDE_HOME, CODEX_HOME);
/** Completed days of history (yesterday and before), rebuilt on a full refresh or day change. */
let _history: { claude: Record<string, Totals>; codex: Record<string, Totals>; codexModels: Record<string, Record<string, Totals>> } = {
  claude: {},
  codex: {},
  codexModels: {},
};
let _historyDays = 90;

export function setContextWindowOverride(tokens: number): void {
  _ctxWindowOverride = tokens > 0 ? tokens : 0;
}

export function getState(): DashboardState {
  return _state;
}

/** The live store (today's requests) — shared with nothing else; the pusher has its own window. */
export function liveStore(): UsageStore {
  return _live;
}

export interface CtxAlert {
  session_id: string;
  model: string;
  cwd: string;
  ctx_tokens: number;
  context_window: number;
  pct: number;
}

/** Active sessions whose context-window usage meets/exceeds `thresholdPct`, worst first. */
export function contextAlerts(thresholdPct: number): CtxAlert[] {
  const alerts: CtxAlert[] = [];
  for (const sess of _state.active_sessions) {
    const win = sess.context_window || 0;
    const ctx = sess.ctx_tokens || 0;
    if (win <= 0 || ctx <= 0) continue;
    const pct = Math.round((ctx / win) * 100);
    if (pct >= thresholdPct) {
      alerts.push({ session_id: sess.session_id, model: sess.model, cwd: sess.cwd, ctx_tokens: ctx, context_window: win, pct });
    }
  }
  alerts.sort((a, b) => b.pct - a.pct);
  return alerts;
}

const STANDARD_WINDOW = 200_000;
const EXTENDED_WINDOW = 1_000_000;

function claudeContextWindow(model: string, ctxTokens: number): number {
  let win = _ctxWindowOverride || getContextWindow(model);
  // A session already holding more than the standard window must be on the extended one.
  if (ctxTokens > STANDARD_WINDOW && win <= STANDARD_WINDOW) win = EXTENDED_WINDOW;
  return win;
}

function toModelEntry(model: string, t: Totals): ModelEntry {
  return {
    model,
    input: t.input,
    output: t.output,
    cache_read: t.cacheRead,
    cache_create: t.cacheWrite5m + t.cacheWrite1h,
    total: t.tokens,
    cost_usd: round(t.cost, 6),
    request_count: t.requests,
  };
}

function cacheHitPct(t: Totals): number {
  const prompt = t.input + t.cacheRead + t.cacheWrite5m + t.cacheWrite1h;
  return prompt > 0 ? round((t.cacheRead / prompt) * 100, 1) : 0;
}

function composition(t: Totals): Record<string, number> {
  return {
    cache_read: t.cacheRead,
    cache_create: t.cacheWrite5m + t.cacheWrite1h,
    input: t.input,
    output: t.output,
    cache_hit_pct: t.tokens > 0 ? round((t.cacheRead / t.tokens) * 100, 1) : 0,
  };
}

/** Session metadata merged over all files of a session (main + subagents). */
function sessionMeta(files: FileInfo[]): Map<string, { lastSeen: string; ctx: number; window: number; cwd: string }> {
  const out = new Map<string, { lastSeen: string; ctx: number; window: number; cwd: string }>();
  for (const f of files) {
    const k = `${f.tool}:${f.sessionId}`;
    const m = out.get(k) ?? { lastSeen: "", ctx: 0, window: 0, cwd: "" };
    if (f.lastSeen > m.lastSeen) m.lastSeen = f.lastSeen;
    if (f.origin === "main") {
      if (f.cwd) m.cwd = f.cwd;
      if (f.lastRec) m.ctx = totalTokens(f.lastRec);
      if (f.contextWindow) m.window = f.contextWindow;
    } else if (!m.cwd && f.cwd) {
      m.cwd = f.cwd;
    }
    out.set(k, m);
  }
  return out;
}

function toSessionRow(s: SessionSummary, meta: { lastSeen: string; ctx: number; window: number; cwd: string } | undefined): SessionRow {
  const lastSeen = meta?.lastSeen && meta.lastSeen > s.lastTs ? meta.lastSeen : s.lastTs;
  const age = tsAge(lastSeen);
  const status: SessionRow["status"] = age < IDLE_THRESHOLD_SECONDS ? "active" : age < ACTIVE_WINDOW_SECONDS ? "idle" : "done";
  const ctx = meta?.ctx ?? 0;
  const cwd = meta?.cwd || s.cwd || (s.tool === "claude" ? slugToCwd(s.slug) : "");
  const window = s.tool === "claude" ? claudeContextWindow(s.model, ctx) : meta?.window || 0;
  return {
    tool: s.tool,
    session_id: s.sessionId,
    project_slug: s.tool === "claude" ? s.slug : "codex",
    cwd,
    model: s.model,
    models: Object.entries(s.byModel)
      .map(([model, t]) => ({ model, total: t.tokens, cost_usd: round(t.cost, 6) }))
      .sort((a, b) => b.total - a.total),
    input: s.totals.input,
    output: s.totals.output,
    cache_read: s.totals.cacheRead,
    cache_create: s.totals.cacheWrite5m + s.totals.cacheWrite1h,
    total: s.totals.tokens,
    cost_usd: round(s.totals.cost, 6),
    requests: s.totals.requests,
    subagent_tokens: s.subagentTokens,
    tok_per_min: status === "active" ? s.tokPerMin : 0,
    ctx_tokens: ctx,
    context_window: window,
    last_seen: lastSeen,
    status,
  };
}

/** Recompute every "today" number from the live store. */
function computeToday(s: DashboardState): void {
  const day = todayIso();
  const entries: Entry[] = _live.entries();
  s.day = day;

  const claudeModels = modelTotals(entries, day, "claude");
  const codexModels = modelTotals(entries, day, "codex");
  const claude = sumTotals(Object.values(claudeModels));
  const codex = sumTotals(Object.values(codexModels));

  s.today_by_model = {};
  for (const [m, t] of Object.entries(claudeModels)) s.today_by_model[m] = toModelEntry(m, t);

  s.claude_tokens_today = claude.tokens;
  s.claude_cost_today = round(claude.cost, 4);
  s.claude_requests_today = claude.requests;
  s.claude_cache_hit_pct = cacheHitPct(claude);
  s.codex_tokens_today = codex.tokens;
  s.codex_cost_today = round(codex.cost, 4);
  s.codex_requests_today = codex.requests;
  s.codex_cache_hit_pct = cacheHitPct(codex);
  s.tokens_today = claude.tokens + codex.tokens;
  s.cost_today_usd = round(claude.cost + codex.cost, 4);
  s.composition_claude = composition(claude);
  s.composition_codex = composition(codex);

  const meta = sessionMeta(_live.fileInfos());
  const rows = sessionSummaries(entries, day)
    .map((x) => toSessionRow(x, meta.get(`${x.tool}:${x.sessionId}`)))
    .sort((a, b) => (a.last_seen < b.last_seen ? 1 : a.last_seen > b.last_seen ? -1 : 0));
  s.today_sessions = rows;
  s.active_sessions = rows.filter((r) => r.status !== "done");
  s.active_session_count = s.active_sessions.length;
  s.tokens_per_min = s.active_sessions.reduce((a, r) => a + r.tok_per_min, 0);
  s.codex_today_sessions = rows.filter((r) => r.tool === "codex");

  s.today_by_project = {};
  for (const r of rows) {
    if (r.tool !== "claude") continue;
    const p = (s.today_by_project[r.project_slug] ??= { cwd: r.cwd, slug: r.project_slug, models: {}, total_tokens: 0, total_cost: 0 });
    if (!p.cwd && r.cwd) p.cwd = r.cwd;
    p.total_tokens += r.total;
    p.total_cost = round(p.total_cost + r.cost_usd, 6);
  }
  for (const { rec, file } of entries) {
    if (rec.day !== day || rec.tool !== "claude") continue;
    const p = s.today_by_project[file.slug];
    if (!p) continue;
    const perModel: Record<string, Totals> = (p._t ??= {});
    addRecord((perModel[rec.model] ??= zeroTotals()), rec);
  }
  for (const p of Object.values(s.today_by_project) as any[]) {
    for (const [m, t] of Object.entries(p._t ?? {})) p.models[m] = toModelEntry(m, t as Totals);
    delete p._t;
  }

  // Today's bar in the history uses the same numbers as the KPIs.
  s.historical_costs = { ...historyCostsMap(_history.claude) };
  if (claude.requests) s.historical_costs[day] = historyCostRow(claude);
  s.codex_historical_daily = codexDailyList(day, codexModels);
}

function historyCostRow(t: Totals) {
  return {
    input: t.input,
    output: t.output,
    cache_read: t.cacheRead,
    cache_create: t.cacheWrite5m + t.cacheWrite1h,
    cost_usd: round(t.cost, 6),
  };
}

function historyCostsMap(m: Record<string, Totals>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [d, t] of Object.entries(m)) out[d] = historyCostRow(t);
  return out;
}

function codexDailyList(today: string, todayModels: Record<string, Totals>): any[] {
  const days: Record<string, Record<string, Totals>> = { ..._history.codexModels };
  if (Object.keys(todayModels).length) days[today] = todayModels;
  return Object.keys(days)
    .sort()
    .map((d) => {
      const models = days[d];
      const tokens_by_model: Record<string, any> = {};
      let cost = 0;
      for (const [m, t] of Object.entries(models)) {
        tokens_by_model[m] = { input: t.input, output: t.output, cached: t.cacheRead, reasoning: 0, total: t.tokens };
        cost += t.cost;
      }
      return { date: d, tokens_by_model, sessions: 0, cost_usd: round(cost, 6) };
    });
}

/** Rebuild completed-day history from a one-shot store over `daysBack` days. */
function buildHistory(daysBack: number): void {
  const today = todayIso();
  const hist = new UsageStore(CLAUDE_HOME, CODEX_HOME);
  hist.refresh(isoDaysAgo(daysBack));
  const entries = hist.entries().filter((e) => e.rec.day < today);
  _history.claude = dailyTotals(entries, "claude");
  _history.codex = dailyTotals(entries, "codex");
  const codexModels: Record<string, Record<string, Totals>> = {};
  for (const { rec } of entries) {
    if (rec.tool !== "codex") continue;
    addRecord(((codexModels[rec.day] ??= {})[rec.model] ??= zeroTotals()), rec);
  }
  _history.codexModels = codexModels;
}

function refreshStats(s: DashboardState, force: boolean): void {
  const now = Date.now();
  if (!force && now - _lastStatsRefresh < STATS_TTL) return;
  const stats = readStatsCache(CLAUDE_HOME);
  s.historical_daily = stats.daily.slice(-30);
  s.historical_last_computed = stats.last_computed_date;
  _lastStatsRefresh = now;
}

export function buildFullState(daysBack = 90): DashboardState {
  _historyDays = daysBack;
  const s = newState();
  buildHistory(daysBack);
  _live.refresh(todayIso());
  refreshStats(s, true);
  computeToday(s);
  s.last_updated = Date.now() / 1000;
  _state = s;
  return s;
}

function summarize(s: DashboardState): string {
  return JSON.stringify([
    s.day,
    s.tokens_today,
    s.cost_today_usd,
    s.active_sessions.map((x) => [x.tool, x.session_id, x.last_seen, x.status, x.tok_per_min, x.ctx_tokens]),
  ]);
}

/**
 * Re-read appended bytes and recompute. Returns the state when anything visible
 * changed, else null. Crossing midnight rebuilds the history (yesterday becomes
 * a completed day) and restarts the live window at the new day.
 */
export function refreshActiveSessions(daysBack = _historyDays): DashboardState | null {
  const prev = summarize(_state);
  if (_state.day !== todayIso()) return buildFullState(daysBack);
  _live.refresh(todayIso());
  computeToday(_state);
  refreshStats(_state, false);
  if (summarize(_state) === prev) return null;
  _state.last_updated = Date.now() / 1000;
  return _state;
}

/** File-watcher entry point — same recompute as the poll (the store reads only new bytes). */
export function applyFileUpdate(_filePath: string, daysBack = _historyDays): DashboardState | null {
  return refreshActiveSessions(daysBack);
}
