/**
 * Gates, sanitizes, and POSTs usage deltas to the central server; advances the
 * cursor only on a 2xx (see improve/09 §E.2). Best-effort: network failure keeps
 * the cursor untouched so the same deltas retry next tick — never blocks the UI.
 *
 * Gate (08 §6): push only apikey + confirmed. OAuth/chatgpt → drop (cursor still
 * advances, delta is "handled"). uncertain → hold: do NOT advance the cursor, so
 * the delta is re-evaluated once auth settles.
 */
import { CursorStore } from "./cursor";
import { Delta, BuildCtx, collectClaudeDeltas, collectCodexDeltas } from "./deltas";

// Catch a full key/token before it ever leaves the machine.
const SECRET_RE = /sk-ant-|sk-proj-[A-Za-z0-9]{20,}|[A-Za-z0-9_-]{40,}/;

export interface PushConfig {
  url: string;
  ingestKey: string;
  osUser: string;
  hostname: string;
}

export type Decision = "push" | "drop" | "hold";

// TEMP (testing only): also push oauth/chatgpt usage so the dashboard has data
// even without an apikey login. Revert to `false` before shipping — production
// must push apikey deltas ONLY (08 §6). No secret is exposed either way; oauth
// deltas simply carry no keyHash. Only the live tick() path reads this; decide()
// keeps its production default so the gate tests stay meaningful.
const TEMP_PUSH_NON_APIKEY = false;

/** Pure gate: what to do with a delta. `pushNonApikey` is TEMP test wiring. */
export function decide(d: Delta, pushNonApikey = false): Decision {
  if (d.auth.confidence === "uncertain") return "hold";
  // "unknown" is almost always transient — the credentials file was mid-rewrite
  // during an OAuth token refresh, so readIdentity() briefly saw no auth. HOLD
  // (do NOT advance the cursor) so the delta is re-evaluated next tick once auth
  // settles, instead of being dropped + skipped forever. A genuinely credential-
  // less machine just re-collects each tick (cheap) and never pushes.
  if (d.auth.authType === "unknown") return "hold";
  if (d.auth.authType === "apikey") return "push";
  if (pushNonApikey) return "push"; // TEMP: also push oauth/chatgpt
  return "drop"; // production: oauth / chatgpt
}

/** Strip to the wire fields only (08 §4.1) — drops internal _* helpers. */
export function toWire(d: Delta) {
  return {
    sessionId: d.sessionId,
    tool: d.tool,
    seq: d.seq,
    eventTsFrom: d.eventTsFrom,
    eventTsTo: d.eventTsTo,
    date: d.date,
    auth: {
      authType: d.auth.authType,
      keyHash: d.auth.keyHash,
      orgShort: d.auth.orgShort,
      confidence: d.auth.confidence,
    },
    project: d.project,
    repo: d.repo,
    model: d.model,
    tokens: d.tokens,
    costEstimate: d.costEstimate,
  };
}

export interface PlanResult {
  toPush: Delta[];
  toDropAdvance: Delta[]; // drop but advance cursor (handled)
  held: Delta[]; // uncertain — do not advance
}

/** Split deltas by decision (pure). `pushNonApikey` is TEMP test wiring. */
export function plan(deltas: Delta[], pushNonApikey = false): PlanResult {
  const r: PlanResult = { toPush: [], toDropAdvance: [], held: [] };
  for (const d of deltas) {
    const dec = decide(d, pushNonApikey);
    if (dec === "push") r.toPush.push(d);
    else if (dec === "drop") r.toDropAdvance.push(d);
    else r.held.push(d);
  }
  return r;
}

/** Advance the cursor for a processed delta (pushed-ok or dropped). */
export function advanceCursor(store: CursorStore, d: Delta): void {
  const prev = store.get(d.tool, d.sessionId);
  const tokens = d.tokens.input + d.tokens.output + d.tokens.cacheRead + d.tokens.cacheWrite;
  store.set({
    tool: d.tool,
    sessionId: d.sessionId,
    lastByteOffset: d._nextByteOffset ?? prev?.lastByteOffset,
    lastCommittedTotal: d._nextCommittedTotal ?? prev?.lastCommittedTotal,
    lastCommittedInput: d._nextCommittedInput ?? prev?.lastCommittedInput,
    lastCommittedOutput: d._nextCommittedOutput ?? prev?.lastCommittedOutput,
    lastCommittedCached: d._nextCommittedCached ?? prev?.lastCommittedCached,
    lastSeq: d.seq,
    cumTokens: (prev?.cumTokens ?? 0) + tokens,
    lastAuthMtime: d._authMtime,
  });
}

export interface Poster {
  (url: string, headers: Record<string, string>, body: string): Promise<{ ok: boolean; status: number }>;
}

/** Default poster using global fetch (Node 18+). */
export const fetchPoster: Poster = async (url, headers, body) => {
  const res = await fetch(url, { method: "POST", headers, body });
  return { ok: res.ok, status: res.status };
};

/**
 * One tick: collect → gate → (sanitize) → POST → advance cursor on 2xx.
 * Returns a small summary for logging. Never throws on network error.
 */
export interface Collector {
  (store: CursorStore, ctx: BuildCtx): Delta[];
}

const defaultCollect: Collector = (store, ctx) => [
  ...collectClaudeDeltas(store, ctx),
  ...collectCodexDeltas(store, ctx),
];

export async function tick(
  store: CursorStore,
  ctx: BuildCtx,
  cfg: PushConfig,
  post: Poster = fetchPoster,
  collect: Collector = defaultCollect,
  pushNonApikey = TEMP_PUSH_NON_APIKEY, // TEMP: default carries the flag; tests can force production gate
): Promise<{ pushed: number; dropped: number; held: number; error?: string }> {
  const deltas = collect(store, ctx);
  const { toPush, toDropAdvance, held } = plan(deltas, pushNonApikey);

  // Dropped deltas are handled → advance immediately (even if network is down).
  for (const d of toDropAdvance) advanceCursor(store, d);

  if (!toPush.length) {
    await store.flush();
    return { pushed: 0, dropped: toDropAdvance.length, held: held.length };
  }

  const wire = toPush.map(toWire);
  const payload = {
    schema: "usage.v1",
    reportedAt: new Date().toISOString(),
    machine: { osUser: cfg.osUser, hostname: cfg.hostname },
    deltas: wire,
  };
  const body = JSON.stringify(payload);

  // Sanitize: never send a payload that looks like it carries a raw secret.
  if (SECRET_RE.test(JSON.stringify(wire))) {
    await store.flush(); // persist the drop-advances above
    return { pushed: 0, dropped: toDropAdvance.length, held: held.length, error: "secret_in_payload" };
  }

  try {
    const res = await post(
      cfg.url.replace(/\/$/, "") + "/api/v1/usage",
      { "content-type": "application/json", "x-ingest-key": cfg.ingestKey },
      body,
    );
    if (res.ok) {
      for (const d of toPush) advanceCursor(store, d);
      await store.flush();
      return { pushed: toPush.length, dropped: toDropAdvance.length, held: held.length };
    }
    // Non-2xx: keep push cursors put; retry next tick. Drop-advances already saved.
    await store.flush();
    return { pushed: 0, dropped: toDropAdvance.length, held: held.length, error: `http_${res.status}` };
  } catch (e: any) {
    await store.flush();
    return { pushed: 0, dropped: toDropAdvance.length, held: held.length, error: `net_${e?.code || "err"}` };
  }
}
