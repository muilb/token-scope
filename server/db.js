"use strict";
/**
 * SQLite store. Single connection, single process → writes are naturally
 * serialized. WAL lets the dashboard read while a client is pushing.
 *
 * Tables
 *   usage_delta    v1 deltas (client ≤ 0.6). Kept read-only for history.
 *   usage_bucket   v2 bucket snapshots (client ≥ 0.7): absolute totals per
 *                  (member, host, tool, session, day, model, speed, tier, geo,
 *                  origin). Upsert REPLACES — re-sends never double count.
 *   member         a person (canonical email + display name)
 *   member_alias   every identity key seen (acct:…, oai:…, owner:…, os:…) → member
 *   pricing_v2     absolute prices per component, dated (effective_from)
 *   pricing_globals web search price, inference-geo multiplier
 *   team, team_member, team_project, team keys (hash only) for PM pages
 *   pricing        v1 ratio table — kept for reference only
 */
const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");

const BASE_FROM = "0000-00-00";

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
CREATE INDEX IF NOT EXISTS idx_delta_host_day ON usage_delta(os_user, hostname, date);

CREATE TABLE IF NOT EXISTS usage_bucket (
  member_key TEXT NOT NULL, hostname TEXT NOT NULL, tool TEXT NOT NULL, session_id TEXT NOT NULL,
  date TEXT NOT NULL, model TEXT NOT NULL, speed TEXT NOT NULL, tier TEXT NOT NULL,
  geo TEXT NOT NULL, origin TEXT NOT NULL,
  os_user TEXT, email TEXT, account_uuid TEXT, display_name TEXT,
  auth_type TEXT, plan TEXT, key_hash TEXT, org_id TEXT, auth_confidence TEXT,
  project TEXT, repo TEXT,
  input INT NOT NULL DEFAULT 0, output INT NOT NULL DEFAULT 0, cache_read INT NOT NULL DEFAULT 0,
  cache_write_5m INT NOT NULL DEFAULT 0, cache_write_1h INT NOT NULL DEFAULT 0,
  web_search INT NOT NULL DEFAULT 0, requests INT NOT NULL DEFAULT 0,
  first_ts TEXT, last_ts TEXT, reported_at TEXT, client_version TEXT,
  PRIMARY KEY (member_key, hostname, tool, session_id, date, model, speed, tier, geo, origin)
);
CREATE INDEX IF NOT EXISTS idx_bucket_date ON usage_bucket(date);
CREATE INDEX IF NOT EXISTS idx_bucket_member ON usage_bucket(member_key);
CREATE INDEX IF NOT EXISTS idx_bucket_proj ON usage_bucket(project);
CREATE INDEX IF NOT EXISTS idx_bucket_host_day ON usage_bucket(os_user, hostname, date);

CREATE TABLE IF NOT EXISTS member (
  member_id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE,
  display_name TEXT DEFAULT '',
  created_at TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS member_alias (
  member_key TEXT PRIMARY KEY,
  member_id INTEGER NOT NULL,
  label TEXT DEFAULT '',
  last_seen TEXT DEFAULT ''
);

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

CREATE TABLE IF NOT EXISTS pricing_v2 (
  provider TEXT DEFAULT '',
  model_prefix TEXT NOT NULL,
  effective_from TEXT NOT NULL DEFAULT '${BASE_FROM}',
  input REAL NOT NULL,
  cached_input REAL,
  cache_write_short REAL,
  cache_write_long REAL,
  output REAL NOT NULL,
  fast_multiplier REAL,
  tier_threshold REAL,
  tier_input REAL,
  tier_cached_input REAL,
  tier_cache_write_short REAL,
  tier_cache_write_long REAL,
  tier_output REAL,
  note TEXT DEFAULT '',
  updated_at TEXT DEFAULT '',
  updated_by TEXT DEFAULT '',
  PRIMARY KEY (model_prefix, effective_from)
);
CREATE TABLE IF NOT EXISTS pricing_globals (key TEXT PRIMARY KEY, value REAL NOT NULL);

CREATE TABLE IF NOT EXISTS team (
  team_id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  key_hash TEXT DEFAULT '',
  created_at TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS team_member (team_id INTEGER NOT NULL, member_id INTEGER NOT NULL, PRIMARY KEY (team_id, member_id));
CREATE TABLE IF NOT EXISTS team_project (team_id INTEGER NOT NULL, project TEXT NOT NULL, PRIMARY KEY (team_id, project));
`;

/**
 * One row source for every report. v2 buckets, plus v1 deltas for any
 * (os user, host, day) that has no v2 data yet — after a 0.7 client backfills
 * a day, its v1 rows for that day stop counting (no double count).
 * Member identity is resolved through member_alias → member.
 */
const VIEW = `
DROP VIEW IF EXISTS usage_all;
CREATE VIEW usage_all AS
WITH u AS (
  SELECT member_key, hostname, os_user, email, display_name, tool, session_id, date, model,
         speed, tier, geo, origin, auth_type, plan, key_hash, org_id, auth_confidence, project, repo,
         input, output, cache_read, cache_write_5m, cache_write_1h, web_search, requests,
         first_ts, last_ts, 0 AS legacy
  FROM usage_bucket
  UNION ALL
  SELECT 'os:' || lower(d.os_user) || '@' || lower(d.hostname), d.hostname, d.os_user, NULL, NULL, d.tool, d.session_id, d.date, d.model,
         'standard', 'base', 'global', 'main', d.auth_type, d.auth_type, d.key_hash, d.org_short, d.auth_confidence, d.project, d.repo,
         d.input, d.output, d.cache_read, d.cache_write, 0, 0, 0,
         d.event_ts_to, d.event_ts_to, 1
  FROM usage_delta d
  WHERE NOT EXISTS (
    SELECT 1 FROM usage_bucket b WHERE b.os_user = d.os_user AND b.hostname = d.hostname AND b.date = d.date
  )
)
SELECT u.*,
       a.member_id AS member_id,
       COALESCE(NULLIF(m.display_name, ''), m.email, u.email, u.os_user || ' @ ' || u.hostname) AS member_label,
       COALESCE(m.email, u.email, '') AS member_email
FROM u
LEFT JOIN member_alias a ON a.member_key = u.member_key
LEFT JOIN member m ON m.member_id = a.member_id;
`;

// ---------------------------------------------------------------------------
// Pricing seed (shared with the extension: ../pricing/seed-v2.json)
// ---------------------------------------------------------------------------
function seedPath() {
  return process.env.PRICING_SEED || path.join(__dirname, "..", "pricing", "seed-v2.json");
}

function loadSeed() {
  const p = seedPath();
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    throw new Error(`pricing seed not readable at ${p} (set PRICING_SEED): ${e.message}`);
  }
}

const V2_COLS = [
  ["provider", "provider"],
  ["model_prefix", "modelPrefix"],
  ["effective_from", "effectiveFrom"],
  ["input", "input"],
  ["cached_input", "cachedInput"],
  ["cache_write_short", "cacheWriteShort"],
  ["cache_write_long", "cacheWriteLong"],
  ["output", "output"],
  ["fast_multiplier", "fastMultiplier"],
  ["tier_threshold", "tierThreshold"],
  ["tier_input", "tierInput"],
  ["tier_cached_input", "tierCachedInput"],
  ["tier_cache_write_short", "tierCacheWriteShort"],
  ["tier_cache_write_long", "tierCacheWriteLong"],
  ["tier_output", "tierOutput"],
  ["note", "note"],
];

function insertPriceRow(db, row, by, now) {
  const vals = {};
  for (const [col, key] of V2_COLS) vals[col] = row[key] === undefined ? null : row[key];
  vals.provider = vals.provider || "";
  vals.effective_from = vals.effective_from || BASE_FROM;
  vals.note = vals.note || "";
  vals.updated_at = now;
  vals.updated_by = by;
  db.prepare(
    `INSERT OR IGNORE INTO pricing_v2 (${V2_COLS.map((c) => c[0]).join(", ")}, updated_at, updated_by)
     VALUES (${V2_COLS.map((c) => "@" + c[0]).join(", ")}, @updated_at, @updated_by)`,
  ).run(vals);
}

/**
 * Seed pricing v2. Every boot adds rows for prefixes the table does not know
 * yet (a new release's seed brings new models) — existing rows, admin edits
 * included, are never overwritten. On the very first v2 boot, v1 rows for
 * models the seed does not cover are converted (ratio → absolute) so
 * admin-added models are kept.
 */
function seedPricing(db) {
  const seed = loadSeed();
  const now = new Date().toISOString();
  const run = db.transaction(() => {
    const firstV2 = db.prepare("SELECT COUNT(*) AS c FROM pricing_v2").get().c === 0;
    const known = new Set(db.prepare("SELECT DISTINCT model_prefix FROM pricing_v2").all().map((r) => r.model_prefix));
    const seedPrefixes = new Set();
    for (const m of seed.models || []) {
      const prefix = String(m.modelPrefix || "").toLowerCase();
      if (!prefix) continue;
      seedPrefixes.add(prefix);
      if (known.has(prefix)) continue;
      insertPriceRow(db, { ...m, modelPrefix: prefix }, "seed", now);
    }
    if (firstV2) {
      for (const r of db.prepare("SELECT * FROM pricing").all()) {
        const prefix = String(r.model_prefix).toLowerCase();
        if (seedPrefixes.has(prefix)) continue;
        insertPriceRow(
          db,
          {
            modelPrefix: prefix,
            input: r.input_per_m,
            output: r.output_per_m,
            cachedInput: r.input_per_m * r.cache_read_ratio,
            cacheWriteShort: r.input_per_m * r.cache_create_ratio,
            cacheWriteLong: r.input_per_m * 2,
            note: "chuyển từ bảng giá v1",
          },
          r.updated_by || "v1",
          now,
        );
      }
    }
    for (const [k, v] of Object.entries(seed.globals || {})) {
      db.prepare("INSERT OR IGNORE INTO pricing_globals (key, value) VALUES (?, ?)").run(k, Number(v));
    }
  });
  run();
}

function openDb(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("synchronous = NORMAL");
  initSchema(db);
  return db;
}

/** Create tables + view, seed pricing, register aliases for v1 identities. */
function initSchema(db) {
  db.exec(SCHEMA);
  db.exec(VIEW);
  seedPricing(db);
  registerLegacyAliases(db);
}

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------
function cleanEmail(e) {
  const s = String(e || "").trim().toLowerCase();
  return /^[^@\s]+@[^@\s]+$/.test(s) ? s : "";
}

/**
 * Resolve an identity key to a member, creating member/alias as needed. A new
 * key with an email joins the member that already has that email — so a
 * person's Claude account, ChatGPT account and owner-email API key usage end
 * up as ONE member.
 */
function ensureMember(db, memberKey, { email, displayName, label, seen } = {}) {
  const mail = cleanEmail(email);
  const alias = db.prepare("SELECT member_id FROM member_alias WHERE member_key = ?").get(memberKey);
  if (alias) {
    const m = db.prepare("SELECT * FROM member WHERE member_id = ?").get(alias.member_id);
    if (m && mail && !m.email) {
      const clash = db.prepare("SELECT member_id FROM member WHERE email = ?").get(mail);
      if (!clash) db.prepare("UPDATE member SET email = ? WHERE member_id = ?").run(mail, m.member_id);
    }
    if (m && displayName && !m.display_name) db.prepare("UPDATE member SET display_name = ? WHERE member_id = ?").run(displayName, m.member_id);
    if (seen) db.prepare("UPDATE member_alias SET last_seen = MAX(last_seen, ?) WHERE member_key = ?").run(seen, memberKey);
    return alias.member_id;
  }
  let memberId;
  const byEmail = mail ? db.prepare("SELECT member_id FROM member WHERE email = ?").get(mail) : null;
  if (byEmail) memberId = byEmail.member_id;
  else {
    memberId = db
      .prepare("INSERT INTO member (email, display_name, created_at) VALUES (?, ?, ?)")
      .run(mail || null, displayName || "", new Date().toISOString()).lastInsertRowid;
  }
  db.prepare("INSERT INTO member_alias (member_key, member_id, label, last_seen) VALUES (?, ?, ?, ?)").run(
    memberKey,
    memberId,
    label || "",
    seen || "",
  );
  return Number(memberId);
}

function registerLegacyAliases(db) {
  const rows = db
    .prepare(
      `SELECT os_user, hostname, MAX(date) AS seen FROM usage_delta
       WHERE 'os:' || lower(os_user) || '@' || lower(hostname) NOT IN (SELECT member_key FROM member_alias)
       GROUP BY os_user, hostname`,
    )
    .all();
  if (!rows.length) return;
  const run = db.transaction(() => {
    for (const r of rows) {
      ensureMember(db, `os:${String(r.os_user).toLowerCase()}@${String(r.hostname).toLowerCase()}`, {
        label: `${r.os_user} @ ${r.hostname}`,
        seen: r.seen,
      });
    }
  });
  run();
}

// ---------------------------------------------------------------------------
// Ingest v1 (client ≤ 0.6)
// ---------------------------------------------------------------------------
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
      ensureMember(db, `os:${row.os_user.toLowerCase()}@${row.hostname.toLowerCase()}`, {
        label: `${row.os_user} @ ${row.hostname}`,
        seen: row.date,
      });
    }
  });
  run(deltas);
  return { accepted: deltas.length, upserted, rejected };
}

function num(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

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

// ---------------------------------------------------------------------------
// Ingest v2 (client ≥ 0.7) — bucket snapshots, upsert REPLACES totals
// ---------------------------------------------------------------------------
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_BUCKETS = 2000;

function int(v) {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v) : 0;
}

function str(v, max = 512) {
  return typeof v === "string" ? v.slice(0, max) : "";
}

function toBucketRow(machine, client, reportedAt, b) {
  if (!b || typeof b !== "object") return null;
  const member = b.member || {};
  const auth = b.auth || {};
  const tk = b.tokens || {};
  if (!b.tool || !b.sessionId || !DAY_RE.test(String(b.date || "")) || !b.model || !member.key) return null;
  return {
    member_key: str(member.key, 200),
    hostname: str((machine && machine.hostname) || "unknown", 200),
    tool: str(b.tool, 20),
    session_id: str(b.sessionId, 200),
    date: b.date,
    model: str(b.model, 120),
    speed: str(b.speed || "standard", 20),
    tier: str(b.tier || "base", 20),
    geo: str(b.geo || "global", 20),
    origin: b.origin === "subagent" ? "subagent" : "main",
    os_user: str((machine && machine.osUser) || "unknown", 200),
    email: cleanEmail(member.email) || null,
    account_uuid: str(member.accountUuid, 64) || null,
    display_name: str(member.displayName, 200) || null,
    auth_type: str(auth.authType || "unknown", 20),
    plan: str(auth.plan || auth.authType || "", 40),
    key_hash: str(auth.keyHash, 16),
    org_id: str(auth.orgId, 64),
    auth_confidence: str(auth.confidence, 20),
    project: str(b.project, 200),
    repo: str(b.repo, 1000),
    input: int(tk.input),
    output: int(tk.output),
    cache_read: int(tk.cacheRead),
    cache_write_5m: int(tk.cacheWrite5m),
    cache_write_1h: int(tk.cacheWrite1h),
    web_search: int(tk.webSearch),
    requests: int(b.requests),
    first_ts: str(b.firstTs, 40),
    last_ts: str(b.lastTs, 40),
    reported_at: str(reportedAt, 40),
    client_version: str(client && client.version, 40),
  };
}

const BUCKET_COLS = [
  "member_key", "hostname", "tool", "session_id", "date", "model", "speed", "tier", "geo", "origin",
  "os_user", "email", "account_uuid", "display_name", "auth_type", "plan", "key_hash", "org_id", "auth_confidence",
  "project", "repo", "input", "output", "cache_read", "cache_write_5m", "cache_write_1h", "web_search", "requests",
  "first_ts", "last_ts", "reported_at", "client_version",
];
const BUCKET_PK = BUCKET_COLS.slice(0, 10);

function upsertBuckets(db, machine, buckets, { client, reportedAt, isSecret } = {}) {
  if (buckets.length > MAX_BUCKETS) return { error: `too many buckets (max ${MAX_BUCKETS})` };
  const stmt = db.prepare(`
    INSERT INTO usage_bucket (${BUCKET_COLS.join(", ")})
    VALUES (${BUCKET_COLS.map((c) => "@" + c).join(", ")})
    ON CONFLICT (${BUCKET_PK.join(", ")}) DO UPDATE SET
    ${BUCKET_COLS.filter((c) => !BUCKET_PK.includes(c)).map((c) => `${c} = excluded.${c}`).join(",\n    ")}
  `);
  let upserted = 0;
  const rejected = [];
  const run = db.transaction(() => {
    buckets.forEach((b, i) => {
      if (isSecret && isSecret(b)) {
        rejected.push({ index: i, reason: "secret" });
        return;
      }
      const row = toBucketRow(machine, client, reportedAt, b);
      if (!row) {
        rejected.push({ index: i, reason: "invalid_bucket" });
        return;
      }
      stmt.run(row);
      upserted++;
      ensureMember(db, row.member_key, {
        email: row.email,
        displayName: row.display_name,
        label: row.email || `${row.os_user} @ ${row.hostname}`,
        seen: row.date,
      });
    });
  });
  run();
  return { accepted: buckets.length, upserted, rejected };
}

module.exports = {
  openDb,
  initSchema,
  upsertDeltas,
  upsertBuckets,
  ensureMember,
  toRow,
  seedPricing,
  loadSeed,
  SCHEMA,
  VIEW,
  BASE_FROM,
  V2_COLS,
  cleanEmail,
};
