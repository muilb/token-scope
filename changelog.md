# Changelog

## 0.8.0

0.7.0 was an internal build that only added per-project `apiKeyHelper`
attribution; 0.8.0 merges it with the usage.v2 rework below.

### Fixed — usage from `apiKeyHelper` projects was silently dropped
- **Per-project API key attribution** (`src/readers/apiKeyHelper.ts`): Claude Code's
  `apiKeyHelper` setting runs a command to fetch the key, so the key never reaches
  `ANTHROPIC_API_KEY`. The identity reader saw no env key, fell back to the OAuth
  credential file, and every delta was classified `oauth` → **dropped** (cursor
  advancing, tokens lost). The helper's *command string* is now parsed for the env
  var it names; that var is read and hashed, giving the same `keyHash` the machine
  produced back when the key was exported directly — so history stays continuous.
  Projects using different key vars are now attributed to different keys, which the
  single global env var could never express.
  - The helper command is **parsed, never executed** — a settings file can be shared
    or committed, so running it would be arbitrary code execution from config.
  - `"apiKeyHelper": ""` is read as an explicit "this project runs on the
    subscription" and resolves to `oauth` (with the account's email + uuid).
  - A helper that names an env var which is not set resolves to `unknown` and is
    **held** — a misconfigured helper delays data instead of losing it.
  - A helper that names no env var at all (a script, a vault call) is billed as
    `apikey`, keyed by a hash of the command string, so it is never held forever.
  - Env-key precedence is unchanged: a machine exporting `ANTHROPIC_API_KEY` /
    `ANTHROPIC_AUTH_TOKEN` behaves exactly as in 0.6.0.
  - Switching a project's helper mid-session now adds a new auth stamp for that
    session, same as an OAuth login switch does.

### Fixed — local dashboard counts and prices
- **Subagent usage was not counted.** Transcripts under
  `projects/<slug>/<session>/subagents/` are now read and attributed to the
  parent session (about a fifth of all tokens on a subagent-heavy machine).
- **Output tokens were undercounted.** Claude Code writes a response once per
  content block while it is still streaming; the first line carries a partial
  `output_tokens`. Lines of one request are now merged with a field-wise maximum.
- **"Tokens today" drifted below the session table.** The 15 s poll advanced file
  offsets without adding the new bytes to today's totals. Every number now comes
  from one de-duplicated request store, recomputed on each refresh; a half-written
  last line is re-read instead of lost; crossing midnight rebuilds the day.
- **tok/min** was output ÷ time since the last request (floored at 0.1 min),
  inflating it ~10×; it is now output in the last 5 minutes ÷ 5.
- **Requests** counted merges, not requests.
- **Per-session cost** priced all tokens at the session's last model; it is now
  computed per request and per model in the extension.
- A request copied into a resumed session is counted once, in the original.
- Context-window colours/alerts in the panel use % of the session's own window
  (a fixed 100K threshold flagged 1M-window sessions at 10%).

### Changed — pricing v2 (shared with the server)
- One table (`pricing/seed-v2.json`) and one formula (`pricing/cost.js`) for the
  extension and the server; absolute prices per component (cache-read ratios now
  differ by model), 5-minute vs 1-hour cache writes, long-prompt tiers (Haiku 5.5
  > 100K, GPT > 272K), fast mode, `inference_geo: "us"`, web searches, and dated
  rows (`effectiveFrom`). Prices read from the official pages on 2026-11-27,
  including Opus 5.5, Sonnet 5.5, Haiku 5.5, Fable/Mythos 5.x, GPT-5.6 / GPT-6.
  Models without a price now cost $0 visibly instead of matching a `gpt-5` 0/0 row.

### Changed — central usage (usage.v2)
- **Every account type is pushed** (API key, Claude subscription / Teams, ChatGPT);
  the server prices API-key usage only. Subscription usage is attributed to the
  Claude / ChatGPT account (email + account uuid); API-key usage to
  `tokenscope.owner` (use your email).
- Pushes are **bucket snapshots** (absolute totals per session × day × model ×
  speed × tier × origin), upserted by the server — idempotent and self-healing.
- **Backfill**: the first run sends the last `tokenscope.central.backfillDays`
  (default 30) days; the server stops counting v1 rows of a day once v2 covers it.
- The secret check no longer matches long repository names (a 40-character repo
  name blocked a machine's pushes forever); only real key/token shapes are caught,
  and only the offending bucket is dropped.

### Removed
- `src/central/deltas.ts`, `src/central/cursor.ts`, `src/readers/codexReader.ts`
  (replaced by `src/core/`).

## 0.5.0

### Added — Central pricing admin + sync
- **Server-managed pricing** (`server/pricing.js`, `server/admin.js`): cost is now
  recomputed from raw tokens against an admin-editable pricing table (`/admin`,
  `ADMIN_KEY`-gated), so editing a price re-values historical and new usage at once.
  Models with no price are surfaced on the admin page (counted at $0 until priced).
- **Pricing sync to the extension** (`src/central/pricingSync.ts`, `GET /api/v1/pricing`):
  the extension pulls the central prices, caches them in `globalState`, and applies
  them to the local dashboard (including the webview's per-session cost) so it matches
  central. Command: **"Sync pricing from central server"**.
- **claude-sonnet-5** added to the pricing tables (extension + server + webview).

### Fixed — central push reliability
- **Livelock on OAuth refresh**: `confidenceFor` marked a delta `uncertain` whenever
  the credentials file changed since the cursor was last written. OAuth tokens refresh
  periodically, so a held delta froze the cursor and every later delta stayed uncertain
  forever. Confidence is now `uncertain` only when the auth file was modified *within
  the delta's own event window* (a genuine mid-batch login switch).
- **Transient "unknown" auth dropped data**: a delta read while `.credentials.json` was
  mid-rewrite got `authType: "unknown"` and was dropped (advancing the cursor, losing
  the tokens). Unknown auth is now **held** and retried, protecting apikey usage too.

## 0.2.0

### Added — Central usage (optional, off by default)
- **Identity reader** (`src/readers/identity.ts`): detects Claude/Codex auth type
  (oauth / apikey / chatgpt), subscription, org, and a **key fingerprint/hash** —
  never a full key or token.
- **Project map resolver** (`src/identity/projectMap.ts`): maps a repo path/slug or
  `key:<hash>` to an enterprise project name (`tokenscope.projectMap`).
- **UsagePusher** (`src/central/`): pushes *aggregated* usage deltas to an internal
  server when `tokenscope.central.enabled` is on. API-key usage only; OAuth/ChatGPT
  and uncertain-auth deltas are never sent. Auth is captured per-delta at read time,
  so a mid-session login switch is attributed correctly. Best-effort with retry;
  the cursor advances only after a successful (2xx) push. No backfill — usage flows
  from the moment you enable it.
- **Central server** (`server/`): Fastify + SQLite (WAL) service that ingests
  deltas (idempotent on `(osUser, hostname, tool, sessionId, seq)`) and serves a
  combined **member × project** dashboard, with the working directory shown as a
  short name, plus CSV export. LAN/VPN only; `X-Ingest-Key` gated. Sized for ~200
  members pushing on an interval.
- New settings: `tokenscope.central.enabled`, `.url`, `.ingestKey`,
  `.pushIntervalMin`, `tokenscope.owner`, `tokenscope.projectMap`.
- New command: **Push usage to central server now** (`tokenscope.central.pushNow`).

### Security
- Full keys/tokens are never stored, serialized, pushed, or logged. Payloads are
  sanitized before sending, and the server rejects (422) any payload that looks
  like it contains a raw secret.

### Internal
- Added a dependency-free test setup (`node:test` + esbuild bundling): `npm test`.

## 0.1.0
- Initial release: live token & cost dashboard, active sessions, context-window
  alerts, tool comparison & history, status bar, i18n.
