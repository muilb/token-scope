import { test } from "node:test";
import assert from "node:assert/strict";
import { CursorStore, KeyValueStore, Cursor } from "./cursor";
import { Delta, BuildCtx } from "./deltas";
import { decide, plan, toWire, advanceCursor, tick, PushConfig, Poster } from "./pusher";

// In-memory Memento stand-in.
function memStore(): KeyValueStore & { data: Record<string, unknown> } {
  const data: Record<string, unknown> = {};
  return {
    data,
    get<T>(k: string, d: T): T {
      return (k in data ? (data[k] as T) : d);
    },
    async update(k: string, v: unknown) {
      data[k] = v;
    },
  };
}

function delta(over: Partial<Delta> = {}): Delta {
  return {
    sessionId: "claude:s1",
    tool: "claude",
    seq: 1,
    eventTsFrom: "2026-06-26T10:00:00Z",
    eventTsTo: "2026-06-26T10:45:00Z",
    date: "2026-06-26",
    auth: { authType: "apikey", confidence: "confirmed", orgShort: "a1b2" },
    project: "SunStory-BTA",
    repo: "d:/Work/Projects/21.SunStory/BTA_Source",
    model: "claude-opus-4-8",
    tokens: { input: 100, output: 50, cacheRead: 10, cacheWrite: 5 },
    costEstimate: 0.12,
    _nextByteOffset: 2048,
    _authMtime: 111,
    ...over,
  };
}

const ctx: BuildCtx = {
  identity: {
    claude: { authType: "apikey", orgShort: "a1b2" },
    codex: { authType: "unknown" },
    osUser: "lb_mui",
  },
  projectMap: {},
  authMtimes: { claude: 111, codex: 0 },
};
const cfg: PushConfig = { url: "http://srv", ingestKey: "k", osUser: "lb_mui", hostname: "PC-A" };

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------
test("decide: apikey+confirmed pushes", () => {
  assert.equal(decide(delta()), "push");
});
test("decide: oauth drops", () => {
  assert.equal(decide(delta({ auth: { authType: "oauth", confidence: "confirmed" } })), "drop");
});
test("decide: chatgpt drops", () => {
  assert.equal(decide(delta({ tool: "codex", auth: { authType: "chatgpt", confidence: "confirmed" } })), "drop");
});
test("decide: unknown holds (transient mid-refresh) — never dropped/skipped", () => {
  // Neither production nor TEMP mode may drop an unknown-auth delta: dropping
  // advances the cursor and loses the tokens forever. Hold + retry instead.
  assert.equal(decide(delta({ auth: { authType: "unknown", confidence: "confirmed" } })), "hold");
  assert.equal(decide(delta({ auth: { authType: "unknown", confidence: "confirmed" } }), true), "hold");
});
test("decide: uncertain holds even if apikey", () => {
  assert.equal(decide(delta({ auth: { authType: "apikey", confidence: "uncertain" } })), "hold");
});

test("plan splits by decision", () => {
  const r = plan([
    delta(),
    delta({ sessionId: "s2", auth: { authType: "oauth", confidence: "confirmed" } }),
    delta({ sessionId: "s3", auth: { authType: "apikey", confidence: "uncertain" } }),
  ]);
  assert.equal(r.toPush.length, 1);
  assert.equal(r.toDropAdvance.length, 1);
  assert.equal(r.held.length, 1);
});

// ---------------------------------------------------------------------------
// Wire shape — no internal fields, no secret
// ---------------------------------------------------------------------------
test("toWire drops internal _ fields", () => {
  const w = toWire(delta()) as any;
  assert.equal(w._nextByteOffset, undefined);
  assert.equal(w._authMtime, undefined);
  assert.equal(w.project, "SunStory-BTA");
});

// ---------------------------------------------------------------------------
// tick — advance only on 2xx
// ---------------------------------------------------------------------------
function okPoster(): { p: Poster; calls: number } {
  const box: { p: Poster; calls: number } = { calls: 0, p: null as any };
  box.p = async () => {
    box.calls++;
    return { ok: true, status: 200 };
  };
  return box;
}
function failPoster(): Poster {
  return async () => ({ ok: false, status: 503 });
}

test("tick: 2xx advances cursor (byte offset + seq)", async () => {
  const store = new CursorStore(memStore());
  const post = okPoster();
  const res = await tick(store, ctx, cfg, post.p, () => [delta()]);
  assert.equal(res.pushed, 1);
  assert.equal(post.calls, 1);
  const c = store.get("claude", "claude:s1")!;
  assert.equal(c.lastByteOffset, 2048);
  assert.equal(c.lastSeq, 1);
});

test("tick: non-2xx does NOT advance push cursor (retry next tick)", async () => {
  const store = new CursorStore(memStore());
  const res = await tick(store, ctx, cfg, failPoster(), () => [delta()]);
  assert.equal(res.pushed, 0);
  assert.equal(res.error, "http_503");
  assert.equal(store.get("claude", "claude:s1"), undefined); // never set
});

test("tick: network throw is caught, cursor untouched", async () => {
  const store = new CursorStore(memStore());
  const throwing: Poster = async () => {
    throw Object.assign(new Error("down"), { code: "ECONNREFUSED" });
  };
  const res = await tick(store, ctx, cfg, throwing, () => [delta()]);
  assert.equal(res.pushed, 0);
  assert.match(res.error!, /^net_/);
});

test("tick: dropped (oauth) advances cursor even with server down", async () => {
  const store = new CursorStore(memStore());
  const oauth = delta({ auth: { authType: "oauth", confidence: "confirmed" } });
  // Force the production gate (apikey-only) so the TEMP push-non-apikey flag
  // doesn't change what this test asserts.
  const res = await tick(store, ctx, cfg, failPoster(), () => [oauth], false);
  assert.equal(res.dropped, 1);
  assert.equal(res.pushed, 0);
  assert.equal(store.get("claude", "claude:s1")!.lastByteOffset, 2048); // advanced
});

test("tick: uncertain is held — cursor NOT advanced", async () => {
  const store = new CursorStore(memStore());
  const unc = delta({ auth: { authType: "apikey", confidence: "uncertain" } });
  const res = await tick(store, ctx, cfg, okPoster().p, () => [unc]);
  assert.equal(res.held, 1);
  assert.equal(res.pushed, 0);
  assert.equal(store.get("claude", "claude:s1"), undefined); // held, not advanced
});

test("tick: refuses to send payload containing a secret", async () => {
  const store = new CursorStore(memStore());
  const bad = delta({ repo: "sk-proj-ABCDEFG1234567890abcdefghijklmnop" });
  const post = okPoster();
  const res = await tick(store, ctx, cfg, post.p, () => [bad]);
  assert.equal(res.error, "secret_in_payload");
  assert.equal(post.calls, 0); // never posted
  assert.equal(store.get("claude", "claude:s1"), undefined);
});

test("tick: persists cursor via flush (survives reload = resume)", async () => {
  const mem = memStore();
  const store = new CursorStore(mem);
  await tick(store, ctx, cfg, okPoster().p, () => [delta()]);
  // Simulate extension restart: new store reads same backing memento.
  const store2 = new CursorStore(mem);
  const c = store2.get("claude", "claude:s1")!;
  assert.equal(c.lastByteOffset, 2048);
  assert.equal(c.lastSeq, 1);
});

test("tick: seq increments across ticks (no double-count key)", async () => {
  const store = new CursorStore(memStore());
  await tick(store, ctx, cfg, okPoster().p, () => [delta({ seq: 1 })]);
  await tick(store, ctx, cfg, okPoster().p, () => [delta({ seq: 2, _nextByteOffset: 4096 })]);
  const c = store.get("claude", "claude:s1")!;
  assert.equal(c.lastSeq, 2);
  assert.equal(c.lastByteOffset, 4096);
});
