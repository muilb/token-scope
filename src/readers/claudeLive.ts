import * as fs from "fs";
import * as path from "path";
import { computeCost, round } from "../pricing";
import {
  Usage,
  zeroUsage,
  addUsage,
  todayIso,
  startOfTodayMs,
  isoDaysAgo,
  tsAge,
  localDay,
} from "../util";

// In-memory state: filepath -> { offset, seen }
interface FileState {
  offset: number;
  seen: Set<string>;
}
const _fileState = new Map<string, FileState>();

export interface SessionRead {
  models: Record<string, Usage>;
  cwd: string;
  last_seen: string;
  ctx_tokens: number;
  dominant_model: string;
  tok_per_min: number;
}

export interface SessionModelUsage {
  model: string;
  total: number;
}

export interface ActiveSession {
  session_id: string;
  project_slug: string;
  cwd: string;
  model: string;
  ctx_tokens: number;
  tok_per_min: number;
  last_seen: string;
  status: string;
  input: number;
  output: number;
  cache_read: number;
  cache_create: number;
  // Per-model token totals for this session, today only. More than one entry
  // means the user switched models mid-session (e.g. /model). Sorted desc by total.
  models: SessionModelUsage[];
}

export interface ScanTodayResult {
  by_project: Record<
    string,
    { cwd: string; models: Record<string, Usage>; sessions: string[] }
  >;
  by_model: Record<string, Usage>;
  active_sessions: ActiveSession[];
}

function emptyScan(): ScanTodayResult {
  return { by_project: {}, by_model: {}, active_sessions: [] };
}

/**
 * Parse a session JSONL file from byteStart. Returns aggregated usage for
 * today's events only, plus updates the file offset/seen-uuid state.
 */
function readSessionFile(
  filePath: string,
  todayLocal: string,
  startOffset: number,
  seenUuids: Set<string>,
): SessionRead | null {
  let buf: Buffer;
  let fileSize: number;
  try {
    fileSize = fs.statSync(filePath).size;
    if (startOffset >= fileSize) {
      // Nothing new; still register state so future calls are correct.
      _fileState.set(filePath, { offset: fileSize, seen: seenUuids });
      return null;
    }
    const fd = fs.openSync(filePath, "r");
    try {
      const len = fileSize - startOffset;
      buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, startOffset);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }

  const newOffset = fileSize;
  const text = buf.toString("utf8");
  const lines = text.split("\n");

  const models: Record<string, Usage> = {};
  let cwd = "";
  let lastSeen = "";
  let lastModel = "";
  let ctxTokens = 0;

  for (const rawLine of lines) {
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

    const ts: string = obj.timestamp ?? "";
    if (localDay(ts) !== todayLocal) continue;

    const uuid: string = obj.uuid ?? "";
    if (uuid && seenUuids.has(uuid)) continue;
    if (uuid) seenUuids.add(uuid);

    const msg = obj.message ?? {};
    const usage = msg.usage;
    if (!usage) continue;

    let model: string = msg.model ?? obj.model ?? "unknown";
    if (!model) model = "unknown";

    const u = (models[model] ??= zeroUsage());
    u.input += usage.input_tokens ?? 0;
    u.output += usage.output_tokens ?? 0;
    u.cache_read += usage.cache_read_input_tokens ?? 0;
    u.cache_create += usage.cache_creation_input_tokens ?? 0;

    // Context the next turn will carry = everything this turn read/created plus
    // its own output (Claude Code folds the prior output into the next turn's
    // cache_read). Including output tracks Claude Code's own counter more closely.
    ctxTokens =
      (usage.input_tokens ?? 0) +
      (usage.cache_read_input_tokens ?? 0) +
      (usage.cache_creation_input_tokens ?? 0) +
      (usage.output_tokens ?? 0);
    lastSeen = ts;
    lastModel = model;
  }

  _fileState.set(filePath, { offset: newOffset, seen: seenUuids });

  if (Object.keys(models).length === 0) return null;

  let totalOutput = 0;
  for (const u of Object.values(models)) totalOutput += u.output;
  let tokPerMin = 0;
  if (lastSeen) {
    const elapsedMin = Math.max(tsAge(lastSeen) / 60, 0.1);
    tokPerMin = Math.round(totalOutput / elapsedMin);
  }

  return {
    models,
    cwd,
    last_seen: lastSeen,
    ctx_tokens: ctxTokens,
    dominant_model: lastModel,
    tok_per_min: tokPerMin,
  };
}

function slugToCwd(slug: string): string {
  if (!slug) return slug;
  const parts = slug.split(/--(.*)/s);
  if (parts.length >= 2 && parts[0].length === 1) {
    const drive = parts[0].toUpperCase() + ":";
    const rest = parts[1].replace(/-/g, "/");
    return drive + "/" + rest;
  }
  return slug.replace(/-/g, "/");
}

export function scanToday(claudeHome: string): ScanTodayResult {
  const projectsDir = path.join(claudeHome, "projects");
  if (!fs.existsSync(projectsDir)) return emptyScan();

  const todayPrefix = todayIso();
  const todayStartMs = startOfTodayMs();

  const byProject: ScanTodayResult["by_project"] = {};
  const byModel: Record<string, Usage> = {};
  const activeSessions: ActiveSession[] = [];

  let projEntries: fs.Dirent[];
  try {
    projEntries = fs.readdirSync(projectsDir, { withFileTypes: true });
  } catch {
    return emptyScan();
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
      let mtimeMs: number;
      try {
        mtimeMs = fs.statSync(jf).mtimeMs;
      } catch {
        continue;
      }
      if (mtimeMs < todayStartMs) continue;

      // Full scan from offset 0 with a fresh seen-set (matches Python scan_today).
      const result = readSessionFile(jf, todayPrefix, 0, new Set());
      if (!result) continue;

      const sessionId = fname.replace(/\.jsonl$/, "");
      const cwd = result.cwd || slugToCwd(slug);

      const proj = (byProject[slug] ??= { cwd, models: {}, sessions: [] });
      if (cwd && !proj.cwd) proj.cwd = cwd;
      if (!proj.sessions.includes(sessionId)) proj.sessions.push(sessionId);

      for (const [model, usage] of Object.entries(result.models)) {
        addUsage((proj.models[model] ??= zeroUsage()), usage);
        addUsage((byModel[model] ??= zeroUsage()), usage);
      }

      if (result.last_seen && tsAge(result.last_seen) < 1800) {
        const agg = zeroUsage();
        for (const usage of Object.values(result.models)) addUsage(agg, usage);
        const perModel: SessionModelUsage[] = Object.entries(result.models)
          .map(([model, u]) => ({
            model,
            total: u.input + u.output + u.cache_read + u.cache_create,
          }))
          .sort((a, b) => b.total - a.total);
        const age = tsAge(result.last_seen);
        const status = age < 300 ? "active" : "idle";
        activeSessions.push({
          session_id: sessionId,
          project_slug: slug,
          cwd,
          model: result.dominant_model,
          ctx_tokens: result.ctx_tokens,
          tok_per_min: status === "active" ? result.tok_per_min : 0,
          last_seen: result.last_seen,
          status,
          input: agg.input,
          output: agg.output,
          cache_read: agg.cache_read,
          cache_create: agg.cache_create,
          models: perModel,
        });
      }
    }
  }

  activeSessions.sort((a, b) => (a.last_seen < b.last_seen ? 1 : -1));

  return { by_project: byProject, by_model: byModel, active_sessions: activeSessions };
}

/** Read only new bytes appended since last call. Returns delta usage or null. */
export function incrementalRead(filePath: string): SessionRead | null {
  let fileSize: number;
  try {
    fileSize = fs.statSync(filePath).size;
  } catch {
    return null;
  }
  const st = _fileState.get(filePath) ?? { offset: 0, seen: new Set<string>() };
  if (fileSize <= st.offset) return null;
  return readSessionFile(filePath, todayIso(), st.offset, st.seen);
}

export interface HistCostDay {
  input: number;
  output: number;
  cache_read: number;
  cache_create: number;
  cost_usd: number;
}

/** Scan all JSONL to compute accurate cost per day for the last N days. */
export function scanHistoricalCosts(
  claudeHome: string,
  daysBack = 30,
): Record<string, HistCostDay> {
  const projectsDir = path.join(claudeHome, "projects");
  if (!fs.existsSync(projectsDir)) return {};

  const cutoffStr = isoDaysAgo(daysBack);
  const byDate: Record<string, HistCostDay> = {};

  let projEntries: fs.Dirent[];
  try {
    projEntries = fs.readdirSync(projectsDir, { withFileTypes: true });
  } catch {
    return {};
  }

  for (const projEnt of projEntries) {
    if (!projEnt.isDirectory()) continue;
    const projDir = path.join(projectsDir, projEnt.name);
    let files: string[];
    try {
      files = fs.readdirSync(projDir).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }

    for (const fname of files) {
      const jf = path.join(projDir, fname);
      let content: string;
      try {
        content = fs.readFileSync(jf, "utf8");
      } catch {
        continue;
      }
      const seen = new Set<string>();
      for (const rawLine of content.split("\n")) {
        const line = rawLine.trim();
        if (!line) continue;
        let obj: any;
        try {
          obj = JSON.parse(line);
        } catch {
          continue;
        }
        if (obj.type !== "assistant") continue;
        const ts: string = obj.timestamp ?? "";
        if (!ts) continue;
        const day = localDay(ts);
        if (!day || day < cutoffStr) continue;
        const uuid: string = obj.uuid ?? "";
        if (uuid) {
          if (seen.has(uuid)) continue;
          seen.add(uuid);
        }
        const msg = obj.message ?? {};
        const usage = msg.usage;
        if (!usage) continue;
        const model: string = msg.model ?? obj.model ?? "unknown";
        const inp = usage.input_tokens ?? 0;
        const out = usage.output_tokens ?? 0;
        const cr = usage.cache_read_input_tokens ?? 0;
        const cc = usage.cache_creation_input_tokens ?? 0;
        const cost = computeCost(inp, out, cr, cc, model || "unknown");
        const d = (byDate[day] ??= {
          input: 0,
          output: 0,
          cache_read: 0,
          cache_create: 0,
          cost_usd: 0.0,
        });
        d.input += inp;
        d.output += out;
        d.cache_read += cr;
        d.cache_create += cc;
        d.cost_usd = round(d.cost_usd + cost, 6);
      }
    }
  }

  return byDate;
}
