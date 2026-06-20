import * as fs from "fs";
import * as readline from "readline";

export interface Usage {
  input: number;
  output: number;
  cache_read: number;
  cache_create: number;
}

export function zeroUsage(): Usage {
  return { input: 0, output: 0, cache_read: 0, cache_create: 0 };
}

export function addUsage(dst: Usage, src: Partial<Usage>): void {
  dst.input += src.input ?? 0;
  dst.output += src.output ?? 0;
  dst.cache_read += src.cache_read ?? 0;
  dst.cache_create += src.cache_create ?? 0;
}

/** Local-date ISO string "YYYY-MM-DD" for a Date (defaults to now). */
function localDayOf(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Local-date ISO string "YYYY-MM-DD" for today. */
export function todayIso(): string {
  return localDayOf(new Date());
}

/**
 * Convert a session JSONL timestamp (UTC, e.g. "2026-06-20T23:00:00Z") to the
 * local calendar day "YYYY-MM-DD". Session JSONL records UTC, but "today" and
 * the daily history are bucketed by the user's local clock — so a turn at
 * 06:00 local on the 20th (23:00Z on the 19th) counts toward the 20th, not the
 * 19th. Returns "" on parse error so callers can skip the row.
 */
export function localDay(ts: string): string {
  if (!ts) return "";
  const ms = Date.parse(ts);
  if (Number.isNaN(ms)) return "";
  return localDayOf(new Date(ms));
}

/** Local start-of-today as epoch milliseconds. */
export function startOfTodayMs(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** ISO date string N days before today (local). */
export function isoDaysAgo(daysBack: number): string {
  const d = new Date();
  d.setDate(d.getDate() - daysBack);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Seconds since an ISO timestamp string. Infinity on parse error. */
export function tsAge(ts: string): number {
  if (!ts) return Infinity;
  const ms = Date.parse(ts);
  if (Number.isNaN(ms)) return Infinity;
  return (Date.now() - ms) / 1000;
}

/** Read a JSONL file line by line, calling cb for each parsed object. */
export async function forEachJsonl(
  filePath: string,
  cb: (obj: any) => void,
): Promise<boolean> {
  let stream: fs.ReadStream;
  try {
    stream = fs.createReadStream(filePath, { encoding: "utf8" });
  } catch {
    return false;
  }
  return new Promise<boolean>((resolve) => {
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    rl.on("line", (line) => {
      const t = line.trim();
      if (!t) return;
      let obj: any;
      try {
        obj = JSON.parse(t);
      } catch {
        return;
      }
      cb(obj);
    });
    rl.on("close", () => resolve(true));
    rl.on("error", () => resolve(false));
    stream.on("error", () => resolve(false));
  });
}
