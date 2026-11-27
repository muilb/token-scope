import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "path";
import { UsageStore, Entry } from "../core/usageStore";
import { AccountIdentity } from "../readers/identity";
import { currentAuth, buildBuckets, updateStamps, StampMap, bucketKey, AuthResolver, fileCwd } from "./buckets";
import { tick, planPush, loadState, KeyValueStore, PushConfig, Poster, SECRET_RE, BATCH_SIZE } from "./pusher";

const HOME = path.join(process.cwd(), "test", "fixtures", "home");

function entries(): Entry[] {
  const s = new UsageStore(path.join(HOME, ".claude"), path.join(HOME, ".codex"));
  s.refresh("2026-11-01");
  return s.entries();
}

function mem(): KeyValueStore & { data: Record<string, unknown> } {
  const data: Record<string, unknown> = {};
  return {
    data,
    get<T>(k: string, d: T): T {
      return k in data ? (JSON.parse(JSON.stringify(data[k])) as T) : d;
    },
    async update(k: string, v: unknown) {
      data[k] = JSON.parse(JSON.stringify(v));
    },
  };
}

const ID_OAUTH: AccountIdentity = {
  claude: {
    authType: "oauth",
    subscriptionType: "team",
    accountUuid: "11111111-2222-3333-4444-555555555555",
    email: "dev1@example.com",
    displayName: "Dev One",
    orgId: "99999999-0000-0000-0000-000000000000",
  },
  codex: { authType: "chatgpt", accountId: "acc-1", email: "dev1@example.com", plan: "business" },
  osUser: "dev1",
};
const ID_APIKEY: AccountIdentity = {
  claude: { authType: "apikey", keyHash: "3f9a1c22" },
  codex: { authType: "apikey", keyHash: "aa00bb11" },
  osUser: "dev1",
};
const ID_UNKNOWN: AccountIdentity = { claude: { authType: "unknown" }, codex: { authType: "unknown" }, osUser: "dev1" };

function authNow(id: AccountIdentity, owner = ""): AuthResolver {
  return (tool) => currentAuth(tool, id, owner, "PC-A");
}

const cfg: PushConfig = { url: "http://srv", ingestKey: "k", osUser: "dev1", hostname: "PC-A" };
const NOW = "2026-11-20T06:05:00.000Z"; // within 15 min of the last fixture request → "confirmed"

function recorder(status = 200) {
  const calls: any[] = [];
  const post: Poster = async (_u, _h, body) => {
    calls.push(JSON.parse(body));
    return { ok: status < 300, status };
  };
  return { calls, post };
}

function input(id: AccountIdentity, extra: Partial<{ entries: Entry[]; nowIso: string; owner: string }> = {}) {
  return {
    entries: extra.entries ?? entries(),
    windowStart: "2026-11-01",
    authFor: authNow(id, extra.owner),
    projectMap: {},
    nowIso: extra.nowIso ?? NOW,
  };
}

// ---------------------------------------------------------------------------
// Identity → member key
// ---------------------------------------------------------------------------
test("subscription (OAuth) usage is attributed to the Claude account, not the OS user", () => {
  const a = currentAuth("claude", ID_OAUTH, "", "PC-A")!;
  assert.equal(a.memberKey, "acct:11111111-2222-3333-4444-555555555555");
  assert.equal(a.email, "dev1@example.com");
  assert.equal(a.plan, "team");
  assert.equal(a.authType, "oauth");
});

test("API-key usage is attributed to the owner setting, else OS user @ host", () => {
  assert.equal(currentAuth("claude", ID_APIKEY, "Dev1@Example.com", "PC-A")!.memberKey, "owner:dev1@example.com");
  assert.equal(currentAuth("claude", ID_APIKEY, "", "PC-A")!.memberKey, "os:dev1@pc-a");
});

test("unknown auth (credentials mid-rewrite) → no identity → held", () => {
  assert.equal(currentAuth("claude", ID_UNKNOWN, "", "PC-A"), null);
});

test("auth is resolved per project directory: two projects, two API keys", () => {
  const stamps: StampMap = {};
  // Move session bbbb into a second project directory.
  const e = entries().map((x) =>
    x.file.sessionId.startsWith("bbbb") ? { ...x, file: { ...x.file, cwd: "D:\\Work\\other-app" } } : x,
  );
  const cwds = [...new Set(e.filter((x) => x.rec.tool === "claude").map((x) => fileCwd(x.file, "claude")))];
  assert.equal(cwds.length, 2);
  const keyOf = (cwd: string) => (cwd === "D:\\Work\\other-app" ? "bbbb2222" : "aaaa1111");
  const authFor: AuthResolver = (tool, cwd) =>
    tool === "codex" ? null : { memberKey: "owner:dev1@example.com", authType: "apikey", plan: "apikey", keyHash: keyOf(cwd) };
  updateStamps(stamps, e, authFor, NOW);
  const b = buildBuckets(e, { stamps, projectMap: {} });
  const hashes = new Set(b.filter((x) => x.tool === "claude").map((x) => x.auth.keyHash));
  assert.deepEqual([...hashes].sort(), ["aaaa1111", "bbbb2222"]);
  assert.ok(!b.some((x) => x.tool === "codex"), "codex unknown → held");
});

// ---------------------------------------------------------------------------
// Buckets
// ---------------------------------------------------------------------------
test("buckets: totals per session/day/model/origin; subagent kept apart", () => {
  const stamps: StampMap = {};
  const e = entries();
  updateStamps(stamps, e, authNow(ID_OAUTH), NOW);
  const b = buildBuckets(e, { stamps, projectMap: {} });
  const aaaa = b.filter((x) => x.sessionId.startsWith("aaaa"));
  assert.equal(aaaa.length, 3); // opus main, sonnet main, haiku subagent
  const sub = aaaa.find((x) => x.origin === "subagent")!;
  assert.equal(sub.model, "claude-haiku-5-5");
  assert.equal(sub.tier, "long");
  assert.equal(sub.tokens.cacheRead, 150000);
  const fast = b.find((x) => x.sessionId.startsWith("bbbb"))!;
  assert.equal(fast.speed, "fast");
  assert.equal(fast.member.key, "acct:11111111-2222-3333-4444-555555555555");
  assert.equal(fast.auth.plan, "team");
  const codex = b.find((x) => x.tool === "codex")!;
  assert.equal(codex.member.key, "oai:acc-1");
  assert.equal(codex.requests, 2);
});

test("buckets: long repo names are not mistaken for secrets", () => {
  assert.equal(SECRET_RE.test("D:/00.SSD/Reverse-Sdd-Source-Analysis-Pack_WCC_V06"), false);
  assert.equal(SECRET_RE.test("AI-Code-Review-Quality-Gate-Pack_WCC_V04-and-even-longer-name"), false);
  assert.equal(SECRET_RE.test("11111111-2222-3333-4444-555555555555"), false);
  assert.equal(SECRET_RE.test("sk-ant-api03-AAAAAAAAAAAAAAAA"), true);
  assert.equal(SECRET_RE.test("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig"), true);
});

// ---------------------------------------------------------------------------
// tick
// ---------------------------------------------------------------------------
test("tick: first run sends every bucket in the window (= backfill), OAuth included", async () => {
  const kv = mem();
  const r = recorder();
  const res = await tick(kv, input(ID_OAUTH), cfg, r.post);
  assert.equal(res.error, undefined);
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].schema, "usage.v2");
  assert.equal(res.pushed, r.calls[0].buckets.length);
  assert.ok(r.calls[0].buckets.every((b: any) => b.auth.authType === "oauth" || b.auth.authType === "chatgpt"));
});

test("tick: second run with no new usage sends nothing", async () => {
  const kv = mem();
  await tick(kv, input(ID_OAUTH), cfg, recorder().post);
  const r = recorder();
  const res = await tick(kv, input(ID_OAUTH), cfg, r.post);
  assert.equal(r.calls.length, 0);
  assert.equal(res.pushed, 0);
  assert.ok(res.unchanged > 0);
});

test("tick: non-2xx keeps nothing as pushed → resent next tick", async () => {
  const kv = mem();
  const bad = await tick(kv, input(ID_OAUTH), cfg, recorder(503).post);
  assert.equal(bad.error, "http_503");
  assert.equal(Object.keys(loadState(kv).pushed).length, 0);
  const r = recorder();
  await tick(kv, input(ID_OAUTH), cfg, r.post);
  assert.equal(r.calls.length, 1);
});

test("tick: unknown identity holds new sessions (nothing sent, nothing stamped)", async () => {
  const kv = mem();
  const r = recorder();
  const res = await tick(kv, input(ID_UNKNOWN), cfg, r.post);
  assert.equal(r.calls.length, 0);
  assert.ok(res.held > 0);
  assert.deepEqual(loadState(kv).stamps, {});
});

test("tick: stamp survives a later login switch — old requests keep the old account", async () => {
  const kv = mem();
  await tick(kv, input(ID_OAUTH), cfg, recorder().post);
  const r = recorder();
  await tick(kv, input(ID_APIKEY, { nowIso: "2026-11-20T07:00:00.000Z" }), cfg, r.post);
  // The fixture requests all predate the switch: nothing changes, nothing re-sent.
  assert.equal(r.calls.length, 0);
});

test("tick: sessions first seen long after their requests are flagged 'assumed'", async () => {
  const kv = mem();
  const r = recorder();
  await tick(kv, input(ID_OAUTH, { nowIso: "2026-11-27T00:00:00.000Z" }), cfg, r.post);
  assert.ok(r.calls[0].buckets.every((b: any) => b.auth.confidence === "assumed"));
});

test("tick: a bucket that disappears is sent once with zero totals", async () => {
  const kv = mem();
  const all = entries();
  await tick(kv, input(ID_OAUTH, { entries: all }), cfg, recorder().post);
  const withoutD = all.filter((e) => e.rec.key !== "msg_D:req_D");
  const r = recorder();
  await tick(kv, input(ID_OAUTH, { entries: withoutD }), cfg, r.post);
  assert.equal(r.calls.length, 1);
  const zeroed = r.calls[0].buckets;
  assert.equal(zeroed.length, 1);
  assert.equal(zeroed[0].sessionId, "bbbb2222-0000-4000-8000-000000000002");
  assert.equal(zeroed[0].requests, 0);
  assert.equal(zeroed[0].tokens.output, 0);
  const again = recorder();
  await tick(kv, input(ID_OAUTH, { entries: withoutD }), cfg, again.post);
  assert.equal(again.calls.length, 0); // not re-sent
});

test("planPush: buckets that merely aged out of the window are not zeroed", () => {
  const stamps: StampMap = {};
  const e = entries();
  updateStamps(stamps, e, authNow(ID_OAUTH), NOW);
  const b = buildBuckets(e, { stamps, projectMap: {} });
  const state = { pushed: Object.fromEntries(b.map((x) => [bucketKey(x), { hash: "x", bucket: x }])), stamps };
  const { send } = planPush(state, [], "2026-11-25");
  assert.equal(send.length, 0);
});

test("tick: large windows are sent in batches", async () => {
  // Synthesize many sessions from one fixture entry.
  const base = entries()[0];
  const many: Entry[] = [];
  for (let i = 0; i < BATCH_SIZE + 3; i++) {
    many.push({ rec: { ...base.rec, key: `k${i}` }, file: { ...base.file, sessionId: `s${i}` } });
  }
  const r = recorder();
  const res = await tick(mem(), input(ID_OAUTH, { entries: many }), cfg, r.post);
  assert.equal(r.calls.length, 2);
  assert.equal(res.pushed, BATCH_SIZE + 3);
});

test("auth info carried on the wire never includes a raw key", async () => {
  const r = recorder();
  await tick(mem(), input(ID_APIKEY), cfg, r.post);
  const body = JSON.stringify(r.calls);
  assert.ok(!SECRET_RE.test(body));
  const b = r.calls[0].buckets[0];
  assert.equal(b.auth.authType, "apikey");
  assert.equal(typeof b.auth.keyHash, "string");
  assert.equal(b.auth.keyHash.length, 8);
});
