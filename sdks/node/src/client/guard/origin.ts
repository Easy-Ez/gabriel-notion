import { AsyncLocalStorage } from "node:async_hooks";
import type { Operation, RecordEntry } from "../../core/records.js";
import { NotionError } from "../../errors.js";
import type { Activity, ActivityEdit } from "../events/normalize.js";

/**
 * Origin of the account's own edits (spec §11.1). Every transaction the SDK
 * submits registers the records it touches *before* it is sent, and the record versions its
 * read-back confirms. An activity edit by this account is `this_client` when its record carries
 * a version the SDK wrote; without version information, when the SDK made the same kind of
 * change to that record (locking, trashing or restoring) within a short window around the edit.
 * Everything else by this account is `self_other_client`.
 */

/** Edit timestamps are server time and close to the write; this allows for clock skew. */
const BEFORE_MS = 30_000;
const AFTER_MS = 30_000;
const TTL_MS = 10 * 60_000;
const MAX_ENTRIES = 20_000;

/** What a write changed, for edits that carry no record version: lock / unlock, trash / restore. */
type Aspect = "lock:true" | "lock:false" | "alive:true" | "alive:false" | "other";

interface Written {
  /** Writes registered for the record; each can be claimed by one edit (`claimedBy`). */
  at: Array<{ t: number; aspect: Aspect; claimedBy?: string }>;
  versions: Set<number>;
  last: number;
}

function aspectOf(op: Operation): Aspect {
  const args = op.args as Record<string, unknown> | undefined;
  const obj = args && typeof args === "object" && !Array.isArray(args) ? args : undefined;
  if (op.path[0] === "format" && obj && "block_locked" in obj) return obj.block_locked ? "lock:true" : "lock:false";
  if (op.path[0] === "alive") return args ? "alive:true" : "alive:false";
  if (obj && "alive" in obj) return obj.alive === false ? "alive:false" : "alive:true";
  return "other";
}

/** The aspect an edit without a version must match. */
function aspectOfEdit(type: string): Aspect | undefined {
  switch (type) {
    case "page-locked":
      return "lock:true";
    case "page-unlocked":
      return "lock:false";
    case "page-deleted":
      return "alive:false";
    case "page-restored":
      return "alive:true";
    default:
      return undefined;
  }
}

export class SelfWrites {
  private readonly written = new Map<string, Written>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Registers every record a transaction touches, before it is sent. */
  registerOperations(operations: readonly Operation[]): void {
    const t = this.now();
    for (const op of operations) {
      this.entry(op.pointer.id).at.push({ t, aspect: aspectOf(op) });
      const childId = (op.args as { id?: unknown } | undefined)?.id;
      if (typeof childId === "string" && (op.command === "listAfter" || op.command === "listBefore" || op.command === "listRemove")) this.entry(childId).at.push({ t, aspect: "other" });
    }
    this.prune();
  }

  /** Registers the versions a successful read-back confirmed. */
  registerVerified(records: Map<string, RecordEntry<unknown>>): void {
    for (const [key, e] of records) {
      const id = key.slice(key.indexOf(":") + 1);
      const v = Number((e.value as { version?: unknown } | undefined)?.version);
      if (Number.isFinite(v)) this.entry(id).versions.add(v);
    }
  }

  /** Whether an activity edit (already known to be by this account) is one of the SDK's writes. */
  isThisClient(activity: Activity, edit: ActivityEdit): boolean {
    const id = edit.block_id ?? edit.comment_id ?? edit.collection_row_id ?? edit.navigable_block_id ?? edit.collection_id ?? activity.navigable_block_id ?? activity.collection_id;
    if (!id) return false;
    const w = this.written.get(id);
    if (!w) return false;
    const after = edit.block_data?.after?.block_value ?? edit.block_data?.block_value ?? (edit.comment_data as { version?: unknown } | undefined);
    const version = Number((after as { version?: unknown } | undefined)?.version);
    if (w.versions.size > 0 && Number.isFinite(version)) return w.versions.has(version);
    return this.claim(w, Number(edit.timestamp ?? 0), aspectOfEdit(edit.type), `${activity.id}|${edit.type}|${edit.timestamp ?? ""}`);
  }

  /** For records found without an activity (discovery, record diffs): by version, else by time. */
  isThisClientRecord(id: string, version: number | undefined, editedAt: number): boolean {
    const w = this.written.get(id);
    if (!w) return false;
    if (w.versions.size > 0 && version !== undefined && Number.isFinite(version)) return w.versions.has(version);
    return this.claim(w, editedAt, undefined, `record|${id}|${version ?? ""}|${editedAt}`);
  }

  /**
   * Finds a write to the record near the edit's time (of the same kind when the edit names one)
   * that no other edit has claimed, and claims it. Re-reading the same edit finds its own claim.
   */
  private claim(w: Written, ts: number, aspect: Aspect | undefined, editKey: string): boolean {
    if (w.at.some((x) => x.claimedBy === editKey)) return true;
    const x = w.at.find((x) => !x.claimedBy && ts >= x.t - BEFORE_MS && ts <= x.t + AFTER_MS && (aspect === undefined || x.aspect === aspect));
    if (!x) return false;
    // Only version-less, kind-specific edits claim a write; generic ones (several block edits
    // from one transaction) may share it.
    if (aspect !== undefined) x.claimedBy = editKey;
    return true;
  }

  private entry(id: string): Written {
    let w = this.written.get(id);
    if (!w) {
      w = { at: [], versions: new Set(), last: this.now() };
      this.written.set(id, w);
    }
    w.last = this.now();
    if (w.at.length > 50) w.at.splice(0, w.at.length - 50);
    return w;
  }

  private prune(): void {
    if (this.written.size < MAX_ENTRIES) return;
    const cutoff = this.now() - TTL_MS;
    for (const [id, w] of this.written) if (w.last < cutoff) this.written.delete(id);
  }
}

// ------------------------------------------------------------------------------------------
// Loop guard

/** Set while an event handler runs (and in everything it awaits). */
export interface HandlerContext {
  eventId: string;
  entityId: string;
}

export const handlerContext = new AsyncLocalStorage<HandlerContext>();

/** Set by a write method for the duration of the write, naming the page it writes to. */
export const writeTarget = new AsyncLocalStorage<string>();

export interface LoopDetectedEvent {
  /** The page (or record) the handler kept writing to. */
  target: string;
  /** Writes counted in the window, including the refused one. */
  count: number;
  windowMs: number;
  /** The event whose handler made the write. */
  eventId: string;
}

/**
 * Writes made inside an event handler are limited per target page (default 5 per 60 s, as in
 * Gabriel); the next one fails with `LOOP_DETECTED` before anything is sent.
 */
export class LoopGuard {
  private readonly windows = new Map<string, number[]>();

  constructor(
    private readonly maxWrites: number,
    private readonly windowMs: number,
    private readonly onLoop: (e: LoopDetectedEvent) => void,
    private readonly now: () => number = Date.now,
  ) {}

  /** Counts a write to `target` if a handler is running; throws when over the limit. */
  check(target: string): void {
    const ctx = handlerContext.getStore();
    if (!ctx) return;
    const cutoff = this.now() - this.windowMs;
    const list = (this.windows.get(target) ?? []).filter((t) => t > cutoff);
    if (list.length >= this.maxWrites) {
      this.windows.set(target, list);
      const e: LoopDetectedEvent = { target, count: list.length + 1, windowMs: this.windowMs, eventId: ctx.eventId };
      this.onLoop(e);
      throw new NotionError("LOOP_DETECTED", `more than ${this.maxWrites} writes to ${target} from event handlers within ${this.windowMs / 1000} s`);
    }
    list.push(this.now());
    this.windows.set(target, list);
    if (this.windows.size > 5_000) for (const [k, v] of this.windows) if (v.every((t) => t <= cutoff)) this.windows.delete(k);
  }
}
