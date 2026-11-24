import { NotionError } from "../errors.js";
import type { HttpClient } from "./http.js";
import { newRandomId } from "./ids.js";

/** The current identity's access to a record. */
export type Role = "editor" | "read_and_write" | "comment_only" | "reader" | "none";

export interface RecordPointer {
  table: string;
  id: string;
  /** Defaults to the bound workspace. Ignored for `notion_user`. */
  spaceId?: string;
}

export interface RecordEntry<T = Record<string, unknown>> {
  role: Role;
  /** Absent when `role` is "none": the server returns the role without content. */
  value?: T;
}

/** A transaction operation as the web client sends it to `saveTransactionsFanout`. */
export interface Operation {
  pointer: RecordPointer;
  path: Array<string | number>;
  command: string;
  args: unknown;
  /** Text operations (`insertText`, `deleteText`) carry `opVersion: 2`. */
  opVersion?: number;
}

/** Tables read through the main cell, without a workspace. */
const MAIN_CELL_TABLES = new Set(["notion_user"]);
/** 2,000 pointers per call worked and 5,000 returned 413; 1,000 leaves headroom. */
export const RECORD_BATCH_SIZE = 1000;

export const recordKey = (table: string, id: string): string => `${table}:${id}`;

/**
 * Record maps wrap entries as `{ value: <record>, role }` or, in newer responses,
 * `{ spaceId, value: { value: <record>, role } }`. Returns undefined when the entry is absent.
 */
export function normalizeEntry<T>(entry: unknown): RecordEntry<T> | undefined {
  if (!entry || typeof entry !== "object") return undefined;
  const e = entry as { value?: unknown; role?: unknown };
  const inner = e.value as { value?: unknown; role?: unknown } | undefined;
  if (inner && typeof inner === "object" && typeof inner.role === "string") {
    const out: RecordEntry<T> = { role: inner.role as Role };
    if (inner.value && typeof inner.value === "object") out.value = inner.value as T;
    return out;
  }
  if (typeof e.role === "string") {
    const out: RecordEntry<T> = { role: e.role as Role };
    if (inner && typeof inner === "object") out.value = inner as T;
    return out;
  }
  return undefined;
}

type SyncResponse = { recordMap?: Record<string, Record<string, unknown> | number | undefined> };

/**
 * Record access and transactions (spec §5): batched reads, role-aware lookups,
 * atomic transaction submit, and read-back verification for writes.
 */
export class Records {
  /** Called with the records a successful `verify` read back (used by the origin guard). */
  onVerified?: (records: Map<string, RecordEntry<unknown>>) => void;

  constructor(private readonly http: HttpClient) {}

  /**
   * Reads records in batches. The result has one entry per pointer key (`table:id`) that the
   * server returned; a key that is absent means "not in the response" (see `get`).
   */
  async getMany<T = Record<string, unknown>>(pointers: readonly RecordPointer[], signal?: AbortSignal): Promise<Map<string, RecordEntry<T>>> {
    const out = new Map<string, RecordEntry<T>>();
    const main = pointers.filter((p) => MAIN_CELL_TABLES.has(p.table));
    const spaced = pointers.filter((p) => !MAIN_CELL_TABLES.has(p.table));

    const run = async (endpoint: string, batch: readonly RecordPointer[], withSpace: boolean) => {
      const requests = batch.map((p) => ({
        pointer: withSpace ? { table: p.table, id: p.id, spaceId: p.spaceId ?? this.requireSpace() } : { table: p.table, id: p.id },
        version: -1,
      }));
      const resp = await this.http.call<SyncResponse>(endpoint, { requests }, signal ? { signal } : {});
      const map = resp?.recordMap ?? {};
      for (const p of batch) {
        const table = map[p.table];
        const entry = table && typeof table === "object" ? normalizeEntry<T>(table[p.id]) : undefined;
        if (entry) out.set(recordKey(p.table, p.id), entry);
      }
    };

    for (let i = 0; i < spaced.length; i += RECORD_BATCH_SIZE) await run("syncRecordValuesSpaceInitial", spaced.slice(i, i + RECORD_BATCH_SIZE), true);
    for (let i = 0; i < main.length; i += RECORD_BATCH_SIZE) await run("syncRecordValuesMain", main.slice(i, i + RECORD_BATCH_SIZE), false);
    return out;
  }

  /**
   * Reads one record and returns its content.
   * - `role: "none"` → NOT_FOUND. The server answers `role: "none"` both for records the identity
   *   cannot access and for IDs that do not exist (live check 2026-11-23), like the official API's
   *   `object_not_found`.
   * - absent from the response → the session is re-checked first (a dead session also returns
   *   200 without records); a valid session yields NOT_FOUND, a dead one AUTH_DEAD.
   */
  async get<T = Record<string, unknown>>(pointer: RecordPointer, signal?: AbortSignal): Promise<{ role: Role; value: T }> {
    const entry = (await this.getMany<T>([pointer], signal)).get(recordKey(pointer.table, pointer.id));
    if (entry?.role === "none" || (entry && entry.value === undefined)) {
      throw new NotionError("NOT_FOUND", `${pointer.table} ${pointer.id} does not exist or is not accessible`);
    }
    if (!entry) {
      const state = await this.http.session.confirm("missing_record");
      if (state === "AUTH_DEAD") this.http.session.assertUsable();
      throw new NotionError("NOT_FOUND", `${pointer.table} ${pointer.id} was not found`);
    }
    return { role: entry.role, value: entry.value as T };
  }

  /** Submits one transaction; it applies atomically or not at all. */
  async submit(operations: readonly Operation[], opts: { userAction?: string; spaceId?: string; signal?: AbortSignal } = {}): Promise<void> {
    if (operations.length === 0) throw new NotionError("INVALID_ARGUMENT", "a transaction needs at least one operation");
    const spaceId = opts.spaceId ?? this.requireSpace();
    const transaction: Record<string, unknown> = {
      id: newRandomId(),
      spaceId,
      operations: operations.map((op) => ({ ...op, pointer: { ...op.pointer, spaceId: op.pointer.spaceId ?? spaceId } })),
    };
    if (opts.userAction) transaction.debug = { userAction: opts.userAction };
    await this.http.call("saveTransactionsFanout", { requestId: newRandomId(), transactions: [transaction] }, { spaceId, ...(opts.signal ? { signal: opts.signal } : {}) });
  }

  /**
   * Reads records back after a write and checks them. A 200 from the server does not prove the
   * write took effect (three such cases are known), so every write
   * method verifies before returning. Fails with WRITE_NOT_APPLIED when a check does not hold.
   */
  async verify<T = Record<string, unknown>>(
    checks: ReadonlyArray<{ pointer: RecordPointer; holds: (value: T | undefined) => boolean; describe: string }>,
    signal?: AbortSignal,
  ): Promise<Map<string, RecordEntry<T>>> {
    const records = await this.getMany<T>(checks.map((c) => c.pointer), signal);
    const failed = checks.filter((c) => !c.holds(records.get(recordKey(c.pointer.table, c.pointer.id))?.value));
    if (failed.length > 0) {
      throw new NotionError("WRITE_NOT_APPLIED", `the write returned 200 but did not take effect: ${failed.map((c) => c.describe).join("; ")}`);
    }
    this.onVerified?.(records as Map<string, RecordEntry<unknown>>);
    return records;
  }

  private requireSpace(): string {
    const space = this.http.workspace();
    if (!space) throw new NotionError("INVALID_STATE", "no workspace is bound; call bindWorkspace() first");
    return space;
  }
}
