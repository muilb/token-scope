/**
 * Folds de-duplicated request records into the numbers the UI and the pusher
 * need. Cost is computed PER REQUEST (the long-prompt tier, fast mode and
 * inference geography are per-request properties) with the shared pricing v2.
 */
import { costOf, tierFor, promptTokens } from "../pricing";
import { UsageRecord, totalTokens, Tool } from "./usageRecord";
import { Entry } from "./usageStore";

export interface Totals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  webSearch: number;
  tokens: number;
  cost: number;
  requests: number;
}

export function zeroTotals(): Totals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, webSearch: 0, tokens: 0, cost: 0, requests: 0 };
}

export function recordTier(r: UsageRecord): "base" | "long" {
  return tierFor(r.model, promptTokens(r), r.day);
}

export function recordCost(r: UsageRecord): number {
  return costOf(r, r.model, { speed: r.speed, geo: r.geo, tier: recordTier(r), day: r.day });
}

export function addRecord(t: Totals, r: UsageRecord, cost = recordCost(r)): void {
  t.input += r.input;
  t.output += r.output;
  t.cacheRead += r.cacheRead;
  t.cacheWrite5m += r.cacheWrite5m;
  t.cacheWrite1h += r.cacheWrite1h;
  t.webSearch += r.webSearch;
  t.tokens += totalTokens(r);
  t.cost += cost;
  t.requests += 1;
}

export interface SessionSummary {
  tool: Tool;
  sessionId: string;
  slug: string;
  cwd: string;
  /** Model of the most recent request. */
  model: string;
  totals: Totals;
  byModel: Record<string, Totals>;
  subagentTokens: number;
  firstTs: string;
  lastTs: string;
  /** Output tokens in the last 5 minutes ÷ 5. */
  tokPerMin: number;
}

const RATE_WINDOW_MS = 5 * 60_000;

/** Per-session totals for requests on `day` (or all days in the window when day is omitted). */
export function sessionSummaries(entries: Entry[], day?: string, now = Date.now()): SessionSummary[] {
  const map = new Map<string, SessionSummary & { _lastModelTs: string; _recentOut: number }>();
  for (const { rec, file } of entries) {
    if (day && rec.day !== day) continue;
    const k = `${rec.tool}:${file.sessionId}`;
    let s = map.get(k);
    if (!s) {
      s = {
        tool: rec.tool,
        sessionId: file.sessionId,
        slug: file.slug,
        cwd: "",
        model: rec.model,
        totals: zeroTotals(),
        byModel: {},
        subagentTokens: 0,
        firstTs: rec.ts,
        lastTs: rec.ts,
        tokPerMin: 0,
        _lastModelTs: "",
        _recentOut: 0,
      };
      map.set(k, s);
    }
    if (file.origin === "main" && file.cwd) s.cwd = file.cwd;
    else if (!s.cwd && file.cwd) s.cwd = file.cwd;
    const c = recordCost(rec);
    addRecord(s.totals, rec, c);
    addRecord((s.byModel[rec.model] ??= zeroTotals()), rec, c);
    if (file.origin === "subagent") s.subagentTokens += totalTokens(rec);
    if (rec.ts < s.firstTs) s.firstTs = rec.ts;
    if (rec.ts > s.lastTs) s.lastTs = rec.ts;
    if (file.origin === "main" && rec.ts >= s._lastModelTs) {
      s._lastModelTs = rec.ts;
      s.model = rec.model;
    }
    const t = Date.parse(rec.ts);
    if (Number.isFinite(t) && now - t <= RATE_WINDOW_MS) s._recentOut += rec.output;
  }
  return [...map.values()].map(({ _lastModelTs, _recentOut, ...s }) => ({
    ...s,
    tokPerMin: Math.round(_recentOut / (RATE_WINDOW_MS / 60_000)),
  }));
}

/** Totals per model for `day`, split by tool. */
export function modelTotals(entries: Entry[], day: string, tool: Tool): Record<string, Totals> {
  const out: Record<string, Totals> = {};
  for (const { rec } of entries) {
    if (rec.day !== day || rec.tool !== tool) continue;
    addRecord((out[rec.model] ??= zeroTotals()), rec);
  }
  return out;
}

/** Totals per day (all days in the window), split by tool. */
export function dailyTotals(entries: Entry[], tool: Tool): Record<string, Totals> {
  const out: Record<string, Totals> = {};
  for (const { rec } of entries) {
    if (rec.tool !== tool) continue;
    addRecord((out[rec.day] ??= zeroTotals()), rec);
  }
  return out;
}

export function sumTotals(list: Totals[]): Totals {
  const t = zeroTotals();
  for (const x of list) {
    t.input += x.input;
    t.output += x.output;
    t.cacheRead += x.cacheRead;
    t.cacheWrite5m += x.cacheWrite5m;
    t.cacheWrite1h += x.cacheWrite1h;
    t.webSearch += x.webSearch;
    t.tokens += x.tokens;
    t.cost += x.cost;
    t.requests += x.requests;
  }
  return t;
}
