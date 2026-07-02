/**
 * Pulls the admin-managed pricing table from the central server and applies it
 * to the local pricing module (setPricingOverride), so this machine's dashboard
 * matches central prices. One-way (server → extension); the extension never
 * pushes prices back.
 *
 * Cached in globalState so we can apply the last-known prices at startup before
 * any network call — offline, or central disabled, falls back to the built-in
 * table baked into pricing.ts.
 */
import * as vscode from "vscode";
import { setPricingOverride } from "../pricing";

type Tuple = [number, number, number, number];

const CACHE_KEY = "tokenscope.pricingCache";

interface PricingWire {
  schema?: string;
  updatedAt?: string;
  models?: {
    modelPrefix?: string;
    inputPerM?: number;
    outputPerM?: number;
    cacheReadRatio?: number;
    cacheCreateRatio?: number;
  }[];
}

function num(v: unknown, dflt = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : dflt;
}

/** Convert the wire shape to the prefix→tuple map getPricing() expects.
 *  Keys are lower-cased to match the built-in table's matching behavior. */
function toMap(wire: PricingWire): Record<string, Tuple> {
  const map: Record<string, Tuple> = {};
  for (const m of wire.models || []) {
    if (!m || !m.modelPrefix) continue;
    map[String(m.modelPrefix).toLowerCase()] = [
      num(m.inputPerM),
      num(m.outputPerM),
      num(m.cacheReadRatio, 0.1),
      num(m.cacheCreateRatio, 1.25),
    ];
  }
  return map;
}

/** Apply the last cached prices (if any) synchronously at startup. */
export function applyCachedPricing(context: vscode.ExtensionContext): void {
  const cached = context.globalState.get<Record<string, Tuple>>(CACHE_KEY);
  if (cached && Object.keys(cached).length) setPricingOverride(cached);
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
  let wire: PricingWire;
  try {
    const res = await fetch(url, {
      headers: cfg.ingestKey ? { "x-ingest-key": cfg.ingestKey } : {},
    });
    if (!res.ok) {
      console.warn("tokenscope pricing sync: http", res.status);
      return false;
    }
    wire = (await res.json()) as PricingWire;
  } catch (e: any) {
    console.warn("tokenscope pricing sync failed:", e?.message || e);
    return false;
  }
  if (!wire || wire.schema !== "pricing.v1" || !Array.isArray(wire.models)) return false;

  const map = toMap(wire);
  if (!Object.keys(map).length) return false; // never blank out to an empty table

  const prev = context.globalState.get<Record<string, Tuple>>(CACHE_KEY);
  const changed = JSON.stringify(prev || {}) !== JSON.stringify(map);
  await context.globalState.update(CACHE_KEY, map);
  setPricingOverride(map);
  return changed;
}
