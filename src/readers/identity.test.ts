import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveClaude, deriveCodex } from "./identity";
import { resolveProject } from "../identity/projectMap";

// A real-looking secret we must never see leak into derived output.
const FAKE_OPENAI_KEY = "sk-proj-ABCDEFG1234567890abcdefghijklmnopqrstuvwxyz";
const FAKE_ANTHROPIC_TOKEN = "sk-ant-oat01-SECRETSECRETSECRETSECRETSECRET";

// Regex that would catch a leaked full key/token in serialized output.
const SECRET_RE = /sk-ant-|sk-proj-[A-Za-z0-9]{20,}|[A-Za-z0-9_-]{40,}/;

function assertNoSecret(obj: unknown): void {
  const s = JSON.stringify(obj);
  assert.ok(!SECRET_RE.test(s), `output leaked a secret: ${s}`);
}

// ---------------------------------------------------------------------------
// Claude
// ---------------------------------------------------------------------------
test("claude: oauth from credential file", () => {
  const id = deriveClaude(
    {},
    {
      organizationUuid: "a1b2c3d4-5678-90ab-cdef-1234567890ab",
      claudeAiOauth: { subscriptionType: "pro", rateLimitTier: "default_claude_ai" },
    },
  );
  assert.equal(id.authType, "oauth");
  assert.equal(id.subscriptionType, "pro");
  assert.equal(id.orgShort, "a1b2c3d4");
  assertNoSecret(id);
});

test("claude: env api key overrides oauth file", () => {
  const id = deriveClaude(
    { ANTHROPIC_API_KEY: FAKE_ANTHROPIC_TOKEN },
    { claudeAiOauth: { subscriptionType: "pro" } },
  );
  assert.equal(id.authType, "apikey");
  assert.equal(id.subscriptionType, undefined); // must not read oauth block
  assert.match(id.keyHash ?? "", /^[0-9a-f]{8}$/); // hashed env key, maps to a member
  assertNoSecret(id);
});

test("claude: proxy flag when ANTHROPIC_BASE_URL set with apikey", () => {
  const id = deriveClaude(
    { ANTHROPIC_AUTH_TOKEN: FAKE_ANTHROPIC_TOKEN, ANTHROPIC_BASE_URL: "http://gw.local" },
    null,
  );
  assert.equal(id.authType, "apikey");
  assert.equal(id.proxy, true);
  assertNoSecret(id);
});

test("claude: unknown when no env key and no file", () => {
  const id = deriveClaude({}, null);
  assert.equal(id.authType, "unknown");
  assertNoSecret(id);
});

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------
test("codex: apikey yields fingerprint + hash, never full key", () => {
  const id = deriveCodex({ auth_mode: "apikey", OPENAI_API_KEY: FAKE_OPENAI_KEY });
  assert.equal(id.authType, "apikey");
  assert.ok(id.keyFingerprint && id.keyFingerprint.length <= 8);
  assert.match(id.keyHash ?? "", /^[0-9a-f]{8}$/);
  assert.ok(!(id.keyFingerprint ?? "").includes("wxyz")); // not the tail of the key
  assertNoSecret(id);
});

test("codex: chatgpt login has no key fingerprint", () => {
  const id = deriveCodex({ auth_mode: "chatgpt", tokens: { access: "x" } });
  assert.equal(id.authType, "chatgpt");
  assert.equal(id.keyFingerprint, undefined);
  assertNoSecret(id);
});

test("codex: unknown when file absent", () => {
  const id = deriveCodex(null);
  assert.equal(id.authType, "unknown");
  assertNoSecret(id);
});

test("codex: keyHash stable for same key", () => {
  const a = deriveCodex({ auth_mode: "apikey", OPENAI_API_KEY: FAKE_OPENAI_KEY });
  const b = deriveCodex({ auth_mode: "apikey", OPENAI_API_KEY: FAKE_OPENAI_KEY });
  assert.equal(a.keyHash, b.keyHash);
});

// ---------------------------------------------------------------------------
// Project resolver
// ---------------------------------------------------------------------------
test("resolveProject: cwd exact match wins", () => {
  const map = { "d:/Work/Projects/21.SunStory/BTA_Source": "SunStory-BTA" };
  assert.equal(
    resolveProject("d:\\Work\\Projects\\21.SunStory\\BTA_Source", undefined, map),
    "SunStory-BTA",
  );
});

test("resolveProject: falls back to keyHash", () => {
  const map = { "key:3f9a1c22": "ProjectX-OpenAI" };
  assert.equal(resolveProject("d:/some/other/repo", "3f9a1c22", map), "ProjectX-OpenAI");
});

test("resolveProject: fallback to basename", () => {
  assert.equal(resolveProject("d:/Work/Projects/MyRepo", undefined, {}), "myrepo");
});
