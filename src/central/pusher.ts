/**
 * Pushes usage.v2 bucket snapshots to the central server (see buckets.ts).
 *
 *  - Every account type is pushed: API key, Claude subscription/Teams (OAuth),
 *    ChatGPT. The server decides what to price (API key only) — the client no
 *    longer drops subscription usage.
 *  - Only buckets whose content changed since the last successful push are sent,
 *    in batches; a batch's push state is saved only after a 2xx.
 *  - A bucket that existed before but has no requests now (e.g. a request was
 *    re-attributed to the session it was copied from) is sent with zero totals.
 *  - Secret scan uses specific key/token patterns and drops only the offending
 *    bucket. The old catch-all /[A-Za-z0-9_-]{40,}/ matched long repo names
 *    and blocked the whole machine forever.
 */
import { Entry } from "../core/usageStore";
import {
  Bucket,
  StampMap,
  AuthInfo,
  buildBuckets,
  bucketHash,
  bucketKey,
  updateStamps,
  pruneStamps,
} from "./buckets";
import { ProjectMap } from "../identity/projectMap";

/** Full keys/tokens — never a path, a uuid or a long project name. */
export const SECRET_RE = /sk-ant-[A-Za-z0-9_-]{8,}|sk-proj-[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9]{40,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./;

export const SCHEMA = "usage.v2";
export const BATCH_SIZE = 500;

export interface PushConfig {
  url: string;
  ingestKey: string;
  osUser: string;
  hostname: string;
  clientVersion?: string;
}

/** Persisted pusher state (globalState). */
export interface PushState {
  /** bucketKey → last successfully pushed bucket + its hash. */
  pushed: Record<string, { hash: string; bucket: Bucket }>;
  stamps: StampMap;
}

export interface KeyValueStore {
  get<T>(key: string, def: T): T;
  update(key: string, value: unknown): Thenable<void> | Promise<void>;
}

const STATE_KEY = "tokenscope.central.v2";

export function loadState(kv: KeyValueStore): PushState {
  const s = kv.get<PushState | null>(STATE_KEY, null);
  return s && typeof s === "object" ? { pushed: s.pushed || {}, stamps: s.stamps || {} } : { pushed: {}, stamps: {} };
}

export function saveState(kv: KeyValueStore, s: PushState): Thenable<void> | Promise<void> {
  return kv.update(STATE_KEY, s);
}

export interface Poster {
  (url: string, headers: Record<string, string>, body: string): Promise<{ ok: boolean; status: number }>;
}

export const fetchPoster: Poster = async (url, headers, body) => {
  const res = await fetch(url, { method: "POST", headers, body });
  return { ok: res.ok, status: res.status };
};

export interface TickInput {
  entries: Entry[];
  windowStart: string;
  authNow: { claude: AuthInfo | null; codex: AuthInfo | null };
  projectMap: ProjectMap;
  nowIso?: string;
}

export interface TickResult {
  pushed: number;
  unchanged: number;
  held: number;
  secretDropped: number;
  error?: string;
}

/** The buckets that must be sent: changed ones plus zeroed tombstones. Pure. */
export function planPush(state: PushState, buckets: Bucket[], windowStart: string): { send: Bucket[]; unchanged: number } {
  const send: Bucket[] = [];
  let unchanged = 0;
  const live = new Set<string>();
  for (const b of buckets) {
    const k = bucketKey(b);
    live.add(k);
    const prev = state.pushed[k];
    if (prev && prev.hash === bucketHash(b)) unchanged++;
    else send.push(b);
  }
  for (const [k, p] of Object.entries(state.pushed)) {
    if (live.has(k)) continue;
    if (p.bucket.date < windowStart) continue; // just aged out of the window — keep server value
    if (p.bucket.requests === 0) continue; // already zeroed
    send.push({
      ...p.bucket,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, webSearch: 0 },
      requests: 0,
    });
  }
  return { send, unchanged };
}

/** One tick: stamp → bucket → diff → POST in batches → save state per successful batch. */
export async function tick(
  kv: KeyValueStore,
  input: TickInput,
  cfg: PushConfig,
  post: Poster = fetchPoster,
): Promise<TickResult> {
  const state = loadState(kv);
  const nowIso = input.nowIso ?? new Date().toISOString();
  updateStamps(state.stamps, input.entries, input.authNow, nowIso);
  pruneStamps(state.stamps, input.entries);

  const buckets = buildBuckets(input.entries, { stamps: state.stamps, projectMap: input.projectMap });
  const stamped = new Set(Object.keys(state.stamps));
  const held = new Set(
    input.entries.filter((e) => !stamped.has(`${e.rec.tool}:${e.file.sessionId}`)).map((e) => `${e.rec.tool}:${e.file.sessionId}`),
  ).size;

  const { send, unchanged } = planPush(state, buckets, input.windowStart);
  const clean: Bucket[] = [];
  let secretDropped = 0;
  for (const b of send) {
    if (SECRET_RE.test(JSON.stringify(b))) {
      secretDropped++;
      console.warn("tokenscope central: bucket dropped (looks like it carries a secret)", b.tool, b.sessionId, b.date);
    } else {
      clean.push(b);
    }
  }

  // Drop push-state entries that aged out of the window (keeps the state small).
  for (const [k, p] of Object.entries(state.pushed)) if (p.bucket.date < input.windowStart) delete state.pushed[k];

  let pushed = 0;
  for (let i = 0; i < clean.length; i += BATCH_SIZE) {
    const batch = clean.slice(i, i + BATCH_SIZE);
    const body = JSON.stringify({
      schema: SCHEMA,
      reportedAt: nowIso,
      machine: { osUser: cfg.osUser, hostname: cfg.hostname },
      client: { version: cfg.clientVersion || "" },
      buckets: batch,
    });
    let res: { ok: boolean; status: number };
    try {
      res = await post(cfg.url.replace(/\/$/, "") + "/api/v1/usage", {
        "content-type": "application/json",
        "x-ingest-key": cfg.ingestKey,
      }, body);
    } catch (e: any) {
      await saveState(kv, state);
      return { pushed, unchanged, held, secretDropped, error: `net_${e?.code || "err"}` };
    }
    if (!res.ok) {
      await saveState(kv, state);
      return { pushed, unchanged, held, secretDropped, error: `http_${res.status}` };
    }
    for (const b of batch) state.pushed[bucketKey(b)] = { hash: bucketHash(b), bucket: b };
    pushed += batch.length;
    await saveState(kv, state);
  }
  await saveState(kv, state);
  return { pushed, unchanged, held, secretDropped };
}
