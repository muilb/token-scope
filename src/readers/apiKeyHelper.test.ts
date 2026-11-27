import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { envVarFromHelper, findHelper, classifyHelper } from "./apiKeyHelper";
import { deriveClaudeForCwd } from "./identity";

const SECRET_RE = /sk-ant-|sk-proj-[A-Za-z0-9]{20,}|[A-Za-z0-9_-]{40,}/;
const FAKE_KEY = "sk-ant-api03-FAKEKEYFORTESTS-0000000000";

function assertNoSecret(obj: unknown): void {
  const s = JSON.stringify(obj);
  assert.ok(!SECRET_RE.test(s), `output leaked a secret: ${s}`);
}

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "apikeyhelper-"));
}

function writeSettings(dir: string, name: string, body: string): void {
  fs.mkdirSync(path.join(dir, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".claude", name), body);
}

// ---------------------------------------------------------------------------
// envVarFromHelper — the command is parsed, never executed
// ---------------------------------------------------------------------------
test("helper: powershell GetEnvironmentVariable, single quotes", () => {
  const cmd =
    "powershell -NoProfile -Command \"[Environment]::GetEnvironmentVariable('AIDD-ANTHROPIC_API_KEY','User')\"";
  assert.equal(envVarFromHelper(cmd), "AIDD-ANTHROPIC_API_KEY");
});

test("helper: powershell GetEnvironmentVariable, double quotes", () => {
  const cmd = '[System.Environment]::GetEnvironmentVariable("ANAC-ANTHROPIC_API_KEY", "User")';
  assert.equal(envVarFromHelper(cmd), "ANAC-ANTHROPIC_API_KEY");
});

test("helper: powershell $env: forms", () => {
  assert.equal(envVarFromHelper("echo $env:MY_KEY"), "MY_KEY");
  assert.equal(envVarFromHelper("Write-Output ${env:TMN-ANTHROPIC_API_KEY}"), "TMN-ANTHROPIC_API_KEY");
});

// This machine really does name its keys `0TMN-…` / `0KMR-…`; a name-must-start-
// with-a-letter rule would silently drop those two projects.
test("helper: env var names may start with a digit (Windows)", () => {
  assert.equal(
    envVarFromHelper("Write-Output ${env:0TMN-ANTHROPIC_API_KEY}"),
    "0TMN-ANTHROPIC_API_KEY",
  );
  assert.equal(
    envVarFromHelper("[Environment]::GetEnvironmentVariable('0KMR-ANTHROPIC_API_KEY','User')"),
    "0KMR-ANTHROPIC_API_KEY",
  );
});

test("helper: posix forms", () => {
  assert.equal(envVarFromHelper("echo $ANTHROPIC_API_KEY"), "ANTHROPIC_API_KEY");
  assert.equal(envVarFromHelper("echo ${TEAM_ANTHROPIC_API_KEY}"), "TEAM_ANTHROPIC_API_KEY");
  assert.equal(envVarFromHelper("printenv WORK_AUTH_TOKEN"), "WORK_AUTH_TOKEN");
});

test("helper: a bare $VAR that is not key-shaped is rejected, not guessed", () => {
  // Would otherwise hash the value of $HOME — a path, not a key.
  assert.equal(envVarFromHelper("cat $HOME/.keys/anthropic"), undefined);
  assert.equal(envVarFromHelper("$SHELL -c list"), undefined);
});

test("helper: non-env commands yield undefined", () => {
  assert.equal(envVarFromHelper("vault read -field=key secret/anthropic"), undefined);
  assert.equal(envVarFromHelper("/usr/local/bin/get-key.sh"), undefined);
  assert.equal(envVarFromHelper(""), undefined);
});

// ---------------------------------------------------------------------------
// findHelper — precedence across settings files
// ---------------------------------------------------------------------------
test("findHelper: settings.local.json wins over settings.json", () => {
  const dir = tmpdir();
  writeSettings(dir, "settings.json", JSON.stringify({ apiKeyHelper: "echo $SHARED_API_KEY" }));
  writeSettings(dir, "settings.local.json", JSON.stringify({ apiKeyHelper: "echo $LOCAL_API_KEY" }));
  assert.equal(findHelper(dir, dir)?.cmd, "echo $LOCAL_API_KEY");
});

test("findHelper: walks up from a subdirectory of the project", () => {
  const dir = tmpdir();
  writeSettings(dir, "settings.json", JSON.stringify({ apiKeyHelper: "echo $ROOT_API_KEY" }));
  const nested = path.join(dir, "src", "deep", "here");
  fs.mkdirSync(nested, { recursive: true });
  assert.equal(findHelper(nested, tmpdir())?.cmd, "echo $ROOT_API_KEY");
});

test("findHelper: empty string is a declaration, not an absent setting", () => {
  const dir = tmpdir();
  writeSettings(dir, "settings.local.json", JSON.stringify({ apiKeyHelper: "" }));
  assert.deepEqual(findHelper(dir, tmpdir())?.cmd, "");
});

test("findHelper: a file without apiKeyHelper falls through to the next one", () => {
  const dir = tmpdir();
  writeSettings(dir, "settings.local.json", JSON.stringify({ permissions: { allow: [] } }));
  writeSettings(dir, "settings.json", JSON.stringify({ apiKeyHelper: "echo $FALLBACK_API_KEY" }));
  assert.equal(findHelper(dir, tmpdir())?.cmd, "echo $FALLBACK_API_KEY");
});

test("findHelper: malformed JSON is ignored, not fatal", () => {
  const dir = tmpdir();
  writeSettings(dir, "settings.local.json", "{ this is not json");
  writeSettings(dir, "settings.json", JSON.stringify({ apiKeyHelper: "echo $GOOD_API_KEY" }));
  assert.equal(findHelper(dir, tmpdir())?.cmd, "echo $GOOD_API_KEY");
});

test("findHelper: user-level ~/.claude/settings.json is the last resort", () => {
  const project = tmpdir();
  const home = tmpdir();
  fs.writeFileSync(
    path.join(home, "settings.json"),
    JSON.stringify({ apiKeyHelper: "echo $USER_LEVEL_API_KEY" }),
  );
  assert.equal(findHelper(project, home)?.cmd, "echo $USER_LEVEL_API_KEY");
});

test("findHelper: nothing declared anywhere", () => {
  assert.equal(findHelper(tmpdir(), tmpdir()), null);
});

// ---------------------------------------------------------------------------
// classifyHelper — the four outcomes
// ---------------------------------------------------------------------------
test("classify: no declaration", () => {
  assert.deepEqual(classifyHelper(null, {}), { kind: "none", mtime: 0 });
});

test("classify: empty helper means subscription", () => {
  assert.deepEqual(classifyHelper({ cmd: "   ", mtime: 5 }, {}), { kind: "subscription", mtime: 5 });
});

test("classify: declared but env var unset is unresolved (→ held, not lost)", () => {
  const r = classifyHelper({ cmd: "echo $MISSING_API_KEY", mtime: 7 }, {});
  assert.deepEqual(r, { kind: "unresolved", mtime: 7 });
});

test("classify: a command naming no env var is opaque, keyed by the command hash", () => {
  const r = classifyHelper({ cmd: "  vault read secret/x ", mtime: 1 }, {});
  assert.equal(r.kind, "opaque");
  const again = classifyHelper({ cmd: "vault read secret/x", mtime: 2 }, {});
  assert.equal(r.kind === "opaque" && again.kind === "opaque" && r.keyHash === again.keyHash, true);
});

test("derive: opaque helper bills as apikey with the command hash", () => {
  const id = deriveClaudeForCwd({}, OAUTH_CRED, { kind: "opaque", keyHash: "0badc0de", mtime: 1 });
  assert.equal(id.authType, "apikey");
  assert.equal(id.keyHash, "0badc0de");
  assert.equal(id.keySource, "helper");
});

test("derive: subscription helper keeps the account identity for the server", () => {
  const id = deriveClaudeForCwd({}, OAUTH_CRED, { kind: "subscription", mtime: 1 }, { accountUuid: "u-1", emailAddress: "dev1@example.com" });
  assert.equal(id.authType, "oauth");
  assert.equal(id.accountUuid, "u-1");
  assert.equal(id.email, "dev1@example.com");
});

test("classify: resolves to apikey + hash, and never echoes the key", () => {
  const r = classifyHelper(
    { cmd: "[Environment]::GetEnvironmentVariable('AIDD-ANTHROPIC_API_KEY','User')", mtime: 9 },
    { "AIDD-ANTHROPIC_API_KEY": FAKE_KEY },
  );
  assert.equal(r.kind, "apikey");
  assert.equal(r.kind === "apikey" && r.envVar, "AIDD-ANTHROPIC_API_KEY");
  assertNoSecret(r);
});

// The dashboard already holds rows keyed by hashes produced with this exact
// formula (sha256, first 8 hex). Changing it would silently split a member's
// history in two, so pin it.
test("classify: keyHash formula is pinned to sha256().slice(0,8)", () => {
  const r = classifyHelper(
    { cmd: "echo $ANTHROPIC_API_KEY", mtime: 0 },
    { ANTHROPIC_API_KEY: FAKE_KEY },
  );
  assert.equal(r.kind === "apikey" && r.keyHash, "ae9fe793");
});

// ---------------------------------------------------------------------------
// deriveClaudeForCwd — precedence with the credential file
// ---------------------------------------------------------------------------
const OAUTH_CRED = { claudeAiOauth: { subscriptionType: "pro" } };

test("derive: env key still wins, unchanged from before", () => {
  const id = deriveClaudeForCwd(
    { ANTHROPIC_API_KEY: FAKE_KEY },
    OAUTH_CRED,
    { kind: "apikey", keyHash: "1a8c16f4", envVar: "OTHER_API_KEY", mtime: 1 },
  );
  assert.equal(id.authType, "apikey");
  assert.equal(id.keyHash, "ae9fe793"); // the env key's hash, not the helper's
  assertNoSecret(id);
});

test("derive: helper key is used when the env is empty", () => {
  const id = deriveClaudeForCwd({}, OAUTH_CRED, {
    kind: "apikey",
    keyHash: "1a8c16f4",
    envVar: "AIDD-ANTHROPIC_API_KEY",
    mtime: 1,
  });
  assert.equal(id.authType, "apikey");
  assert.equal(id.keyHash, "1a8c16f4");
});

test("derive: empty helper falls through to the subscription", () => {
  const id = deriveClaudeForCwd({}, OAUTH_CRED, { kind: "subscription", mtime: 1 });
  assert.equal(id.authType, "oauth");
  assert.equal(id.subscriptionType, "pro");
});

test("derive: no helper behaves exactly as before", () => {
  const id = deriveClaudeForCwd({}, OAUTH_CRED, { kind: "none", mtime: 0 });
  assert.equal(id.authType, "oauth");
});

test("derive: unusable helper is unknown so the pusher holds the delta", () => {
  const id = deriveClaudeForCwd({}, OAUTH_CRED, { kind: "unresolved", mtime: 1 });
  assert.equal(id.authType, "unknown");
  assert.equal(id.keyHash, undefined);
});

test("derive: proxy flag survives the helper path", () => {
  const id = deriveClaudeForCwd({ ANTHROPIC_BASE_URL: "http://gw.internal" }, null, {
    kind: "apikey",
    keyHash: "1a8c16f4",
    envVar: "X_API_KEY",
    mtime: 1,
  });
  assert.equal(id.proxy, true);
});
