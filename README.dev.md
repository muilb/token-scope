# Tokenscope — VS Code Extension

Native port of the `token-dashboard` Python web app. Reads Claude Code /
Codex JSONL session files directly and shows realtime token + cost usage
inside VS Code — no Python, no web server, no browser.

> `token-dashboard` という Python 製 Web アプリのネイティブ移植版です。Claude Code /
> Codex の JSONL セッションファイルを直接読み取り、VS Code 内でトークン＋コスト使用量を
> リアルタイムに表示します（Python・Web サーバー・ブラウザ不要）。

## What it does / 機能概要

- **Sidebar view** (Activity Bar → Tokenscope icon): full dashboard in a side panel.
  <br>**サイドバービュー**（アクティビティバー → Tokenscope アイコン）：サイドパネルに
  完全なダッシュボードを表示。
- **Status bar**: today's cost (`$x.xx`); click to open the full dashboard in an editor column.
  <br>**ステータスバー**：本日のコスト（`$x.xx`）。クリックでエディタ列に完全な
  ダッシュボードを開きます。
- **Realtime**: a `chokidar` file watcher on `~/.claude/projects` and
  `~/.codex/sessions` pushes updates to the webview via `postMessage`
  (replaces the WebSocket in the Python version).
  <br>**リアルタイム**：`~/.claude/projects` と `~/.codex/sessions` を `chokidar` で監視し、
  `postMessage` で Webview に更新を送ります（Python 版の WebSocket を置き換え）。
- **Poll loop**: every 15s re-scans active sessions (catches opens/closes).
  <br>**ポーリングループ**：15 秒ごとにアクティブなセッションを再スキャンします
  （開始／終了を検知）。
- **Context-window alerts**: when an active session's context usage crosses the
  threshold, a warning toast fires (debounced per 10% bucket per session) and the
  status bar turns yellow (≥ threshold) / red (≥ 95%). Runs in the background —
  activates on VS Code startup (`onStartupFinished`), no need to open the sidebar.
  <br>**コンテキストウィンドウ警告**：アクティブなセッションのコンテキスト使用量がしきい値を
  超えると警告トーストが表示され（セッションごと・10％刻みでデバウンス）、ステータスバーが
  黄色（しきい値以上）／赤（95％以上）になります。バックグラウンドで動作し、VS Code 起動時
  （`onStartupFinished`）に有効化されるため、サイドバーを開く必要はありません。

## Context window detection / コンテキストウィンドウ検出

- **Codex** sessions carry `model_context_window` in their JSONL — read directly.
  <br>**Codex** のセッションは JSONL に `model_context_window` を持つため直接読み取ります。
- **Claude Code** assistant messages don't record a context window, so it's
  derived from the model name via the `CONTEXT_WINDOWS` table in `src/pricing.ts`
  (opus-4-8 / sonnet-4-6 / fable-5 = 1M, haiku-4-5 = 200K; fallback 200K). Note
  Claude Code itself often runs a 200K window even on 1M-capable models.
  <br>**Claude Code** のアシスタントメッセージにはコンテキストウィンドウが記録されないため、
  `src/pricing.ts` の `CONTEXT_WINDOWS` テーブルを使ってモデル名から導出します
  （opus-4-8 / sonnet-4-6 / fable-5 = 1M、haiku-4-5 = 200K、フォールバック 200K）。
  Claude Code 自体は 1M 対応モデルでも 200K ウィンドウで動作することが多い点に注意。

## Architecture (port map) / アーキテクチャ（移植対応表）

| Python | TypeScript |
|--------|-----------|
| `config.py` | `src/pricing.ts` |
| `readers/claude_stats.py` | `src/readers/claudeStats.ts` |
| `readers/claude_live.py` | `src/readers/claudeLive.ts` |
| `readers/codex_reader.py` | `src/readers/codexReader.ts` |
| `aggregator.py` | `src/aggregator.ts` |
| `api.py` (FastAPI + WebSocket) | `src/extension.ts` (webview + postMessage) |
| `static/index.html`, `static/app.js` | `media/index.html`, `media/app.js` |

Pricing table and all aggregation logic are 1:1 with the Python source.

> 料金テーブルとすべての集計ロジックは Python 版と 1:1 で対応しています。

## Develop / 開発

```bash
npm install
npm run compile     # or: npm run watch
```

Press `F5` in VS Code to launch an Extension Development Host.

> VS Code で `F5` を押すと Extension Development Host が起動します。

## Build & install the .vsix (internal use, no Marketplace) / .vsix のビルドとインストール（社内利用・Marketplace 非公開）

```bash
npm run package                       # -> tokenscope.vsix
code --install-extension tokenscope.vsix
```

Then reload VS Code. Find Tokenscope on the Activity Bar.

> その後 VS Code を再読み込みします。アクティビティバーに Tokenscope が表示されます。

## Config (Settings → Tokenscope, or `Ctrl+,` then search "tokenscope") / 設定（設定 → Tokenscope、または `Ctrl+,` で "tokenscope" を検索）

- `tokenscope.statusBar.enabled` — show today's cost in status bar (default `true`).
  <br>本日のコストをステータスバーに表示（デフォルト `true`）。
- `tokenscope.historyDaysBack` — days of JSONL to scan for history (default `90`).
  <br>履歴としてスキャンする JSONL の日数（デフォルト `90`）。
- `tokenscope.alert.enabled` — context-window warnings (default `true`).
  <br>コンテキストウィンドウ警告（デフォルト `true`）。
- `tokenscope.alert.thresholdPct` — usage % that triggers the warning (default `80`, range 1–100).
  <br>警告を発する使用率％（デフォルト `80`、範囲 1〜100）。

## Notes / 補足

- The initial history scan is deferred off the activation path (`setImmediate`)
  so it doesn't block VS Code startup.
  <br>初回の履歴スキャンは起動パスから外して遅延実行（`setImmediate`）するため、
  VS Code の起動をブロックしません。
- Service Worker / browser Notification code from the web version is inert in
  a webview (guarded by feature detection) — no behavior change.
  <br>Web 版の Service Worker／ブラウザ Notification のコードは Webview では無効です
  （機能検出でガード）。動作に変化はありません。
- The `localhost:7777` header badge and the Live-token-rate chart were removed
  from the webview UI; their render code in `media/app.js` is guarded so it
  no-ops if the elements are absent.
  <br>`localhost:7777` のヘッダーバッジとライブトークンレートのチャートは Webview UI から
  削除されました。`media/app.js` のレンダリングコードはガードされており、要素が無ければ
  何もしません。
