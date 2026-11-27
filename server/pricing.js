"use strict";
/**
 * Server-side pricing v2. The formula is ../pricing/cost.js — the SAME file the
 * extension bundles, so the central dashboard and every member's local
 * dashboard compute identical costs. Prices live in `pricing_v2` (absolute
 * per-component prices, dated by effective_from) and are admin-editable.
 *
 * Cost is recomputed at query time (the client's numbers are never trusted).
 * A dated row re-prices only the days on/after its effective_from; editing a
 * row re-prices every day that row covers.
 */
const path = require("path");
const core = require(path.join(__dirname, "..", "pricing", "cost.js"));
const { BASE_FROM, V2_COLS } = require("./db");

// In-memory cache, invalidated on any write.
let cache = null;

function toRow(r) {
  const out = {};
  for (const [col, key] of V2_COLS) {
    const v = r[col];
    if (v === null || v === undefined) continue;
    out[key] = v;
  }
  if (out.effectiveFrom === BASE_FROM) delete out.effectiveFrom;
  return out;
}

/** { rows: PriceRow[], globals } — cached until invalidate(). */
function loadPricing(db) {
  if (cache) return cache;
  const rows = db.prepare("SELECT * FROM pricing_v2").all().map(toRow);
  const globals = {};
  for (const g of db.prepare("SELECT key, value FROM pricing_globals").all()) globals[g.key] = g.value;
  cache = { rows, globals };
  return cache;
}

function invalidate() {
  cache = null;
}

/** USD cost of one usage row (needs model, date, speed, tier, geo and token columns). */
function costOfRow(ctx, r) {
  const row = core.findPrice(ctx.rows, r.model, r.date);
  return core.costOf(
    row,
    {
      input: r.input,
      output: r.output,
      cacheRead: r.cache_read,
      cacheWrite5m: r.cache_write_5m,
      cacheWrite1h: r.cache_write_1h,
      webSearch: r.web_search,
    },
    { speed: r.speed, tier: r.tier, geo: r.geo },
    ctx.globals,
  );
}

function isPriced(ctx, model) {
  return core.findPrice(ctx.rows, model) !== null;
}

/** Distinct API-key models (the only usage that is priced) with no matching price row. */
function unpricedModels(db, ctx) {
  const rows = db
    .prepare("SELECT DISTINCT model FROM usage_all WHERE model <> '' AND auth_type = 'apikey' ORDER BY model")
    .all();
  return rows.map((r) => r.model).filter((m) => !isPriced(ctx, m));
}

function listPricing(db) {
  return db.prepare("SELECT * FROM pricing_v2 ORDER BY model_prefix, effective_from").all();
}

function listGlobals(db) {
  return db.prepare("SELECT key, value FROM pricing_globals ORDER BY key").all();
}

const NUM_COLS = V2_COLS.map((c) => c[0]).filter((c) => !["provider", "model_prefix", "effective_from", "note"].includes(c));
const REQUIRED = new Set(["input", "output"]);

function parseNum(v, name) {
  if (v === undefined || v === null || String(v).trim() === "") {
    if (REQUIRED.has(name)) throw new Error(`${name} là bắt buộc`);
    return null;
  }
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} phải là số >= 0`);
  return n;
}

/** Insert or update one dated price row (admin form). */
function upsertPricing(db, body, updatedBy) {
  const prefix = String(body.model_prefix || "").trim().toLowerCase();
  if (!prefix) throw new Error("model_prefix là bắt buộc");
  const from = String(body.effective_from || "").trim() || BASE_FROM;
  if (from !== BASE_FROM && !/^\d{4}-\d{2}-\d{2}$/.test(from)) throw new Error("effective_from phải dạng YYYY-MM-DD");
  const vals = {
    provider: String(body.provider || "").trim(),
    model_prefix: prefix,
    effective_from: from,
    note: String(body.note || ""),
    updated_at: new Date().toISOString(),
    updated_by: String(updatedBy || ""),
  };
  for (const c of NUM_COLS) vals[c] = parseNum(body[c], c);
  const cols = Object.keys(vals);
  db.prepare(
    `INSERT INTO pricing_v2 (${cols.join(", ")}) VALUES (${cols.map((c) => "@" + c).join(", ")})
     ON CONFLICT (model_prefix, effective_from) DO UPDATE SET
     ${cols.filter((c) => c !== "model_prefix" && c !== "effective_from").map((c) => `${c} = excluded.${c}`).join(", ")}`,
  ).run(vals);
  invalidate();
}

function deletePricing(db, prefix, effectiveFrom) {
  db.prepare("DELETE FROM pricing_v2 WHERE model_prefix = ? AND effective_from = ?").run(
    String(prefix || "").toLowerCase(),
    String(effectiveFrom || "") || BASE_FROM,
  );
  invalidate();
}

function setGlobal(db, key, value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${key} phải là số >= 0`);
  db.prepare("INSERT INTO pricing_globals (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(key, n);
  invalidate();
}

/** pricing.v2 wire for the extension. */
function wireV2(db) {
  const ctx = loadPricing(db);
  const rows = listPricing(db);
  return {
    schema: "pricing.v2",
    updatedAt: rows.reduce((m, r) => (r.updated_at > m ? r.updated_at : m), ""),
    globals: ctx.globals,
    models: ctx.rows,
  };
}

/** pricing.v1 wire for clients ≤ 0.6 (current base prices as ratios). */
function wireV1(db) {
  const ctx = loadPricing(db);
  const today = new Date().toISOString().slice(0, 10);
  const prefixes = [...new Set(ctx.rows.map((r) => r.modelPrefix))];
  return {
    schema: "pricing.v1",
    updatedAt: "",
    models: prefixes.map((p) => {
      const r = core.findPrice(ctx.rows.filter((x) => x.modelPrefix === p), p, today);
      const u = core.unitPrices(r, "base");
      return {
        modelPrefix: p,
        inputPerM: u.input,
        outputPerM: u.output,
        cacheReadRatio: u.input ? u.cachedInput / u.input : 0,
        cacheCreateRatio: u.input ? u.cacheWriteShort / u.input : 0,
      };
    }),
  };
}

module.exports = {
  loadPricing,
  invalidate,
  costOfRow,
  isPriced,
  unpricedModels,
  listPricing,
  listGlobals,
  upsertPricing,
  deletePricing,
  setGlobal,
  wireV1,
  wireV2,
  round: core.round,
  core,
};
