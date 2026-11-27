"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { openDb } = require("../db");
const { freshApp, v1Payload, v2Payload, bucket, post } = require("./helpers");

// opus-4-8 (5 / 0.5 / 6.25 / 25) with in100/out50/cr10/cw5(5m):
//   (100*5 + 10*0.5 + 5*6.25 + 50*25) / 1e6 = 0.00178625 → 0.0018 (4dp)
const COST_V1 = 0.0018;
// opus-5-5 (4 / 0.2 / 8(1h) / 20) with in100/out1000/cr10000/cw1h2000 = 0.0384
const COST_V2 = 0.0384;

test("healthz ok", async () => {
  const { app } = freshApp();
  const res = await app.inject({ method: "GET", url: "/healthz" });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { ok: true });
});

// ---------------------------------------------------------------------------
// v1 (client ≤ 0.6) still accepted
// ---------------------------------------------------------------------------
test("v1: ingest accepts and upserts a delta", async () => {
  const { app } = freshApp();
  const res = await post(app, v1Payload());
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { accepted: 1, upserted: 1, rejected: [] });
});

test("v1: same (sessionId, seq) twice = one row, cost recomputed with v2 prices", async () => {
  const { app } = freshApp();
  await post(app, v1Payload());
  await post(app, v1Payload());
  const rows = (await app.inject({ method: "GET", url: "/api/v1/summary?groupBy=project" })).json();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].tokens, 165);
  assert.equal(rows[0].cost, COST_V1);
});

test("401 on wrong ingest key (also without content-type), 200 with the right one", async () => {
  const { app } = freshApp({ ingestKey: "secret-token" });
  assert.equal((await post(app, v1Payload(), { "x-ingest-key": "wrong" })).statusCode, 401);
  const noCt = await app.inject({ method: "POST", url: "/api/v1/usage", headers: { "x-ingest-key": "wrong" } });
  assert.equal(noCt.statusCode, 401);
  assert.equal((await post(app, v1Payload(), { "x-ingest-key": "secret-token" })).statusCode, 200);
});

test("reject unsupported schema without crashing", async () => {
  const { app } = freshApp();
  const res = await post(app, { schema: "usage.v9", deltas: [] });
  assert.equal(res.statusCode, 400);
});

test("v1: payload with a raw secret is rejected", async () => {
  const { app } = freshApp();
  const p = v1Payload();
  p.deltas[0].repo = "sk-ant-api03-abcdefghijklmnop";
  assert.equal((await post(app, p)).statusCode, 422);
});

// ---------------------------------------------------------------------------
// v2 buckets
// ---------------------------------------------------------------------------
test("v2: upsert REPLACES totals — re-sends never double count", async () => {
  const { app, db } = freshApp();
  await post(app, v2Payload([bucket({ auth: { authType: "apikey", plan: "apikey", keyHash: "3f9a1c22" } })]));
  await post(app, v2Payload([bucket({ auth: { authType: "apikey", plan: "apikey", keyHash: "3f9a1c22" } })]));
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM usage_bucket").get().c, 1);
  const grown = bucket({ auth: { authType: "apikey", plan: "apikey", keyHash: "3f9a1c22" }, requests: 4 });
  grown.tokens = { ...grown.tokens, output: 2000 };
  await post(app, v2Payload([grown]));
  const r = db.prepare("SELECT output, requests FROM usage_bucket").get();
  assert.deepEqual(r, { output: 2000, requests: 4 });
});

test("v2: API-key usage is priced with the shared v2 core; subscription usage is tokens only", async () => {
  const { app } = freshApp();
  await post(
    app,
    v2Payload([
      bucket({ sessionId: "api", auth: { authType: "apikey", plan: "apikey", keyHash: "3f9a1c22" }, member: { key: "owner:dev1@example.com", email: "dev1@example.com" } }),
      bucket({ sessionId: "sub" }),
    ]),
  );
  const rows = (await app.inject({ method: "GET", url: "/api/v1/summary?groupBy=plan" })).json();
  const api = rows.find((r) => r.plan_name === "apikey");
  const sub = rows.find((r) => r.plan_name === "team");
  assert.equal(api.cost, COST_V2);
  assert.equal(sub.cost, null);
  assert.equal(sub.tokens, 13100);
  assert.equal(sub.sub_tokens, 13100);
  assert.equal(sub.requests, 3);
});

test("v2: buckets of one person (Claude account + API key owner email) resolve to one member", async () => {
  const { app } = freshApp();
  await post(
    app,
    v2Payload([
      bucket({ sessionId: "a" }),
      bucket({ sessionId: "b", member: { key: "owner:dev1@example.com", email: "dev1@example.com" }, auth: { authType: "apikey", plan: "apikey" } }),
      bucket({ sessionId: "c", tool: "codex", model: "gpt-5.4-mini", member: { key: "oai:acc-1", email: "DEV1@example.com" }, auth: { authType: "chatgpt", plan: "business" } }),
    ]),
  );
  const rows = (await app.inject({ method: "GET", url: "/api/v1/summary?groupBy=member" })).json();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].member_email, "dev1@example.com");
  assert.equal(rows[0].member_label, "Dev One");
});

test("v2: once a machine re-sends a day as v2, its v1 deltas for that day stop counting", async () => {
  const { app } = freshApp();
  await post(app, v1Payload()); // lb_mui @ PC-A, 2026-06-26, 165 tokens
  const v2 = bucket({ date: "2026-06-26", auth: { authType: "apikey", plan: "apikey" }, member: { key: "os:lb_mui@pc-a" } });
  await post(app, v2Payload([v2], { osUser: "lb_mui", hostname: "PC-A" }));
  const rows = (await app.inject({ method: "GET", url: "/api/v1/summary?groupBy=project&from=2026-06-26&to=2026-06-26" })).json();
  const total = rows.reduce((a, r) => a + r.tokens, 0);
  assert.equal(total, 13100); // v2 only, not 13100 + 165
});

test("v2: an invalid or secret-looking bucket is rejected alone, the rest is stored", async () => {
  const { app, db } = freshApp();
  const res = await post(
    app,
    v2Payload([bucket(), bucket({ sessionId: "bad", date: "yesterday" }), bucket({ sessionId: "leak", repo: "sk-ant-api03-abcdefghijk" })]),
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().upserted, 1);
  assert.deepEqual(res.json().rejected.map((r) => r.reason).sort(), ["invalid_bucket", "secret"]);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM usage_bucket").get().c, 1);
});

test("v2: long project / repo names are accepted (no catch-all secret regex)", async () => {
  const { app } = freshApp();
  const res = await post(app, v2Payload([bucket({ repo: "D:/00.SSD/Reverse-Sdd-Source-Analysis-Pack_WCC_V06", project: "AI-Code-Review-Quality-Gate-Pack_WCC_V04" })]));
  assert.equal(res.json().upserted, 1);
});

// ---------------------------------------------------------------------------
// Dashboard + CSV
// ---------------------------------------------------------------------------
test("dashboard renders short repo, not full path; subscription cost shows —", async () => {
  const { app } = freshApp();
  await post(app, v2Payload([bucket({ repo: "D:/Work/Secret/deep/demo-app" })]));
  const html = (await app.inject({ method: "GET", url: "/?from=2026-11-20&to=2026-11-20" })).body;
  assert.match(html, />demo-app</);
  assert.ok(!html.includes(">D:/Work/Secret/deep/demo-app<"));
  assert.match(html, /Dev One/);
  assert.match(html, /<td class="num">—<\/td>/);
});

test("fresh dashboard load defaults to today; ?all=1 shows every day", async () => {
  const { app } = freshApp();
  await post(app, v2Payload([bucket({ project: "OldProj", date: "2026-01-02" })]));
  assert.ok(!(await app.inject({ method: "GET", url: "/" })).body.includes('class="proj">OldProj<'));
  assert.match((await app.inject({ method: "GET", url: "/?all=1" })).body, /class="proj">OldProj</);
});

test("filters: member id, project, plan", async () => {
  const { app } = freshApp();
  await post(
    app,
    v2Payload([
      bucket({ sessionId: "a", project: "P1" }),
      bucket({ sessionId: "b", project: "P2", member: { key: "acct:uuid-2", email: "dev2@example.com" }, auth: { authType: "apikey", plan: "apikey" } }),
    ]),
  );
  const all = (await app.inject({ method: "GET", url: "/api/v1/summary?groupBy=member" })).json();
  const dev2 = all.find((r) => r.member_email === "dev2@example.com");
  const byMember = (await app.inject({ method: "GET", url: `/api/v1/summary?groupBy=project&member=${dev2.member_id}` })).json();
  assert.deepEqual(byMember.map((r) => r.project), ["P2"]);
  const sub = (await app.inject({ method: "GET", url: "/api/v1/summary?groupBy=project&plan=subscription" })).json();
  assert.deepEqual(sub.map((r) => r.project), ["P1"]);
});

test("breakdown CSV: BOM for Excel, short repo only, cost blank for subscription rows", async () => {
  const { app } = freshApp();
  await post(app, v2Payload([bucket({ repo: "D:/Work/Secret/deep/demo-app" })]));
  const res = await app.inject({ method: "GET", url: "/api/v1/breakdown.csv?from=2026-11-20&to=2026-11-20" });
  assert.equal(res.statusCode, 200);
  assert.ok(res.body.startsWith("\ufeffmember,email,hostname,project,repo,date,plan,requests,"));
  assert.ok(!res.body.includes("Secret"));
  const line = res.body.split("\r\n")[1];
  assert.ok(line.endsWith(","), "cost_usd_apikey empty for a subscription-only row");
});

// ---------------------------------------------------------------------------
// View access
// ---------------------------------------------------------------------------
test("VIEW_KEY gates the company-wide pages; ?vk= sets a cookie; ADMIN_KEY also works", async () => {
  const { app } = freshApp({ viewKey: "view-1", adminKey: "adm-1" });
  assert.equal((await app.inject({ method: "GET", url: "/" })).statusCode, 401);
  assert.equal((await app.inject({ method: "GET", url: "/api/v1/summary" })).statusCode, 401);
  assert.equal((await app.inject({ method: "GET", url: "/api/v1/breakdown.csv" })).statusCode, 401);
  assert.equal((await app.inject({ method: "GET", url: "/?vk=wrong" })).statusCode, 401);
  const ok = await app.inject({ method: "GET", url: "/?vk=view-1" });
  assert.equal(ok.statusCode, 200);
  const cookie = String(ok.headers["set-cookie"]).split(";")[0];
  assert.equal((await app.inject({ method: "GET", url: "/sessions", headers: { cookie } })).statusCode, 200);
  assert.equal((await app.inject({ method: "GET", url: "/api/v1/summary", headers: { "x-view-key": "adm-1" } })).statusCode, 200);
});

test("the ingest key does not open the dashboard", async () => {
  const { app } = freshApp({ ingestKey: "ing-1", viewKey: "view-1" });
  assert.equal((await app.inject({ method: "GET", url: "/?vk=ing-1" })).statusCode, 401);
});

test("db file uses WAL journal", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tokenscope-db-"));
  const db = openDb(path.join(dir, "usage.db"));
  assert.equal(db.pragma("journal_mode", { simple: true }), "wal");
  db.close();
});
