"use strict";
/**
 * SQLite store for usage deltas. Single connection, single process → writes are
 * naturally serialized (see improve/09 §E.2). WAL lets the dashboard read while
 * a client is pushing; busy_timeout absorbs the rare concurrent-writer case.
 */
const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS usage_delta (
  os_user TEXT, hostname TEXT, tool TEXT, session_id TEXT, seq INT,
  event_ts_to TEXT, date TEXT,
  auth_type TEXT, key_hash TEXT, org_short TEXT, auth_confidence TEXT,
  project TEXT, repo TEXT, model TEXT,
  input INT, output INT, cache_read INT, cache_write INT,
  cost_estimate REAL, reported_at TEXT,
  PRIMARY KEY (os_user, hostname, tool, session_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_delta_date ON usage_delta(date);
CREATE INDEX IF NOT EXISTS idx_delta_proj ON usage_delta(project);
CREATE INDEX IF NOT EXISTS idx_delta_auth ON usage_delta(auth_type);

-- Admin-managed pricing (see improve/10). Cost is recomputed from raw tokens at
-- query time against this table; changing a price re-values history immediately.
CREATE TABLE IF NOT EXISTS pricing (
  model_prefix   TEXT PRIMARY KEY,
  input_per_m    REAL NOT NULL,
  output_per_m   REAL NOT NULL,
  cache_read_ratio   REAL NOT NULL DEFAULT 0.1,
  cache_create_ratio REAL NOT NULL DEFAULT 1.25,
  note        TEXT DEFAULT '',
  updated_at  TEXT DEFAULT '',
  updated_by  TEXT DEFAULT ''
);
`;

// Seed prices — mirrors token-dashboard-ext/src/pricing.ts PRICING at first boot.
// Only used when the pricing table is empty; admin edits are never overwritten.
const SEED_PRICING = [
  ["claude-sonnet-5", 3.0, 15.0, 0.1, 1.25],
  ["claude-sonnet-4-6", 3.0, 15.0, 0.1, 1.25],
  ["claude-sonnet-4-5", 3.0, 15.0, 0.1, 1.25],
  ["claude-haiku-4-5", 1.0, 5.0, 0.1, 1.25],
  ["claude-haiku-4-6", 1.0, 5.0, 0.1, 1.25],
  ["claude-opus-4-8", 5.0, 25.0, 0.1, 1.25],
  ["claude-opus-4-7", 5.0, 25.0, 0.1, 1.25],
  ["claude-opus-4-6", 5.0, 25.0, 0.1, 1.25],
  ["claude-fable-5", 10.0, 50.0, 0.1, 1.25],
  ["gpt-5.5", 5.0, 30.0, 0.1, 0.0],
  ["gpt-5.4-mini", 0.75, 4.5, 0.1, 0.0],
  ["gpt-5.4", 2.5, 15.0, 0.1, 0.0],
  ["gpt-5.3-codex", 2.5, 15.0, 0.1, 0.0],
  ["gpt-5.3", 2.5, 15.0, 0.1, 0.0],
];

function seedPricing(db) {
  const n = db.prepare("SELECT COUNT(*) AS c FROM pricing").get().c;
  if (n > 0) return; // never overwrite admin edits
  const ins = db.prepare(
    `INSERT INTO pricing (model_prefix, input_per_m, output_per_m, cache_read_ratio, cache_create_ratio, updated_at, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, 'seed')`,
  );
  const now = new Date().toISOString();
  const run = db.transaction((rows) => {
    for (const r of rows) ins.run(r[0], r[1], r[2], r[3], r[4], now);
  });
  run(SEED_PRICING);
}

function openDb(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("synchronous = NORMAL");
  db.exec(SCHEMA);
  seedPricing(db);
  return db;
}

/**
 * Upsert one machine payload's deltas in a single transaction.
 * Idempotent on PK (os_user, hostname, tool, session_id, seq) → re-pushing the
 * same delta is a no-op, never double-counts.
 * Returns { accepted, upserted, rejected }.
 */
function upsertDeltas(db, machine, deltas) {
  const stmt = db.prepare(`
    INSERT INTO usage_delta (
      os_user, hostname, tool, session_id, seq,
      event_ts_to, date,
      auth_type, key_hash, org_short, auth_confidence,
      project, repo, model,
      input, output, cache_read, cache_write,
      cost_estimate, reported_at
    ) VALUES (
      @os_user, @hostname, @tool, @session_id, @seq,
      @event_ts_to, @date,
      @auth_type, @key_hash, @org_short, @auth_confidence,
      @project, @repo, @model,
      @input, @output, @cache_read, @cache_write,
      @cost_estimate, @reported_at
    )
    ON CONFLICT (os_user, hostname, tool, session_id, seq) DO UPDATE SET
      event_ts_to = excluded.event_ts_to, date = excluded.date,
      auth_type = excluded.auth_type, key_hash = excluded.key_hash,
      org_short = excluded.org_short, auth_confidence = excluded.auth_confidence,
      project = excluded.project, repo = excluded.repo, model = excluded.model,
      input = excluded.input, output = excluded.output,
      cache_read = excluded.cache_read, cache_write = excluded.cache_write,
      cost_estimate = excluded.cost_estimate, reported_at = excluded.reported_at
  `);

  let upserted = 0;
  const rejected = [];

  const run = db.transaction((rows) => {
    for (const d of rows) {
      const row = toRow(machine, d);
      if (!row) {
        rejected.push({ sessionId: d && d.sessionId, reason: "invalid_delta" });
        continue;
      }
      stmt.run(row);
      upserted++;
    }
  });
  run(deltas);

  return { accepted: deltas.length, upserted, rejected };
}

function num(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** Map a payload delta to a DB row; return null if it lacks required identity. */
function toRow(machine, d) {
  if (!d || !d.sessionId || !d.tool || typeof d.seq !== "number") return null;
  const tk = d.tokens || {};
  const auth = d.auth || {};
  return {
    os_user: (machine && machine.osUser) || "unknown",
    hostname: (machine && machine.hostname) || "unknown",
    tool: d.tool,
    session_id: d.sessionId,
    seq: d.seq,
    event_ts_to: d.eventTsTo || "",
    date: d.date || "",
    auth_type: auth.authType || "unknown",
    key_hash: auth.keyHash || "",
    org_short: auth.orgShort || "",
    auth_confidence: auth.confidence || "",
    project: d.project || "",
    repo: d.repo || "",
    model: d.model || "",
    input: num(tk.input),
    output: num(tk.output),
    cache_read: num(tk.cacheRead),
    cache_write: num(tk.cacheWrite),
    cost_estimate: num(d.costEstimate),
    reported_at: d.reportedAt || "",
  };
}

module.exports = { openDb, upsertDeltas, toRow, SCHEMA, seedPricing, SEED_PRICING };
