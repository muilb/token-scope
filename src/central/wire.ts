/**
 * Wires the usage.v2 pusher into the extension host. Additive and gated behind
 * `tokenscope.central.enabled` â€” disabled = zero overhead.
 *
 * The pusher owns a UsageStore whose window is the last `backfillDays` days
 * (default 30). On the first run every bucket in that window is new to the push
 * state, so the window IS the backfill; afterwards only changed buckets go out.
 */
import * as vscode from "vscode";
import * as os from "os";
import * as fs from "fs";
import * as path from "path";
import { CLAUDE_HOME, CODEX_HOME } from "../pricing";
import { readIdentity } from "../readers/identity";
import { ProjectMap } from "../identity/projectMap";
import { UsageStore } from "../core/usageStore";
import { isoDaysAgo } from "../util";
import { currentAuth } from "./buckets";
import { tick, PushConfig } from "./pusher";
import { syncPricing } from "./pricingSync";

let timer: NodeJS.Timeout | undefined;
let authWatchers: fs.FSWatcher[] = [];
let ticking = false;
let store: UsageStore | undefined;
let ctxRef: vscode.ExtensionContext | undefined;

function cfg() {
  return vscode.workspace.getConfiguration("tokenscope");
}

function owner(): string {
  return cfg().get<string>("owner", "").trim();
}

function pushConfig(context: vscode.ExtensionContext): PushConfig | null {
  const url = cfg().get<string>("central.url", "").trim();
  if (!url) return null;
  return {
    url,
    ingestKey: cfg().get<string>("central.ingestKey", "").trim(),
    osUser: owner() || process.env.USERNAME || safeUser(),
    hostname: os.hostname(),
    clientVersion: String(context.extension?.packageJSON?.version ?? ""),
  };
}

function safeUser(): string {
  try {
    return os.userInfo().username;
  } catch {
    return "unknown";
  }
}

function backfillDays(): number {
  const n = cfg().get<number>("central.backfillDays", 30);
  return Math.min(Math.max(Math.floor(n), 0), 90);
}

/** Pull central prices and, if they changed, refresh the local dashboard. */
async function runPricingSync(context: vscode.ExtensionContext): Promise<void> {
  const url = cfg().get<string>("central.url", "").trim();
  if (!url) return;
  const ingestKey = cfg().get<string>("central.ingestKey", "").trim();
  const changed = await syncPricing(context, { url, ingestKey });
  if (changed) {
    try {
      await vscode.commands.executeCommand("tokenscope.refresh");
    } catch {
      /* ignore */
    }
  }
}

/** Single-flight tick: skip if one is already running (watch + timer overlap). */
async function runTick(context: vscode.ExtensionContext): Promise<void> {
  if (ticking || !store) return;
  const conf = pushConfig(context);
  if (!conf) return;
  ticking = true;
  try {
    const windowStart = isoDaysAgo(backfillDays());
    store.refresh(windowStart);
    const id = readIdentity();
    const r = await tick(
      context.globalState,
      {
        entries: store.entries(),
        windowStart,
        authNow: {
          claude: currentAuth("claude", id, owner(), conf.hostname),
          codex: currentAuth("codex", id, owner(), conf.hostname),
        },
        projectMap: cfg().get<ProjectMap>("projectMap", {}),
      },
      conf,
    );
    if (r.error || r.secretDropped) console.warn("tokenscope central push:", r);
  } catch (e) {
    console.error("tokenscope central tick failed", e);
  } finally {
    ticking = false;
  }
}

function watchAuthFiles(onChange: () => void): void {
  const files = [path.join(CLAUDE_HOME, ".credentials.json"), path.join(CODEX_HOME, "auth.json")];
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

/** Register the manual commands ONCE (survives re-wiring on config change). */
export function registerCentralCommands(context: vscode.ExtensionContext): void {
  if (commandRegistered) return;
  commandRegistered = true;
  context.subscriptions.push(
    vscode.commands.registerCommand("tokenscope.central.pushNow", () => {
      if (ctxRef) void runTick(ctxRef);
    }),
    vscode.commands.registerCommand("tokenscope.central.syncPricing", () => {
      void runPricingSync(context);
    }),
  );
}

export function activateCentral(context: vscode.ExtensionContext): void {
  registerCentralCommands(context);
  // v1 delta cursors are obsolete (usage.v2 pushes snapshots) â€” free the space.
  void context.globalState.update("tokenscope.central.cursors.v1", undefined);

  if (!cfg().get<boolean>("central.enabled", false)) {
    store = undefined;
    ctxRef = undefined;
    return;
  }
  store = new UsageStore(CLAUDE_HOME, CODEX_HOME);
  ctxRef = context;

  // Login switch â†’ tick promptly so the new identity stamps new requests.
  watchAuthFiles(() => void runTick(context));

  const min = Math.max(cfg().get<number>("central.pushIntervalMin", 1), 1);
  timer = setInterval(() => {
    void runTick(context);
    void runPricingSync(context);
  }, min * 60_000);

  // First tick soon after startup (this is when the backfill window is sent).
  setTimeout(() => {
    void runPricingSync(context).then(() => runTick(context));
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
