/**
 * Reads account/auth metadata for Claude and Codex from local config files.
 *
 * SECURITY (see improve/07): this module never stores, serializes, or returns
 * a full token or API key. Only derived metadata leaves this file:
 *   - authType / plan (enums)
 *   - account identity for subscription logins: accountUuid, email, display
 *     name, organization uuid — so the central server can attribute usage to a
 *     person (R1 decision 2026-11-27: members are identified by email + accountUuid)
 *   - key fingerprint (prefix, <=8 chars) and key hash (8 hex of SHA-256)
 * Every file read is wrapped in try/catch and degrades to "unknown" on failure.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import { CLAUDE_HOME, CODEX_HOME } from "../pricing";

export interface ClaudeIdentity {
  authType: "oauth" | "apikey" | "unknown";
  keyHash?: string; // 8 hex of SHA-256(env key) — stable map id, does not reveal key (apikey only)
  proxy?: boolean; // apikey routed through ANTHROPIC_BASE_URL (internal gateway)
  /** Where the API key was found: extension env, ~/.claude/settings.json env, or apiKeyHelper. */
  keySource?: "env" | "settings" | "helper";
  subscriptionType?: string; // "pro" | "max" | "team" | "enterprise" | ...
  rateLimitTier?: string;
  orgId?: string; // organizationUuid (full UUID; not a secret)
  orgShort?: string; // first 8 chars for display
  accountUuid?: string;
  email?: string;
  displayName?: string;
  seatTier?: string;
  billingType?: string;
}

export interface CodexIdentity {
  authType: "chatgpt" | "apikey" | "unknown"; // from auth_mode
  keyFingerprint?: string; // "sk-proj-xxxx" prefix only
  keyHash?: string; // 8 hex of SHA-256(key) — stable map id, does not reveal key
  accountId?: string; // ChatGPT account id (from the id_token claims)
  email?: string;
  plan?: string; // ChatGPT plan type (plus / pro / team / business / enterprise)
}

export interface AccountIdentity {
  claude: ClaudeIdentity;
  codex: CodexIdentity;
  osUser: string;
}

const CLAUDE_CRED = path.join(CLAUDE_HOME, ".credentials.json");
const CLAUDE_SETTINGS = path.join(CLAUDE_HOME, "settings.json");
const CLAUDE_JSON = path.join(process.env.USERPROFILE || os.homedir(), ".claude.json");
const CODEX_AUTH = path.join(CODEX_HOME, "auth.json");

function osUser(): string {
  return (
    process.env.USERNAME ||
    (() => {
      try {
        return os.userInfo().username;
      } catch {
        return "unknown";
      }
    })()
  );
}

function shortHash(secret: string): string {
  return crypto.createHash("sha256").update(secret).digest("hex").slice(0, 8);
}

/** Prefix fingerprint: keep up to 8 leading chars, never the full key. */
function fingerprint(key: string): string {
  return key.slice(0, 8);
}

function mtimeOf(file: string): number {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

function readJson(file: string): any | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

/**
 * Pure: derive Claude identity.
 *  env        — the extension host's environment
 *  cred       — ~/.claude/.credentials.json (OAuth tokens; only enums are read)
 *  account    — ~/.claude.json → oauthAccount (who is logged in)
 *  settings   — ~/.claude/settings.json (Claude Code may get its key from here,
 *               not from the environment VS Code was started with)
 */
export function deriveClaude(
  env: NodeJS.ProcessEnv,
  cred: any | null,
  account: any | null = null,
  settings: any | null = null,
): ClaudeIdentity {
  const sEnv = settings && typeof settings.env === "object" && settings.env ? settings.env : {};
  const envKey = env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN || "";
  const settingsKey = sEnv.ANTHROPIC_API_KEY || sEnv.ANTHROPIC_AUTH_TOKEN || "";
  const proxy = !!(env.ANTHROPIC_BASE_URL || sEnv.ANTHROPIC_BASE_URL);
  if (envKey || settingsKey) {
    const key = String(envKey || settingsKey);
    return {
      authType: "apikey",
      keyHash: key ? shortHash(key) : undefined,
      proxy: proxy || undefined,
      keySource: envKey ? "env" : "settings",
    };
  }
  if (settings && typeof settings.apiKeyHelper === "string" && settings.apiKeyHelper.trim()) {
    // The key itself is produced at run time; hash the helper command as a stable id.
    return { authType: "apikey", keyHash: shortHash(settings.apiKeyHelper.trim()), proxy: proxy || undefined, keySource: "helper" };
  }

  const orgId: string | undefined = str(cred?.organizationUuid) || str(account?.organizationUuid);
  const oauth = cred?.claudeAiOauth;
  const who = {
    accountUuid: str(account?.accountUuid),
    email: str(account?.emailAddress),
    displayName: str(account?.displayName) || str(account?.fullName),
    seatTier: str(account?.seatTier),
    billingType: str(account?.billingType),
  };
  if (oauth) {
    return {
      authType: "oauth",
      subscriptionType: str(oauth.subscriptionType),
      rateLimitTier: str(oauth.rateLimitTier),
      orgId,
      orgShort: orgId ? orgId.slice(0, 8) : undefined,
      ...who,
    };
  }
  return { authType: "unknown", orgId, orgShort: orgId ? orgId.slice(0, 8) : undefined };
}

/** Decode the claims of a JWT without verifying it (identity hints only, never sent as-is). */
function jwtClaims(token: unknown): any | null {
  if (typeof token !== "string") return null;
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    return JSON.parse(Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
  } catch {
    return null;
  }
}

/** Pure: derive Codex identity from parsed auth.json (null if absent). */
export function deriveCodex(auth: any | null): CodexIdentity {
  if (!auth) return { authType: "unknown" };

  const mode = auth.auth_mode;
  const key: string | undefined = auth.OPENAI_API_KEY;
  let authType: CodexIdentity["authType"] = mode === "apikey" ? "apikey" : mode === "chatgpt" ? "chatgpt" : "unknown";
  if (authType === "unknown" && typeof key === "string" && key) authType = "apikey";
  if (authType === "unknown" && auth.tokens) authType = "chatgpt";

  if (authType === "apikey" && typeof key === "string" && key.length > 0) {
    return { authType, keyFingerprint: fingerprint(key), keyHash: shortHash(key) };
  }
  if (authType === "chatgpt") {
    const claims = jwtClaims(auth.tokens?.id_token) || {};
    const oa = claims["https://api.openai.com/auth"] || {};
    return {
      authType,
      accountId: str(auth.tokens?.account_id) || str(oa.chatgpt_account_id),
      email: str(claims.email),
      plan: str(oa.chatgpt_plan_type),
    };
  }
  return { authType };
}

// Cache: re-read only when one of the source files changes.
let _cache: AccountIdentity | null = null;
let _sig = "";

/** mtimes of the two credential files (0 if absent). */
export function authFileMtimes(): { claude: number; codex: number } {
  return { claude: mtimeOf(CLAUDE_CRED), codex: mtimeOf(CODEX_AUTH) };
}

/** Pick only the oauthAccount object out of ~/.claude.json (a large, often-rewritten file). */
function readOauthAccount(): any | null {
  const j = readJson(CLAUDE_JSON);
  return j && typeof j.oauthAccount === "object" ? j.oauthAccount : null;
}

export function readIdentity(): AccountIdentity {
  const sig = [CLAUDE_CRED, CLAUDE_JSON, CLAUDE_SETTINGS, CODEX_AUTH].map(mtimeOf).join("|");
  if (_cache && sig === _sig) return _cache;
  _cache = {
    claude: deriveClaude(process.env, readJson(CLAUDE_CRED), readOauthAccount(), readJson(CLAUDE_SETTINGS)),
    codex: deriveCodex(readJson(CODEX_AUTH)),
    osUser: osUser(),
  };
  _sig = sig;
  return _cache;
}

/** Testing hook: drop the cache so the next read re-parses the files. */
export function _resetIdentityCache(): void {
  _cache = null;
  _sig = "";
}
