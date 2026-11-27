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

// ---------------------------------------------------------------------------
// 0.7: subscription account identity, settings-file keys, ChatGPT claims
// ---------------------------------------------------------------------------
test("claude: oauth carries the logged-in account (uuid, email, name) from ~/.claude.json", () => {
  const id = deriveClaude(
    {},
    { claudeAiOauth: { subscriptionType: "team", accessToken: FAKE_ANTHROPIC_TOKEN, refreshToken: FAKE_ANTHROPIC_TOKEN } },
    { accountUuid: "11111111-2222-3333-4444-555555555555", emailAddress: "dev1@example.com", displayName: "Dev One", organizationUuid: "a1b2c3d4-5678-90ab-cdef-1234567890ab", seatTier: "standard" },
  );
  assert.equal(id.authType, "oauth");
  assert.equal(id.accountUuid, "11111111-2222-3333-4444-555555555555");
  assert.equal(id.email, "dev1@example.com");
  assert.equal(id.displayName, "Dev One");
  assert.equal(id.orgShort, "a1b2c3d4");
  assert.ok(!JSON.stringify(id).includes("sk-ant-"), "tokens never copied");
});

test("claude: API key set in ~/.claude/settings.json env counts as apikey (VS Code env may lack it)", () => {
  const id = deriveClaude({}, { claudeAiOauth: { subscriptionType: "max" } }, null, { env: { ANTHROPIC_API_KEY: FAKE_ANTHROPIC_TOKEN } });
  assert.equal(id.authType, "apikey");
  assert.equal(id.keySource, "settings");
  assert.equal(id.keyHash!.length, 8);
  assertNoSecret(id);
});

test("claude: apiKeyHelper counts as apikey, hashed by command", () => {
  const id = deriveClaude({}, null, null, { apiKeyHelper: "~/bin/get-key.sh" });
  assert.equal(id.authType, "apikey");
  assert.equal(id.keySource, "helper");
});

test("codex: chatgpt login exposes account id, email and plan from id_token claims only", () => {
  const claims = { email: "dev1@example.com", "https://api.openai.com/auth": { chatgpt_plan_type: "business", chatgpt_account_id: "acc-1" } };
  const jwt = "eyJhbGciOiJub25lIn0." + Buffer.from(JSON.stringify(claims)).toString("base64url") + ".sig";
  const id = deriveCodex({ auth_mode: "chatgpt", tokens: { id_token: jwt, access_token: "secret-access" } });
  assert.equal(id.authType, "chatgpt");
  assert.equal(id.email, "dev1@example.com");
  assert.equal(id.plan, "business");
  assert.equal(id.accountId, "acc-1");
  assert.ok(!JSON.stringify(id).includes("secret-access"));
});