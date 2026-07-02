/**
 * Reads account/auth metadata for Claude and Codex from local credential files.
 *
 * SECURITY (see improve/07): this module never stores, serializes, or returns
 * a full token or API key. Only derived metadata leaves this file:
 *   - authType / subscriptionType / auth_mode (enums)
 *   - organizationUuid (a UUID, not a secret)
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
  subscriptionType?: string; // "pro" | "max" | "team" | ...
  rateLimitTier?: string;
  orgId?: string; // organizationUuid (full UUID; not a secret)
  orgShort?: string; // first 8 chars for display
}

export interface CodexIdentity {
  authType: "chatgpt" | "apikey" | "unknown"; // from auth_mode
  keyFingerprint?: string; // "sk-proj-xxxx" prefix only
  keyHash?: string; // 8 hex of SHA-256(key) — stable map id, does not reveal key
}

export interface AccountIdentity {
  claude: ClaudeIdentity;
  codex: CodexIdentity;
  osUser: string;
}

const CLAUDE_CRED = path.join(CLAUDE_HOME, ".credentials.json");
const CODEX_AUTH = path.join(CODEX_HOME, "auth.json");

function osUser(): string {
  return process.env.USERNAME || (() => {
    try {
      return os.userInfo().username;
    } catch {
      return "unknown";
    }
  })();
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

/** Pure: derive Claude identity from env + parsed credential json (null if absent). */
export function deriveClaude(
  env: NodeJS.ProcessEnv,
  cred: any | null,
): ClaudeIdentity {
  // Env API key/token takes precedence over the OAuth credential file.
  const hasEnvKey = !!(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN);
  const proxy = !!env.ANTHROPIC_BASE_URL;
  if (hasEnvKey) {
    const key = env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN || "";
    return {
      authType: "apikey",
      keyHash: key ? shortHash(key) : undefined,
      proxy: proxy || undefined,
    };
  }

  const orgId: string | undefined = cred?.organizationUuid;
  const oauth = cred?.claudeAiOauth;
  if (oauth) {
    return {
      authType: "oauth",
      subscriptionType: oauth.subscriptionType,
      rateLimitTier: oauth.rateLimitTier,
      orgId,
      orgShort: orgId ? orgId.slice(0, 8) : undefined,
    };
  }
  return { authType: "unknown", orgId, orgShort: orgId ? orgId.slice(0, 8) : undefined };
}

/** Pure: derive Codex identity from parsed auth.json (null if absent). */
export function deriveCodex(auth: any | null): CodexIdentity {
  if (!auth) return { authType: "unknown" };

  const mode = auth.auth_mode;
  const authType: CodexIdentity["authType"] =
    mode === "apikey" ? "apikey" : mode === "chatgpt" ? "chatgpt" : "unknown";

  // Only apikey mode carries a project-scoped key we can fingerprint.
  const key: string | undefined = auth.OPENAI_API_KEY;
  if (authType === "apikey" && typeof key === "string" && key.length > 0) {
    return { authType, keyFingerprint: fingerprint(key), keyHash: shortHash(key) };
  }
  return { authType };
}

// Cache: re-read only when either auth file's mtime changes.
let _cache: AccountIdentity | null = null;
let _claudeMtime = -1;
let _codexMtime = -1;

/** mtimes of the two auth files (0 if absent) — pusher uses these for uncertainty. */
export function authFileMtimes(): { claude: number; codex: number } {
  return { claude: mtimeOf(CLAUDE_CRED), codex: mtimeOf(CODEX_AUTH) };
}

export function readIdentity(): AccountIdentity {
  const cm = mtimeOf(CLAUDE_CRED);
  const xm = mtimeOf(CODEX_AUTH);
  if (_cache && cm === _claudeMtime && xm === _codexMtime) return _cache;

  _cache = {
    claude: deriveClaude(process.env, readJson(CLAUDE_CRED)),
    codex: deriveCodex(readJson(CODEX_AUTH)),
    osUser: osUser(),
  };
  _claudeMtime = cm;
  _codexMtime = xm;
  return _cache;
}

/** Testing hook: drop the cache so the next read re-parses the files. */
export function _resetIdentityCache(): void {
  _cache = null;
  _claudeMtime = -1;
  _codexMtime = -1;
}
