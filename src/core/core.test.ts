import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { costOf } from "../pricing";
import { UsageStore } from "./usageStore";
import { parseClaudeLine } from "./usageRecord";
import { sessionSummaries, recordTier, recordCost } from "./aggregate";

const FIX = path.join(process.cwd(), "test", "fixtures");
const EXPECTED = JSON.parse(fs.readFileSync(path.join(FIX, "expected.json"), "utf8"));
const HOME = path.join(FIX, "home");

const close = (a: number, b: number, msg?: string) => assert.ok(Math.abs(a - b) < 1e-9, `${msg ?? ""} ${a} != ${b}`);

// ---------------------------------------------------------------------------
// Pricing v2 — shared hand-computed cases (the server runs the same file)
// ---------------------------------------------------------------------------
for (const c of EXPECTED.pricingCases) {
  test(`pricing: ${c.name}`, () => {
    close(costOf(c.tokens, c.model, c.opts), c.cost, c.name);
  });
}

// ---------------------------------------------------------------------------
// Store over the fixture logs
// ---------------------------------------------------------------------------
function fixtureStore(): UsageStore {
  const s = new UsageStore(path.join(HOME, ".claude"), path.join(HOME, ".codex"));
  s.refresh(EXPECTED.fixture.sinceDay);
  return s;
}

test("store: Claude sessions match hand-computed totals (subagent, dedup, max output, synthetic)", () => {
  const sums = sessionSummaries(fixtureStore().entries()).filter((x) => x.tool === "claude");
  const want = EXPECTED.fixture.claudeSessions;
  assert.equal(sums.length, Object.keys(want).length);
  for (const s of sums) {
    const w = want[s.sessionId];
    assert.ok(w, `unexpected session ${s.sessionId}`);
    assert.equal(s.totals.requests, w.requests, "requests");
    assert.equal(s.totals.tokens, w.tokens, "tokens");
    assert.equal(s.totals.output, w.output, "output (max of repeated lines)");
    assert.equal(s.subagentTokens, w.subagentTokens, "subagent tokens");
    close(s.totals.cost, w.cost, "cost");
  }
});

test("store: a request copied into a resumed session is counted once, in the original", () => {
  const a = fixtureStore()
    .entries()
    .filter((e) => e.rec.key === "msg_A:req_A");
  assert.equal(a.length, 1);
  assert.equal(a[0].file.sessionId, "aaaa1111-0000-4000-8000-000000000001");
});

test("store: subagent requests belong to the parent session", () => {
  const c = fixtureStore()
    .entries()
    .find((e) => e.rec.key === "msg_C:req_C")!;
  assert.equal(c.file.origin, "subagent");
  assert.equal(c.file.sessionId, "aaaa1111-0000-4000-8000-000000000001");
  assert.equal(recordTier(c.rec), "long"); // haiku-5-5, prompt 151K > 100K
});

test("store: Codex cumulative token_count → per-request records", () => {
  const sums = sessionSummaries(fixtureStore().entries()).filter((x) => x.tool === "codex");
  const w = EXPECTED.fixture.codexSession;
  assert.equal(sums.length, 1);
  assert.equal(sums[0].sessionId, w.id);
  assert.equal(sums[0].totals.requests, w.requests); // repeated totals ignored
  assert.equal(sums[0].totals.tokens, w.tokens); // = cumulative total_tokens
  close(sums[0].totals.cost, w.cost, "codex cost");
});

test("store: fast-mode request is priced at the fast multiplier", () => {
  const d = fixtureStore()
    .entries()
    .find((e) => e.rec.key === "msg_D:req_D")!;
  assert.equal(d.rec.speed, "fast");
  close(recordCost(d.rec), 0.00324);
});

// ---------------------------------------------------------------------------
// Incremental reading
// ---------------------------------------------------------------------------
function tmpHome(): { home: string; file: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tokenscope-core-"));
  const dir = path.join(home, ".claude", "projects", "d--x");
  fs.mkdirSync(dir, { recursive: true });
  return { home, file: path.join(dir, "s1.jsonl") };
}

function line(out: number, ts = "2026-11-20T05:00:00.000Z"): string {
  return JSON.stringify({
    type: "assistant",
    timestamp: ts,
    requestId: "r1",
    message: { id: "m1", model: "claude-opus-5-5", usage: { input_tokens: 1, output_tokens: out, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
  });
}

test("incremental: a half-written last line is read once complete, not lost", () => {
  const { home, file } = tmpHome();
  const full = line(10);
  fs.writeFileSync(file, full.slice(0, 40));
  const s = new UsageStore(path.join(home, ".claude"), path.join(home, ".codex"), { codex: false });
  s.refresh("2026-11-01");
  assert.equal(s.entries().length, 0);
  fs.appendFileSync(file, full.slice(40) + "\n");
  s.refresh("2026-11-01");
  assert.equal(s.entries().length, 1);
  assert.equal(s.entries()[0].rec.output, 10);
});

test("incremental: a later line of the same request with more output updates the record", () => {
  const { home, file } = tmpHome();
  fs.writeFileSync(file, line(16) + "\n");
  const s = new UsageStore(path.join(home, ".claude"), path.join(home, ".codex"), { codex: false });
  s.refresh("2026-11-01");
  assert.equal(s.entries()[0].rec.output, 16);
  fs.appendFileSync(file, line(488, "2026-11-20T05:00:09.000Z") + "\n");
  assert.equal(s.refresh("2026-11-01"), true);
  assert.equal(s.entries().length, 1);
  assert.equal(s.entries()[0].rec.output, 488);
  assert.equal(s.entries()[0].rec.ts, "2026-11-20T05:00:00.000Z"); // first occurrence kept
});

test("incremental: unchanged file → refresh reports no change", () => {
  const { home, file } = tmpHome();
  fs.writeFileSync(file, line(5) + "\n");
  const s = new UsageStore(path.join(home, ".claude"), path.join(home, ".codex"), { codex: false });
  assert.equal(s.refresh("2026-11-01"), true);
  assert.equal(s.refresh("2026-11-01"), false);
});

test("window: moving the window forward drops older days", () => {
  const { home, file } = tmpHome();
  fs.writeFileSync(file, line(5, "2026-11-10T05:00:00.000Z").replace(/"m1"/, '"m0"') + "\n" + line(7) + "\n");
  const s = new UsageStore(path.join(home, ".claude"), path.join(home, ".codex"), { codex: false });
  s.refresh("2026-11-01");
  assert.equal(s.entries().length, 2);
  s.refresh("2026-11-15");
  assert.equal(s.entries().length, 1);
});

// ---------------------------------------------------------------------------
// Line parsing
// ---------------------------------------------------------------------------
test("parse: no TTL split → cache write priced as 5-minute", () => {
  const r = parseClaudeLine({
    type: "assistant",
    timestamp: "2026-11-20T05:00:00Z",
    requestId: "r",
    message: { id: "m", model: "claude-sonnet-5", usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 300 } },
  })!;
  assert.equal(r.cacheWrite5m, 300);
  assert.equal(r.cacheWrite1h, 0);
});

test("parse: synthetic and usage-less lines are not requests", () => {
  assert.equal(parseClaudeLine({ type: "assistant", timestamp: "2026-11-20T05:00:00Z", requestId: "r", message: { id: "m", model: "<synthetic>", usage: { input_tokens: 5 } } }), null);
  assert.equal(parseClaudeLine({ type: "assistant", timestamp: "2026-11-20T05:00:00Z", message: { id: "m" } }), null);
  assert.equal(parseClaudeLine({ type: "user", timestamp: "2026-11-20T05:00:00Z" }), null);
});
