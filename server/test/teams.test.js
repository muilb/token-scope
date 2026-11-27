"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { freshApp, v2Payload, bucket, post } = require("./helpers");

const CT = { "content-type": "application/x-www-form-urlencoded" };

async function seed(app) {
  await post(
    app,
    v2Payload([
      bucket({ sessionId: "a1", project: "alpha", date: "2026-11-20" }),
      bucket({ sessionId: "a2", project: "beta", date: "2026-11-21", auth: { authType: "apikey", plan: "apikey" } }),
      bucket({ sessionId: "b1", project: "alpha", member: { key: "acct:uuid-2", email: "dev2@example.com", displayName: "Dev Two" } }),
      bucket({ sessionId: "c1", project: "gamma", member: { key: "acct:uuid-3", email: "dev3@example.com", displayName: "Dev Three" } }),
    ]),
  );
}

function memberId(db, email) {
  return db.prepare("SELECT member_id FROM member WHERE email = ?").get(email).member_id;
}

async function createTeam(app, name) {
  const res = await app.inject({ method: "POST", url: "/admin/teams/create", payload: `name=${encodeURIComponent(name)}`, headers: CT });
  assert.equal(res.statusCode, 303);
  const loc = new URL(res.headers.location, "http://x");
  return loc.searchParams.get("newKey");
}

async function setTeam(app, db, teamName, emails, projects = "") {
  const id = db.prepare("SELECT team_id FROM team WHERE name = ?").get(teamName).team_id;
  const form = new URLSearchParams({ team_id: String(id), projects });
  for (const e of emails) form.append("member_ids", String(memberId(db, e)));
  const res = await app.inject({ method: "POST", url: "/admin/teams/update", payload: form.toString(), headers: CT });
  assert.equal(res.statusCode, 303);
  assert.ok(!res.headers.location.includes("err="), res.headers.location);
}

test("team link shows only that team's members, with tokens and API-key cost", async () => {
  const { app, db } = freshApp();
  await seed(app);
  const k = await createTeam(app, "Alpha team");
  assert.ok(k && k.length >= 20);
  await setTeam(app, db, "Alpha team", ["dev1@example.com", "dev2@example.com"]);
  const html = (await app.inject({ method: "GET", url: `/team?k=${k}&from=2026-11-01&to=2026-11-30` })).body;
  assert.match(html, /Dev One/);
  assert.match(html, /Dev Two/);
  assert.ok(!html.includes("Dev Three"));
  assert.match(html, /\$0\.04/); // dev1's API-key bucket (0.0384)
});

test("team restricted to projects only counts those projects", async () => {
  const { app, db } = freshApp();
  await seed(app);
  const k = await createTeam(app, "Alpha only");
  await setTeam(app, db, "Alpha only", ["dev1@example.com", "dev2@example.com"], "alpha");
  const res = await app.inject({ method: "GET", url: `/api/v1/team/export.csv?k=${k}&from=2026-11-01&to=2026-11-30&groupBy=project` });
  assert.equal(res.statusCode, 200);
  assert.ok(res.body.startsWith("﻿"));
  const lines = res.body.slice(1).split("\r\n");
  assert.equal(lines.length, 2); // header + alpha
  assert.match(lines[0], /^team,from,to,project,plan,requests,input,output,cache_read,cache_write_5m,cache_write_1h,web_search,tokens,/);
  assert.match(lines[1], /^Alpha only,2026-11-01,2026-11-30,alpha,team,/);
});

test("CSV export by member × day has one row per member per day", async () => {
  const { app, db } = freshApp();
  await seed(app);
  const k = await createTeam(app, "T");
  await setTeam(app, db, "T", ["dev1@example.com"]);
  const res = await app.inject({ method: "GET", url: `/api/v1/team/export.csv?k=${k}&from=2026-11-01&to=2026-11-30&groupBy=member-day` });
  const lines = res.body.slice(1).split("\r\n");
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^team,from,to,date,member,email,/);
});

test("wrong team key → 403, no key → 401; rekey invalidates the old link", async () => {
  const { app, db } = freshApp();
  await seed(app);
  assert.equal((await app.inject({ method: "GET", url: "/team" })).statusCode, 401);
  assert.equal((await app.inject({ method: "GET", url: "/team?k=nope" })).statusCode, 403);
  const k = await createTeam(app, "R");
  assert.equal((await app.inject({ method: "GET", url: `/team?k=${k}` })).statusCode, 200);
  const id = db.prepare("SELECT team_id FROM team WHERE name = 'R'").get().team_id;
  const res = await app.inject({ method: "POST", url: "/admin/teams/rekey", payload: `team_id=${id}`, headers: CT });
  const k2 = new URL(res.headers.location, "http://x").searchParams.get("newKey");
  assert.notEqual(k2, k);
  assert.equal((await app.inject({ method: "GET", url: `/team?k=${k}` })).statusCode, 403);
  assert.equal((await app.inject({ method: "GET", url: `/team?k=${k2}` })).statusCode, 200);
});

test("a team key does not open the company-wide dashboard or admin", async () => {
  const { app } = freshApp({ adminKey: "adm", viewKey: "view" });
  await seed(app);
  const res = await app.inject({ method: "POST", url: "/admin/teams/create", payload: "name=X&key=adm", headers: CT });
  const k = new URL(res.headers.location, "http://x").searchParams.get("newKey");
  assert.equal((await app.inject({ method: "GET", url: `/?vk=${k}` })).statusCode, 401);
  assert.match((await app.inject({ method: "GET", url: `/admin?key=${k}` })).body, /Nhập ADMIN_KEY/);
  assert.equal((await app.inject({ method: "GET", url: `/team?k=${k}` })).statusCode, 200);
});

test("team keys are stored hashed only", async () => {
  const { app, db } = freshApp();
  const k = await createTeam(app, "H");
  const row = db.prepare("SELECT key_hash FROM team WHERE name = 'H'").get();
  assert.notEqual(row.key_hash, k);
  assert.equal(row.key_hash.length, 64);
});

test("merging two members moves identities and team membership", async () => {
  const { app, db } = freshApp();
  await seed(app);
  await createTeam(app, "M");
  await setTeam(app, db, "M", ["dev3@example.com"]);
  const from = memberId(db, "dev3@example.com");
  const into = memberId(db, "dev1@example.com");
  const res = await app.inject({ method: "POST", url: "/admin/members/merge", payload: `from_id=${from}&into_id=${into}`, headers: CT });
  assert.equal(res.statusCode, 303);
  assert.equal(db.prepare("SELECT member_id FROM member_alias WHERE member_key = 'acct:uuid-3'").get().member_id, into);
  assert.ok(db.prepare("SELECT 1 FROM team_member WHERE member_id = ?").get(into));
  const rows = (await app.inject({ method: "GET", url: "/api/v1/summary?groupBy=member&all=1" })).json();
  assert.equal(rows.length, 2);
});
