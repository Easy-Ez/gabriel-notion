import { randomBytes } from "node:crypto";
import { chmod, mkdir, open, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { NotionError, isNotionError } from "../errors.js";
import { defaultConfigDir } from "../core/credentials.js";
import { silentLogger, type Logger } from "../util/logger.js";
import { MemoryStateStore, type StateStoreHealth } from "./store.js";

export interface FileStateStoreOptions {
  /**
   * The state file. Default: `state.json` in `$GABRIEL_NOTION_CONFIG_DIR`, else
   * `$XDG_CONFIG_HOME/gabriel-notion` (`~/.config/gabriel-notion`).
   */
  file?: string;
  /**
   * How long changes wait before they are written, so a burst of signals costs one write.
   * 0 writes every change before the call returns. Default 1,000 ms.
   */
  flushDelayMs?: number;
  logger?: Logger;
}

interface StoredState {
  format: 1;
  savedAt: string;
  entries: Record<string, string>;
}

const FORMAT = 1;

/** Files held by a store in this process; a second store on the same file is refused. */
const openFiles = new Set<string>();

export function defaultStateFile(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(defaultConfigDir(env), "state.json");
}

function unavailable(message: string, cause?: unknown): NotionError {
  return new NotionError("STATE_STORE_UNAVAILABLE", message, cause === undefined ? {} : { cause });
}

function isAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Persistent store in one local JSON file (spec §1.1), the default for
 * `NotionClient`. State lives in memory and is written as a whole snapshot: to a temporary file
 * in the same directory, flushed to disk, then renamed over the old file, so a crash leaves
 * either the previous snapshot or the new one and never half a file. Directory 0700, file 0600.
 *
 * One process at a time: a `<file>.lock` holding the owner's PID is taken on first use and
 * released by `close()`; a second process gets `STATE_STORE_UNAVAILABLE` while the owner is
 * alive, and a lock left by a crashed process is taken over.
 */
export class FileStateStore extends MemoryStateStore {
  override readonly persistent = true;
  readonly file: string;
  private readonly lockFile: string;
  private readonly flushDelayMs: number;
  private readonly logger: Logger;
  private loading?: Promise<void>;
  private locked = false;
  private dirty = false;
  private timer?: NodeJS.Timeout;
  private writing: Promise<void> = Promise.resolve();
  private lastFlushedAt?: string;
  private lastError?: string;

  constructor(opts: FileStateStoreOptions = {}) {
    super();
    const file = opts.file ?? defaultStateFile();
    if (typeof file !== "string" || file.length === 0 || file.includes("\0")) {
      throw new NotionError("INVALID_ARGUMENT", "FileStateStore.file must be a non-empty path");
    }
    this.file = path.resolve(file);
    this.lockFile = `${this.file}.lock`;
    this.flushDelayMs = Math.max(0, opts.flushDelayMs ?? 1_000);
    this.logger = opts.logger ?? silentLogger;
  }

  /** Loads the file and takes the lock now instead of on first use. */
  async open(): Promise<void> {
    await this.ready();
  }

  override async flush(): Promise<void> {
    await this.ready();
    await this.write();
  }

  override async close(): Promise<void> {
    if (this.closed) return;
    clearTimeout(this.timer);
    this.timer = undefined;
    try {
      if (this.locked) await this.write();
    } finally {
      this.closed = true;
      await this.releaseLock();
    }
  }

  override health(): StateStoreHealth {
    const h: StateStoreHealth = { persistent: true, pending: this.dirty };
    if (this.lastFlushedAt) h.lastFlushedAt = this.lastFlushedAt;
    if (this.lastError) h.lastError = this.lastError;
    return h;
  }

  protected override async ready(): Promise<void> {
    await super.ready();
    this.loading ??= this.load();
    try {
      await this.loading;
    } catch (err) {
      this.loading = undefined; // let a later call retry, e.g. once the other process exits
      throw err;
    }
  }

  protected override async changed(): Promise<void> {
    this.dirty = true;
    // After a failed write, try again right away so the caller learns the store is still down.
    if (this.flushDelayMs === 0 || this.lastError) {
      await this.write();
      return;
    }
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.write().catch(() => {
        /* recorded in lastError and logged by write() */
      });
    }, this.flushDelayMs);
    this.timer.unref?.();
  }

  private async load(): Promise<void> {
    const dir = path.dirname(this.file);
    try {
      await mkdir(dir, { recursive: true, mode: 0o700 });
    } catch (err) {
      throw unavailable(`cannot create ${dir}`, err);
    }
    await this.acquireLock();
    try {
      await this.removeStaleTemps(dir);
      let text: string | undefined;
      try {
        text = await readFile(this.file, "utf8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw unavailable(`cannot read ${this.file}`, err);
      }
      if (text === undefined) return;
      let parsed: Partial<StoredState>;
      try {
        parsed = JSON.parse(text) as Partial<StoredState>;
      } catch (err) {
        throw unavailable(`${this.file} is not valid JSON; move it away to start from an empty state`, err);
      }
      if (parsed.format !== FORMAT || typeof parsed.entries !== "object" || parsed.entries === null) {
        throw unavailable(`${this.file} has an unknown format; move it away to start from an empty state`);
      }
      for (const [k, v] of Object.entries(parsed.entries)) if (typeof v === "string") this.data.set(k, v);
    } catch (err) {
      await this.releaseLock();
      throw err;
    }
  }

  private async acquireLock(): Promise<void> {
    if (openFiles.has(this.file)) throw unavailable(`${this.file} is already open in this process`);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await writeFile(this.lockFile, String(process.pid), { flag: "wx", mode: 0o600 });
        this.locked = true;
        openFiles.add(this.file);
        return;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw unavailable(`cannot create ${this.lockFile}`, err);
      }
      const owner = Number((await readFile(this.lockFile, "utf8").catch(() => "")).trim());
      if (owner !== process.pid && isAlive(owner)) {
        throw unavailable(`${this.file} is in use by process ${owner}`);
      }
      // Left by a crashed process.
      await unlink(this.lockFile).catch(() => {});
    }
    throw unavailable(`cannot lock ${this.file}`);
  }

  private async releaseLock(): Promise<void> {
    if (!this.locked) return;
    this.locked = false;
    openFiles.delete(this.file);
    await unlink(this.lockFile).catch(() => {});
  }

  private async removeStaleTemps(dir: string): Promise<void> {
    const prefix = `${path.basename(this.file)}.`;
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (err) {
      throw unavailable(`cannot list ${dir}`, err);
    }
    for (const name of names) {
      if (name.startsWith(prefix) && name.endsWith(".tmp")) await unlink(path.join(dir, name)).catch(() => {});
    }
  }

  /** Serialized: one snapshot write at a time, each covering every change made before it. */
  private write(): Promise<void> {
    const next = this.writing.then(() => this.writeNow());
    this.writing = next.catch(() => {});
    return next;
  }

  private async writeNow(): Promise<void> {
    if (!this.dirty || !this.locked) return;
    clearTimeout(this.timer);
    this.timer = undefined;
    const body: StoredState = { format: FORMAT, savedAt: new Date().toISOString(), entries: Object.fromEntries(this.data) };
    this.dirty = false;
    const tmp = `${this.file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    try {
      const handle = await open(tmp, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify(body));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await chmod(tmp, 0o600);
      await rename(tmp, this.file);
      await this.syncDir();
      this.lastFlushedAt = body.savedAt;
      this.lastError = undefined;
    } catch (err) {
      this.dirty = true;
      await unlink(tmp).catch(() => {});
      const error = isNotionError(err) ? err : unavailable(`cannot write ${this.file}`, err);
      this.lastError = error.code;
      this.logger.error({ code: error.code }, "state store write failed");
      throw error;
    }
  }

  /** Makes the rename itself durable; not supported on every platform, so best effort. */
  private async syncDir(): Promise<void> {
    let handle;
    try {
      handle = await open(path.dirname(this.file), "r");
      await handle.sync();
    } catch {
      /* e.g. EISDIR / EPERM on platforms that cannot fsync a directory */
    } finally {
      await handle?.close().catch(() => {});
    }
  }
}
