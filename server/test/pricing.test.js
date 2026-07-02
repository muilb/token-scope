"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const os = require("os");
const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");
const { openDb, SCHEMA, seedPricing } = require("../db");
const { buildApp } = require("../app");
const pricing = require("../pricing");

function freshApp(adminKey, ingestKey) {
  const db = new Database(":memory:");
  db.exec(SCHEMA);
  seedPricing(db);
  pricing.invalidate();
  return { app: buildApp(db, { ingestKey, adminKey }), db };
}

function usagePayload(model, tokens) {
  return {
    schema: "usage.v1",
    reportedAt: "2026-06-26T03:00:00Z",
    machine: { osUser: "lb_mui", hostname: "PC-A" },
    deltas: [
      {
        sessionId: "claude:" + model,
        tool: "claude",
        seq: 1,
        eventTsTo: "2026-06-26T10:45:00Z",
        date: "2026-06-26",
        auth: { authType: "apikey", keyHash: "3f9a1c22", orgShort: "a1b2", confidence: "confirmed" },
        project: "P",
        repo: "d:/work/p",
        model,
        tokens,
        costEstimate: 999, // deliberately wrong — server must ignore this
      },
    ],
  };
}

async function summaryCost(app, query = "?groupBy=project") {
  const rows = (await app.inject({ method: "GET", url: "/api/v1/summary" + query })).json();
  return rows.length ? rows[0].cost : 0;
}

test("openDb seeds the pricing table; existing prices are not overwritten", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ts-price-"));
  const p = path.join(dir, "usage.db");
  const db = openDb(p);
  const n = db.prepare("SELECT COUNT(*) AS c FROM pricing").get().c;
  assert.ok(n > 0, "seeded");
  db.prepare("UPDATE pricing SET input_per_m = 99 WHERE model_prefix = 'claude-opus-4-8'").run();
  db.close();
  const db2 = openDb(p); // reopen → seed must NOT clobber the edit
  assert.equal(db2.prepare("SELECT input_per_m AS v FROM pricing WHERE model_prefix='claude-opus-4-8'").get().v, 99);
  db2.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("cost ignores client costEstimate and is recomputed from the pricing table", async () => {
  const { app } = freshApp();
  await app.inject({ method: "POST", url: "/api/v1/usage", payload: usagePayload("claude-opus-4-8", { input: 100, output: 50, cacheRead: 10, cacheWrite: 5 }) });
  assert.equal(await summaryCost(app), 0.0018); // not 999
});

test("editing a price re-values historical usage immediately", async () => {
  const { app } = freshApp();
  await app.inject({ method: "POST", url: "/api/v1/usage", payload: usagePayload("claude-opus-4-8", { input: 1000, output: 0, cacheRead: 0, cacheWrite: 0 }) });
  assert.equal(await summaryCost(app), 0.005); // 1000/1e6*5

  const res = await app.inject({
    method: "POST",
    url: "/admin/pricing",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: "model_prefix=claude-opus-4-8&input_per_m=10&output_per_m=25",
  });
  assert.equal(res.statusCode, 303);
  assert.equal(await summaryCost(app), 0.01); // same old row, doubled input price
});

test("adding a price for a previously unpriced model raises its cost above 0", async () => {
  const { app } = freshApp();
  await app.inject({ method: "POST", url: "/api/v1/usage", payload: usagePayload("claude-brandnew-9", { input: 1000, output: 0, cacheRead: 0, cacheWrite: 0 }) });
  assert.equal(await summaryCost(app), 0); // unknown model → 0

  await app.inject({
    method: "POST",
    url: "/admin/pricing",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: "model_prefix=claude-brandnew-9&input_per_m=7&output_per_m=20",
  });
  assert.equal(await summaryCost(app), 0.007); // 1000/1e6*7
});

test("unpriced model shows on the admin page", async () => {
  const { app } = freshApp();
  await app.inject({ method: "POST", url: "/api/v1/usage", payload: usagePayload("claude-brandnew-9", { input: 10, output: 0, cacheRead: 0, cacheWrite: 0 }) });
  const html = (await app.inject({ method: "GET", url: "/admin" })).body;
  assert.ok(html.includes("Model chưa có giá"));
  assert.ok(html.includes("claude-brandnew-9"));
});

test("admin edits are rejected without the admin key", async () => {
  const { app } = freshApp("secret-admin");
  const res = await app.inject({
    method: "POST",
    url: "/admin/pricing",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: "model_prefix=claude-opus-4-8&input_per_m=1&output_per_m=1",
  });
  assert.equal(res.statusCode, 401);
});

test("admin edits succeed with the admin key; GET /admin without key shows prompt", async () => {
  const { app } = freshApp("secret-admin");
  const prompt = (await app.inject({ method: "GET", url: "/admin" })).body;
  assert.ok(prompt.includes("Nhập ADMIN_KEY"));

  const ok = await app.inject({
    method: "POST",
    url: "/admin/pricing",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: "key=secret-admin&model_prefix=claude-opus-4-8&input_per_m=1&output_per_m=1",
  });
  assert.equal(ok.statusCode, 303);
});

test("the ingest key does NOT unlock admin", async () => {
  const { app } = freshApp("secret-admin", "ingest-token");
  const res = await app.inject({
    method: "POST",
    url: "/admin/pricing",
    headers: { "content-type": "application/x-www-form-urlencoded", "x-ingest-key": "ingest-token" },
    payload: "model_prefix=claude-opus-4-8&input_per_m=1&output_per_m=1",
  });
  assert.equal(res.statusCode, 401);
});

test("GET /api/v1/pricing returns the table for extension sync", async () => {
  const { app } = freshApp();
  const body = (await app.inject({ method: "GET", url: "/api/v1/pricing" })).json();
  assert.equal(body.schema, "pricing.v1");
  const opus = body.models.find((m) => m.modelPrefix === "claude-opus-4-8");
  assert.equal(opus.inputPerM, 5);
  assert.equal(opus.outputPerM, 25);
});

test("GET /api/v1/pricing is gated by the ingest key when set", async () => {
  const { app } = freshApp(undefined, "ingest-token");
  assert.equal((await app.inject({ method: "GET", url: "/api/v1/pricing" })).statusCode, 401);
  assert.equal(
    (await app.inject({ method: "GET", url: "/api/v1/pricing", headers: { "x-ingest-key": "ingest-token" } })).statusCode,
    200,
  );
});

test("deleting a price makes its model unpriced again", async () => {
  const { app } = freshApp();
  await app.inject({ method: "POST", url: "/api/v1/usage", payload: usagePayload("claude-opus-4-8", { input: 1000, output: 0, cacheRead: 0, cacheWrite: 0 }) });
  assert.equal(await summaryCost(app), 0.005);
  await app.inject({
    method: "POST",
    url: "/admin/pricing/delete",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: "model_prefix=claude-opus-4-8",
  });
  assert.equal(await summaryCost(app), 0); // no price → 0
});
