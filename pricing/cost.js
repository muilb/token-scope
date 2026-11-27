"use strict";
/**
 * Pricing v2 — the ONE cost implementation shared by the extension (bundled by
 * esbuild) and the central server (required directly). Keeping a single file is
 * the point: the two sides used to carry hand-copied tables and formulas that
 * drifted apart. No dependencies, CommonJS, ES2018.
 *
 * A price row holds ABSOLUTE USD-per-1M-token prices per component — cache-read
 * ratios are no longer uniform (0.1x / 0.05x / 0.025x depending on the model),
 * so ratios cannot describe current prices.
 *
 *   row = {
 *     provider, modelPrefix, effectiveFrom?,           // "YYYY-MM-DD"; absent = base row
 *     input, cachedInput?, cacheWriteShort?, cacheWriteLong?, output,
 *     fastMultiplier?,                                  // scales token prices in fast mode
 *     tierThreshold?, tierInput?, tierCachedInput?,     // long-prompt tier, per request
 *     tierCacheWriteShort?, tierCacheWriteLong?, tierOutput?
 *   }
 *   tokens = { input, output, cacheRead, cacheWrite5m, cacheWrite1h, webSearch }
 *     input = UNCACHED input only (cache reads/writes are separate fields).
 *   opts = { speed: "standard"|"fast", tier: "base"|"long", geo: "global"|"us" }
 */

const BASE_FROM = "0000-00-00";

function num(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function has(v) {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * Price row for a model on a given day. Longest matching prefix wins; among rows
 * with that prefix, the latest whose effectiveFrom <= day. If every row of that
 * prefix starts after `day`, the earliest one is used (a seed applies backwards).
 * Returns null when no prefix matches (the model is unpriced).
 */
function findPrice(rows, model, day) {
  const m = String(model || "").toLowerCase();
  if (!m) return null;
  let bestLen = -1;
  let group = [];
  for (const r of rows || []) {
    const p = String((r && r.modelPrefix) || "").toLowerCase();
    if (!p || !m.startsWith(p)) continue;
    if (p.length > bestLen) {
      bestLen = p.length;
      group = [r];
    } else if (p.length === bestLen) {
      group.push(r);
    }
  }
  if (!group.length) return null;
  const from = (r) => r.effectiveFrom || BASE_FROM;
  group.sort((a, b) => (from(a) < from(b) ? -1 : from(a) > from(b) ? 1 : 0));
  const d = day || "9999-12-31";
  let pick = group[0];
  for (const r of group) if (from(r) <= d) pick = r;
  return pick;
}

/** Prompt size used for tier decisions: everything the model read this request. */
function promptTokens(t) {
  return num(t.input) + num(t.cacheRead) + num(t.cacheWrite5m) + num(t.cacheWrite1h);
}

/** "long" when this single request's prompt exceeds the row's tier threshold. */
function tierFor(row, prompt) {
  return row && has(row.tierThreshold) && row.tierThreshold > 0 && prompt > row.tierThreshold ? "long" : "base";
}

/** Component prices for a row, falling back sensibly when a column is empty. */
function unitPrices(row, tier) {
  const long = tier === "long" && has(row.tierThreshold);
  const pick = (base, tierKey) => (long && has(row[tierKey]) ? row[tierKey] : row[base]);
  const input = num(pick("input", "tierInput"));
  const cached = pick("cachedInput", "tierCachedInput");
  const cwShort = pick("cacheWriteShort", "tierCacheWriteShort");
  const cwLong = pick("cacheWriteLong", "tierCacheWriteLong");
  return {
    input,
    cachedInput: has(cached) ? cached : input,
    cacheWriteShort: has(cwShort) ? cwShort : input * 1.25,
    cacheWriteLong: has(cwLong) ? cwLong : input * 2,
    output: num(pick("output", "tierOutput")),
  };
}

/** USD cost of a token bundle priced with `row` (null row → web search only). */
function costOf(row, tokens, opts, globals) {
  const t = tokens || {};
  const o = opts || {};
  const g = globals || {};
  let c = 0;
  if (row) {
    const p = unitPrices(row, o.tier);
    c =
      (num(t.input) * p.input +
        num(t.cacheRead) * p.cachedInput +
        num(t.cacheWrite5m) * p.cacheWriteShort +
        num(t.cacheWrite1h) * p.cacheWriteLong +
        num(t.output) * p.output) /
      1e6;
    if (o.speed === "fast" && has(row.fastMultiplier) && row.fastMultiplier > 0) c *= row.fastMultiplier;
    if (o.geo === "us" && has(g.inferenceGeoUsMultiplier)) c *= g.inferenceGeoUsMultiplier;
  }
  c += (num(t.webSearch) / 1000) * num(g.webSearchPer1k);
  return c;
}

function round(n, dp) {
  const f = Math.pow(10, dp);
  return Math.round(n * f) / f;
}

module.exports = { findPrice, promptTokens, tierFor, unitPrices, costOf, round };
