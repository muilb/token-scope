"use strict";
const Database = require("better-sqlite3");
const { initSchema } = require("../db");
const { buildApp } = require("../app");
const pricing = require("../pricing");

/** In-memory DB + app. opts: { ingestKey, adminKey, viewKey } */
function freshApp(opts = {}) {
  const db = new Database(":memory:");
  initSchema(db);
  pricing.invalidate(); // drop any cache from a previous in-memory db
  const app = buildApp(db, opts);
  return { app, db };
}

function v1Payload(overrides = {}) {
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

function bucket(over = {}) {
  return {
    tool: "claude",
    sessionId: "s-1",
    date: "2026-11-20",
    model: "claude-opus-5-5",
    speed: "standard",
    tier: "base",
    geo: "global",
    origin: "main",
    member: { key: "acct:uuid-1", email: "dev1@example.com", accountUuid: "uuid-1", displayName: "Dev One" },
    auth: { authType: "oauth", plan: "team", confidence: "confirmed" },
    project: "demo-app",
    repo: "D:/Work/demo-app",
    tokens: { input: 100, output: 1000, cacheRead: 10000, cacheWrite5m: 0, cacheWrite1h: 2000, webSearch: 0 },
    requests: 3,
    firstTs: "2026-11-20T05:00:00.000Z",
    lastTs: "2026-11-20T05:10:00.000Z",
    ...over,
  };
}

function v2Payload(buckets, machine = { osUser: "dev1", hostname: "PC-A" }) {
  return { schema: "usage.v2", reportedAt: "2026-11-20T06:00:00Z", machine, client: { version: "0.7.0" }, buckets };
}

async function post(app, payload, headers = {}) {
  return app.inject({ method: "POST", url: "/api/v1/usage", payload, headers });
}

module.exports = { freshApp, v1Payload, v2Payload, bucket, post };
