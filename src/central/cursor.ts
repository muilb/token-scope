/**
 * Per-session read cursor for the pusher, persisted in globalState (see
 * improve/09 §E.2 — NOT workspaceState: the JSONL files live under ~/.claude and
 * ~/.codex and belong to the machine, not any workspace; one cursor per session
 * file shared across all windows avoids double-push / gaps).
 *
 * Cursor advances ONLY after a successful POST (2xx). A failed push leaves the
 * cursor untouched so the same delta is retried next tick.
 */

export interface Cursor {
  tool: "claude" | "codex";
  sessionId: string;
  /** Claude: byte offset already read from the append-only JSONL. */
  lastByteOffset?: number;
  /** Codex: committed_total already accounted for (snapshot diff baseline). */
  lastCommittedTotal?: number;
  /** Codex: per-field committed baselines, so a delta can split into input/output/cached. */
  lastCommittedInput?: number;
  lastCommittedOutput?: number;
  lastCommittedCached?: number;
  /** Monotonic delta index within this session — idempotency key half. */
  lastSeq: number;
  /** Total tokens already pushed for this session (sanity / debugging). */
  cumTokens: number;
  /** mtime of the auth file at the time of the last processed delta. */
  lastAuthMtime?: number;
}

/** Minimal slice of vscode.Memento so this module is testable without vscode. */
export interface KeyValueStore {
  get<T>(key: string, def: T): T;
  update(key: string, value: unknown): Thenable<void> | Promise<void>;
}

const KEY = "tokenscope.central.cursors.v1";

export class CursorStore {
  private map: Record<string, Cursor>;

  constructor(private readonly store: KeyValueStore) {
    this.map = store.get<Record<string, Cursor>>(KEY, {});
  }

  static keyFor(tool: string, sessionId: string): string {
    return `${tool}:${sessionId}`;
  }

  get(tool: string, sessionId: string): Cursor | undefined {
    return this.map[CursorStore.keyFor(tool, sessionId)];
  }

  /** True the first time we see this session (used to seed at end-of-file, no backfill). */
  isNew(tool: string, sessionId: string): boolean {
    return !this.map[CursorStore.keyFor(tool, sessionId)];
  }

  set(cursor: Cursor): void {
    this.map[CursorStore.keyFor(cursor.tool, cursor.sessionId)] = cursor;
  }

  all(): Cursor[] {
    return Object.values(this.map);
  }

  /** Persist to backing store. Call after mutating (typically after a 2xx push). */
  flush(): Promise<void> | Thenable<void> {
    return this.store.update(KEY, this.map);
  }
}
