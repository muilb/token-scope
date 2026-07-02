# CodeTokens Monitor

Realtime token & cost monitor for AI coding assistants, native to VS Code.

CodeTokens Monitor reads your local session logs and shows live token usage, estimated
cost, active sessions, and context-window pressure — right in the editor. No
Python, no web server, no browser, no API key.

## Features

- **Live token & cost** — today's tokens and estimated USD, updated in real time
  as you work (file-watcher based).
- **Active sessions** — context-window usage per running session, with a fill bar.
- **Context-window alerts** — a warning toast fires and the status bar turns
  yellow / red when a session's context is nearly full, so you know when to
  `/compact`. Works in the background — no need to open the panel.
- **Tool comparison & history** — per-tool split, token composition, and a
  daily-usage chart.
- **Status bar** — today's cost at a glance; click to open the full dashboard.
- **i18n** — English / Tiếng Việt / 日本語.
- **Central usage (optional, off by default)** — push *aggregated* usage to an
  internal team server for a combined member × project dashboard. Only usage
  authenticated with an **API key** is pushed; personal OAuth / ChatGPT logins are
  never sent. Cost is recomputed on the server from an **admin-managed pricing
  table** and can be **synced back** to each machine so local costs match the team
  dashboard. See [Central usage server](#central-usage-server-optional).

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
| `tokenscope.central.enabled` | `false` | Push aggregated usage (API-key only) to a central server. Local dashboard is unaffected. |
| `tokenscope.central.url` | `""` | Central server base URL (LAN/VPN only), e.g. `http://server:8787`. |
| `tokenscope.central.ingestKey` | `""` | Shared internal token sent as `X-Ingest-Key`. **Not** your Claude/OpenAI key. |
| `tokenscope.central.pushIntervalMin` | `1` | Fallback push interval (minutes); also when local prices are synced from the server. |
| `tokenscope.owner` | `""` | Override the reported member identity. Empty = OS user + org. |
| `tokenscope.projectMap` | `{}` | Map a repo path/slug or `key:<hash>` to an enterprise project name. |

## Central usage server (optional)

Off by default. When enabled, the extension pushes **aggregated** usage (token
counts + estimated cost + short auth metadata) to a small internal server so a
team can see a combined **member × project** dashboard. It's designed for LAN/VPN,
not the Internet.

What is **never** sent: full API keys or tokens, prompt/transcript content, and
any usage that isn't authenticated with an API key (personal OAuth / ChatGPT
logins are skipped). The auth attached to each usage delta is read at push time,
so a mid-day login switch is attributed correctly. Pushes are best-effort — if the
server is down, the local dashboard keeps working and the data is retried later.

To run the server, see [`server/README.md`](server/README.md). Set
`tokenscope.central.enabled`, `.url`, and `.ingestKey`, then usage starts flowing
from the moment you enable it (there is no backfill of past sessions).

### Pricing (centrally managed)

The server recomputes cost from the raw token counts against a pricing table an
admin edits on the server's `/admin` page (protected by a separate `ADMIN_KEY`) —
so changing a price re-values both past and new usage at once, and a brand-new
model can be priced without shipping a new build. The extension pulls that table
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
then only *aggregated* numbers plus short auth metadata are sent — never full
keys/tokens, never prompt content, and only for API-key-authenticated usage. See
[Central usage server](#central-usage-server-optional) for exactly what is sent.

## License

MIT
