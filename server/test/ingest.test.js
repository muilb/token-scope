"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");
const { openDb, SCHEMA, seedPricing } = require("../db");
const { buildApp } = require("../app");
const pricing = require("../pricing");

function freshApp(ingestKey, adminKey) {
  const db = new Database(":memory:");
  db.exec(SCHEMA);
  seedPricing(db); // cost is recomputed from this table (see queries.js)
  pricing.invalidate(); // drop any cache from a previous in-memory db
  return buildApp(db, { ingestKey, adminKey });
}

// opus-4-8 @ [5,25,0.1,1.25] with in100/out50/cr10/cw5:
//   100/1e6*5 + 50/1e6*25 + 10/1e6*5*0.1 + 5/1e6*5*1.25 = 0.00178625 → 0.0018 (4dp)
const COST_A = 0.0018;

function payload(overrides = {}) {
  return {
    schema: "usage.v1",
    reportedAt: "2026-06-26T03:00:00Z",
    machine: { osUser: "lb_mui", hostname: "PC-A" },
    deltas: [
      {
        sessionId: "claude:9f2a",
        tool: "claude",
        seq: 1,
        eventTsTo: "2026-06-26T10:45:00Z",
        date: "2026-06-26",
        auth: { authType: "apikey", keyHash: "3f9a1c22", orgShort: "a1b2", confidence: "confirmed" },
        project: "SunStory-BTA",
        repo: "d:/Work/Projects/21.SunStory/BTA_Source",
        model: "claude-opus-4-8",
        tokens: { input: 100, output: 50, cacheRead: 10, cacheWrite: 5 },
        costEstimate: 0.12,
      },
    ],
    ...overrides,
  };
}

test("healthz ok", async () => {
  const app = freshApp("");
  const res = await app.inject({ method: "GET", url: "/healthz" });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { ok: true });
});

test("ingest accepts and upserts a delta", async () => {
  const app = freshApp("");
  const res = await app.inject({ method: "POST", url: "/api/v1/usage", payload: payload() });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { accepted: 1, upserted: 1, rejected: [] });
});

test("dedupe: same (sessionId, seq) pushed twice = one row, no double count", async () => {
  const app = freshApp("");
  await app.inject({ method: "POST", url: "/api/v1/usage", payload: payload() });
  await app.inject({ method: "POST", url: "/api/v1/usage", payload: payload() });

  const res = await app.inject({ method: "GET", url: "/api/v1/summary?groupBy=project" });
  const rows = res.json();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].deltas, 1); // COUNT(*) is 1, not 2
  assert.equal(rows[0].cost, COST_A); // recomputed, not doubled
});

test("401 on wrong ingest key", async () => {
  const app = freshApp("secret-token");
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/usage",
    headers: { "x-ingest-key": "wrong" },
    payload: payload(),
  });
  assert.equal(res.statusCode, 401);
});

test("401 on wrong key even without content-type (gate before body parse)", async () => {
  const app = freshApp("secret-token");
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/usage",
    headers: { "x-ingest-key": "wrong" },
    body: "{}", // no content-type header
  });
  assert.equal(res.statusCode, 401);
});

test("200 on correct ingest key", async () => {
  const app = freshApp("secret-token");
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/usage",
    headers: { "x-ingest-key": "secret-token" },
    payload: payload(),
  });
  assert.equal(res.statusCode, 200);
});

test("reject unsupported schema without crashing", async () => {
  const app = freshApp("");
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/usage",
    payload: payload({ schema: "usage.v999" }),
  });
  assert.equal(res.statusCode, 400);
});

test("reject payload containing a raw secret", async () => {
  const app = freshApp("");
  const bad = payload();
  bad.deltas[0].repo = "sk-proj-ABCDEFG1234567890abcdefghijklmnop"; // leaked secret
  const res = await app.inject({ method: "POST", url: "/api/v1/usage", payload: bad });
  assert.equal(res.statusCode, 422);
});

test("summary groups by member and by key", async () => {
  const app = freshApp("");
  await app.inject({ method: "POST", url: "/api/v1/usage", payload: payload() });

  const byMember = (await app.inject({ method: "GET", url: "/api/v1/summary?groupBy=member" })).json();
  assert.equal(byMember[0].os_user, "lb_mui");
  assert.equal(byMember[0].tokens, 165);

  const byKey = (await app.inject({ method: "GET", url: "/api/v1/summary?groupBy=key" })).json();
  assert.equal(byKey[0].key_hash, "3f9a1c22");
});

test("date filter excludes out-of-range deltas", async () => {
  const app = freshApp("");
  await app.inject({ method: "POST", url: "/api/v1/usage", payload: payload() });
  const res = await app.inject({
    method: "GET",
    url: "/api/v1/summary?from=2026-07-01&to=2026-07-31",
  });
  assert.equal(res.json().length, 0);
});

test("dashboard renders short repo, not full path", async () => {
  const app = freshApp("");
  await app.inject({ method: "POST", url: "/api/v1/usage", payload: payload() });
  // ?all=1 so the seeded (past-dated) row isn't hidden by the default today filter.
  const res = await app.inject({ method: "GET", url: "/?all=1" });
  assert.equal(res.statusCode, 200);
  const html = res.body;
  assert.ok(html.includes("BTA_Source")); // short name shown
  assert.ok(html.includes("SunStory-BTA")); // project shown
  // full path only in the title attr (tooltip), main cell is short — sanity: project is bold
  assert.ok(html.includes("Central Usage"));
});

function payloadB() {
  // A second member / project / key so filters have something to exclude.
  return payload({
    machine: { osUser: "nva", hostname: "PC-B" },
    deltas: [
      {
        sessionId: "claude:aaaa",
        tool: "claude",
        seq: 1,
        eventTsTo: "2026-06-26T11:00:00Z",
        date: "2026-06-26",
        auth: { authType: "apikey", keyHash: "5c11aa90", orgShort: "z9", confidence: "confirmed" },
        project: "Acme-Web",
        repo: "d:/work/acme-web",
        model: "claude-opus-4-8",
        tokens: { input: 200, output: 80, cacheRead: 0, cacheWrite: 0 },
        costEstimate: 0.30,
      },
    ],
  });
}

async function seedTwo(app) {
  await app.inject({ method: "POST", url: "/api/v1/usage", payload: payload() });
  await app.inject({ method: "POST", url: "/api/v1/usage", payload: payloadB() });
}

test("member filter keeps only that member", async () => {
  const app = freshApp("");
  await seedTwo(app);
  const rows = (await app.inject({ method: "GET", url: "/api/v1/summary?member=nva" })).json();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].project, "Acme-Web");
});

test("project filter keeps only that project", async () => {
  const app = freshApp("");
  await seedTwo(app);
  const rows = (await app.inject({ method: "GET", url: "/api/v1/summary?project=SunStory-BTA" })).json();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].cost, COST_A);
});

test("key filter keeps only that key_hash", async () => {
  const app = freshApp("");
  await seedTwo(app);
  const rows = (await app.inject({ method: "GET", url: "/api/v1/summary?groupBy=key&key=5c11aa90" })).json();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].key_hash, "5c11aa90");
});

test("fresh dashboard load defaults the date range to today", async () => {
  const app = freshApp("");
  await app.inject({ method: "POST", url: "/api/v1/usage", payload: payload() }); // date 2026-06-26
  const html = (await app.inject({ method: "GET", url: "/" })).body;
  const today = new Date();
  const p = (n) => String(n).padStart(2, "0");
  const iso = `${today.getFullYear()}-${p(today.getMonth() + 1)}-${p(today.getDate())}`;
  assert.ok(html.includes(`value="${iso}"`)); // both date inputs prefilled with today
  assert.ok(html.includes("Chưa có dữ liệu")); // the 2026-06-26 row is filtered out by default
});

test("?all=1 clears the default date range and shows every day", async () => {
  const app = freshApp("");
  await app.inject({ method: "POST", url: "/api/v1/usage", payload: payload() });
  const html = (await app.inject({ method: "GET", url: "/?all=1" })).body;
  assert.ok(html.includes("SunStory-BTA")); // the old-dated row is visible again
  assert.ok(!html.includes("Chưa có dữ liệu"));
});

test("dashboard renders filter bar with distinct options and preselects current filter", async () => {
  const app = freshApp("");
  await seedTwo(app);
  const html = (await app.inject({ method: "GET", url: "/?member=nva" })).body;
  assert.ok(html.includes('name="member"')); // filter bar present
  assert.ok(html.includes(">lb_mui<") && html.includes(">nva<")); // both members offered
  assert.ok(html.includes('value="nva" selected')); // current filter preselected
});

test("Export CSV link carries the active filters", async () => {
  const app = freshApp("");
  await seedTwo(app);
  const html = (await app.inject({ method: "GET", url: "/?member=nva&project=Acme-Web" })).body;
  assert.ok(html.includes("breakdown.csv?") && html.includes("member=nva") && html.includes("project=Acme-Web"));
});

test("breakdown CSV = one row per table row, filtered, no full path", async () => {
  const app = freshApp("");
  await seedTwo(app);
  const csv = (await app.inject({ method: "GET", url: "/api/v1/breakdown.csv?member=lb_mui" })).body;
  const lines = csv.trim().split("\n");
  assert.equal(lines[0], "member,hostname,project,repo,date,auth,key_hash,input,output,cache_read,cache_write,tokens,cost");
  assert.equal(lines.length, 2); // header + one row (only lb_mui after filter)
  assert.ok(lines[1].startsWith("lb_mui,PC-A,SunStory-BTA,BTA_Source,")); // short repo, not full path
  assert.ok(!csv.includes("d:/Work/Projects")); // full path never exported
  // token breakdown split out: ...,input,output,cache_read,cache_write,tokens,cost
  assert.ok(lines[1].endsWith(",100,50,10,5,165," + COST_A)); // recomputed from pricing table
});

test("db file uses WAL journal", () => {
  const os = require("os");
  const path = require("path");
  const fs = require("fs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ts-db-"));
  const db = openDb(path.join(dir, "usage.db"));
  assert.equal(db.pragma("journal_mode", { simple: true }), "wal");
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
