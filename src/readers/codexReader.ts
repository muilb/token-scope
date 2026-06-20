import * as fs from "fs";
import * as path from "path";
import { computeCost, round } from "../pricing";
import { todayIso, isoDaysAgo } from "../util";

export interface CodexSession {
  session_id: string;
  date: string;
  cwd: string;
  model: string;
  input: number;
  output: number;
  cached: number;
  reasoning: number;
  total: number;
  committed_input: number;
  committed_cached: number;
  committed_output: number;
  committed_total: number;
  in_progress_turn: boolean;
  cost_usd: number;
  ctx_tokens: number;
  context_window: number;
  started_at: string;
  last_seen: string;
  tok_per_min: number;
}

export interface CodexDaily {
  date: string;
  tokens_by_model: Record<string, any>;
  sessions: number;
  cost_usd: number;
}

export interface CodexResult {
  daily: CodexDaily[];
  today: { sessions: CodexSession[] };
}

function empty(): CodexResult {
  return { daily: [], today: { sessions: [] } };
}

function estimateTokPerMin(
  totalTokens: number,
  startedAt: string,
  lastSeen: string,
): number {
  if (totalTokens <= 0 || !startedAt) return 0;
  const start = Date.parse(startedAt);
  const end = Date.parse(lastSeen || startedAt);
  if (Number.isNaN(start) || Number.isNaN(end)) return 0;
  const now = Date.now();
  const elapsedMin = Math.max((Math.min(end, now) - start) / 60000, 0.1);
  return Math.round(totalTokens / elapsedMin);
}

function parseCodexFile(filePath: string, dateStr: string): CodexSession | null {
  let cwd = "";
  let model = "";
  let startedAt = "";
  let lastSeen = "";
  let modelContextWindow = 0;
  let lastTokenUsage: Record<string, number> = {};
  let lastTurnUsage: Record<string, number> = {};
  let lastTaskStarted = "";
  let lastTaskComplete = "";

  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }

  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }

    const evt: string = obj.type ?? obj.event ?? "";
    const payload =
      obj.payload && typeof obj.payload === "object" ? obj.payload : {};
    const timestamp: string = obj.timestamp ?? "";

    if (timestamp && timestamp > lastSeen) lastSeen = timestamp;

    if (evt === "session_meta") {
      cwd = payload.cwd || cwd;
      startedAt = payload.timestamp || obj.timestamp || startedAt;
    }
    if (evt === "event_msg" && payload.type === "task_started") {
      lastTaskStarted = timestamp || lastTaskStarted;
    }
    if (evt === "event_msg" && payload.type === "task_complete") {
      lastTaskComplete = timestamp || lastTaskComplete;
    }
    if (evt === "turn_context") {
      cwd = payload.cwd || cwd;
      model = payload.model || model;
    }
    if (evt === "event_msg" && payload.type === "token_count") {
      const info = payload.info && typeof payload.info === "object" ? payload.info : {};
      modelContextWindow = info.model_context_window || modelContextWindow;
      const ltu = info.last_token_usage;
      if (ltu && typeof ltu === "object" && Object.keys(ltu).length) {
        lastTurnUsage = ltu;
      }
      const tu = info.total_token_usage;
      if (tu) lastTokenUsage = tu;
    }
  }

  if (Object.keys(lastTokenUsage).length === 0 && !model) return null;

  const sessionId = path.basename(filePath).replace(/\.jsonl$/, "");
  const inputTokens = lastTokenUsage.input_tokens ?? 0;
  const outputTokens = lastTokenUsage.output_tokens ?? 0;
  const totalTokens = lastTokenUsage.total_tokens ?? inputTokens + outputTokens;
  const currentCtxTokens = lastTurnUsage.input_tokens ?? 0;
  const inProgressTurn = !!(lastTaskStarted && lastTaskStarted > lastTaskComplete);

  let committedInput = inputTokens;
  let committedCached = lastTokenUsage.cached_input_tokens ?? 0;
  let committedOutput = outputTokens;
  let committedTotal = totalTokens;

  if (inProgressTurn && Object.keys(lastTurnUsage).length) {
    committedInput = Math.max(inputTokens - (lastTurnUsage.input_tokens ?? 0), 0);
    committedCached = Math.max(
      (lastTokenUsage.cached_input_tokens ?? 0) - (lastTurnUsage.cached_input_tokens ?? 0),
      0,
    );
    committedOutput = Math.max(outputTokens - (lastTurnUsage.output_tokens ?? 0), 0);
    committedTotal = Math.max(totalTokens - (lastTurnUsage.total_tokens ?? 0), 0);
  }

  const uncachedInput = Math.max(committedInput - committedCached, 0);
  const costUsd = computeCost(uncachedInput, committedOutput, committedCached, 0, model || "unknown");

  return {
    session_id: sessionId,
    date: dateStr,
    cwd,
    model: model || "unknown",
    input: inputTokens,
    output: outputTokens,
    cached: lastTokenUsage.cached_input_tokens ?? 0,
    reasoning: lastTokenUsage.reasoning_output_tokens ?? 0,
    total: totalTokens,
    committed_input: committedInput,
    committed_cached: committedCached,
    committed_output: committedOutput,
    committed_total: committedTotal,
    in_progress_turn: inProgressTurn,
    cost_usd: costUsd,
    ctx_tokens: currentCtxTokens,
    context_window: modelContextWindow,
    started_at: startedAt,
    last_seen: lastSeen || startedAt,
    tok_per_min: estimateTokPerMin(totalTokens, startedAt, lastSeen),
  };
}

export function scanCodexSessions(codexHome: string, daysBack = 90): CodexResult {
  const sessionsRoot = path.join(codexHome, "sessions");
  if (!fs.existsSync(sessionsRoot)) return empty();

  const todayStr = todayIso();
  const cutoffStr = isoDaysAgo(daysBack);

  const dailyMap: Record<string, Record<string, any>> = {};
  const dailySessions: Record<string, number> = {};
  const dailyCosts: Record<string, number> = {};
  const todaySessions: CodexSession[] = [];

  let years: string[];
  try {
    years = fs.readdirSync(sessionsRoot).sort();
  } catch {
    return empty();
  }

  for (const year of years) {
    const yearDir = path.join(sessionsRoot, year);
    if (!safeIsDir(yearDir)) continue;
    for (const month of fs.readdirSync(yearDir).sort()) {
      const monthDir = path.join(yearDir, month);
      if (!safeIsDir(monthDir)) continue;
      for (const day of fs.readdirSync(monthDir).sort()) {
        const dayDir = path.join(monthDir, day);
        if (!safeIsDir(dayDir)) continue;

        const yn = Number(year), mn = Number(month), dn = Number(day);
        if (!yn || !mn || !dn) continue;
        const dateStr = `${String(yn).padStart(4, "0")}-${String(mn).padStart(2, "0")}-${String(dn).padStart(2, "0")}`;
        if (dateStr < cutoffStr) continue;

        let files: string[];
        try {
          files = fs.readdirSync(dayDir).filter((f) => f.startsWith("rollout-") && f.endsWith(".jsonl"));
        } catch {
          continue;
        }
        for (const fname of files) {
          const sess = parseCodexFile(path.join(dayDir, fname), dateStr);
          if (!sess) continue;

          const model = sess.model || "unknown";
          const dm = (dailyMap[dateStr] ??= {});
          const m = (dm[model] ??= { input: 0, output: 0, cached: 0, reasoning: 0, total: 0 });
          m.input += sess.input;
          m.output += sess.output;
          m.cached += sess.cached;
          m.reasoning += sess.reasoning;
          m.total += sess.total;
          dailySessions[dateStr] = (dailySessions[dateStr] ?? 0) + 1;
          dailyCosts[dateStr] = (dailyCosts[dateStr] ?? 0) + sess.cost_usd;

          if (dateStr === todayStr) todaySessions.push(sess);
        }
      }
    }
  }

  const daily: CodexDaily[] = Object.keys(dailyMap)
    .sort()
    .map((d) => ({
      date: d,
      tokens_by_model: dailyMap[d],
      sessions: dailySessions[d] ?? 0,
      cost_usd: round(dailyCosts[d] ?? 0, 6),
    }));

  return { daily, today: { sessions: todaySessions } };
}

function safeIsDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}
