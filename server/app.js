"use strict";
/**
 * Fastify app factory (no listen) — importable by tests.
 * Endpoints (see improve/08 §4.2, improve/10):
 *   POST /api/v1/usage         ingest deltas (X-Ingest-Key gated)
 *   GET  /api/v1/summary       aggregated JSON (groupBy=member|project|key)
 *   GET  /api/v1/pricing       current pricing table (for extension sync)
 *   GET  /                     dashboard HTML
 *   GET  /admin                pricing admin page (ADMIN_KEY gated)
 *   POST /admin/pricing        upsert a price row (ADMIN_KEY gated)
 *   POST /admin/pricing/delete delete a price row (ADMIN_KEY gated)
 *   GET  /healthz              liveness
 */
const querystring = require("querystring");
const Fastify = require("fastify");
const { upsertDeltas } = require("./db");
const { summary, breakdown, filterOptions } = require("./queries");
const { renderDashboard } = require("./dashboard");
const { renderAdmin, renderKeyPrompt } = require("./admin");
const pricing = require("./pricing");

const SUPPORTED_SCHEMA = "usage.v1";
// Catch a full key/token accidentally included in a payload before it hits the DB.
const SECRET_RE = /sk-ant-|sk-proj-[A-Za-z0-9]{20,}/;

function buildApp(db, { ingestKey, adminKey } = {}) {
  const app = Fastify({ logger: false });

  // Parse HTML form posts (admin pages) in addition to Fastify's built-in JSON.
  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string" },
    (req, body, done) => {
      try {
        done(null, querystring.parse(body));
      } catch (e) {
        done(e);
      }
    },
  );

  // Minimal access log: one line per request with the source IP, so an operator
  // can see which machines reach the server (fastify's own logger stays off to
  // avoid pino noise). Prints method, url, and remote address.
  app.addHook("onRequest", async (req, reply) => {
    console.log(`${new Date().toISOString()} ${req.ip} ${req.method} ${req.url}`);
    if (req.method === "POST" && req.url.startsWith("/api/v1/usage")) {
      if (ingestKey && req.headers["x-ingest-key"] !== ingestKey) {
        console.log(`  -> 401 bad ingest key from ${req.ip}`);
        return reply.code(401).send({ error: "bad ingest key" });
      }
    }
  });

  app.get("/healthz", async () => ({ ok: true }));

  app.post("/api/v1/usage", async (req, reply) => {
    const body = req.body || {};
    if (body.schema !== SUPPORTED_SCHEMA) {
      return reply.code(400).send({ error: "unsupported schema", schema: body.schema });
    }
    if (!Array.isArray(body.deltas)) {
      return reply.code(400).send({ error: "deltas must be an array" });
    }
    // Defense in depth: never persist a payload carrying a raw secret.
    if (SECRET_RE.test(JSON.stringify(body.deltas))) {
      return reply.code(422).send({ error: "payload appears to contain a secret" });
    }
    const result = upsertDeltas(db, body.machine, body.deltas);
    return reply.send(result);
  });

  app.get("/api/v1/summary", async (req) => {
    const { from, to, groupBy, member, project, key } = req.query || {};
    return summary(db, pricing.loadPricing(db), { from, to, groupBy, member, project, key });
  });

  // Current pricing table — the extension pulls this to keep its local dashboard
  // in step with the admin-managed central prices. Read-only; gated by the same
  // ingest key clients already hold (not the admin key).
  app.get("/api/v1/pricing", async (req, reply) => {
    if (ingestKey && req.headers["x-ingest-key"] !== ingestKey) {
      return reply.code(401).send({ error: "bad ingest key" });
    }
    const rows = pricing.listPricing(db);
    return reply.send({
      schema: "pricing.v1",
      updatedAt: rows.reduce((m, r) => (r.updated_at > m ? r.updated_at : m), ""),
      models: rows.map((r) => ({
        modelPrefix: r.model_prefix,
        inputPerM: r.input_per_m,
        outputPerM: r.output_per_m,
        cacheReadRatio: r.cache_read_ratio,
        cacheCreateRatio: r.cache_create_ratio,
      })),
    });
  });

  // Aggregated CSV (grouped by member|project|key) — kept for API consumers.
  app.get("/api/v1/summary.csv", async (req, reply) => {
    const { from, to, groupBy, member, project, key } = req.query || {};
    const rows = summary(db, pricing.loadPricing(db), { from, to, groupBy, member, project, key });
    reply.type("text/csv").header("content-disposition", 'attachment; filename="usage.csv"');
    return toCsv(rows);
  });

  // Dashboard CSV — one row per table row (member×project×date). Explicit column
  // set so the full repo path is NEVER exported (only the short name, like the UI).
  app.get("/api/v1/breakdown.csv", async (req, reply) => {
    const { from, to, member, project, key } = req.query || {};
    const rows = breakdown(db, pricing.loadPricing(db), { from, to, member, project, key }).map((r) => ({
      member: r.os_user,
      hostname: r.hostname,
      project: r.project,
      repo: r.repoShort,
      date: r.date,
      auth: r.auth_type,
      key_hash: r.key_hash || "",
      input: r.input,
      output: r.output,
      cache_read: r.cache_read,
      cache_write: r.cache_write,
      tokens: r.tokens,
      cost: r.cost,
    }));
    reply.type("text/csv").header("content-disposition", 'attachment; filename="usage-breakdown.csv"');
    return toCsv(rows);
  });

  app.get("/", async (req, reply) => {
    const q = req.query || {};
    const { member, project, key, all } = q;
    let { from, to } = q;
    // Default the date range to today on a fresh load. "Xoá lọc" (?all=1) opts
    // out to show every day; an explicit from/to is always respected.
    const untouched = !from && !to && !member && !project && !key;
    if (untouched && !all) {
      from = to = todayLocal();
    }
    const filter = { from, to, member, project, key };
    const rows = breakdown(db, pricing.loadPricing(db), filter);
    const options = filterOptions(db);
    reply.type("text/html").send(renderDashboard(rows, { ...filter, options }));
  });

  // ---- Admin (pricing) -----------------------------------------------------

  // Extract the supplied admin key from header, query, or form body.
  function suppliedKey(req) {
    return (
      req.headers["x-admin-key"] ||
      (req.query && req.query.key) ||
      (req.body && req.body.key) ||
      ""
    );
  }
  // True when the request is authorized to touch admin. Empty ADMIN_KEY = open.
  function adminOk(req) {
    if (!adminKey) return true;
    return suppliedKey(req) === adminKey;
  }

  app.get("/admin", async (req, reply) => {
    if (!adminOk(req)) {
      return reply.type("text/html").send(renderKeyPrompt());
    }
    return reply.type("text/html").send(renderAdminPage(req.query || {}));
  });

  app.post("/admin/pricing", async (req, reply) => {
    if (!adminOk(req)) return reply.code(401).send({ error: "bad admin key" });
    const b = req.body || {};
    try {
      pricing.upsertPricing(db, b, suppliedKey(req) ? "admin" : "");
      return redirectAdmin(reply, adminKey ? suppliedKey(req) : "", { saved: b.model_prefix });
    } catch (e) {
      return redirectAdmin(reply, adminKey ? suppliedKey(req) : "", { err: e.message });
    }
  });

  app.post("/admin/pricing/delete", async (req, reply) => {
    if (!adminOk(req)) return reply.code(401).send({ error: "bad admin key" });
    const b = req.body || {};
    pricing.deletePricing(db, b.model_prefix);
    return redirectAdmin(reply, adminKey ? suppliedKey(req) : "", { deleted: b.model_prefix });
  });

  function renderAdminPage(query) {
    const map = pricing.loadPricing(db);
    const rows = pricing.listPricing(db);
    const unpriced = pricing.unpricedModels(db, map);
    let banner;
    if (query.saved) banner = { kind: "ok", text: `Đã lưu giá "${query.saved}".` };
    else if (query.deleted) banner = { kind: "ok", text: `Đã xoá giá "${query.deleted}".` };
    else if (query.err) banner = { kind: "err", text: query.err };
    return renderAdmin(rows, unpriced, { adminKey: adminKey ? query.key || "" : "", banner });
  }

  // Redirect back to /admin (PRG pattern) preserving the key and a status banner.
  function redirectAdmin(reply, key, status) {
    const qs = new URLSearchParams();
    if (key) qs.set("key", key);
    for (const [k, v] of Object.entries(status)) if (v != null) qs.set(k, String(v));
    reply.code(303).header("location", "/admin" + (qs.toString() ? "?" + qs.toString() : ""));
    return reply.send();
  }

  return app;
}

/** Local calendar day 'YYYY-MM-DD' — matches the `date` column the client writes. */
function todayLocal() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function toCsv(rows) {
  if (!rows.length) return "";
  const cols = Object.keys(rows[0]);
  const cell = (v) => {
    const s = String(v == null ? "" : v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [cols.join(",")];
  for (const r of rows) lines.push(cols.map((c) => cell(r[c])).join(","));
  return lines.join("\n");
}

module.exports = { buildApp, SUPPORTED_SCHEMA };
