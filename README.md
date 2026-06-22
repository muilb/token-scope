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

## Notes on context-window detection

Session logs don't always record the context-window size, so CodeTokens Monitor infers
it from the model and from usage: a session already holding more than 200K
tokens is treated as the 1M window. The percentage is an out-of-band estimate
and may differ from the assistant's own counter by a few percent — the absolute
token count is the reliable figure.

## Privacy

Everything runs locally. CodeTokens Monitor reads session files on your machine and
sends nothing anywhere.

## License

MIT
