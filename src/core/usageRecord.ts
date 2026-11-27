/**
 * One billed model request, normalized across Claude Code and Codex logs. Every
 * consumer — the local dashboard, history, and the central pusher — derives its
 * numbers from these records, so they cannot disagree.
 *
 * Token fields are disjoint: `input` is UNCACHED input only; cache reads and
 * cache writes are separate; total = input + output + cacheRead + cacheWrite*.
 */
import { localDay } from "../util";

export type Tool = "claude" | "codex";

export interface UsageRecord {
  tool: Tool;
  /** Request identity — Claude: message.id:requestId; Codex: session:cumulativeTotal. */
  key: string;
  ts: string;
  day: string;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  /** Claude 5-minute cache write; Codex cache write (TTL not logged). */
  cacheWrite5m: number;
  /** Claude 1-hour cache write. */
  cacheWrite1h: number;
  webSearch: number;
  speed: "standard" | "fast";
  geo: "global" | "us";
}

export const TOKEN_FIELDS = ["input", "output", "cacheRead", "cacheWrite5m", "cacheWrite1h", "webSearch"] as const;

function n(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
}

export function totalTokens(r: Pick<UsageRecord, "input" | "output" | "cacheRead" | "cacheWrite5m" | "cacheWrite1h">): number {
  return r.input + r.output + r.cacheRead + r.cacheWrite5m + r.cacheWrite1h;
}

/**
 * Claude Code writes one JSONL line per content block of a response and stamps a
 * `usage` on each. The early lines are written while the response is still
 * streaming, so their output_tokens is PARTIAL; the last line carries the final
 * count. Merging two lines of the same request therefore keeps the field-wise
 * maximum (never the first line, which undercounts output).
 */
export function mergeMax(a: UsageRecord, b: UsageRecord): UsageRecord {
  const out: UsageRecord = { ...a };
  for (const f of TOKEN_FIELDS) out[f] = Math.max(a[f], b[f]);
  if (b.ts && (!a.ts || b.ts < a.ts)) {
    out.ts = b.ts;
    out.day = b.day;
  }
  if (b.speed === "fast") out.speed = "fast";
  if (b.geo === "us") out.geo = "us";
  return out;
}

/** Parse one Claude Code JSONL object into a record, or null if it is not billed usage. */
export function parseClaudeLine(obj: any): UsageRecord | null {
  if (!obj || obj.type !== "assistant") return null;
  const msg = obj.message ?? {};
  const u = msg.usage;
  if (!u || typeof u !== "object") return null;
  const model: string = msg.model ?? obj.model ?? "unknown";
  // Synthetic messages are local placeholders (API errors, interrupts) — not billed.
  if (model === "<synthetic>") return null;

  const ts: string = obj.timestamp ?? "";
  const cwTotal = n(u.cache_creation_input_tokens);
  const cc = u.cache_creation && typeof u.cache_creation === "object" ? u.cache_creation : null;
  let cw1h = cc ? n(cc.ephemeral_1h_input_tokens) : 0;
  let cw5m = cc ? n(cc.ephemeral_5m_input_tokens) : 0;
  // Older logs have no TTL split: everything is a 5-minute write. If the split
  // does not add up to the total, the remainder is priced as a 5-minute write.
  if (cw1h + cw5m < cwTotal) cw5m += cwTotal - cw1h - cw5m;
  if (cw1h > cwTotal && cwTotal > 0) cw1h = cwTotal;

  const rec: UsageRecord = {
    tool: "claude",
    key: msg.id && obj.requestId ? `${msg.id}:${obj.requestId}` : obj.uuid ? `uuid:${obj.uuid}` : "",
    ts,
    day: localDay(ts),
    model: model || "unknown",
    input: n(u.input_tokens),
    output: n(u.output_tokens),
    cacheRead: n(u.cache_read_input_tokens),
    cacheWrite5m: cw5m,
    cacheWrite1h: cw1h,
    webSearch: n(u.server_tool_use?.web_search_requests),
    speed: u.speed === "fast" ? "fast" : "standard",
    geo: u.inference_geo === "us" ? "us" : "global",
  };
  if (!rec.key || !rec.day) return null;
  if (totalTokens(rec) === 0 && rec.webSearch === 0) return null;
  return rec;
}

/**
 * Codex logs a `token_count` event after each model call carrying CUMULATIVE
 * session totals (and sometimes repeats the same totals). A request = an
 * increase of the cumulative total; its usage = the difference. Codex's
 * input_tokens includes cached and cache-write tokens, so they are split out.
 * Stateful: one parser per session file, fed lines in order.
 */
export class CodexParser {
  model = "";
  cwd = "";
  startedAt = "";
  lastSeen = "";
  contextWindow = 0;
  lastPromptTokens = 0;
  private prev = { input: 0, cached: 0, cacheWrite: 0, output: 0, total: 0 };

  constructor(readonly sessionId: string) {}

  feed(obj: any): UsageRecord | null {
    if (!obj || typeof obj !== "object") return null;
    const type: string = obj.type ?? obj.event ?? "";
    const p = obj.payload && typeof obj.payload === "object" ? obj.payload : {};
    const ts: string = obj.timestamp ?? "";
    if (ts && ts > this.lastSeen) this.lastSeen = ts;

    if (type === "session_meta") {
      this.cwd = p.cwd || this.cwd;
      this.startedAt = p.timestamp || ts || this.startedAt;
      return null;
    }
    if (type === "turn_context") {
      this.cwd = p.cwd || this.cwd;
      this.model = p.model || this.model;
      return null;
    }
    if (type !== "event_msg" || p.type !== "token_count") return null;
    const info = p.info && typeof p.info === "object" ? p.info : {};
    this.contextWindow = info.model_context_window || this.contextWindow;
    const ltu = info.last_token_usage;
    if (ltu && typeof ltu === "object") this.lastPromptTokens = n(ltu.input_tokens);
    const tu = info.total_token_usage;
    if (!tu || typeof tu !== "object") return null;

    const cur = {
      input: n(tu.input_tokens),
      cached: n(tu.cached_input_tokens),
      cacheWrite: n(tu.cache_write_input_tokens),
      output: n(tu.output_tokens),
      total: n(tu.total_tokens) || n(tu.input_tokens) + n(tu.output_tokens),
    };
    if (cur.total <= this.prev.total) {
      // Same totals repeated (no new request), or a counter reset: re-baseline on reset.
      if (cur.total < this.prev.total) this.prev = cur;
      return null;
    }
    const d = {
      input: Math.max(cur.input - this.prev.input, 0),
      cached: Math.max(cur.cached - this.prev.cached, 0),
      cacheWrite: Math.max(cur.cacheWrite - this.prev.cacheWrite, 0),
      output: Math.max(cur.output - this.prev.output, 0),
    };
    this.prev = cur;
    const day = localDay(ts);
    if (!day) return null;
    return {
      tool: "codex",
      key: `${this.sessionId}:${cur.total}`,
      ts,
      day,
      model: this.model || "unknown",
      input: Math.max(d.input - d.cached - d.cacheWrite, 0),
      output: d.output,
      cacheRead: d.cached,
      cacheWrite5m: d.cacheWrite,
      cacheWrite1h: 0,
      webSearch: 0,
      speed: "standard",
      geo: "global",
    };
  }
}
