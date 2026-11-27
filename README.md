# CodeTokens Monitor

Realtime token & cost monitor for AI coding assistants, native to VS Code.

CodeTokens Monitor reads your local session logs and shows live token usage, estimated
cost, active sessions, and context-window pressure — right in the editor. No
Python, no web server, no browser, no API key.

## Features

- **Live token & cost** — today's tokens and estimated USD, updated in real time
  as you work (file-watcher based). Counts every billed request once — including
  **subagent** transcripts — and prices it per request (per model, 5-minute vs
  1-hour cache writes, long-prompt tiers, fast mode, web searches).
- **Active sessions** — context-window usage per running session, with a fill bar.
- **Context-window alerts** — a warning toast fires and the status bar turns
  yellow / red when a session's context is nearly full, so you know when to
  `/compact`. Works in the background — no need to open the panel.
- **Tool comparison & history** — per-tool split, token composition, and a
  daily-usage chart.
- **Status bar** — today's cost at a glance; click to open the full dashboard.
- **i18n** — English / Tiếng Việt / 日本語.
- **Central usage (optional, off by default)** — push *aggregated* usage to an
  internal team server for a combined member × project dashboard, for every
  account type: API key, Claude subscription / Teams, ChatGPT. The server prices
  API-key usage only (subscriptions are flat-fee: tokens only) from an
  **admin-managed pricing table**, which is **synced back** to each machine.
  Project managers get a per-team link to view and export their team's numbers.
  See [Central usage server](#central-usage-server-optional).

## Requirements

- VS Code 1.85+
- A supported AI coding assistant installed that writes local session logs.

If a machine has never run a supported assistant, the dashboard simply shows no
data — there is nothing to configure.

## Usage

Open the **CodeTokens Monitor** icon in the Activity Bar for the sidebar dashboard, or
click the cost in the status bar to open the full panel in an editor column.

## Settings

| Setting | Default | Description |
|---|---|---|
| `tokenscope.statusBar.enabled` | `true` | Show today's cost in the status bar. |
| `tokenscope.alert.enabled` | `true` | Context-window warnings (toast + status-bar color). |
| `tokenscope.alert.thresholdPct` | `80` | Usage % that triggers the warning (1–100). |
| `tokenscope.historyDaysBack` | `90` | Days of session logs to scan for history. |
| `tokenscope.contextWindowOverride` | `0` | Force a context-window size (tokens) for sessions. `0` = auto-detect from model. |
| `tokenscope.central.enabled` | `false` | Push aggregated usage (every account type) to a central server. Local dashboard is unaffected. |
| `tokenscope.central.url` | `""` | Central server base URL (LAN/VPN only), e.g. `http://server:8787`. |
| `tokenscope.central.ingestKey` | `""` | Shared internal token sent as `X-Ingest-Key`. **Not** your Claude/OpenAI key. |
| `tokenscope.central.pushIntervalMin` | `1` | Push interval (minutes); only changed totals are sent. Prices are synced on the same timer. |
| `tokenscope.central.backfillDays` | `30` | Days kept in sync with the server. The first run after enabling (or upgrading to 0.8) sends the whole window. |
| `tokenscope.owner` | `""` | Member identity for **API-key** usage — use your company email. Subscription logins are identified by their account automatically. Empty = OS user @ host. |
| `tokenscope.projectMap` | `{}` | Map a repo path/slug or `key:<hash>` to an enterprise project name. |

## Central usage server (optional)

Off by default. When enabled, the extension sends **aggregated** usage to a small
internal server so a team can see a combined **member × project** dashboard. It's
designed for LAN/VPN, not the Internet.

What is sent, per session × day × model: token totals (input, output, cache read,
5-minute and 1-hour cache writes), request and web-search counts, first/last
timestamp, project name and working directory, and the account it ran under:

- **API key**: auth type, an 8-hex hash of the key (never the key), and the
  `tokenscope.owner` value (recommended: your company email).
- **Claude subscription / Teams (OAuth)**: plan, organization id, and the logged-in
  account's **email, account uuid and display name** (from `~/.claude.json`), so
  the server can attribute usage to the person.
- **ChatGPT (Codex)**: plan, account id and email (from the login's id-token claims).

What is **never** sent: API keys, OAuth/ChatGPT tokens, prompts or transcript
content.

Each push carries absolute totals ("bucket snapshots"), not increments, so
re-sending is harmless: a retry, a crash, or a fix in how logs are counted converge
on the right number. A session is attributed to the account logged in when the
extension first sees it; a login switch mid-session starts a new attribution from
that moment. Sessions first seen long after they ran (the first-run backfill) are
flagged *assumed*.

To run the server, see [`server/README.md`](server/README.md). Set
`tokenscope.central.enabled`, `.url`, and `.ingestKey` (and `tokenscope.owner` if
you use an API key). The first run sends the last `backfillDays` days.

### Pricing (centrally managed)

The server recomputes cost from the raw token counts against a pricing table an
admin edits on the server's `/admin` page (protected by a separate `ADMIN_KEY`).
Prices are absolute per component (input, cached input, short/long cache write,
output, long-prompt tier, fast-mode multiplier) and dated: a row "effective from"
a day re-prices only that day onward, so a price change doesn't rewrite history.
The built-in table is `pricing/seed-v2.json`, shared by the extension and the
server, and so is the formula (`pricing/cost.js`). The extension pulls that table
and applies it locally, so per-session costs in the dashboard match the team
server. It syncs automatically when Central usage is on; run **"CodeTokens
Monitor: Sync pricing from central server"** to refresh on demand. When offline or
before the first sync, a built-in price table is used as a fallback.

## Notes on context-window detection

Session logs don't always record the context-window size, so CodeTokens Monitor infers
it from the model and from usage: a session already holding more than 200K
tokens is treated as the 1M window. The percentage is an out-of-band estimate
and may differ from the assistant's own counter by a few percent — the absolute
token count is the reliable figure.

## Privacy

By default everything runs locally: CodeTokens Monitor reads session files on your
machine and sends nothing anywhere. The only case data leaves your machine is when
you explicitly enable **Central usage** (`tokenscope.central.enabled`), and even
then only *aggregated* numbers plus account metadata are sent — never
keys/tokens, never prompt content. For subscription logins that metadata includes
your account email. See
[Central usage server](#central-usage-server-optional) for exactly what is sent.

## License

MIT
