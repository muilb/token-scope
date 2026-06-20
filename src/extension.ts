import * as vscode from "vscode";
import * as path from "path";
import chokidar, { FSWatcher } from "chokidar";
import { CLAUDE_HOME, CODEX_HOME } from "./pricing";
import {
  buildFullState,
  applyFileUpdate,
  refreshActiveSessions,
  contextAlerts,
  setContextWindowOverride,
  getState,
  DashboardState,
} from "./aggregator";

let statusBarItem: vscode.StatusBarItem | undefined;
let watcher: FSWatcher | undefined;
let pollTimer: NodeJS.Timeout | undefined;
let debounceTimer: NodeJS.Timeout | undefined;

// Per-session toast throttle: session_id -> last-notified bucket (10% steps).
const notifiedBuckets = new Map<string, number>();

// All live webview targets (sidebar view + any opened panels).
const sinks = new Set<vscode.Webview>();

function cfg() {
  return vscode.workspace.getConfiguration("tokenscope");
}

function daysBack(): number {
  return cfg().get<number>("historyDaysBack", 90);
}

function applyContextOverride(): void {
  setContextWindowOverride(cfg().get<number>("contextWindowOverride", 0));
}

function broadcast(state: DashboardState): void {
  for (const w of sinks) {
    w.postMessage({ type: "update", data: state }).then(undefined, () => {});
  }
  updateStatusBar(state);
  checkContextAlerts();
}

function shortCwd(p: string): string {
  if (!p) return "";
  const parts = p.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] || p;
}

/** Warn (toast + status-bar color) when a session's context window is nearly full. */
function checkContextAlerts(): void {
  if (!cfg().get<boolean>("alert.enabled", true)) {
    if (statusBarItem) statusBarItem.backgroundColor = undefined;
    return;
  }
  const threshold = cfg().get<number>("alert.thresholdPct", 80);
  const alerts = contextAlerts(threshold);

  // Status bar color: red at >=95%, yellow otherwise when any session is over.
  if (statusBarItem) {
    if (alerts.length) {
      const worst = alerts[0].pct;
      statusBarItem.backgroundColor = new vscode.ThemeColor(
        worst >= 95 ? "statusBarItem.errorBackground" : "statusBarItem.warningBackground",
      );
    } else {
      statusBarItem.backgroundColor = undefined;
    }
  }

  // Toast once per 10% bucket per session, so it nags as it climbs but not every tick.
  const live = new Set<string>();
  for (const a of alerts) {
    live.add(a.session_id);
    const bucket = Math.floor(a.pct / 10);
    if (notifiedBuckets.get(a.session_id) === bucket) continue;
    notifiedBuckets.set(a.session_id, bucket);
    const proj = shortCwd(a.cwd) || a.session_id.slice(0, 8);
    vscode.window.showWarningMessage(
      `Tokenscope: ${(a.ctx_tokens / 1000).toFixed(0)}K / ${(a.context_window / 1000).toFixed(0)}K context (${a.pct}%) in ${proj} · ${a.model}. Consider /compact.`,
    );
  }
  // Drop sessions that fell back below threshold so they re-alert if they climb again.
  for (const id of [...notifiedBuckets.keys()]) {
    if (!live.has(id)) notifiedBuckets.delete(id);
  }
}

function updateStatusBar(state: DashboardState): void {
  if (!statusBarItem) return;
  const enabled = cfg().get<boolean>("statusBar.enabled", true);
  if (!enabled) {
    statusBarItem.hide();
    return;
  }
  const cost = state.cost_today_usd ?? 0;
  statusBarItem.text = `$(graph) $${cost.toFixed(2)}`;
  statusBarItem.tooltip = `Tokenscope · today\nTokens: ${(state.tokens_today ?? 0).toLocaleString()}\nClaude $${(state.claude_cost_today ?? 0).toFixed(2)} · Codex $${(state.codex_cost_today ?? 0).toFixed(2)}`;
  statusBarItem.show();
}

function getHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const mediaUri = (file: string) =>
    webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", file));
  const nonce = String(Math.random()).slice(2);
  const csp = [
    `default-src 'none'`,
    `img-src ${webview.cspSource} data:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
  ].join("; ");

  // index.html in media/ has a placeholder for the app script + csp + nonce.
  const fs = require("fs") as typeof import("fs");
  const htmlPath = vscode.Uri.joinPath(extensionUri, "media", "index.html").fsPath;
  let html = fs.readFileSync(htmlPath, "utf8");
  html = html
    .replace(/%CSP%/g, csp)
    .replace(/%NONCE%/g, nonce)
    .replace(/%APP_JS%/g, mediaUri("app.js").toString());
  return html;
}

function registerSink(webview: vscode.Webview): vscode.Disposable {
  sinks.add(webview);
  // Push current state immediately.
  webview.postMessage({ type: "update", data: getState() }).then(undefined, () => {});
  const msgSub = webview.onDidReceiveMessage((msg) => {
    if (msg?.type === "refresh") {
      const state = buildFullState(daysBack());
      broadcast(state);
    }
  });
  return new vscode.Disposable(() => {
    sinks.delete(webview);
    msgSub.dispose();
  });
}

class TokenscopeViewProvider implements vscode.WebviewViewProvider {
  constructor(private readonly extensionUri: vscode.Uri) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")],
    };
    view.webview.html = getHtml(view.webview, this.extensionUri);
    const sub = registerSink(view.webview);
    view.onDidDispose(() => sub.dispose());
  }
}

function scheduleFileUpdate(filePath: string): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    const updated = applyFileUpdate(filePath, daysBack());
    if (updated) broadcast(updated);
  }, 250);
}

function startWatcher(): void {
  const fsLib = require("fs") as typeof import("fs");
  const paths: string[] = [];
  const claudeProjects = path.join(CLAUDE_HOME, "projects");
  const codexSessions = path.join(CODEX_HOME, "sessions");
  if (fsLib.existsSync(claudeProjects)) paths.push(claudeProjects);
  if (fsLib.existsSync(codexSessions)) paths.push(codexSessions);
  if (!paths.length) return;

  watcher = chokidar.watch(paths, {
    ignoreInitial: true,
    persistent: true,
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
    depth: 6,
  });
  watcher.on("add", (p) => scheduleFileUpdate(p));
  watcher.on("change", (p) => scheduleFileUpdate(p));
}

let disposed = false;

export function activate(context: vscode.ExtensionContext): void {
  disposed = false;
  applyContextOverride();

  // Re-apply settings live and refresh the view when the user edits them.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration("tokenscope")) return;
      applyContextOverride();
      try {
        broadcast(refreshActiveSessions(daysBack()) ?? getState());
      } catch {
        /* ignore */
      }
    }),
  );

  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = "tokenscope.openPanel";
  statusBarItem.text = "$(graph) …";
  statusBarItem.tooltip = "Tokenscope · scanning usage…";
  if (cfg().get<boolean>("statusBar.enabled", true)) statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  // Initial build is a synchronous file scan over many days of JSONL — defer it
  // off the activation path so VS Code startup isn't blocked.
  setImmediate(() => {
    if (disposed) return;
    try {
      const state = buildFullState(daysBack());
      broadcast(state);
    } catch (e) {
      console.error("Tokenscope initial scan failed", e);
    }
  });

  const provider = new TokenscopeViewProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("tokenscope.view", provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("tokenscope.refresh", () => {
      const state = buildFullState(daysBack());
      broadcast(state);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("tokenscope.openPanel", () => {
      const panel = vscode.window.createWebviewPanel(
        "tokenscope.panel",
        "Tokenscope",
        vscode.ViewColumn.Beside,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")],
        },
      );
      panel.webview.html = getHtml(panel.webview, context.extensionUri);
      const sub = registerSink(panel.webview);
      panel.onDidDispose(() => sub.dispose());
    }),
  );

  startWatcher();

  // Poll active sessions every 15s — catches opens/closes missed by file events.
  pollTimer = setInterval(() => {
    try {
      const updated = refreshActiveSessions(daysBack());
      if (updated) broadcast(updated);
    } catch (e) {
      console.error("Tokenscope poll failed", e);
    }
  }, 15000);
}

export function deactivate(): void {
  disposed = true;
  if (pollTimer) clearInterval(pollTimer);
  if (debounceTimer) clearTimeout(debounceTimer);
  if (watcher) watcher.close();
}
