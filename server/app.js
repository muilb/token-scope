"use strict";
/**
 * Fastify app factory (no listen) — importable by tests.
 *
 * Ingest
 *   POST /api/v1/usage                 usage.v2 buckets (client ≥ 0.7) or usage.v1 deltas (≤ 0.6); X-Ingest-Key
 *   GET  /api/v1/pricing               pricing.v1 (old clients) or ?schema=v2; X-Ingest-Key
 * Views (VIEW_KEY or ADMIN_KEY; ?vk= once → cookie)
 *   GET  /                             member × project × day
 *   GET  /sessions                     one row per session
 *   GET  /api/v1/summary[.csv]         groupBy=member|project|key|plan
 *   GET  /api/v1/breakdown.csv, /api/v1/sessions.csv
 * Team (PM) — team key only, sees only that team
 *   GET  /team?k=…                     grouped report for one team
 *   GET  /api/v1/team/export.csv?k=…
 * Admin (ADMIN_KEY)
 *   GET  /admin?tab=pricing|members|teams, POST /admin/...
 *   GET  /healthz
 */
const crypto = require("crypto");
const querystring = require("querystring");
const Fastify = require("fastify");
const { upsertDeltas, upsertBuckets } = require("./db");
const { aggregate, totals, summary, breakdown, sessionBreakdown, filterOptions } = require("./queries");
const { renderDashboard, renderViewKeyPrompt } = require("./dashboard");
const { renderSessions } = require("./sessions");
const { renderAdmin, renderKeyPrompt } = require("./admin");
const { renderTeam, renderTeamDenied, TEAM_GROUPS } = require("./teams");
const pricing = require("./pricing");

// Specific key/token shapes only — never a long path or project name (see pusher.ts).
const SECRET_RE = /sk-ant-[A-Za-z0-9_-]{8,}|sk-proj-[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9]{40,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./;
const VIEW_COOKIE = "tsv";

function sha256(s) {
  return crypto.createHash("sha256").update(String(s)).digest("hex");
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function buildApp(db, { ingestKey, adminKey, viewKey } = {}) {
  const app = Fastify({ logger: false, bodyLimit: 8 * 1024 * 1024 });

  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (req, body, done) => {
    try {
      done(null, querystring.parse(body));
    } catch (e) {
      done(e);
    }
  });

  app.addHook("onRequest", async (req, reply) => {
    const url = req.url.replace(/([?&](vk|k|key)=)[^&]*/g, "$1***");
    console.log(`${new Date().toISOString()} ${req.ip} ${req.method} ${url}`);
    if (req.method === "POST" && req.url.startsWith("/api/v1/usage")) {
      if (ingestKey && !safeEqual(req.headers["x-ingest-key"] || "", ingestKey)) {
        console.log(`  -> 401 bad ingest key from ${req.ip}`);
        return reply.code(401).send({ error: "bad ingest key" });
      }
    }
  });

  // ---- access helpers -----------------------------------------------------
  function suppliedAdminKey(req) {
    return req.headers["x-admin-key"] || (req.query && req.query.key) || (req.body && req.body.key) || "";
  }
  function adminOk(req) {
    if (!adminKey) return true;
    return safeEqual(suppliedAdminKey(req), adminKey);
  }
  /** View access: VIEW_KEY (or ADMIN_KEY) via ?vk=, X-View-Key or the cookie set after a ?vk= visit. */
  function viewOk(req, reply) {
    if (!viewKey && !adminKey) return true;
    const q = (req.query && req.query.vk) || "";
    const candidates = [q, req.headers["x-view-key"] || "", cookies(req)[VIEW_COOKIE] || ""];
    for (const c of candidates) {
      if (!c) continue;
      if ((viewKey && safeEqual(c, viewKey)) || (adminKey && safeEqual(c, adminKey))) {
        if (q && reply) reply.header("set-cookie", `${VIEW_COOKIE}=${encodeURIComponent(q)}; HttpOnly; SameSite=Strict; Path=/`);
        return true;
      }
    }
    return false;
  }
  function denyView(req, reply, html) {
    if (html) return reply.code(401).type("text/html").send(renderViewKeyPrompt(req.url.split("?")[0]));
    return reply.code(401).send({ error: "view key required" });
  }
  function teamFromKey(k) {
    if (!k) return null;
    return db.prepare("SELECT * FROM team WHERE key_hash = ?").get(sha256(k)) || null;
  }
  function ctx() {
    return pricing.loadPricing(db);
  }

  app.get("/healthz", async () => ({ ok: true }));

  // ---- ingest -------------------------------------------------------------
  app.post("/api/v1/usage", async (req, reply) => {
    const body = req.body || {};
    if (body.schema === "usage.v2") {
      if (!Array.isArray(body.buckets)) return reply.code(400).send({ error: "buckets must be an array" });
      const res = upsertBuckets(db, body.machine, body.buckets, {
        client: body.client,
        reportedAt: body.reportedAt,
        isSecret: (b) => SECRET_RE.test(JSON.stringify(b)),
      });
      if (res.error) return reply.code(413).send(res);
      return reply.send(res);
    }
    if (body.schema === "usage.v1") {
      if (!Array.isArray(body.deltas)) return reply.code(400).send({ error: "deltas must be an array" });
      if (SECRET_RE.test(JSON.stringify(body.deltas))) {
        return reply.code(422).send({ error: "payload appears to contain a secret" });
      }
      return reply.send(upsertDeltas(db, body.machine, body.deltas));
    }
    return reply.code(400).send({ error: "unsupported schema", schema: body.schema });
  });

  app.get("/api/v1/pricing", async (req, reply) => {
    if (ingestKey && !safeEqual(req.headers["x-ingest-key"] || "", ingestKey)) {
      return reply.code(401).send({ error: "bad ingest key" });
    }
    return reply.send(req.query && req.query.schema === "v2" ? pricing.wireV2(db) : pricing.wireV1(db));
  });

  // ---- views --------------------------------------------------------------
  function viewFilter(q) {
    const { member, project, key, plan, all } = q;
    let { from, to } = q;
    const untouched = !from && !to && !member && !project && !key && !plan;
    if (untouched && !all) from = to = todayLocal();
    return { from, to, member, project, key, plan };
  }

  app.get("/", async (req, reply) => {
    if (!viewOk(req, reply)) return denyView(req, reply, true);
    const filter = viewFilter(req.query || {});
    const rows = breakdown(db, ctx(), filter);
    reply.type("text/html").send(renderDashboard(rows, { ...filter, options: filterOptions(db), totals: totals(rows) }));
  });

  app.get("/sessions", async (req, reply) => {
    if (!viewOk(req, reply)) return denyView(req, reply, true);
    const filter = viewFilter(req.query || {});
    const rows = sessionBreakdown(db, ctx(), filter);
    reply.type("text/html").send(renderSessions(rows, { ...filter, options: filterOptions(db), totals: totals(rows) }));
  });

  app.get("/api/v1/summary", async (req, reply) => {
    if (!viewOk(req, reply)) return denyView(req, reply, false);
    const q = req.query || {};
    return summary(db, ctx(), q).map(publicRow);
  });

  app.get("/api/v1/summary.csv", async (req, reply) => {
    if (!viewOk(req, reply)) return denyView(req, reply, false);
    const rows = summary(db, ctx(), req.query || {}).map(publicRow);
    return sendCsv(reply, "usage.csv", rows);
  });

  app.get("/api/v1/breakdown.csv", async (req, reply) => {
    if (!viewOk(req, reply)) return denyView(req, reply, false);
    const rows = breakdown(db, ctx(), req.query || {}).map((r) => ({
      member: r.member_label,
      email: r.member_email || "",
      hostname: r.hostname,
      project: r.project,
      repo: r.repoShort,
      date: r.date,
      plan: r.plan,
      requests: r.requests,
      ...tokenCols(r),
    }));
    return sendCsv(reply, "usage-breakdown.csv", rows);
  });

  app.get("/api/v1/sessions.csv", async (req, reply) => {
    if (!viewOk(req, reply)) return denyView(req, reply, false);
    const rows = sessionBreakdown(db, ctx(), req.query || {}).map((r) => ({
      session_id: r.session_id,
      tool: r.tool,
      member: r.member_label,
      email: r.member_email || "",
      hostname: r.hostname,
      project: r.project,
      repo: r.repoShort,
      plan: r.plan,
      first_ts: r.first_ts || "",
      last_ts: r.last_ts || "",
      requests: r.requests,
      ...tokenCols(r),
    }));
    return sendCsv(reply, "usage-sessions.csv", rows);
  });

  // ---- team (PM) ----------------------------------------------------------
  function teamQuery(q) {
    const g = TEAM_GROUPS[q.groupBy] ? q.groupBy : "member";
    let { from, to } = q;
    if (!from && !to) {
      const t = todayLocal();
      from = t.slice(0, 8) + "01";
      to = t;
    }
    return { from, to, groupBy: g };
  }

  app.get("/team", async (req, reply) => {
    const q = req.query || {};
    const team = teamFromKey(q.k);
    if (!team) return reply.code(q.k ? 403 : 401).type("text/html").send(renderTeamDenied(!!q.k));
    const tq = teamQuery(q);
    const rows = aggregate(db, ctx(), { from: tq.from, to: tq.to, team: team.team_id }, TEAM_GROUPS[tq.groupBy].dims);
    const memberCount = db.prepare("SELECT COUNT(*) AS c FROM team_member WHERE team_id = ?").get(team.team_id).c;
    const projects = db.prepare("SELECT project FROM team_project WHERE team_id = ? ORDER BY project").all(team.team_id).map((r) => r.project);
    reply.type("text/html").send(renderTeam(team, rows, { ...tq, k: q.k, totals: totals(rows), memberCount, projects }));
  });

  app.get("/api/v1/team/export.csv", async (req, reply) => {
    const q = req.query || {};
    const team = teamFromKey(q.k);
    if (!team) return reply.code(q.k ? 403 : 401).send({ error: "team key required" });
    const tq = teamQuery(q);
    const dims = TEAM_GROUPS[tq.groupBy].dims;
    const rows = aggregate(db, ctx(), { from: tq.from, to: tq.to, team: team.team_id }, dims).map((r) => ({
      team: team.name,
      from: tq.from || "",
      to: tq.to || "",
      ...(dims.includes("date") ? { date: r.date } : {}),
      ...(dims.includes("month") ? { month: r.month } : {}),
      ...(dims.includes("member") ? { member: r.member_label, email: r.member_email || "" } : {}),
      ...(dims.includes("project") ? { project: r.project } : {}),
      ...(dims.includes("model") ? { model: r.model_name } : {}),
      plan: r.plan,
      requests: r.requests,
      ...tokenCols(r),
    }));
    const safeName = String(team.name).replace(/[^A-Za-z0-9_.-]+/g, "_");
    return sendCsv(reply, `team-${safeName}-${tq.from || "all"}_${tq.to || "all"}.csv`, rows);
  });

  // ---- admin --------------------------------------------------------------
  function adminRedirect(req, reply, tab, status) {
    const qs = new URLSearchParams();
    if (adminKey) qs.set("key", suppliedAdminKey(req));
    qs.set("tab", tab);
    for (const [k, v] of Object.entries(status || {})) if (v != null) qs.set(k, String(v));
    reply.code(303).header("location", "/admin?" + qs.toString());
    return reply.send();
  }
  function adminAction(path, tab, fn) {
    app.post(path, async (req, reply) => {
      if (!adminOk(req)) return reply.code(401).send({ error: "bad admin key" });
      try {
        const extra = fn(req.body || {}) || {};
        return adminRedirect(req, reply, tab, { ok: extra.ok || "Đã lưu.", ...extra.params });
      } catch (e) {
        return adminRedirect(req, reply, tab, { err: e.message });
      }
    });
  }

  app.get("/admin", async (req, reply) => {
    if (!adminOk(req)) return reply.type("text/html").send(renderKeyPrompt());
    const q = req.query || {};
    const c = ctx();
    reply.type("text/html").send(
      renderAdmin({
        tab: q.tab || "pricing",
        adminKey: adminKey ? q.key || "" : "",
        banner: q.err ? { kind: "err", text: q.err } : q.ok ? { kind: "ok", text: q.ok } : null,
        newTeamKey: q.newKey || "",
        newTeamKeyFor: q.team || "",
        pricingRows: pricing.listPricing(db),
        globals: pricing.listGlobals(db),
        unpriced: pricing.unpricedModels(db, c),
        members: listMembers(db),
        teams: listTeams(db),
        projects: filterOptions(db).projects,
      }),
    );
  });

  adminAction("/admin/pricing", "pricing", (b) => {
    pricing.upsertPricing(db, b, "admin");
    return { ok: `Đã lưu giá ${b.model_prefix}${b.effective_from ? " từ " + b.effective_from : ""}.` };
  });
  adminAction("/admin/pricing/delete", "pricing", (b) => {
    pricing.deletePricing(db, b.model_prefix, b.effective_from);
    return { ok: `Đã xoá giá ${b.model_prefix}.` };
  });
  adminAction("/admin/globals", "pricing", (b) => {
    for (const k of ["webSearchPer1k", "inferenceGeoUsMultiplier"]) if (b[k] !== undefined && b[k] !== "") pricing.setGlobal(db, k, b[k]);
    return { ok: "Đã lưu tham số chung." };
  });

  adminAction("/admin/members/update", "members", (b) => {
    const id = Number(b.member_id);
    if (!id) throw new Error("member_id không hợp lệ");
    const email = String(b.email || "").trim().toLowerCase() || null;
    if (email && db.prepare("SELECT 1 FROM member WHERE email = ? AND member_id <> ?").get(email, id)) {
      throw new Error(`Email ${email} đã thuộc member khác — dùng "Gộp vào" thay vì sửa email.`);
    }
    db.prepare("UPDATE member SET display_name = ?, email = ? WHERE member_id = ?").run(String(b.display_name || ""), email, id);
    return { ok: "Đã lưu member." };
  });
  adminAction("/admin/members/merge", "members", (b) => {
    const from = Number(b.from_id);
    const into = Number(b.into_id);
    if (!from || !into || from === into) throw new Error("Chọn hai member khác nhau để gộp.");
    const run = db.transaction(() => {
      db.prepare("UPDATE member_alias SET member_id = ? WHERE member_id = ?").run(into, from);
      db.prepare("INSERT OR IGNORE INTO team_member (team_id, member_id) SELECT team_id, ? FROM team_member WHERE member_id = ?").run(into, from);
      db.prepare("DELETE FROM team_member WHERE member_id = ?").run(from);
      const src = db.prepare("SELECT * FROM member WHERE member_id = ?").get(from);
      db.prepare("DELETE FROM member WHERE member_id = ?").run(from);
      const dst = db.prepare("SELECT * FROM member WHERE member_id = ?").get(into);
      if (src && dst && !dst.email && src.email) db.prepare("UPDATE member SET email = ? WHERE member_id = ?").run(src.email, into);
      if (src && dst && !dst.display_name && src.display_name) db.prepare("UPDATE member SET display_name = ? WHERE member_id = ?").run(src.display_name, into);
    });
    run();
    return { ok: "Đã gộp member." };
  });

  adminAction("/admin/teams/create", "teams", (b) => {
    const name = String(b.name || "").trim();
    if (!name) throw new Error("Tên team là bắt buộc.");
    if (db.prepare("SELECT 1 FROM team WHERE name = ?").get(name)) throw new Error(`Team "${name}" đã có.`);
    const key = crypto.randomBytes(18).toString("base64url");
    db.prepare("INSERT INTO team (name, key_hash, created_at) VALUES (?, ?, ?)").run(name, sha256(key), new Date().toISOString());
    return { ok: `Đã tạo team ${name}.`, params: { newKey: key, team: name } };
  });
  adminAction("/admin/teams/update", "teams", (b) => {
    const id = Number(b.team_id);
    if (!db.prepare("SELECT 1 FROM team WHERE team_id = ?").get(id)) throw new Error("Không thấy team.");
    const members = [].concat(b.member_ids || []).map(Number).filter(Boolean);
    const projects = String(b.projects || "")
      .split(/[\n,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    const run = db.transaction(() => {
      db.prepare("DELETE FROM team_member WHERE team_id = ?").run(id);
      for (const m of members) db.prepare("INSERT OR IGNORE INTO team_member (team_id, member_id) VALUES (?, ?)").run(id, m);
      db.prepare("DELETE FROM team_project WHERE team_id = ?").run(id);
      for (const p of projects) db.prepare("INSERT OR IGNORE INTO team_project (team_id, project) VALUES (?, ?)").run(id, p);
      if (b.name && String(b.name).trim()) db.prepare("UPDATE team SET name = ? WHERE team_id = ?").run(String(b.name).trim(), id);
    });
    run();
    return { ok: "Đã lưu team." };
  });
  adminAction("/admin/teams/rekey", "teams", (b) => {
    const t = db.prepare("SELECT * FROM team WHERE team_id = ?").get(Number(b.team_id));
    if (!t) throw new Error("Không thấy team.");
    const key = crypto.randomBytes(18).toString("base64url");
    db.prepare("UPDATE team SET key_hash = ? WHERE team_id = ?").run(sha256(key), t.team_id);
    return { ok: `Đã tạo key mới cho team ${t.name} — link cũ hết hiệu lực.`, params: { newKey: key, team: t.name } };
  });
  adminAction("/admin/teams/delete", "teams", (b) => {
    const id = Number(b.team_id);
    db.prepare("DELETE FROM team_member WHERE team_id = ?").run(id);
    db.prepare("DELETE FROM team_project WHERE team_id = ?").run(id);
    db.prepare("DELETE FROM team WHERE team_id = ?").run(id);
    return { ok: "Đã xoá team." };
  });

  return app;
}

function listMembers(db) {
  const members = db
    .prepare(
      `SELECT m.member_id, m.email, m.display_name,
              (SELECT group_concat(member_key, ' | ') FROM member_alias a WHERE a.member_id = m.member_id) AS keys,
              (SELECT MAX(last_seen) FROM member_alias a WHERE a.member_id = m.member_id) AS last_seen,
              (SELECT group_concat(t.name, ', ') FROM team_member tm JOIN team t ON t.team_id = tm.team_id WHERE tm.member_id = m.member_id) AS teams
       FROM member m ORDER BY COALESCE(NULLIF(m.display_name, ''), m.email, keys)`,
    )
    .all();
  return members;
}

function listTeams(db) {
  return db
    .prepare("SELECT * FROM team ORDER BY name")
    .all()
    .map((t) => ({
      ...t,
      member_ids: db.prepare("SELECT member_id FROM team_member WHERE team_id = ?").all(t.team_id).map((r) => r.member_id),
      projects: db.prepare("SELECT project FROM team_project WHERE team_id = ? ORDER BY project").all(t.team_id).map((r) => r.project),
    }));
}

/** Token columns + cost for CSV. Cost is blank for subscription-only rows. */
function tokenCols(r) {
  return {
    input: r.input,
    output: r.output,
    cache_read: r.cache_read,
    cache_write_5m: r.cache_write_5m,
    cache_write_1h: r.cache_write_1h,
    web_search: r.web_search,
    tokens: r.tokens,
    subscription_tokens: r.sub_tokens,
    apikey_tokens: r.api_tokens,
    cost_usd_apikey: r.cost == null ? "" : r.cost,
  };
}

/** JSON summary row without internal fields. */
function publicRow(r) {
  const { legacy_rows, ...rest } = r;
  return rest;
}

function todayLocal() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** CSV with a UTF-8 BOM so Excel opens Vietnamese/Japanese text correctly. */
function sendCsv(reply, filename, rows) {
  reply.type("text/csv; charset=utf-8").header("content-disposition", `attachment; filename="${filename}"`);
  return "﻿" + toCsv(rows);
}

function toCsv(rows) {
  if (!rows.length) return "";
  const cols = Object.keys(rows[0]);
  const cell = (v) => {
    const s = String(v == null ? "" : v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [cols.join(",")];
  for (const r of rows) lines.push(cols.map((c) => cell(r[c])).join(","));
  return lines.join("\r\n");
}

module.exports = { buildApp, SECRET_RE, sha256 };
