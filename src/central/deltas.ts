/**
 * Builds usage deltas (payload unit = delta event, see improve/08 §4.1) from
 * local JSONL, attaching the auth read AT THE MOMENT the delta is processed
 * (per-delta auth — the core of 08 §6). Only the delta shape is produced here;
 * gating + queueing lives in pusher.ts.
 *
 * Two collection strategies (09 §0):
 *   - Claude: append-only JSONL → read new bytes from lastByteOffset.
 *   - Codex: reader parses whole-file snapshots → delta = committed_total diff.
 */
import * as fs from "fs";
import * as path from "path";
import { computeCost, CLAUDE_HOME, CODEX_HOME } from "../pricing";
import { slugToCwd } from "../readers/claudeLive";
import { scanCodexSessions } from "../readers/codexReader";
import { localDay } from "../util";
import { AccountIdentity, ClaudeIdentity, CodexIdentity } from "../readers/identity";
import { resolveProject, ProjectMap } from "../identity/projectMap";
import { CursorStore, Cursor } from "./cursor";

export interface DeltaAuth {
  authType: "oauth" | "apikey" | "chatgpt" | "unknown";
  keyHash?: string;
  orgShort?: string;
  confidence: "confirmed" | "uncertain";
}

export interface Delta {
  sessionId: string;
  tool: "claude" | "codex";
  seq: number;
  eventTsFrom?: string;
  eventTsTo?: string;
  date: string;
  auth: DeltaAuth;
  project: string;
  repo: string;
  model: string;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  costEstimate: number;
  /** Byte offset reached after this delta (Claude) — for advancing the cursor on 2xx. */
  _nextByteOffset?: number;
  /** message.id:requestId of the last response counted (Claude) — persisted for cross-tick dedup. */
  _nextMsgKey?: string;
  /** committed_* reached after this delta (Codex) — for advancing on 2xx. */
  _nextCommittedTotal?: number;
  _nextCommittedInput?: number;
  _nextCommittedOutput?: number;
  _nextCommittedCached?: number;
  /** Auth-file mtime observed while building — for uncertainty on the next tick. */
  _authMtime: number;
}

export interface BuildCtx {
  identity: AccountIdentity;
  projectMap: ProjectMap;
  authMtimes: { claude: number; codex: number };
  now?: number;
  /**
   * Per-project Claude auth, honouring the project's `apiKeyHelper` (each
   * project may draw its key from a different env var). Injected so tests can
   * drive it; when absent, every delta falls back to the global identity, which
   * is the pre-0.7.0 behaviour.
   */
  claudeAuthFor?: (cwd: string) => { identity: ClaudeIdentity; mtime: number };
}

/**
 * Decide confidence: uncertain ONLY if the auth file was last modified during the
 * time window this delta covers — i.e. a login switch happened mid-batch, so we
 * can't cleanly attribute the usage. A refresh before or after the window leaves
 * attribution unambiguous.
 *
 * We deliberately do NOT compare against the cursor's previously-stored mtime:
 * OAuth access tokens refresh periodically, rewriting .credentials.json. The old
 * "changed since last cursor" rule then marked such deltas uncertain → held →
 * cursor never advanced → its stored mtime stayed frozen → every later delta was
 * uncertain forever (livelock; observed on live sessions spanning a refresh).
 */
function confidenceFor(authMtime: number, tsFrom?: string, tsTo?: string): DeltaAuth["confidence"] {
  const from = Date.parse(tsFrom || "");
  const to = Date.parse(tsTo || "");
  if (Number.isFinite(from) && Number.isFinite(to) && authMtime >= from && authMtime <= to) {
    return "uncertain";
  }
  return "confirmed";
}

function claudeAuth(c: ClaudeIdentity, confidence: DeltaAuth["confidence"]): DeltaAuth {
  return {
    authType: c.authType,
    keyHash: c.keyHash,
    orgShort: c.orgShort,
    confidence,
  };
}

function codexAuth(c: CodexIdentity, confidence: DeltaAuth["confidence"]): DeltaAuth {
  return {
    authType: c.authType,
    keyHash: c.keyHash,
    orgShort: undefined,
    confidence,
  };
}

// ---------------------------------------------------------------------------
// Claude — append-only JSONL, delta = new bytes since lastByteOffset
// ---------------------------------------------------------------------------
export function collectClaudeDeltas(store: CursorStore, ctx: BuildCtx): Delta[] {
  const projectsDir = path.join(CLAUDE_HOME, "projects");
  if (!fs.existsSync(projectsDir)) return [];

  const out: Delta[] = [];
  let projEntries: fs.Dirent[];
  try {
    projEntries = fs.readdirSync(projectsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const projEnt of projEntries) {
    if (!projEnt.isDirectory()) continue;
    const slug = projEnt.name;
    const projDir = path.join(projectsDir, slug);
    let files: string[];
    try {
      files = fs.readdirSync(projDir).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }

    for (const fname of files) {
      const jf = path.join(projDir, fname);
      const sessionId = fname.replace(/\.jsonl$/, "");
      const delta = readClaudeSession(jf, sessionId, slug, store, ctx);
      if (delta) out.push(delta);
    }
  }
  return out;
}

function readClaudeSession(
  filePath: string,
  sessionId: string,
  slug: string,
  store: CursorStore,
  ctx: BuildCtx,
): Delta | null {
  let size: number;
  try {
    size = fs.statSync(filePath).size;
  } catch {
    return null;
  }

  const cursor = store.get("claude", sessionId);

  // No backfill: first time we see a session, seed cursor at end-of-file and
  // emit nothing (08 §5.2b). Cursor is persisted by the caller after the tick.
  if (!cursor) {
    store.set({
      tool: "claude",
      sessionId,
      lastByteOffset: size,
      lastSeq: 0,
      cumTokens: 0,
      lastAuthMtime: ctx.authMtimes.claude,
    });
    return null;
  }

  const start = cursor.lastByteOffset ?? 0;
  if (size <= start) return null;

  let buf: Buffer;
  try {
    const fd = fs.openSync(filePath, "r");
    try {
      buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, size - start, start);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }

  let input = 0, output = 0, cacheRead = 0, cacheWrite = 0;
  let cwd = "";
  let model = "unknown";
  let tsFrom = "", tsTo = "";

  // Dedup by API response identity (message.id:requestId), NOT the JSONL line:
  // a multi-block response repeats the same `usage` across several lines, so
  // summing every line double-counts its tokens. Seed with the last key counted
  // (persisted in the cursor) so a duplicate that arrives on a later tick — the
  // blocks can be written seconds apart — is still skipped. See cursor.lastMsgKey.
  const seen = new Set<string>();
  if (cursor.lastMsgKey) seen.add(cursor.lastMsgKey);
  let lastMsgKey = cursor.lastMsgKey;

  for (const rawLine of buf.toString("utf8").split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (!cwd && obj.cwd) cwd = obj.cwd;
    if (obj.type !== "assistant") continue;
    const msg = obj.message;
    const usage = msg?.usage;
    if (!usage) continue;
    const key = msg?.id && obj.requestId ? `${msg.id}:${obj.requestId}` : "";
    if (key && seen.has(key)) continue;
    if (key) {
      seen.add(key);
      lastMsgKey = key;
    }
    const ts: string = obj.timestamp ?? "";
    if (ts) {
      if (!tsFrom) tsFrom = ts;
      tsTo = ts;
    }
    input += usage.input_tokens ?? 0;
    output += usage.output_tokens ?? 0;
    cacheRead += usage.cache_read_input_tokens ?? 0;
    cacheWrite += usage.cache_creation_input_tokens ?? 0;
    model = msg?.model ?? obj.model ?? model;
  }

  const total = input + output + cacheRead + cacheWrite;
  if (total === 0) {
    // Nothing new to bill (only non-usage lines, or already-counted duplicates);
    // still advance offset — and remember the last key — so we don't re-read.
    store.set({ ...cursor, lastByteOffset: size, lastMsgKey });
    return null;
  }

  const cwdResolved = cwd || slugToCwd(slug);
  // Auth is resolved per project: with apiKeyHelper, two sessions running at the
  // same moment can legitimately bill to two different keys.
  const perProject = ctx.claudeAuthFor?.(cwdResolved);
  const claudeId = perProject?.identity ?? ctx.identity.claude;
  const authMtime = Math.max(ctx.authMtimes.claude, perProject?.mtime ?? 0);
  const confidence = confidenceFor(authMtime, tsFrom, tsTo);

  return {
    sessionId,
    tool: "claude",
    seq: cursor.lastSeq + 1,
    eventTsFrom: tsFrom,
    eventTsTo: tsTo,
    date: localDay(tsTo) || localDay(new Date().toISOString()),
    auth: claudeAuth(claudeId, confidence),
    project: resolveProject(cwdResolved, undefined, ctx.projectMap),
    repo: cwdResolved,
    model,
    tokens: { input, output, cacheRead, cacheWrite },
    costEstimate: computeCost(input, output, cacheRead, cacheWrite, model),
    _nextByteOffset: size,
    _nextMsgKey: lastMsgKey,
    _authMtime: authMtime,
  };
}

// ---------------------------------------------------------------------------
// Codex — whole-file snapshot, delta = committed_total diff since cursor
// ---------------------------------------------------------------------------
export function collectCodexDeltas(store: CursorStore, ctx: BuildCtx): Delta[] {
  const out: Delta[] = [];
  let result;
  try {
    // Pusher only consumes result.today.sessions, so scan just today (daysBack=0)
    // instead of 7 days — the extra days were parsed and discarded each tick,
    // which matters once the fallback interval drops to 1 min.
    result = scanCodexSessions(CODEX_HOME, 0);
  } catch {
    return [];
  }

  for (const sess of result.today.sessions) {
    const sessionId = sess.session_id;
    const committedTotal = sess.committed_total ?? 0;
    const cursor = store.get("codex", sessionId);

    const curInput = sess.committed_input ?? 0;
    const curOutput = sess.committed_output ?? 0;
    const curCached = sess.committed_cached ?? 0;

    // No backfill: seed at current snapshot, emit nothing.
    if (!cursor) {
      store.set({
        tool: "codex",
        sessionId,
        lastCommittedTotal: committedTotal,
        lastCommittedInput: curInput,
        lastCommittedOutput: curOutput,
        lastCommittedCached: curCached,
        lastSeq: 0,
        cumTokens: 0,
        lastAuthMtime: ctx.authMtimes.codex,
      });
      continue;
    }

    const deltaTotal = committedTotal - (cursor.lastCommittedTotal ?? 0);
    if (deltaTotal <= 0) continue;

    // Snapshot gives cumulative committed_* only; delta = current minus the
    // per-field baseline in the cursor. Per-session granularity by design (09 §E.3).
    const input = Math.max(curInput - (cursor.lastCommittedInput ?? 0), 0);
    const output = Math.max(curOutput - (cursor.lastCommittedOutput ?? 0), 0);
    const cached = Math.max(curCached - (cursor.lastCommittedCached ?? 0), 0);
    const model = sess.model || "unknown";
    const confidence = confidenceFor(ctx.authMtimes.codex, sess.started_at, sess.last_seen);
    const repo = sess.cwd || "";

    out.push({
      sessionId,
      tool: "codex",
      seq: cursor.lastSeq + 1,
      eventTsFrom: sess.started_at,
      eventTsTo: sess.last_seen,
      date: sess.date || localDay(sess.last_seen),
      auth: codexAuth(ctx.identity.codex, confidence),
      project: resolveProject(repo, ctx.identity.codex.keyHash, ctx.projectMap),
      repo,
      model,
      tokens: { input, output, cacheRead: cached, cacheWrite: 0 },
      costEstimate: computeCost(Math.max(input - cached, 0), output, cached, 0, model),
      _nextCommittedTotal: committedTotal,
      _nextCommittedInput: curInput,
      _nextCommittedOutput: curOutput,
      _nextCommittedCached: curCached,
      _authMtime: ctx.authMtimes.codex,
    });
  }
  return out;
}
