import { NotionError } from "../errors.js";

/**
 * One write inside `StateStore.batch()`: set `key` to `value`, or delete it when `value` is
 * undefined.
 */
export interface StateWrite {
  key: string;
  value?: string;
}

export interface StateStoreHealth {
  persistent: boolean;
  /** ISO time of the last successful write to storage. */
  lastFlushedAt?: string;
  /** Error code of the last failed write; cleared by the next successful one. */
  lastError?: string;
  /** Changes not yet written to storage. */
  pending: boolean;
}

/**
 * Pluggable persistence for the watch state (spec §1.1): the page tree, the last
 * Message Store version of every subscription key, and the activity cursor of every watched
 * page and data source. Values are opaque strings; `WatchState` gives them types.
 *
 * Implementations MUST write every `set` / `delete` / `batch` as one unit: after a crash storage
 * holds either the state before the call or the state after it, never part of it. A write MAY be
 * buffered briefly (`FileStateStore` debounces), so a crash can lose the last buffered writes,
 * but never tear one. Every method rejects with `STATE_STORE_UNAVAILABLE` when storage cannot be
 * read or written; a rejected write is not applied.
 */
export interface StateStore {
  /** true when state survives a process restart (enables restart backfill). */
  readonly persistent: boolean;
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  /** Applies several writes as one unit. */
  batch(writes: readonly StateWrite[]): Promise<void>;
  /** Keys starting with `prefix`, in no particular order. */
  keys(prefix: string): Promise<string[]>;
  /** Writes pending changes to storage now. */
  flush(): Promise<void>;
  /** Flushes and releases resources (file locks, timers). Later calls reject with `INVALID_STATE`. */
  close(): Promise<void>;
  health(): StateStoreHealth;
}

export function assertKey(key: unknown): asserts key is string {
  if (typeof key !== "string" || key.length === 0) throw new NotionError("INVALID_ARGUMENT", "state keys must be non-empty strings");
}

function assertValue(value: unknown): asserts value is string {
  if (typeof value !== "string") throw new NotionError("INVALID_ARGUMENT", "state values must be strings");
}

/**
 * In-memory store. State is lost when the process exits, so a restart re-walks the workspace and
 * cannot backfill what changed while it was down. Meant for tests and short-lived jobs.
 */
export class MemoryStateStore implements StateStore {
  readonly persistent: boolean = false;
  protected readonly data = new Map<string, string>();
  protected closed = false;

  async get(key: string): Promise<string | undefined> {
    await this.ready();
    assertKey(key);
    return this.data.get(key);
  }

  async set(key: string, value: string): Promise<void> {
    await this.batch([{ key, value }]);
  }

  async delete(key: string): Promise<void> {
    await this.batch([{ key }]);
  }

  async batch(writes: readonly StateWrite[]): Promise<void> {
    await this.ready();
    for (const w of writes) {
      assertKey(w.key);
      if (w.value !== undefined) assertValue(w.value);
    }
    if (writes.length === 0) return;
    const before = new Map<string, string | undefined>();
    for (const w of writes) {
      if (!before.has(w.key)) before.set(w.key, this.data.get(w.key));
      if (w.value === undefined) this.data.delete(w.key);
      else this.data.set(w.key, w.value);
    }
    const after = new Map(writes.map((w) => [w.key, w.value]));
    try {
      await this.changed();
    } catch (err) {
      // A rejected write is not applied, so callers can retry it without double effects. Keys a
      // later call has changed since are left alone.
      for (const [key, value] of before) {
        if (this.data.get(key) !== after.get(key)) continue;
        if (value === undefined) this.data.delete(key);
        else this.data.set(key, value);
      }
      throw err;
    }
  }

  async keys(prefix: string): Promise<string[]> {
    await this.ready();
    return [...this.data.keys()].filter((k) => k.startsWith(prefix));
  }

  async flush(): Promise<void> {
    await this.ready();
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  health(): StateStoreHealth {
    return { persistent: this.persistent, pending: false };
  }

  /** Resolves once the store can serve calls; persistent subclasses load here. */
  protected async ready(): Promise<void> {
    if (this.closed) throw new NotionError("INVALID_STATE", "the state store is closed");
  }

  /** Called after every applied write; persistent subclasses schedule a flush here. */
  protected async changed(): Promise<void> {}
}
