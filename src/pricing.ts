import * as os from "os";
import * as path from "path";
import * as core from "../pricing/cost";
import type { PriceRow, PricingGlobals, CostTokens, CostOpts } from "../pricing/cost";
import seed from "../pricing/seed-v2.json";

export type { PriceRow, PricingGlobals, CostTokens, CostOpts };

// ---------------------------------------------------------------------------
// Path discovery — works on Windows, macOS, Linux
// ---------------------------------------------------------------------------
const HOME = process.env.USERPROFILE || os.homedir();
export const CLAUDE_HOME = path.join(HOME, ".claude");
export const CODEX_HOME = path.join(HOME, ".codex");

// ---------------------------------------------------------------------------
// Pricing v2. The built-in table is pricing/seed-v2.json (shared with the
// central server); the formula is pricing/cost.js (shared too). A table synced
// from the central server (src/central/pricingSync.ts) overrides the built-in
// one so local cost matches what the admin manages centrally.
// ---------------------------------------------------------------------------
const SEED_ROWS: PriceRow[] = (seed as any).models as PriceRow[];
const SEED_GLOBALS: PricingGlobals = (seed as any).globals as PricingGlobals;

let OVERRIDE: { rows: PriceRow[]; globals: PricingGlobals } | null = null;

/** Replace the active pricing table with a synced one, or pass null to clear. */
export function setPricingOverride(v: { rows: PriceRow[]; globals?: PricingGlobals } | null): void {
  OVERRIDE = v && Array.isArray(v.rows) && v.rows.length ? { rows: v.rows, globals: v.globals ?? SEED_GLOBALS } : null;
}

export function activeRows(): PriceRow[] {
  return OVERRIDE ? OVERRIDE.rows : SEED_ROWS;
}

export function activeGlobals(): PricingGlobals {
  return OVERRIDE ? OVERRIDE.globals : SEED_GLOBALS;
}

/** The pricing table in effect (synced override, else built-in). */
export function pricingSnapshot(): { rows: PriceRow[]; globals: PricingGlobals } {
  return { rows: activeRows(), globals: activeGlobals() };
}

export function priceFor(model: string, day?: string): PriceRow | null {
  return core.findPrice(activeRows(), model, day);
}

export function isPriced(model: string): boolean {
  return priceFor(model) !== null;
}

/** "long" when one request's prompt is above the model's long-prompt tier. */
export function tierFor(model: string, prompt: number, day?: string): "base" | "long" {
  return core.tierFor(priceFor(model, day), prompt);
}

/** USD cost for a token bundle of one model (not rounded). */
export function costOf(tokens: CostTokens, model: string, opts: CostOpts & { day?: string } = {}): number {
  return core.costOf(priceFor(model, opts.day), tokens, opts, activeGlobals());
}

export const promptTokens = core.promptTokens;
export const round = core.round;

// ---------------------------------------------------------------------------
// Context window sizes by model prefix (longest match wins). Claude 4.6+ and
// the 5.x family run a 1M window; Haiku 4.5 and older models 200K.
// ---------------------------------------------------------------------------
const CONTEXT_WINDOWS: Record<string, number> = {
  "claude-fable-5": 1_000_000,
  "claude-mythos-5": 1_000_000,
  "claude-opus-5": 1_000_000,
  "claude-sonnet-5": 1_000_000,
  "claude-haiku-5": 1_000_000,
  "claude-opus-4-8": 1_000_000,
  "claude-opus-4-7": 1_000_000,
  "claude-opus-4-6": 1_000_000,
  "claude-sonnet-4-6": 1_000_000,
  "claude-sonnet-4-5": 1_000_000,
  "claude-haiku-4-5": 200_000,
};

const DEFAULT_CONTEXT_WINDOW = 200_000;

export function getContextWindow(model: string): number {
  const modelLower = (model || "").toLowerCase();
  let bestKey = "";
  for (const key of Object.keys(CONTEXT_WINDOWS)) {
    if (modelLower.startsWith(key) && key.length > bestKey.length) bestKey = key;
  }
  return CONTEXT_WINDOWS[bestKey] ?? DEFAULT_CONTEXT_WINDOW;
}
