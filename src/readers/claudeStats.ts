import * as fs from "fs";
import * as path from "path";

export interface StatsDaily {
  date: string;
  tokens_by_model: Record<string, any>;
  messages: number;
  sessions: number;
  tool_calls: number;
}

export interface StatsResult {
  daily: StatsDaily[];
  cumulative_by_model: Record<string, any>;
  last_computed_date: string | null;
  total_sessions: number;
  total_messages: number;
}

function empty(): StatsResult {
  return {
    daily: [],
    cumulative_by_model: {},
    last_computed_date: null,
    total_sessions: 0,
    total_messages: 0,
  };
}

/** Read ~/.claude/stats-cache.json for historical aggregated data. */
export function readStatsCache(claudeHome: string): StatsResult {
  const p = path.join(claudeHome, "stats-cache.json");
  if (!fs.existsSync(p)) return empty();

  let raw: any;
  try {
    raw = JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return empty();
  }

  const activityByDate: Record<string, any> = {};
  for (const entry of raw.dailyActivity ?? []) {
    activityByDate[entry.date ?? ""] = entry;
  }

  const daily: StatsDaily[] = [];
  for (const entry of raw.dailyModelTokens ?? []) {
    const date = entry.date ?? "";
    const act = activityByDate[date] ?? {};
    daily.push({
      date,
      tokens_by_model: entry.tokensByModel ?? {},
      messages: act.messageCount ?? 0,
      sessions: act.sessionCount ?? 0,
      tool_calls: act.toolCallCount ?? 0,
    });
  }

  const cumulative: Record<string, any> = {};
  for (const [model, usage] of Object.entries<any>(raw.modelUsage ?? {})) {
    cumulative[model] = {
      input: usage.inputTokens ?? 0,
      output: usage.outputTokens ?? 0,
      cache_read: usage.cacheReadInputTokens ?? 0,
      cache_create: usage.cacheCreationInputTokens ?? 0,
      cost_usd: usage.costUSD ?? 0.0,
    };
  }

  return {
    daily,
    cumulative_by_model: cumulative,
    last_computed_date: raw.lastComputedDate ?? null,
    total_sessions: raw.totalSessions ?? 0,
    total_messages: raw.totalMessages ?? 0,
  };
}
