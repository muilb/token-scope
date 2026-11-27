/**
 * usage.v2 — the pusher sends BUCKET SNAPSHOTS, not deltas.
 *
 * A bucket is the absolute total of one session's requests on one day for one
 * (model, speed, tier, geo, origin) and one account. The server upserts it by
 * key and REPLACES the totals. That makes every push idempotent: re-sending,
 * backfilling, a crash between push and save, or a fix to how logs are counted
 * all converge on the right number instead of double counting or losing a
 * delta (the v1 delta stream could only add).
 *
 * Account attribution: each session gets an "auth stamp" the first time the
 * pusher sees it (the identity logged in at that moment). If the identity
 * changes while the session continues, a new stamp starts at that time. Stamps
 * persist across restarts. Sessions first seen long after their requests
 * (backfill) are stamped with the current identity and flagged "assumed".
 */
import * as crypto from "crypto";
import { UsageRecord } from "../core/usageRecord";
import { Entry } from "../core/usageStore";
import { recordTier } from "../core/aggregate";
import { AccountIdentity } from "../readers/identity";
import { resolveProject, ProjectMap } from "../identity/projectMap";
import { slugToCwd } from "../readers/claudeLive";

export interface AuthInfo {
  memberKey: string;
  authType: "oauth" | "apikey" | "chatgpt";
  plan: string;
  email?: string;
  accountUuid?: string;
  displayName?: string;
  orgId?: string;
  keyHash?: string;
}

export interface AuthStamp {
  fromTs: string;
  auth: AuthInfo;
  confidence: "confirmed" | "assumed";
}

export interface Bucket {
  tool: "claude" | "codex";
  sessionId: string;
  date: string;
  model: string;
  speed: string;
  tier: string;
  geo: string;
  origin: "main" | "subagent";
  member: { key: string; email?: string; accountUuid?: string; displayName?: string };
  auth: { authType: string; plan: string; keyHash?: string; orgId?: string; confidence: string };
  project: string;
  repo: string;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite5m: number; cacheWrite1h: number; webSearch: number };
  requests: number;
  firstTs: string;
  lastTs: string;
}

/** Account the given tool is currently logged in as, or null while unknown (hold). */
export function currentAuth(tool: "claude" | "codex", id: AccountIdentity, owner: string, hostname: string): AuthInfo | null {
  const ownerKey = owner ? `owner:${owner.toLowerCase()}` : `os:${id.osUser}@${hostname}`.toLowerCase();
  const ownerEmail = /@/.test(owner) ? owner : undefined;
  if (tool === "claude") {
    const c = id.claude;
    if (c.authType === "apikey") {
      return { memberKey: ownerKey, authType: "apikey", plan: "apikey", keyHash: c.keyHash, email: ownerEmail };
    }
    if (c.authType === "oauth") {
      const key = c.accountUuid ? `acct:${c.accountUuid}` : c.email ? `email:${c.email.toLowerCase()}` : ownerKey;
      return {
        memberKey: key,
        authType: "oauth",
        plan: c.subscriptionType || c.seatTier || "oauth",
        email: c.email || ownerEmail,
        accountUuid: c.accountUuid,
        displayName: c.displayName,
        orgId: c.orgId,
      };
    }
    return null;
  }
  const x = id.codex;
  if (x.authType === "apikey") {
    return { memberKey: ownerKey, authType: "apikey", plan: "apikey", keyHash: x.keyHash, email: ownerEmail };
  }
  if (x.authType === "chatgpt") {
    const key = x.accountId ? `oai:${x.accountId}` : x.email ? `email:${x.email.toLowerCase()}` : ownerKey;
    return { memberKey: key, authType: "chatgpt", plan: x.plan || "chatgpt", email: x.email || ownerEmail };
  }
  return null;
}

function authFingerprint(a: AuthInfo): string {
  return [a.memberKey, a.authType, a.plan, a.keyHash || "", a.orgId || ""].join("|");
}

/** Stamps persisted per session ("tool:sessionId" → ordered stamps). */
export type StampMap = Record<string, AuthStamp[]>;

const ASSUME_AFTER_MS = 15 * 60_000;

/**
 * Account a session is billed to right now. Claude depends on the session's
 * project directory: a project's `apiKeyHelper` can pick its own API key.
 * null = unknown (the session is held).
 */
export type AuthResolver = (tool: "claude" | "codex", cwd: string) => AuthInfo | null;

/** Project directory of a log file (Claude: from the log, else the folder slug). */
export function fileCwd(file: Entry["file"], tool: "claude" | "codex"): string {
  return file.cwd || (tool === "claude" ? slugToCwd(file.slug) : "");
}

/**
 * Make sure every session in `entries` has a stamp; append a new stamp when the
 * identity changed. Sessions whose identity is unknown get none (held).
 */
export function updateStamps(stamps: StampMap, entries: Entry[], authFor: AuthResolver, nowIso: string): boolean {
  let changed = false;
  const firstTs = new Map<string, string>();
  const lastTs = new Map<string, string>();
  const cwdOf = new Map<string, string>();
  for (const { rec, file } of entries) {
    const k = `${rec.tool}:${file.sessionId}`;
    const f = firstTs.get(k);
    if (!f || rec.ts < f) firstTs.set(k, rec.ts);
    const l = lastTs.get(k);
    if (!l || rec.ts > l) lastTs.set(k, rec.ts);
    if (!cwdOf.get(k)) cwdOf.set(k, fileCwd(file, rec.tool));
  }
  const now = Date.parse(nowIso);
  for (const [k, first] of firstTs) {
    const tool = k.startsWith("codex:") ? "codex" : "claude";
    const auth = authFor(tool, cwdOf.get(k) || "");
    if (!auth) continue;
    const list = stamps[k];
    if (!list || !list.length) {
      const last = Date.parse(lastTs.get(k) || first);
      const confidence = Number.isFinite(last) && now - last > ASSUME_AFTER_MS ? "assumed" : "confirmed";
      stamps[k] = [{ fromTs: "", auth, confidence }];
      changed = true;
      continue;
    }
    const cur = list[list.length - 1];
    if (authFingerprint(cur.auth) !== authFingerprint(auth)) {
      list.push({ fromTs: nowIso, auth, confidence: "confirmed" });
      changed = true;
    }
  }
  return changed;
}

/** Drop stamps of sessions that no longer have requests in the window. */
export function pruneStamps(stamps: StampMap, entries: Entry[]): void {
  const live = new Set(entries.map((e) => `${e.rec.tool}:${e.file.sessionId}`));
  for (const k of Object.keys(stamps)) if (!live.has(k)) delete stamps[k];
}

function stampFor(list: AuthStamp[] | undefined, ts: string): AuthStamp | null {
  if (!list || !list.length) return null;
  let pick = list[0];
  for (const s of list) if (!s.fromTs || s.fromTs <= ts) pick = s;
  return pick;
}

export interface BuildOpts {
  stamps: StampMap;
  projectMap: ProjectMap;
}

export function bucketKey(b: Pick<Bucket, "tool" | "sessionId" | "date" | "model" | "speed" | "tier" | "geo" | "origin" | "member">): string {
  return [b.tool, b.sessionId, b.date, b.model, b.speed, b.tier, b.geo, b.origin, b.member.key].join("|");
}

/** Fold de-duplicated requests into bucket snapshots. Requests without a stamp are skipped (held). */
export function buildBuckets(entries: Entry[], opts: BuildOpts): Bucket[] {
  const map = new Map<string, Bucket>();
  for (const { rec, file } of entries) {
    const stamp = stampFor(opts.stamps[`${rec.tool}:${file.sessionId}`], rec.ts);
    if (!stamp) continue;
    const a = stamp.auth;
    const repo = fileCwd(file, rec.tool);
    const proto = {
      tool: rec.tool,
      sessionId: file.sessionId,
      date: rec.day,
      model: rec.model,
      speed: rec.speed,
      tier: recordTier(rec),
      geo: rec.geo,
      origin: file.origin,
      member: { key: a.memberKey, email: a.email, accountUuid: a.accountUuid, displayName: a.displayName },
    };
    const k = bucketKey(proto);
    let b = map.get(k);
    if (!b) {
      b = {
        ...proto,
        auth: { authType: a.authType, plan: a.plan, keyHash: a.keyHash, orgId: a.orgId, confidence: stamp.confidence },
        project: resolveProject(repo, a.keyHash, opts.projectMap),
        repo,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, webSearch: 0 },
        requests: 0,
        firstTs: rec.ts,
        lastTs: rec.ts,
      };
      map.set(k, b);
    }
    addTokens(b, rec);
  }
  return [...map.values()];
}

function addTokens(b: Bucket, r: UsageRecord): void {
  b.tokens.input += r.input;
  b.tokens.output += r.output;
  b.tokens.cacheRead += r.cacheRead;
  b.tokens.cacheWrite5m += r.cacheWrite5m;
  b.tokens.cacheWrite1h += r.cacheWrite1h;
  b.tokens.webSearch += r.webSearch;
  b.requests += 1;
  if (r.ts < b.firstTs) b.firstTs = r.ts;
  if (r.ts > b.lastTs) b.lastTs = r.ts;
}

/** Content hash of everything the server stores for a bucket — unchanged hash = nothing to push. */
export function bucketHash(b: Bucket): string {
  return crypto.createHash("sha1").update(JSON.stringify(b)).digest("hex").slice(0, 16);
}
