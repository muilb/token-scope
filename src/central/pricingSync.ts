/**
 * Pulls the admin-managed pricing table from the central server and applies it
 * to the local pricing module (setPricingOverride), so this machine's dashboard
 * matches central prices. One-way (server → extension).
 *
 * Accepts pricing.v2 (absolute prices per component, dated rows) and, from an
 * older server, pricing.v1 (input/output + cache ratios), converted to v2.
 * Cached in globalState so the last-known prices apply at startup offline.
 */
import * as vscode from "vscode";
import { setPricingOverride, PriceRow, PricingGlobals } from "../pricing";

const CACHE_KEY = "tokenscope.pricingCache.v2";
const OLD_CACHE_KEY = "tokenscope.pricingCache";

interface Cached {
  rows: PriceRow[];
  globals?: PricingGlobals;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** pricing.v2 wire → rows (unknown fields ignored, numbers validated). */
export function rowsFromV2(models: any[]): PriceRow[] {
  const out: PriceRow[] = [];
  for (const m of models || []) {
    if (!m || !m.modelPrefix) continue;
    const row: PriceRow = {
      provider: typeof m.provider === "string" ? m.provider : undefined,
      modelPrefix: String(m.modelPrefix).toLowerCase(),
      effectiveFrom: typeof m.effectiveFrom === "string" ? m.effectiveFrom : undefined,
      input: num(m.input) ?? 0,
      output: num(m.output) ?? 0,
    };
    for (const k of [
      "cachedInput",
      "cacheWriteShort",
      "cacheWriteLong",
      "fastMultiplier",
      "tierThreshold",
      "tierInput",
      "tierCachedInput",
      "tierCacheWriteShort",
      "tierCacheWriteLong",
      "tierOutput",
    ] as const) {
      const v = num(m[k]);
      if (v !== undefined) (row as any)[k] = v;
    }
    out.push(row);
  }
  return out;
}

/** pricing.v1 wire (ratios) → v2 rows. */
export function rowsFromV1(models: any[]): PriceRow[] {
  const out: PriceRow[] = [];
  for (const m of models || []) {
    if (!m || !m.modelPrefix) continue;
    const input = num(m.inputPerM) ?? 0;
    out.push({
      modelPrefix: String(m.modelPrefix).toLowerCase(),
      input,
      output: num(m.outputPerM) ?? 0,
      cachedInput: input * (num(m.cacheReadRatio) ?? 0.1),
      cacheWriteShort: input * (num(m.cacheCreateRatio) ?? 1.25),
      cacheWriteLong: input * 2,
    });
  }
  return out;
}

/** Apply the last cached prices (if any) synchronously at startup. */
export function applyCachedPricing(context: vscode.ExtensionContext): void {
  void context.globalState.update(OLD_CACHE_KEY, undefined); // v1 tuple cache is obsolete
  const cached = context.globalState.get<Cached>(CACHE_KEY);
  if (cached && Array.isArray(cached.rows) && cached.rows.length) setPricingOverride(cached);
}

/**
 * Fetch prices from the central server and apply + cache them.
 * Returns true if the prices changed vs the cache (caller can refresh the UI).
 * Never throws: network/parse errors keep the current override and return false.
 */
export async function syncPricing(
  context: vscode.ExtensionContext,
  cfg: { url: string; ingestKey: string },
): Promise<boolean> {
  const url = cfg.url.replace(/\/$/, "") + "/api/v1/pricing";
  let wire: any;
  try {
    const res = await fetch(url, { headers: cfg.ingestKey ? { "x-ingest-key": cfg.ingestKey } : {} });
    if (!res.ok) {
      console.warn("tokenscope pricing sync: http", res.status);
      return false;
    }
    wire = await res.json();
  } catch (e: any) {
    console.warn("tokenscope pricing sync failed:", e?.message || e);
    return false;
  }
  if (!wire || !Array.isArray(wire.models)) return false;
  let next: Cached;
  if (wire.schema === "pricing.v2") next = { rows: rowsFromV2(wire.models), globals: wire.globals };
  else if (wire.schema === "pricing.v1") next = { rows: rowsFromV1(wire.models) };
  else return false;
  if (!next.rows.length) return false; // never blank out to an empty table

  const prev = context.globalState.get<Cached>(CACHE_KEY);
  const changed = JSON.stringify(prev || {}) !== JSON.stringify(next);
  await context.globalState.update(CACHE_KEY, next);
  setPricingOverride(next);
  return changed;
}
