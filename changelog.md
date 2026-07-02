# Changelog

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
