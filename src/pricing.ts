import * as os from "os";
import * as path from "path";

// ---------------------------------------------------------------------------
// Path discovery — works on Windows, macOS, Linux
// ---------------------------------------------------------------------------
const HOME = process.env.USERPROFILE || os.homedir();
export const CLAUDE_HOME = path.join(HOME, ".claude");
export const CODEX_HOME = path.join(HOME, ".codex");

// ---------------------------------------------------------------------------
// Pricing table: model_prefix -> [input_per_M, output_per_M, cache_read_ratio, cache_create_ratio]
// cache ratios are multiplied against the input_per_M price
// ---------------------------------------------------------------------------
type PricingTuple = [number, number, number, number];

const PRICING: Record<string, PricingTuple> = {
  "claude-sonnet-4-6": [3.0, 15.0, 0.1, 1.25],
  "claude-sonnet-4-5": [3.0, 15.0, 0.1, 1.25],
  "claude-haiku-4-5": [1.0, 5.0, 0.1, 1.25],
  "claude-haiku-4-6": [1.0, 5.0, 0.1, 1.25],
  "claude-opus-4-8": [5.0, 25.0, 0.1, 1.25],
  "claude-opus-4-7": [5.0, 25.0, 0.1, 1.25],
  "claude-opus-4-6": [5.0, 25.0, 0.1, 1.25],
  "claude-fable-5": [10.0, 50.0, 0.1, 1.25],
  // Codex
  "gpt-5.5": [5.0, 30.0, 0.1, 0.0],
  "gpt-5.4-mini": [0.75, 4.5, 0.1, 0.0],
  "gpt-5.4": [2.5, 15.0, 0.1, 0.0],
  "gpt-5.3-codex": [2.5, 15.0, 0.1, 0.0],
  "gpt-5.3": [2.5, 15.0, 0.1, 0.0],
  "gpt-5": [0.0, 0.0, 0.0, 0.0],
  "gpt-4": [0.0, 0.0, 0.0, 0.0],
  o3: [0.0, 0.0, 0.0, 0.0],
  o4: [0.0, 0.0, 0.0, 0.0],
};

/** Return pricing tuple for model, matching by prefix (longest match wins). */
export function getPricing(model: string): PricingTuple {
  const modelLower = (model || "").toLowerCase();
  let bestKey = "";
  for (const key of Object.keys(PRICING)) {
    if (modelLower.startsWith(key) && key.length > bestKey.length) {
      bestKey = key;
    }
  }
  return PRICING[bestKey] ?? [0.0, 0.0, 0.0, 0.0];
}

// ---------------------------------------------------------------------------
// Context window sizes by model prefix (longest match wins).
// Claude Code typically operates a 200K window even on 1M-capable models, so we
// prefer the context_window value parsed from JSONL when present and only fall
// back to this table by model name.
// ---------------------------------------------------------------------------
const CONTEXT_WINDOWS: Record<string, number> = {
  "claude-opus-4-8": 1_000_000,
  "claude-opus-4-7": 1_000_000,
  "claude-opus-4-6": 1_000_000,
  "claude-sonnet-4-6": 1_000_000,
  "claude-sonnet-4-5": 1_000_000,
  "claude-fable-5": 1_000_000,
  "claude-haiku-4-5": 200_000,
  "claude-haiku-4-6": 200_000,
};

const DEFAULT_CONTEXT_WINDOW = 200_000;

/** Context window for a model, matching by prefix (longest match wins). */
export function getContextWindow(model: string): number {
  const modelLower = (model || "").toLowerCase();
  let bestKey = "";
  for (const key of Object.keys(CONTEXT_WINDOWS)) {
    if (modelLower.startsWith(key) && key.length > bestKey.length) {
      bestKey = key;
    }
  }
  return CONTEXT_WINDOWS[bestKey] ?? DEFAULT_CONTEXT_WINDOW;
}

function round(n: number, decimals: number): number {
  const f = Math.pow(10, decimals);
  return Math.round(n * f) / f;
}

export function computeCost(
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  cacheCreateTokens: number,
  model: string,
): number {
  const [inpM, outM, crRatio, ccRatio] = getPricing(model);
  const cost =
    (inputTokens / 1_000_000) * inpM +
    (outputTokens / 1_000_000) * outM +
    (cacheReadTokens / 1_000_000) * inpM * crRatio +
    (cacheCreateTokens / 1_000_000) * inpM * ccRatio;
  return round(cost, 6);
}

export { round };
