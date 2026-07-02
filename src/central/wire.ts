/**
 * Wires the UsagePusher into the extension host. Everything here is additive and
 * gated behind `tokenscope.central.enabled` — disabled = zero overhead.
 * Runs in the background; does NOT touch the local reader/aggregator/webview.
 */
import * as vscode from "vscode";
import * as os from "os";
import * as fs from "fs";
import * as path from "path";
import { CLAUDE_HOME, CODEX_HOME } from "../pricing";
import { readIdentity, authFileMtimes } from "../readers/identity";
import { ProjectMap } from "../identity/projectMap";
import { CursorStore } from "./cursor";
import { BuildCtx } from "./deltas";
import { tick, PushConfig } from "./pusher";
import { syncPricing } from "./pricingSync";

let timer: NodeJS.Timeout | undefined;
let authWatchers: fs.FSWatcher[] = [];
let ticking = false;
let activeStore: CursorStore | undefined; // current store for the pushNow command

function cfg() {
  return vscode.workspace.getConfiguration("tokenscope");
}

function pushConfig(): PushConfig | null {
  const url = cfg().get<string>("central.url", "").trim();
  if (!url) return null;
  const owner = cfg().get<string>("owner", "").trim();
  return {
    url,
    ingestKey: cfg().get<string>("central.ingestKey", "").trim(),
    osUser: owner || process.env.USERNAME || safeUser(),
    hostname: os.hostname(),
  };
}

function safeUser(): string {
  try {
    return os.userInfo().username;
  } catch {
    return "unknown";
  }
}

/** Pull central prices and, if they changed, refresh the local dashboard. */
async function runPricingSync(context: vscode.ExtensionContext): Promise<void> {
  const url = cfg().get<string>("central.url", "").trim();
  if (!url) return;
  const ingestKey = cfg().get<string>("central.ingestKey", "").trim();
  const changed = await syncPricing(context, { url, ingestKey });
  if (changed) {
    // tokenscope.refresh (registered in extension.ts) rebuilds + rebroadcasts
    // state so recomputed costs show immediately. Ignore if unavailable.
    try {
      await vscode.commands.executeCommand("tokenscope.refresh");
    } catch {
      /* ignore */
    }
  }
}

function buildCtx(): BuildCtx {
  return {
    identity: readIdentity(),
    projectMap: cfg().get<ProjectMap>("projectMap", {}),
    authMtimes: authFileMtimes(),
  };
}

/** Single-flight tick: skip if one is already running (watch + timer overlap). */
async function runTick(store: CursorStore): Promise<void> {
  if (ticking) return;
  const conf = pushConfig();
  if (!conf) return;
  ticking = true;
  try {
    const r = await tick(store, buildCtx(), conf);
    if (r.error) console.warn("tokenscope central push:", r.error, r);
  } catch (e) {
    console.error("tokenscope central tick failed", e);
  } finally {
    ticking = false;
  }
}

function watchAuthFiles(onChange: () => void): void {
  const files = [
    path.join(CLAUDE_HOME, ".credentials.json"),
    path.join(CODEX_HOME, "auth.json"),
  ];
  for (const f of files) {
    try {
      // Watch the directory so we still fire if the file is atomically replaced.
      const w = fs.watch(path.dirname(f), (_e, name) => {
        if (name && path.basename(f) === name.toString()) onChange();
      });
      authWatchers.push(w);
    } catch {
      /* dir may not exist yet; timer still covers it */
    }
  }
}

let commandRegistered = false;

/** Register the manual push command ONCE (survives re-wiring on config change). */
export function registerCentralCommands(context: vscode.ExtensionContext): void {
  if (commandRegistered) return;
  commandRegistered = true;
  context.subscriptions.push(
    vscode.commands.registerCommand("tokenscope.central.pushNow", () => {
      if (activeStore) void runTick(activeStore);
    }),
    vscode.commands.registerCommand("tokenscope.central.syncPricing", () => {
      void runPricingSync(context);
    }),
  );
}

export function activateCentral(context: vscode.ExtensionContext): void {
  registerCentralCommands(context);

  const enabled = cfg().get<boolean>("central.enabled", false);
  if (!enabled) {
    activeStore = undefined;
    return;
  }

  const store = new CursorStore(context.globalState);
  activeStore = store;

  // (a) file watcher in extension.ts fires on JSONL changes; the fallback timer
  //     below plus pushNow keep pushes flowing without duplicating that watch.
  // (b) auth file change → readIdentity() re-reads by mtime; also tick promptly
  //     so a login switch is reflected in the next delta's auth.
  watchAuthFiles(() => void runTick(store));

  // (c) fallback interval — also piggyback a pricing sync so local prices track
  //     the central admin table without a separate timer.
  const min = Math.max(cfg().get<number>("central.pushIntervalMin", 15), 1);
  timer = setInterval(() => {
    void runTick(store);
    void runPricingSync(context);
  }, min * 60_000);

  // Kick one tick soon after startup (seeds cursors at end-of-file; no backfill),
  // and pull prices once so the dashboard reflects central pricing promptly.
  setTimeout(() => {
    void runTick(store);
    void runPricingSync(context);
  }, 5_000);
}

export function deactivateCentral(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
  for (const w of authWatchers) {
    try {
      w.close();
    } catch {
      /* ignore */
    }
  }
  authWatchers = [];
}
