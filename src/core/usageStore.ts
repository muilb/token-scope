/**
 * Incremental, de-duplicated view of every billed request in the local session
 * logs. One store feeds the dashboard, the history, and the central pusher.
 *
 *  - Reads only bytes appended since the last refresh, and only up to the last
 *    complete line (a half-written line is re-read next time instead of lost).
 *  - Keeps one record per request per file, merging repeated lines with a
 *    field-wise max (see mergeMax).
 *  - De-duplicates the same request across files (a resumed or forked session
 *    copies earlier turns into its new file); the request is attributed to the
 *    file where it appears earliest.
 */
import * as fs from "fs";
import { UsageRecord, parseClaudeLine, CodexParser, mergeMax, Tool } from "./usageRecord";
import { SessionFile, listClaudeFiles, listCodexFiles } from "./jsonlFiles";

export interface FileInfo {
  path: string;
  tool: Tool;
  sessionId: string;
  origin: "main" | "subagent";
  slug: string;
  cwd: string;
  /** Latest timestamp seen in the file (any line). */
  lastSeen: string;
  startedAt: string;
  /** Last request of this file (for context-window size). */
  lastRec: UsageRecord | null;
  /** Codex: model_context_window from the log. */
  contextWindow: number;
}

export interface Entry {
  rec: UsageRecord;
  file: FileInfo;
}

interface FileCache {
  info: FileInfo;
  offset: number;
  size: number;
  mtimeMs: number;
  records: Map<string, UsageRecord>;
  codex?: CodexParser;
}

function dayStartMs(day: string): number {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, (m || 1) - 1, d || 1).getTime();
}

function shiftDay(day: string, delta: number): string {
  const t = new Date(dayStartMs(day));
  t.setDate(t.getDate() + delta);
  const p = (x: number) => String(x).padStart(2, "0");
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}`;
}

export class UsageStore {
  private files = new Map<string, FileCache>();
  private version = 0;
  private cachedEntries: { version: number; list: Entry[] } | null = null;
  private sinceDay = "";

  constructor(
    private readonly claudeHome: string,
    private readonly codexHome: string,
    private readonly opts: { claude?: boolean; codex?: boolean } = {},
  ) {}

  /**
   * Bring the store up to date for requests on or after `sinceDay` (local
   * YYYY-MM-DD). Returns true when anything changed.
   */
  refresh(sinceDay: string): boolean {
    let changed = false;
    if (sinceDay !== this.sinceDay) {
      if (this.sinceDay && sinceDay > this.sinceDay) changed = this.prune(sinceDay) || changed;
      if (this.sinceDay && sinceDay < this.sinceDay) {
        // Window widened: older bytes were never kept — start over.
        this.files.clear();
        changed = true;
      }
      this.sinceDay = sinceDay;
    }
    const sinceMs = dayStartMs(sinceDay);
    const listed: SessionFile[] = [];
    if (this.opts.claude !== false) listed.push(...listClaudeFiles(this.claudeHome, sinceMs));
    if (this.opts.codex !== false) listed.push(...listCodexFiles(this.codexHome, sinceMs, shiftDay(sinceDay, -7)));

    const seen = new Set<string>();
    for (const f of listed) {
      seen.add(f.path);
      if (this.readFile(f, sinceDay)) changed = true;
    }
    for (const p of [...this.files.keys()]) {
      if (!seen.has(p)) {
        // Not modified inside the window any more: its requests are all older.
        this.files.delete(p);
        changed = true;
      }
    }
    if (changed) this.version++;
    return changed;
  }

  private prune(sinceDay: string): boolean {
    let changed = false;
    for (const fc of this.files.values()) {
      for (const [k, r] of fc.records) {
        if (r.day < sinceDay) {
          fc.records.delete(k);
          changed = true;
        }
      }
    }
    return changed;
  }

  private readFile(f: SessionFile, sinceDay: string): boolean {
    let fc = this.files.get(f.path);
    if (fc && f.size < fc.offset) fc = undefined; // truncated / rewritten → re-read
    if (fc && f.size === fc.size && f.mtimeMs === fc.mtimeMs) return false;
    if (!fc) {
      fc = {
        info: {
          path: f.path,
          tool: f.tool,
          sessionId: f.sessionId,
          origin: f.origin,
          slug: f.slug,
          cwd: "",
          lastSeen: "",
          startedAt: "",
          lastRec: null,
          contextWindow: 0,
        },
        offset: 0,
        size: 0,
        mtimeMs: 0,
        records: new Map(),
        codex: f.tool === "codex" ? new CodexParser(f.sessionId) : undefined,
      };
      this.files.set(f.path, fc);
    }
    fc.mtimeMs = f.mtimeMs;
    if (f.size <= fc.offset) {
      fc.size = f.size;
      return false;
    }

    let buf: Buffer;
    try {
      const fd = fs.openSync(f.path, "r");
      try {
        buf = Buffer.alloc(f.size - fc.offset);
        const got = fs.readSync(fd, buf, 0, buf.length, fc.offset);
        if (got < buf.length) buf = buf.subarray(0, got);
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return false;
    }
    const lastNl = buf.lastIndexOf(0x0a);
    if (lastNl < 0) {
      fc.size = f.size;
      return false; // only a partial line so far
    }
    fc.offset += lastNl + 1;
    fc.size = f.size;

    let changed = false;
    const text = buf.subarray(0, lastNl + 1).toString("utf8");
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (!line) continue;
      let obj: any;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      const ts: string = obj.timestamp ?? "";
      if (ts && ts > fc.info.lastSeen) fc.info.lastSeen = ts;
      if (ts && (!fc.info.startedAt || ts < fc.info.startedAt)) fc.info.startedAt = ts;

      let rec: UsageRecord | null;
      if (fc.codex) {
        rec = fc.codex.feed(obj);
        fc.info.cwd = fc.codex.cwd || fc.info.cwd;
        fc.info.contextWindow = fc.codex.contextWindow;
      } else {
        if (!fc.info.cwd && obj.cwd) fc.info.cwd = obj.cwd;
        rec = parseClaudeLine(obj);
      }
      if (!rec) continue;
      if (!fc.info.lastRec || rec.ts >= fc.info.lastRec.ts) fc.info.lastRec = rec;
      if (rec.day < sinceDay) continue;
      const prev = fc.records.get(rec.key);
      fc.records.set(rec.key, prev ? mergeMax(prev, rec) : rec);
      changed = true;
    }
    return changed;
  }

  /** All requests in the window, each counted once across files. */
  entries(): Entry[] {
    if (this.cachedEntries && this.cachedEntries.version === this.version) return this.cachedEntries.list;
    const byKey = new Map<string, Entry>();
    for (const fc of this.files.values()) {
      for (const rec of fc.records.values()) {
        const k = `${rec.tool}:${rec.key}`;
        const cur = byKey.get(k);
        if (!cur) {
          byKey.set(k, { rec, file: fc.info });
          continue;
        }
        const merged = mergeMax(cur.rec, rec);
        // Owner = the file where the request appears earliest (the original);
        // ties go to the main transcript, then the lexically smaller path.
        const curFirst = cur.rec.ts;
        const thisFirst = rec.ts;
        const takeThis =
          thisFirst < curFirst ||
          (thisFirst === curFirst &&
            ((fc.info.origin === "main" && cur.file.origin !== "main") ||
              (fc.info.origin === cur.file.origin && fc.info.path < cur.file.path)));
        byKey.set(k, { rec: merged, file: takeThis ? fc.info : cur.file });
      }
    }
    const list = [...byKey.values()];
    this.cachedEntries = { version: this.version, list };
    return list;
  }

  /** Per-file metadata (cwd, last seen, last request) for files in the window. */
  fileInfos(): FileInfo[] {
    return [...this.files.values()].map((f) => f.info);
  }

  get windowStart(): string {
    return this.sinceDay;
  }
}
