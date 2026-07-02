"use strict";
/**
 * Server-side pricing: read the admin-managed `pricing` table and compute cost
 * from raw tokens. Mirrors token-dashboard-ext/src/pricing.ts (same formula,
 * same longest-prefix match) so the central dashboard and the local extension
 * dashboards agree once the extension has synced prices.
 *
 * Cost is recomputed at query time (never trusts the client's cost_estimate),
 * so editing a price re-values both historical and new usage immediately.
 */

// In-memory cache of the pricing table, invalidated on any write (see invalidate()).
let cache = null;

/**
 * Load pricing as a Map<prefix, tuple> where tuple =
 * [input_per_m, output_per_m, cache_read_ratio, cache_create_ratio].
 * Cached until invalidate() is called.
 */
function loadPricing(db) {
  if (cache) return cache;
  const rows = db.prepare("SELECT * FROM pricing").all();
  const map = new Map();
  for (const r of rows) {
    map.set(r.model_prefix, [
      r.input_per_m,
      r.output_per_m,
      r.cache_read_ratio,
      r.cache_create_ratio,
    ]);
  }
  cache = map;
  return map;
}

/** Drop the cache so the next loadPricing() re-reads the table. */
function invalidate() {
  cache = null;
}

/** Pricing tuple for a model, longest-prefix match; unknown → [0,0,0,0]. */
function getPricing(map, model) {
  const modelLower = String(model || "").toLowerCase();
  let bestKey = "";
  for (const key of map.keys()) {
    if (modelLower.startsWith(key) && key.length > bestKey.length) bestKey = key;
  }
  return map.get(bestKey) || [0, 0, 0, 0];
}

function round(n, dp) {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

/** Cost for one (tokens, model) pair against the given pricing map. */
function computeCost(map, tokens, model) {
  const [inpM, outM, crRatio, ccRatio] = getPricing(map, model);
  const input = num(tokens.input);
  const output = num(tokens.output);
  const cacheRead = num(tokens.cacheRead);
  const cacheCreate = num(tokens.cacheCreate);
  const cost =
    (input / 1_000_000) * inpM +
    (output / 1_000_000) * outM +
    (cacheRead / 1_000_000) * inpM * crRatio +
    (cacheCreate / 1_000_000) * inpM * ccRatio;
  return round(cost, 6);
}

function num(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** True if the model has no matching price prefix (→ counted at cost 0). */
function isUnpriced(map, model) {
  const [i, o] = getPricing(map, model);
  // A price row of [0,0,...] (e.g. free/older models) still counts as "priced".
  const modelLower = String(model || "").toLowerCase();
  for (const key of map.keys()) {
    if (modelLower.startsWith(key)) return false;
  }
  return true;
}

/** Distinct models in usage_delta that have no matching price row. */
function unpricedModels(db, map) {
  const rows = db
    .prepare("SELECT DISTINCT model FROM usage_delta WHERE model <> '' ORDER BY model")
    .all();
  return rows.map((r) => r.model).filter((m) => isUnpriced(map, m));
}

/** All price rows, ordered for the admin table. */
function listPricing(db) {
  return db.prepare("SELECT * FROM pricing ORDER BY model_prefix").all();
}

/** Upsert one price row; validates non-empty prefix and non-negative numbers. */
function upsertPricing(db, row, updatedBy) {
  const prefix = String(row.model_prefix || "").trim();
  if (!prefix) throw new Error("model_prefix required");
  const inputPerM = mustNonNeg(row.input_per_m, "input_per_m");
  const outputPerM = mustNonNeg(row.output_per_m, "output_per_m");
  const crRatio = mustNonNeg(row.cache_read_ratio != null ? row.cache_read_ratio : 0.1, "cache_read_ratio");
  const ccRatio = mustNonNeg(row.cache_create_ratio != null ? row.cache_create_ratio : 1.25, "cache_create_ratio");
  db.prepare(
    `INSERT INTO pricing (model_prefix, input_per_m, output_per_m, cache_read_ratio, cache_create_ratio, note, updated_at, updated_by)
     VALUES (@prefix, @inputPerM, @outputPerM, @crRatio, @ccRatio, @note, @now, @by)
     ON CONFLICT (model_prefix) DO UPDATE SET
       input_per_m = excluded.input_per_m,
       output_per_m = excluded.output_per_m,
       cache_read_ratio = excluded.cache_read_ratio,
       cache_create_ratio = excluded.cache_create_ratio,
       note = excluded.note,
       updated_at = excluded.updated_at,
       updated_by = excluded.updated_by`,
  ).run({
    prefix,
    inputPerM,
    outputPerM,
    crRatio,
    ccRatio,
    note: String(row.note || ""),
    now: new Date().toISOString(),
    by: String(updatedBy || ""),
  });
  invalidate();
}

function deletePricing(db, prefix) {
  db.prepare("DELETE FROM pricing WHERE model_prefix = ?").run(String(prefix || ""));
  invalidate();
}

function mustNonNeg(v, name) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a number >= 0`);
  return n;
}

module.exports = {
  loadPricing,
  invalidate,
  getPricing,
  computeCost,
  unpricedModels,
  isUnpriced,
  listPricing,
  upsertPricing,
  deletePricing,
  round,
};
