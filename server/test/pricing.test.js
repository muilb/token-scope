"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Database = require("better-sqlite3");
const { openDb, initSchema } = require("../db");
const pricing = require("../pricing");
const { freshApp, v2Payload, bucket, post } = require("./helpers");

const EXPECTED = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "test", "fixtures", "expected.json"), "utf8"));

// ---------------------------------------------------------------------------
// Same hand-computed cases as the extension (src/core/core.test.ts)
// ---------------------------------------------------------------------------
for (const c of EXPECTED.pricingCases) {
  test(`shared pricing case: ${c.name}`, () => {
    const { db } = freshApp();
    const ctx = pricing.loadPricing(db);
    const row = pricing.core.findPrice(ctx.rows, c.model);
    const got = pricing.core.costOf(row, c.tokens, c.opts, ctx.globals);
    assert.ok(Math.abs(got - c.cost) < 1e-9, `${got} != ${c.cost}`);
  });
}

// ---------------------------------------------------------------------------
// Seed / migration
// ---------------------------------------------------------------------------
test("first v2 boot: seed rows + v1 rows for models the seed lacks are converted, not lost", () => {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE pricing (model_prefix TEXT PRIMARY KEY, input_per_m REAL NOT NULL, output_per_m REAL NOT NULL,
    cache_read_ratio REAL NOT NULL DEFAULT 0.1, cache_create_ratio REAL NOT NULL DEFAULT 1.25, note TEXT DEFAULT '', updated_at TEXT DEFAULT '', updated_by TEXT DEFAULT '')`);
  db.prepare("INSERT INTO pricing (model_prefix, input_per_m, output_per_m) VALUES ('my-internal-model', 2, 8)").run();
  db.prepare("INSERT INTO pricing (model_prefix, input_per_m, output_per_m) VALUES ('claude-opus-5', 9, 99)").run(); // seed wins for seeded prefixes
  initSchema(db);
  pricing.invalidate();
  const mine = db.prepare("SELECT * FROM pricing_v2 WHERE model_prefix = 'my-internal-model'").get();
  assert.equal(mine.input, 2);
  assert.equal(mine.cached_input, 0.2);
  assert.equal(mine.cache_write_short, 2.5);
  const opus = db.prepare("SELECT * FROM pricing_v2 WHERE model_prefix = 'claude-opus-5'").get();
  assert.equal(opus.input, 5);
  assert.ok(db.prepare("SELECT 1 FROM pricing_v2 WHERE model_prefix = 'claude-opus-5-5'").get());
});

test("re-seeding never overwrites admin edits but adds new prefixes", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tokenscope-seed-"));
  const p = path.join(dir, "u.db");
  let db = openDb(p);
  db.prepare("UPDATE pricing_v2 SET input = 123 WHERE model_prefix = 'claude-opus-5-5'").run();
  db.prepare("DELETE FROM pricing_v2 WHERE model_prefix = 'claude-haiku-5-5'").run();
  db.close();
  db = openDb(p);
  assert.equal(db.prepare("SELECT input FROM pricing_v2 WHERE model_prefix = 'claude-opus-5-5'").get().input, 123);
  assert.ok(db.prepare("SELECT 1 FROM pricing_v2 WHERE model_prefix = 'claude-haiku-5-5'").get());
  db.close();
});

// ---------------------------------------------------------------------------
// Dated prices
// ---------------------------------------------------------------------------
test("a dated price row applies only from its effective day", async () => {
  const { app, db } = freshApp();
  pricing.upsertPricing(db, { model_prefix: "claude-opus-5-5", effective_from: "2026-12-01", input: 8, cached_input: 0.4, cache_write_short: 10, cache_write_long: 16, output: 40 }, "t");
  const api = { authType: "apikey", plan: "apikey" };
  await post(app, v2Payload([bucket({ sessionId: "nov", date: "2026-11-20", auth: api }), bucket({ sessionId: "dec", date: "2026-12-02", auth: api })]));
  const rows = (await app.inject({ method: "GET", url: "/api/v1/summary?groupBy=project&from=2026-11-20&to=2026-11-20" })).json();
  assert.equal(rows[0].cost, 0.0384);
  const dec = (await app.inject({ method: "GET", url: "/api/v1/summary?groupBy=project&from=2026-12-02&to=2026-12-02" })).json();
  assert.equal(dec[0].cost, 0.0768);
});

test("editing a price re-values the days it covers", async () => {
  const { app, db } = freshApp();
  await post(app, v2Payload([bucket({ auth: { authType: "apikey", plan: "apikey" } })]));
  pricing.upsertPricing(db, { model_prefix: "claude-opus-5-5", input: 4, cached_input: 0.2, cache_write_short: 5, cache_write_long: 8, output: 40 }, "t");
  const rows = (await app.inject({ method: "GET", url: "/api/v1/summary?groupBy=project&all=1" })).json();
  assert.equal(rows[0].cost, 0.0584); // output 1000 × 40 instead of × 20
});

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------
test("unpriced API-key model shows on the admin page; subscription models do not", async () => {
  const { app } = freshApp();
  await post(app, v2Payload([bucket({ model: "mystery-api-model", auth: { authType: "apikey", plan: "apikey" } }), bucket({ sessionId: "s2", model: "mystery-sub-model" })]));
  const html = (await app.inject({ method: "GET", url: "/admin" })).body;
  assert.match(html, /mystery-api-model/);
  assert.ok(!html.includes("<code>mystery-sub-model</code>"));
});

test("admin edits need the admin key; the ingest key does not unlock admin", async () => {
  const { app } = freshApp({ adminKey: "adm", ingestKey: "ing" });
  const form = "model_prefix=foo&input=1&output=2";
  const ct = { "content-type": "application/x-www-form-urlencoded" };
  assert.equal((await app.inject({ method: "POST", url: "/admin/pricing", payload: form, headers: ct })).statusCode, 401);
  assert.equal((await app.inject({ method: "POST", url: "/admin/pricing", payload: form + "&key=ing", headers: ct })).statusCode, 401);
  const ok = await app.inject({ method: "POST", url: "/admin/pricing", payload: form + "&key=adm", headers: ct });
  assert.equal(ok.statusCode, 303);
  assert.match((await app.inject({ method: "GET", url: "/admin" })).body, /Nhập ADMIN_KEY/);
  assert.match((await app.inject({ method: "GET", url: "/admin?key=adm" })).body, /<b>foo<\/b>/);
});

test("admin form validation errors come back as a banner, nothing saved", async () => {
  const { app, db } = freshApp();
  const res = await app.inject({
    method: "POST",
    url: "/admin/pricing",
    payload: "model_prefix=bar&input=-1&output=2",
    headers: { "content-type": "application/x-www-form-urlencoded" },
  });
  assert.equal(res.statusCode, 303);
  assert.match(decodeURIComponent(res.headers.location), /err=input/);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM pricing_v2 WHERE model_prefix = 'bar'").get().c, 0);
});

test("deleting the only price row makes an API-key model unpriced again", async () => {
  const { app, db } = freshApp();
  await post(app, v2Payload([bucket({ model: "gpt-5.3-codex", tool: "codex", auth: { authType: "apikey", plan: "apikey" } })]));
  pricing.deletePricing(db, "gpt-5.3-codex", "");
  assert.deepEqual(pricing.unpricedModels(db, pricing.loadPricing(db)), ["gpt-5.3-codex"]);
});

// ---------------------------------------------------------------------------
// Pricing sync endpoint
// ---------------------------------------------------------------------------
test("GET /api/v1/pricing: v1 shape for old clients, ?schema=v2 for 0.7+; gated by the ingest key", async () => {
  const { app } = freshApp({ ingestKey: "ing" });
  assert.equal((await app.inject({ method: "GET", url: "/api/v1/pricing" })).statusCode, 401);
  const v1 = (await app.inject({ method: "GET", url: "/api/v1/pricing", headers: { "x-ingest-key": "ing" } })).json();
  assert.equal(v1.schema, "pricing.v1");
  const o = v1.models.find((m) => m.modelPrefix === "claude-opus-5-5");
  assert.equal(o.inputPerM, 4);
  assert.equal(o.cacheReadRatio, 0.05);
  const v2 = (await app.inject({ method: "GET", url: "/api/v1/pricing?schema=v2", headers: { "x-ingest-key": "ing" } })).json();
  assert.equal(v2.schema, "pricing.v2");
  assert.equal(v2.globals.webSearchPer1k, 10);
  assert.ok(v2.models.find((m) => m.modelPrefix === "claude-haiku-5-5").tierThreshold === 100000);
});
