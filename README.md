# Tokenscope

Realtime token & cost monitor for **Claude Code** and **OpenAI Codex**, native to VS Code.

> **Claude Code** と **OpenAI Codex** のトークン・コストをリアルタイムで監視する VS Code ネイティブ拡張機能です。

Tokenscope reads your local Claude Code / Codex session logs and shows live token
usage, estimated cost, active sessions, and context-window pressure — right in the
editor. No Python, no web server, no browser, no API key.

> Tokenscope はローカルの Claude Code / Codex セッションログを読み取り、トークン使用量・
> 推定コスト・アクティブなセッション・コンテキストウィンドウの逼迫度をエディタ内に
> リアルタイムで表示します。Python・Web サーバー・ブラウザ・API キーは一切不要です。

## Features / 機能

- **Live token & cost** — today's tokens and estimated USD, updated in real time as
  you work (file-watcher based).
  <br>**ライブのトークン・コスト** — 本日のトークン数と推定 USD を、作業中にリアルタイムで
  更新します（ファイル監視ベース）。
- **Active sessions** — context-window usage per running session, with a fill bar.
  <br>**アクティブなセッション** — 実行中の各セッションのコンテキストウィンドウ使用量を
  フィルバーで表示します。
- **Context-window alerts** — a warning toast fires and the status bar turns
  yellow / red when a session's context is nearly full, so you know when to
  `/compact`. Works in the background — no need to open the panel.
  <br>**コンテキストウィンドウ警告** — セッションのコンテキストが満杯に近づくと警告トーストが
  表示され、ステータスバーが黄色／赤になり、`/compact` のタイミングが分かります。
  バックグラウンドで動作し、パネルを開く必要はありません。
- **Tool comparison & history** — Claude Code vs Codex split, token composition,
  and a daily-usage chart.
  <br>**ツール比較と履歴** — Claude Code と Codex の内訳、トークン構成、日次使用量チャートを
  表示します。
- **Status bar** — today's cost at a glance; click to open the full dashboard.
  <br>**ステータスバー** — 本日のコストを一目で確認でき、クリックすると完全な
  ダッシュボードが開きます。
- **i18n** — English / Tiếng Việt / 日本語.
  <br>**多言語対応** — 英語 / ベトナム語 / 日本語。

## Requirements / 動作要件

- VS Code 1.85+
- Claude Code installed (creates `~/.claude/`). Codex (`~/.codex/`) is optional.
  <br>Claude Code がインストールされていること（`~/.claude/` が作成されます）。
  Codex（`~/.codex/`）は任意です。

If a machine has never run Claude Code, the dashboard simply shows no data — there
is nothing to configure.

> Claude Code を一度も実行していない環境では、ダッシュボードはデータを表示しないだけで、
> 設定は不要です。

## Usage / 使い方

Open the **Tokenscope** icon in the Activity Bar for the sidebar dashboard, or
click the cost in the status bar to open the full panel in an editor column.

> アクティビティバーの **Tokenscope** アイコンを開くとサイドバーのダッシュボードが表示され、
> ステータスバーのコストをクリックするとエディタ列に完全なパネルが開きます。

## Settings / 設定

| Setting | Default | Description / 説明 |
|---|---|---|
| `tokenscope.statusBar.enabled` | `true` | Show today's cost in the status bar.<br>本日のコストをステータスバーに表示します。 |
| `tokenscope.alert.enabled` | `true` | Context-window warnings (toast + status-bar color).<br>コンテキストウィンドウ警告（トースト＋ステータスバーの色）。 |
| `tokenscope.alert.thresholdPct` | `80` | Usage % that triggers the warning (1–100).<br>警告を発する使用率％（1〜100）。 |
| `tokenscope.historyDaysBack` | `90` | Days of session logs to scan for history.<br>履歴としてスキャンするセッションログの日数。 |
| `tokenscope.contextWindowOverride` | `0` | Force a context-window size (tokens) for Claude sessions. `0` = auto-detect from model.<br>Claude セッションのコンテキストウィンドウサイズ（トークン）を固定します。`0` はモデルから自動検出。 |

## Notes on context-window detection / コンテキストウィンドウ検出について

Claude Code session logs don't record the context-window size, so Tokenscope
infers it from the model (Opus / Sonnet / Fable = 1M, Haiku = 200K) and from
usage: a session already holding more than 200K tokens is treated as the 1M
window. The percentage is an out-of-band estimate and may differ from Claude
Code's own counter by a few percent — the absolute token count is the reliable
figure.

> Claude Code のセッションログにはコンテキストウィンドウサイズが記録されないため、
> Tokenscope はモデル（Opus / Sonnet / Fable = 1M、Haiku = 200K）と使用量から推定します。
> 既に 200K トークンを超えているセッションは 1M ウィンドウとして扱われます。
> この割合は外部からの推定値で、Claude Code 自身のカウンターと数％ずれることがあります。
> 信頼できるのは絶対トークン数の方です。

## Privacy / プライバシー

Everything runs locally. Tokenscope reads session files on your machine and sends
nothing anywhere.

> すべてローカルで動作します。Tokenscope はお使いのマシン上のセッションファイルを
> 読み取るだけで、外部には何も送信しません。

## License / ライセンス

MIT
