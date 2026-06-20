/**
 * Aggregates all data sources into a single state object that is serialized
 * and posted to the webview. Port of aggregator.py (singleton state model).
 */
import { computeCost, round, getContextWindow, CLAUDE_HOME, CODEX_HOME } from "./pricing";
import { readStatsCache } from "./readers/claudeStats";
import {
  scanToday,
  incrementalRead,
  scanHistoricalCosts,
  ScanTodayResult,
  ActiveSession,
} from "./readers/claudeLive";
import { scanCodexSessions, CodexSession } from "./readers/codexReader";
import { Usage } from "./util";

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

export interface DashboardState {
  last_updated: number;
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
  active_sessions: any[];
  composition_claude: Record<string, any>;
  composition_codex: Record<string, any>;
  historical_daily: any[];
  historical_last_computed: string | null;
  historical_costs: Record<string, any>;
  codex_today_sessions: CodexSession[];
  codex_historical_daily: any[];
}

function newState(): DashboardState {
  return {
    last_updated: Date.now() / 1000,
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
// 0 = auto-detect from model; >0 forces this window for Claude sessions.
let _ctxWindowOverride = 0;

export function setContextWindowOverride(tokens: number): void {
  _ctxWindowOverride = tokens > 0 ? tokens : 0;
}
// Scratch values for Codex composition, kept out of the serialized state.
let _codexInput = 0;
let _codexOutput = 0;
let _codexCached = 0;

export function getState(): DashboardState {
  return _state;
}

export interface CtxAlert {
  session_id: string;
  model: string;
  cwd: string;
  ctx_tokens: number;
  context_window: number;
  pct: number;
}

/**
 * Active sessions whose context-window usage meets/exceeds `thresholdPct`.
 * Returns the worst-first list so the caller can alert on the most-full session.
 */
export function contextAlerts(thresholdPct: number): CtxAlert[] {
  const alerts: CtxAlert[] = [];
  for (const sess of _state.active_sessions) {
    if ((sess.tool ?? "claude") === "codex") {
      // Codex carries its own context_window from JSONL; include it too.
    }
    const win = sess.context_window || 0;
    const ctx = sess.ctx_tokens || 0;
    if (win <= 0 || ctx <= 0) continue;
    const pct = Math.round((ctx / win) * 100);
    if (pct >= thresholdPct) {
      alerts.push({
        session_id: sess.session_id,
        model: sess.model,
        cwd: sess.cwd,
        ctx_tokens: ctx,
        context_window: win,
        pct,
      });
    }
  }
  alerts.sort((a, b) => b.pct - a.pct);
  return alerts;
}

function zeroModelEntry(model: string): ModelEntry {
  return {
    model,
    input: 0,
    output: 0,
    cache_read: 0,
    cache_create: 0,
    total: 0,
    cost_usd: 0,
    request_count: 0,
  };
}

function mergeUsage(dst: ModelEntry, src: Partial<Usage>): void {
  dst.input += src.input ?? 0;
  dst.output += src.output ?? 0;
  dst.cache_read += src.cache_read ?? 0;
  dst.cache_create += src.cache_create ?? 0;
  dst.request_count += 1;
  dst.total = dst.input + dst.output + dst.cache_read + dst.cache_create;
  dst.cost_usd = computeCost(dst.input, dst.output, dst.cache_read, dst.cache_create, dst.model);
}

function tsAge(ts: string): number {
  if (!ts) return Infinity;
  const ms = Date.parse(ts);
  if (Number.isNaN(ms)) return Infinity;
  return (Date.now() - ms) / 1000;
}

const STANDARD_WINDOW = 200_000;
const EXTENDED_WINDOW = 1_000_000;

function claudeContextWindow(model: string, ctxTokens: number): number {
  let win = _ctxWindowOverride || getContextWindow(model);
  // JSONL never records the 1M-context beta, but a session that already holds
  // more than the standard window must be running the extended one — infer it.
  if (ctxTokens > STANDARD_WINDOW && win <= STANDARD_WINDOW) {
    win = EXTENDED_WINDOW;
  }
  return win;
}

function decorateClaudeSessions(sessions: ActiveSession[]): any[] {
  return sessions.map((s) => ({
    ...s,
    tool: "claude",
    context_window: claudeContextWindow(s.model, s.ctx_tokens || 0),
  }));
}

function activeCodexSessions(sessions: CodexSession[]): any[] {
  const active: any[] = [];
  for (const sess of sessions) {
    const lastSeen = sess.last_seen || sess.started_at || "";
    const age = tsAge(lastSeen);
    if (age >= ACTIVE_WINDOW_SECONDS) continue;
    const status = age < IDLE_THRESHOLD_SECONDS ? "active" : "idle";
    active.push({
      session_id: sess.session_id,
      project_slug: "codex",
      cwd: sess.cwd,
      model: sess.model,
      ctx_tokens: sess.ctx_tokens,
      context_window: sess.context_window,
      tok_per_min: status === "active" ? sess.tok_per_min : 0,
      last_seen: lastSeen,
      tool: "codex",
      total_tokens: sess.total,
      status,
    });
  }
  return active;
}

function refreshActiveSessionList(
  s: DashboardState,
  claudeSessions: ActiveSession[],
  codexSessions: CodexSession[],
): void {
  const combined = [...decorateClaudeSessions(claudeSessions), ...activeCodexSessions(codexSessions)];
  combined.sort((a, b) => ((a.last_seen ?? "") < (b.last_seen ?? "") ? 1 : -1));
  s.active_sessions = combined;
  s.active_session_count = combined.length;
  s.tokens_per_min = combined.reduce((acc, x) => acc + (x.tok_per_min ?? 0), 0);
}

function recomputeComposition(s: DashboardState): void {
  const claudeCacheRead = sumModel(s, "cache_read");
  const claudeCacheCreate = sumModel(s, "cache_create");
  const claudeInput = sumModel(s, "input");
  const claudeOutput = sumModel(s, "output");
  const claudeTotal = claudeCacheRead + claudeCacheCreate + claudeInput + claudeOutput || 1;
  const codexTotal = _codexCached + _codexInput + _codexOutput || 1;

  s.composition_claude = {
    cache_read: claudeCacheRead,
    cache_create: claudeCacheCreate,
    input: claudeInput,
    output: claudeOutput,
    cache_hit_pct: round((claudeCacheRead / claudeTotal) * 100, 1),
  };
  s.composition_codex = {
    cache_read: _codexCached,
    cache_create: 0,
    input: _codexInput,
    output: _codexOutput,
    cache_hit_pct: round((_codexCached / codexTotal) * 100, 1),
  };
}

function sumModel(s: DashboardState, key: keyof ModelEntry): number {
  let acc = 0;
  for (const m of Object.values(s.today_by_model)) acc += (m[key] as number) ?? 0;
  return acc;
}

function recomputeClaudeTotals(s: DashboardState): void {
  let totalTok = 0, totalCost = 0, totalReq = 0, totalCacheRead = 0, totalAllInput = 0;
  for (const me of Object.values(s.today_by_model)) {
    totalTok += me.total;
    totalCost += me.cost_usd;
    totalReq += me.request_count;
    totalCacheRead += me.cache_read;
    totalAllInput += me.input + me.cache_read + me.cache_create + me.output;
  }
  s.claude_tokens_today = totalTok;
  s.claude_cost_today = round(totalCost, 4);
  s.claude_requests_today = totalReq;
  if (totalAllInput > 0) s.claude_cache_hit_pct = round((totalCacheRead / totalAllInput) * 100, 1);
  s.tokens_today = s.claude_tokens_today + s.codex_tokens_today;
  s.cost_today_usd = round(s.claude_cost_today + s.codex_cost_today, 4);
  recomputeComposition(s);
}

function applyLive(s: DashboardState, live: ScanTodayResult): void {
  s.active_sessions = decorateClaudeSessions(live.active_sessions);
  s.active_session_count = s.active_sessions.length;
  s.tokens_per_min = s.active_sessions.reduce((a, x) => a + (x.tok_per_min ?? 0), 0);

  for (const [model, usage] of Object.entries(live.by_model)) {
    s.today_by_model[model] = zeroModelEntry(model);
    mergeUsage(s.today_by_model[model], usage);
  }

  for (const [slug, proj] of Object.entries(live.by_project)) {
    const entry: any = { cwd: proj.cwd, slug, models: {}, total_tokens: 0, total_cost: 0 };
    for (const [model, usage] of Object.entries(proj.models)) {
      const me = zeroModelEntry(model);
      mergeUsage(me, usage);
      entry.models[model] = me;
      entry.total_tokens += me.total;
      entry.total_cost += me.cost_usd;
    }
    s.today_by_project[slug] = entry;
  }

  recomputeClaudeTotals(s);
}

function applyCodexToday(s: DashboardState, sessions: CodexSession[]): void {
  let totalInput = 0, totalOutput = 0, totalCached = 0, totalTokens = 0, totalCost = 0;
  for (const sess of sessions) {
    const sInput = sess.committed_input ?? sess.input ?? 0;
    const sCached = sess.committed_cached ?? sess.cached ?? 0;
    const sOutput = sess.committed_output ?? sess.output ?? 0;
    const sTotal = sess.committed_total ?? sess.total ?? 0;
    totalInput += sInput;
    totalOutput += sOutput;
    totalCached += sCached;
    totalTokens += sTotal;
    const uncachedInput = Math.max(sInput - sCached, 0);
    totalCost += computeCost(uncachedInput, sOutput, sCached, 0, sess.model || "unknown");
  }

  s.codex_tokens_today = totalTokens;
  s.codex_cost_today = round(totalCost, 4);
  s.codex_requests_today = sessions.length;
  if (totalInput > 0) s.codex_cache_hit_pct = round((totalCached / totalInput) * 100, 1);

  _codexInput = Math.max(totalInput - totalCached, 0);
  _codexOutput = totalOutput;
  _codexCached = totalCached;

  s.tokens_today = s.claude_tokens_today + s.codex_tokens_today;
  s.cost_today_usd = round(s.claude_cost_today + s.codex_cost_today, 4);
  recomputeComposition(s);
}

export function buildFullState(daysBack = 90): DashboardState {
  const s = newState();

  const stats = readStatsCache(CLAUDE_HOME);
  s.historical_daily = stats.daily.slice(-30);
  s.historical_last_computed = stats.last_computed_date;

  s.historical_costs = scanHistoricalCosts(CLAUDE_HOME, daysBack);

  const live = scanToday(CLAUDE_HOME);
  applyLive(s, live);

  const codex = scanCodexSessions(CODEX_HOME, daysBack);
  s.codex_historical_daily = codex.daily;
  s.codex_today_sessions = codex.today.sessions;
  applyCodexToday(s, s.codex_today_sessions);
  refreshActiveSessionList(s, live.active_sessions, s.codex_today_sessions);

  s.last_updated = Date.now() / 1000;
  _state = s;
  _lastStatsRefresh = Date.now();
  return s;
}

/** Re-scan active sessions; return state if the live summary changed, else null. */
export function refreshActiveSessions(daysBack = 90): DashboardState | null {
  const prev = summarize(_state);
  const live = scanToday(CLAUDE_HOME);
  const codex = scanCodexSessions(CODEX_HOME, daysBack);
  _state.codex_historical_daily = codex.daily;
  _state.codex_today_sessions = codex.today.sessions;
  applyCodexToday(_state, _state.codex_today_sessions);
  refreshActiveSessionList(_state, live.active_sessions, _state.codex_today_sessions);
  if (summarize(_state) !== prev) {
    _state.last_updated = Date.now() / 1000;
    return _state;
  }
  return null;
}

function summarize(s: DashboardState): string {
  return JSON.stringify([
    s.active_session_count,
    s.tokens_per_min,
    s.codex_tokens_today,
    s.active_sessions.map((x) => [x.tool ?? "claude", x.session_id, x.last_seen, x.tok_per_min ?? 0]),
  ]);
}

/** Incremental update after a file watcher event. Returns state if changed. */
export function applyFileUpdate(filePath: string, daysBack = 90): DashboardState | null {
  let changed = false;

  if (filePath.endsWith(".jsonl") && filePath.includes(".claude")) {
    const delta = incrementalRead(filePath);
    if (delta) {
      for (const [model, usage] of Object.entries(delta.models)) {
        const existing = (_state.today_by_model[model] ??= zeroModelEntry(model));
        mergeUsage(existing, usage);
      }
      recomputeClaudeTotals(_state);
      changed = true;
    }
  }

  const prevSummary = summarize(_state);
  const prevCodex = JSON.stringify([
    _state.codex_tokens_today,
    _state.codex_today_sessions.map((x) => [x.session_id, x.total, x.last_seen]),
  ]);

  const live = scanToday(CLAUDE_HOME);
  const codex = scanCodexSessions(CODEX_HOME, daysBack);
  _state.codex_historical_daily = codex.daily;
  _state.codex_today_sessions = codex.today.sessions;
  applyCodexToday(_state, _state.codex_today_sessions);
  refreshActiveSessionList(_state, live.active_sessions, _state.codex_today_sessions);

  const newCodex = JSON.stringify([
    _state.codex_tokens_today,
    _state.codex_today_sessions.map((x) => [x.session_id, x.total, x.last_seen]),
  ]);
  if (summarize(_state) !== prevSummary || newCodex !== prevCodex) changed = true;

  if (!changed) return null;

  const now = Date.now();
  if (now - _lastStatsRefresh > STATS_TTL) {
    const stats = readStatsCache(CLAUDE_HOME);
    _state.historical_daily = stats.daily.slice(-30);
    _lastStatsRefresh = now;
  }

  _state.last_updated = Date.now() / 1000;
  return _state;
}
