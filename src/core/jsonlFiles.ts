/**
 * Enumerates session log files. Claude Code writes a session's main transcript
 * to projects/<slug>/<sessionId>.jsonl and each subagent's transcript to
 * projects/<slug>/<sessionId>/subagents/<agent>.jsonl — the subagent files are
 * billed usage of that same session and must be counted (they were skipped
 * before, ~20% of tokens on a heavy-subagent machine).
 */
import * as fs from "fs";
import * as path from "path";
import { Tool } from "./usageRecord";

export interface SessionFile {
  path: string;
  tool: Tool;
  /** Parent session id (for a subagent file: the session that spawned it). */
  sessionId: string;
  origin: "main" | "subagent";
  /** Claude project slug ("" for Codex). */
  slug: string;
  mtimeMs: number;
  size: number;
}

function stat(p: string): fs.Stats | null {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

function readdir(p: string): fs.Dirent[] {
  try {
    return fs.readdirSync(p, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Claude session + subagent files modified at or after `sinceMs`. */
export function listClaudeFiles(claudeHome: string, sinceMs: number): SessionFile[] {
  const out: SessionFile[] = [];
  const projectsDir = path.join(claudeHome, "projects");
  for (const proj of readdir(projectsDir)) {
    if (!proj.isDirectory()) continue;
    const slug = proj.name;
    const projDir = path.join(projectsDir, slug);
    for (const ent of readdir(projDir)) {
      const full = path.join(projDir, ent.name);
      if (ent.isFile() && ent.name.endsWith(".jsonl")) {
        const st = stat(full);
        if (st && st.mtimeMs >= sinceMs) {
          out.push({
            path: full,
            tool: "claude",
            sessionId: ent.name.replace(/\.jsonl$/, ""),
            origin: "main",
            slug,
            mtimeMs: st.mtimeMs,
            size: st.size,
          });
        }
      } else if (ent.isDirectory()) {
        const subDir = path.join(full, "subagents");
        for (const sub of readdir(subDir)) {
          if (!sub.isFile() || !sub.name.endsWith(".jsonl")) continue;
          const sp = path.join(subDir, sub.name);
          const st = stat(sp);
          if (st && st.mtimeMs >= sinceMs) {
            out.push({
              path: sp,
              tool: "claude",
              sessionId: ent.name,
              origin: "subagent",
              slug,
              mtimeMs: st.mtimeMs,
              size: st.size,
            });
          }
        }
      }
    }
  }
  return out;
}

/**
 * Codex rollout files modified at or after `sinceMs`. Day folders older than
 * `dirCutoff` (YYYY-MM-DD) are not walked — a rollout lives in the folder of the
 * day it started, so the cutoff should sit some days before the window start.
 */
export function listCodexFiles(codexHome: string, sinceMs: number, dirCutoff: string): SessionFile[] {
  const out: SessionFile[] = [];
  const root = path.join(codexHome, "sessions");
  for (const y of readdir(root)) {
    if (!y.isDirectory()) continue;
    for (const m of readdir(path.join(root, y.name))) {
      if (!m.isDirectory()) continue;
      for (const d of readdir(path.join(root, y.name, m.name))) {
        if (!d.isDirectory()) continue;
        const dateStr = `${y.name.padStart(4, "0")}-${m.name.padStart(2, "0")}-${d.name.padStart(2, "0")}`;
        if (dateStr < dirCutoff) continue;
        const dayDir = path.join(root, y.name, m.name, d.name);
        for (const f of readdir(dayDir)) {
          if (!f.isFile() || !f.name.startsWith("rollout-") || !f.name.endsWith(".jsonl")) continue;
          const fp = path.join(dayDir, f.name);
          const st = stat(fp);
          if (st && st.mtimeMs >= sinceMs) {
            out.push({
              path: fp,
              tool: "codex",
              sessionId: f.name.replace(/\.jsonl$/, ""),
              origin: "main",
              slug: "",
              mtimeMs: st.mtimeMs,
              size: st.size,
            });
          }
        }
      }
    }
  }
  return out;
}
