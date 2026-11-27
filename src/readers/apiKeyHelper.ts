/**
 * Resolves the per-project Anthropic key identity declared by Claude Code's
 * `apiKeyHelper` setting (see improve/07 §auth, 08 §6).
 *
 * Why this exists: `apiKeyHelper` lets each project draw its key from a
 * different env var, and the CLI runs that command itself — the key never lands
 * in ANTHROPIC_API_KEY, so identity.ts used to see no key at all and fall back
 * to the OAuth credential file (→ authType "oauth" → the delta was dropped).
 *
 * SECURITY: this module NEVER executes the helper command — a settings file can
 * be shared or committed, so running the string in it would be arbitrary code
 * execution from config. It only parses out the *name* of the env var, reads
 * that var, and hashes it. The key itself never leaves this file, exactly as in
 * identity.ts: only 8 hex of SHA-256 escapes.
 */
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { CLAUDE_HOME } from "../pricing";

export type HelperAuth =
  /** Helper names a readable env var → same keyHash shape as an env-key login. */
  | { kind: "apikey"; keyHash: string; envVar: string; mtime: number }
  /** `"apiKeyHelper": ""` — an explicit "this project runs on the subscription". */
  | { kind: "subscription"; mtime: number }
  /**
   * The command names no env var (a script, a vault call): the key is real but
   * unreadable here, so the command string is hashed as a stable key id.
   */
  | { kind: "opaque"; keyHash: string; mtime: number }
  /** Declared but unusable: it names an env var that is not set. */
  | { kind: "unresolved"; mtime: number }
  /** No settings file declares apiKeyHelper at all. */
  | { kind: "none"; mtime: 0 };

/** How far up from the session cwd we look for a `.claude/` directory. */
const MAX_WALK_UP = 10;

/** Re-resolve at most this often per cwd (the pusher ticks once a minute). */
const CACHE_TTL_MS = 30_000;

// Explicit, unambiguous ways to name an env var. Any name is accepted here:
// the command is doing nothing but reading that variable.
const EXPLICIT_PATTERNS: RegExp[] = [
  // [Environment]::GetEnvironmentVariable('NAME','User')
  /GetEnvironmentVariable\s*\(\s*['"]([^'"]+)['"]/,
  // $env:NAME  /  ${env:NAME} — a leading digit is legal on Windows, and real
  // config in the wild uses it (e.g. `0TMN-ANTHROPIC_API_KEY`).
  /\$\{?env:([A-Za-z0-9_][A-Za-z0-9_.\-]*)\}?/,
  // printenv NAME
  /\bprintenv\s+([A-Za-z0-9_][A-Za-z0-9_.\-]*)/,
];

// Bare `$NAME` / `${NAME}` (e.g. `echo $ANTHROPIC_API_KEY`). This form is loose
// enough to match `$HOME` in `cat $HOME/.keys/anthropic`, which would hash a
// path instead of a key — so only names that actually look like a key var are
// accepted, and anything else falls through to "unresolved" (→ held, not lost).
const BARE_PATTERN = /\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g;
const KEYLIKE_NAME = /API_KEY|AUTH_TOKEN|ANTHROPIC/i;

/**
 * Extract the env var name an apiKeyHelper command reads.
 * Returns undefined when the command does something else (a vault call, a
 * script, a literal) — the caller then keys it by the command hash ("opaque")
 * rather than guessing a variable.
 */
export function envVarFromHelper(cmd: string): string | undefined {
  if (!cmd) return undefined;
  for (const re of EXPLICIT_PATTERNS) {
    const m = re.exec(cmd);
    if (m) return m[1];
  }
  BARE_PATTERN.lastIndex = 0;
  for (let m = BARE_PATTERN.exec(cmd); m; m = BARE_PATTERN.exec(cmd)) {
    if (KEYLIKE_NAME.test(m[1])) return m[1];
  }
  return undefined;
}

interface Declared {
  cmd: string;
  mtime: number;
}

/** Read `apiKeyHelper` out of one settings file. null = file absent or silent. */
function declaredIn(file: string): Declared | null {
  let raw: string;
  let mtime = 0;
  try {
    raw = fs.readFileSync(file, "utf8");
    mtime = fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
  let json: any;
  try {
    json = JSON.parse(raw);
  } catch {
    return null; // malformed settings — treat as if it said nothing
  }
  // hasOwnProperty, not truthiness: `"apiKeyHelper": ""` is a *declaration*
  // (use the subscription), not an absent setting.
  if (!json || typeof json !== "object") return null;
  if (!Object.prototype.hasOwnProperty.call(json, "apiKeyHelper")) return null;
  const cmd = json.apiKeyHelper;
  if (typeof cmd !== "string") return null;
  return { cmd, mtime };
}

/**
 * Find the apiKeyHelper that applies to `cwd`, in Claude Code's own precedence:
 * `.claude/settings.local.json` then `.claude/settings.json`, walking up from
 * the session cwd (a session often runs in a subdirectory of the repo), and
 * finally the user-level `~/.claude/settings.json`.
 */
export function findHelper(cwd: string, claudeHome: string = CLAUDE_HOME): Declared | null {
  let dir = cwd;
  for (let i = 0; i < MAX_WALK_UP && dir; i++) {
    for (const name of ["settings.local.json", "settings.json"]) {
      const found = declaredIn(path.join(dir, ".claude", name));
      if (found) return found;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break; // hit the filesystem root
    dir = parent;
  }
  return declaredIn(path.join(claudeHome, "settings.json"));
}

function shortHash(secret: string): string {
  return crypto.createHash("sha256").update(secret).digest("hex").slice(0, 8);
}

/** Pure core: classify a declaration against an env. Exported for tests. */
export function classifyHelper(
  declared: Declared | null,
  env: NodeJS.ProcessEnv,
): HelperAuth {
  if (!declared) return { kind: "none", mtime: 0 };
  const { cmd, mtime } = declared;
  if (!cmd.trim()) return { kind: "subscription", mtime };
  const envVar = envVarFromHelper(cmd);
  if (!envVar) return { kind: "opaque", keyHash: shortHash(cmd.trim()), mtime };
  const value = env[envVar];
  if (!value) return { kind: "unresolved", mtime };
  return { kind: "apikey", keyHash: shortHash(value), envVar, mtime };
}

interface CacheEntry {
  at: number;
  result: HelperAuth;
}
const _cache = new Map<string, CacheEntry>();

/**
 * Cached resolve for one session cwd. Re-reads when the TTL lapses; the TTL is
 * short enough that editing a settings file takes effect within a tick or two.
 */
export function resolveHelperAuth(cwd: string, env: NodeJS.ProcessEnv = process.env): HelperAuth {
  const now = Date.now();
  const hit = _cache.get(cwd);
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.result;

  const result = classifyHelper(findHelper(cwd), env);
  _cache.set(cwd, { at: now, result });
  return result;
}

/** Testing hook: drop the cache so the next resolve re-reads the settings files. */
export function _resetHelperCache(): void {
  _cache.clear();
}
