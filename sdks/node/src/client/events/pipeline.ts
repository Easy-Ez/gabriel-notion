import type { NotionCore } from "../../core/core.js";
import { normalizeEntry, type RecordPointer } from "../../core/records.js";
import { isNotionError, NotionError } from "../../errors.js";
import { silentLogger, type Logger } from "../../util/logger.js";
import { Semaphore } from "../../util/async.js";
import type { ActivityCursor, WatchState } from "../../state/watch-state.js";
import { editKey as keyOf, normalizeActivities, recordsToLoad, type Activity, type ActivityEdit, type LoadedRecord } from "./normalize.js";
import { diffRecord, type RecordDiffTable } from "./record-diff.js";
import type { NotionEvent, ProtocolDriftEvent } from "./types.js";

/**
 * Event pipeline (spec §8.3): Message Store signals open an activity window per page or
 * data source; the window reads `getActivityLog` at once (after a short coalescing delay), then
 * every 90 s, and closes after 10 minutes without change. Each read is normalized, filtered by
 * access, de-duplicated by edit key, delivered, and committed to the StateStore together with
 * the activity cursor.
 */

export type WatchKind = "page" | "data_source";

export interface WatchedEntity {
  id: string;
  kind: WatchKind;
}

/** Emitted at the end of every recovery (spec §10). */
export interface ConnectionGapEvent {
  kind: "reconnect" | "restart";
  /** When the SDK stopped seeing changes: the disconnect, or the last time the previous run was alive. */
  from: string;
  /** When the backfill finished. */
  to: string;
  /** true when every entity that changed meanwhile was read back without a gap. */
  recovered: boolean;
  /** Entities whose backfill failed, or whose activity cursor was out of reach. */
  failed: string[];
  /** Entities read back. */
  entities: number;
  /** Events delivered with `delivery: "backfill"`. */
  events: number;
}

export interface PipelineOptions {
  core: NotionCore;
  state: WatchState;
  workspaceId: string;
  selfUserId?: string;
  deliver: (event: NotionEvent) => void;
  gap?: (event: ConnectionGapEvent) => void;
  /** Origin guard (§11): whether an edit by this account came from this SDK instance. */
  isThisClient?: (activity: Activity, edit: ActivityEdit) => boolean;
  /** Same, for records found without an activity. */
  isThisClientRecord?: (id: string, version: number | undefined, editedAt: number) => boolean;
  drift?: (event: ProtocolDriftEvent) => void;
  logger?: Logger;
  /** Delay after an `activity/` signal, folding a burst into one read. Default 1,000 ms (as the web client). */
  coalesceMs?: number;
  /**
   * Delay after a record-level signal (`versions/`, `collection/`). The activity log is written
   * about 4 s after the record, so an earlier read misses edits merged into an open activity.
   * Default 5,000 ms.
   */
  recordSignalDelayMs?: number;
  /** Re-read period while a window is open. Default 90 s. */
  rereadMs?: number;
  /** A window closes after this long without a new signal or activity change. Default 10 min. */
  quietMs?: number;
  /** Activities per `getActivityLog` page. Default 20 (as the web client). */
  pageSize?: number;
  /** Pages to walk back looking for the cursor before reporting a gap. Default 10. */
  maxPages?: number;
  /** Activity reads in flight at once across all entities. Default 8. */
  maxConcurrentReads?: number;
  /** How long after a reconnect replayed signals are collected before the backfill. Default 5 s. */
  catchUpMs?: number;
  /** How often `aliveAt` is stored, so a restart knows where its gap began. Default 60 s. */
  aliveIntervalMs?: number;
  now?: () => number;
}

export interface ReadResult {
  events: number;
  /** The cursor was not found within `maxPages`: older activities may be missing. */
  gap: boolean;
}

interface Window {
  entity: WatchedEntity;
  lastChangeAt: number;
  /** Oldest signal not covered by a finished read. */
  pendingSince?: number;
  timer?: NodeJS.Timeout;
  /** When the scheduled read fires. */
  dueAt?: number;
  reading?: Promise<ReadResult>;
  again: boolean;
}

export interface PipelineHealth {
  watched: number;
  openWindows: number;
  /** Age of the oldest change not yet delivered, in seconds: pending signals, or the start of a running recovery. */
  lagSeconds: number;
  /** A recovery is collecting replayed signals or reading back. */
  recovering: boolean;
  lastGap?: ConnectionGapEvent;
  lastError?: { code: string; entityId: string; at: string };
}

interface Recovery {
  kind: ConnectionGapEvent["kind"];
  from: number;
  phase: "collecting" | "reading";
  entities: Set<string>;
  timer?: NodeJS.Timeout;
  events: number;
}

const KEY_RE = /^(versions|activity|collection)\/([0-9a-f-]{36})(?::([a-z_]+))?(?::[0-9a-f-]{36})?$/;

export function keysFor(entity: WatchedEntity): string[] {
  return entity.kind === "page"
    ? [`versions/${entity.id}:block`, `activity/${entity.id}`]
    : [`collection/${entity.id}`, `activity/${entity.id}`, `versions/${entity.id}:collection`];
}

export class EventPipeline {
  private readonly watched = new Map<string, WatchedEntity>();
  /** Records watched for record-level diffs (comments, views, data source schema). */
  private readonly watchedRecords = new Map<string, { table: RecordDiffTable; id: string; last?: Record<string, unknown> }>();
  private readonly windows = new Map<string, Window>();
  private readonly drifted = new Set<string>();
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly coalesceMs: number;
  private readonly recordSignalDelayMs: number;
  private readonly rereadMs: number;
  private readonly quietMs: number;
  private readonly pageSize: number;
  private readonly maxPages: number;
  private readonly reads: Semaphore;
  private offSignal?: () => void;
  private offDrift?: () => void;
  private running = false;
  private lastError?: PipelineHealth["lastError"];
  private readonly catchUpMs: number;
  private readonly aliveIntervalMs: number;
  private recovery?: Recovery;
  /** Live events held while a recovery runs, so backfilled events come first. */
  private held: NotionEvent[] = [];
  private lastGap?: ConnectionGapEvent;
  private readonly readyConnections = new Set<number>();
  private offConn: Array<() => void> = [];
  private aliveTimer?: NodeJS.Timeout;

  constructor(private readonly opts: PipelineOptions) {
    this.logger = opts.logger ?? silentLogger;
    this.now = opts.now ?? Date.now;
    this.coalesceMs = opts.coalesceMs ?? 1_000;
    this.recordSignalDelayMs = opts.recordSignalDelayMs ?? 5_000;
    this.rereadMs = opts.rereadMs ?? 90_000;
    this.quietMs = opts.quietMs ?? 10 * 60_000;
    this.pageSize = opts.pageSize ?? 20;
    this.maxPages = opts.maxPages ?? 10;
    this.reads = new Semaphore(Math.max(1, opts.maxConcurrentReads ?? 8));
    this.catchUpMs = opts.catchUpMs ?? 5_000;
    this.aliveIntervalMs = opts.aliveIntervalMs ?? 60_000;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const store = this.opts.core.messageStore;
    this.offSignal = store.on("signal", (s) => this.onSignal(s.key, s.version, s.initial === true));
    this.offDrift = store.on("protocol.drift", (d) => this.reportDrift(d.kind, d.sample));
    this.offConn = [
      store.on("connection.closed", (e) => {
        // A connection that was serving signals went away (not a deliberate close).
        if (e.code !== 1000 && this.readyConnections.has(e.connectionId)) this.beginRecovery("reconnect", this.now());
      }),
      store.on("connection.ready", (e) => {
        this.readyConnections.add(e.connectionId);
        if (e.reconnect && this.recovery) this.settleRecovery();
      }),
    ];
    this.aliveTimer = setInterval(() => void this.markAlive(), this.aliveIntervalMs);
    this.aliveTimer.unref?.();
  }

  /** Stops reading and stores the time, so the next start knows where its gap began. */
  async stop(): Promise<void> {
    const wasRunning = this.running;
    this.running = false;
    this.offSignal?.();
    this.offDrift?.();
    for (const off of this.offConn) off();
    this.offConn = [];
    clearInterval(this.aliveTimer);
    for (const w of this.windows.values()) clearTimeout(w.timer);
    this.windows.clear();
    if (this.recovery) clearTimeout(this.recovery.timer);
    this.recovery = undefined;
    this.held = [];
    if (wasRunning) await this.markAlive();
  }

  private async markAlive(): Promise<void> {
    await this.opts.state.setMeta("aliveAt", String(this.now())).catch((err) => this.fail("state", err));
  }

  /** Last time a previous run was known to be alive (ms), if any. */
  async lastAlive(): Promise<number | undefined> {
    const v = Number(await this.opts.state.getMeta("aliveAt"));
    return Number.isFinite(v) && v > 0 ? v : undefined;
  }

  // ---------------------------------------------------------------------------------------
  // Recovery (spec §10)

  /**
   * Starts collecting the entities that changed while the SDK could not see signals. After
   * resubscribing with the stored versions, the server sends one frame per key that changed
   * meanwhile; those entities, plus any with an open window, are read back with
   * `delivery: "backfill"` once `settleRecovery()` has given the replay time to arrive.
   */
  beginRecovery(kind: ConnectionGapEvent["kind"], from: number): void {
    if (!this.running) return;
    if (!this.recovery) {
      this.recovery = { kind, from, phase: "collecting", entities: new Set(), events: 0 };
      this.logger.info({ kind }, "recovering: collecting changes made while disconnected");
    } else {
      this.recovery.from = Math.min(this.recovery.from, from);
      if (this.recovery.phase === "reading") return;
    }
    for (const [id, w] of this.windows) {
      this.recovery.entities.add(id);
      clearTimeout(w.timer);
    }
    this.windows.clear();
  }

  /** Reads back what was collected, `catchUpMs` from now. */
  settleRecovery(delayMs: number = this.catchUpMs): void {
    const r = this.recovery;
    if (!r || r.phase !== "collecting") return;
    clearTimeout(r.timer);
    r.timer = setTimeout(() => void this.runRecovery(r), delayMs);
  }

  private async runRecovery(r: Recovery): Promise<void> {
    if (this.recovery !== r || !this.running) return;
    r.phase = "reading";
    const ids = [...r.entities].filter((id) => this.watched.has(id));
    const failed: string[] = [];
    await Promise.all(
      ids.map((id) =>
        this.reads.run(async () => {
          try {
            const res = await this.read(id, { delivery: "backfill" });
            if (res.gap) failed.push(id);
          } catch (err) {
            this.fail(id, err);
            failed.push(id);
          }
        }),
      ),
    );
    if (this.recovery !== r || !this.running) return;
    const gap: ConnectionGapEvent = {
      kind: r.kind,
      from: new Date(r.from).toISOString(),
      to: new Date(this.now()).toISOString(),
      recovered: failed.length === 0,
      failed: failed.sort(),
      entities: ids.length,
      events: r.events,
    };
    this.recovery = undefined;
    this.lastGap = gap;
    this.logger.info({ kind: gap.kind, recovered: gap.recovered, entities: gap.entities, events: gap.events, failed: failed.length }, "recovery finished");
    try {
      this.opts.gap?.(gap);
    } catch (err) {
      this.logger.error({ err: err instanceof Error ? err.name : "error" }, "gap handler threw");
    }
    const held = this.held;
    this.held = [];
    for (const e of held) this.emit(e);
    // Keep reading what just changed: its activity may still be merging.
    for (const id of ids) {
      const w = this.windows.get(id) ?? { entity: this.watched.get(id)!, lastChangeAt: this.now(), again: false };
      if (!w.entity) continue;
      w.lastChangeAt = this.now();
      this.windows.set(id, w);
      if (!w.reading) this.schedule(w, this.rereadMs);
    }
  }

  /** Delivers an event, holding live ones back while a recovery runs. */
  deliverEvent(event: NotionEvent): void {
    if (this.recovery && event.delivery === "live") {
      this.held.push(event);
      return;
    }
    if (this.recovery && event.delivery === "backfill") this.recovery.events++;
    this.emit(event);
  }

  /** Origin for a record found outside an activity read (discovery). */
  originOf(author: string | undefined, id: string, version: number | undefined, editedAt: number): NotionEvent["origin"] {
    if (!author || author !== this.opts.selfUserId) return "other_user";
    return this.opts.isThisClientRecord?.(id, version, editedAt) ? "this_client" : "self_other_client";
  }

  /** `delivery` for events found outside activity reads (discovery): backfill while recovering. */
  currentDelivery(): "live" | "backfill" {
    return this.recovery ? "backfill" : "live";
  }

  private emit(event: NotionEvent): void {
    try {
      this.opts.deliver(event);
    } catch (err) {
      this.logger.error({ type: event.type, err: err instanceof Error ? err.name : "error" }, "event handler threw");
    }
  }

  /**
   * Starts watching pages and data sources: subscribes their keys with the versions stored in
   * the StateStore. Entities seen for the first time get an empty cursor marked with the current
   * time; their first read treats older edits as history, so nothing is replayed and no read is
   * needed up front (cold start over thousands of pages).
   */
  async watch(entities: readonly WatchedEntity[], opts: { signal?: AbortSignal } = {}): Promise<void> {
    const fresh = entities.filter((e) => !this.watched.has(e.id));
    if (fresh.length === 0) return;
    const versions = await this.opts.state.subscriptionVersions();
    for (const e of fresh) this.watched.set(e.id, e);
    const keys = fresh.flatMap(keysFor).map((key) => ({ key, version: versions.get(key) ?? -1 }));
    await this.opts.core.subscribe(keys, opts);
    await this.opts.state.setSubscriptionVersions(keys.map((k) => [k.key, k.version] as const));
    await this.opts.state.initCursors(fresh.map((e) => e.id), this.now());
  }

  async unwatch(ids: readonly string[]): Promise<void> {
    const keys: string[] = [];
    for (const id of ids) {
      const e = this.watched.get(id);
      if (!e) continue;
      this.watched.delete(id);
      keys.push(...keysFor(e));
      const w = this.windows.get(id);
      if (w) clearTimeout(w.timer);
      this.windows.delete(id);
    }
    if (keys.length === 0) return;
    await this.opts.core.unsubscribe(keys);
    await this.opts.state.removeSubscriptions(keys);
  }

  /** Watches single records whose changes have no activity: comments, views, data source schema. */
  async watchRecords(records: ReadonlyArray<{ table: RecordDiffTable; id: string }>): Promise<void> {
    const keys: string[] = [];
    for (const r of records) {
      const k = `${r.table}:${r.id}`;
      if (this.watchedRecords.has(k)) continue;
      this.watchedRecords.set(k, { table: r.table, id: r.id });
      keys.push(r.table === "comment" ? `versions/${r.id}:comment:${this.opts.workspaceId}` : `versions/${r.id}:${r.table}`);
    }
    if (keys.length === 0) return;
    await this.opts.core.subscribe(keys);
    await this.seedRecords(records);
  }

  isWatching(id: string): boolean {
    return this.watched.has(id);
  }

  health(): PipelineHealth {
    const pending = [...this.windows.values()].map((w) => w.pendingSince).filter((t): t is number => t !== undefined);
    const oldest = pending.length > 0 ? Math.min(...pending) : undefined;
    const since = Math.min(oldest ?? Infinity, this.recovery?.from ?? Infinity);
    const h: PipelineHealth = {
      watched: this.watched.size,
      openWindows: this.windows.size,
      lagSeconds: Number.isFinite(since) ? Math.max(0, Math.round((this.now() - since) / 1000)) : 0,
      recovering: this.recovery !== undefined,
    };
    if (this.lastGap) h.lastGap = { ...this.lastGap, failed: [...this.lastGap.failed] };
    if (this.lastError) h.lastError = { ...this.lastError };
    return h;
  }

  /**
   * Handles one Message Store signal. An `initial` signal is the current state sent in reply to a
   * subscription with version -1: its version is stored, but it is not a change.
   */
  onSignal(key: string, version: number, initial = false): void {
    const m = KEY_RE.exec(key);
    if (!m) return;
    const [, kind, id, table] = m as unknown as [string, string, string, string | undefined];
    if (this.watched.has(id)) {
      void this.opts.state.setSubscriptionVersions([[key, version]]).catch((err) => this.fail(id, err));
    }
    if (initial) return;
    // While collecting a recovery, changed entities wait for the backfill read.
    if (this.recovery?.phase === "collecting" && this.watched.has(id)) {
      this.recovery.entities.add(id);
      return;
    }
    if (kind === "versions" && table && table !== "block" && this.watchedRecords.has(`${table}:${id}`)) {
      void this.readRecord(table as RecordDiffTable, id).catch((err) => this.fail(id, err));
      if (table !== "collection" || !this.watched.has(id)) return;
    }
    if (!this.watched.has(id)) return;
    this.touch(id, kind === "activity" ? this.coalesceMs : this.recordSignalDelayMs);
  }

  /** Opens or extends the entity's window and schedules a read `delayMs` from now (or earlier). */
  touch(id: string, delayMs: number = this.coalesceMs): void {
    const entity = this.watched.get(id);
    if (!entity || !this.running) return;
    let w = this.windows.get(id);
    const now = this.now();
    if (!w) {
      w = { entity, lastChangeAt: now, again: false };
      this.windows.set(id, w);
    }
    w.lastChangeAt = now;
    w.pendingSince ??= now;
    if (w.reading) {
      w.again = true;
      return;
    }
    if (w.dueAt === undefined || w.dueAt > now + delayMs) this.schedule(w, delayMs);
  }

  private schedule(w: Window, delay: number): void {
    clearTimeout(w.timer);
    w.dueAt = this.now() + delay;
    w.timer = setTimeout(() => void this.tick(w), delay);
  }

  private async tick(w: Window): Promise<void> {
    if (!this.running || this.windows.get(w.entity.id) !== w) return;
    const startedAt = this.now();
    w.again = false;
    w.dueAt = undefined;
    w.reading = this.reads.run(() => this.read(w.entity.id));
    let changed = false;
    try {
      const r = await w.reading;
      changed = r.events > 0;
      if (w.pendingSince !== undefined && w.pendingSince <= startedAt) w.pendingSince = undefined;
    } catch (err) {
      this.fail(w.entity.id, err);
    } finally {
      w.reading = undefined;
    }
    if (!this.running || this.windows.get(w.entity.id) !== w) return;
    const now = this.now();
    if (changed) w.lastChangeAt = now;
    if (w.again) {
      this.schedule(w, this.recordSignalDelayMs);
      return;
    }
    if (now - w.lastChangeAt >= this.quietMs) {
      this.windows.delete(w.entity.id);
      return;
    }
    this.schedule(w, Math.min(this.rereadMs, Math.max(0, w.lastChangeAt + this.quietMs - now)));
  }

  /**
   * Reads the entity's activities newer than (or merged into) its cursor and delivers their
   * events. `baseline` records the cursor and marks the edits as seen without delivering
   * (first watch); `delivery: "backfill"` marks events found while recovering (S11).
   */
  async read(id: string, opts: { baseline?: boolean; delivery?: "live" | "backfill" } = {}): Promise<ReadResult> {
    const entity = this.watched.get(id);
    if (!entity) return { events: 0, gap: false };
    const { core, state, workspaceId } = this.opts;
    const cursor = await state.getCursor(id);
    const scope = entity.kind === "page" ? { navigableBlock: { id, spaceId: workspaceId } } : { collections: [{ id, spaceId: workspaceId }] };

    const activities: Activity[] = [];
    let ids: string[] = [];
    const positioned = Boolean(cursor?.latestActivityId);
    let found = !positioned;
    let gap = false;
    let startingAfterId: string | undefined;
    for (let page = 0; page < this.maxPages; page++) {
      let res: { activityIds?: string[]; recordMap?: Record<string, Record<string, unknown>> };
      try {
        res = await core.callApi("getActivityLog", { spaceId: workspaceId, ...scope, limit: this.pageSize, ...(startingAfterId ? { startingAfterId } : {}) });
      } catch (err) {
        if (isNotionError(err) && (err.status === 400 || err.code === "PERMISSION_DENIED" || err.code === "NOT_FOUND")) {
          await this.checkAccess(entity);
        }
        throw err;
      }
      const pageIds = res.activityIds ?? [];
      for (const aid of pageIds) {
        const entry = normalizeEntry<Activity>(res.recordMap?.activity?.[aid]);
        if (!entry?.value) continue;
        const a = { ...entry.value, id: entry.value.id ?? aid };
        // `collections` reads also return unrelated activities; keep the data source's own.
        if (entity.kind === "data_source" && a.collection_id !== id && !(a.edits ?? []).some((e) => e.collection_id === id)) continue;
        activities.push(a);
      }
      ids = ids.concat(pageIds);
      if (positioned && pageIds.includes(cursor!.latestActivityId)) found = true;
      if (found || pageIds.length < this.pageSize) break;
      startingAfterId = pageIds[pageIds.length - 1];
    }
    if (!found) {
      gap = true;
      this.logger.warn({ entityId: id }, "activity cursor not found; older activities may be missing");
    }

    // Activities up to the cursor's position, plus recent ones whose version may have grown.
    const cutoff = positioned ? ids.indexOf(cursor!.latestActivityId) : -1;
    const recent = new Set((cursor?.recent ?? []).map((r) => r.id));
    const relevant = activities.filter((a) => {
      const i = ids.indexOf(a.id);
      return cutoff < 0 || i <= cutoff || recent.has(a.id);
    });
    const newest = activities[0];
    const nextCursor: ActivityCursor | undefined = newest
      ? { latestActivityId: newest.id, recent: activities.slice(0, 5).map((a) => ({ id: a.id, version: Number(a.version ?? 0) })), ...(cursor?.since !== undefined ? { since: cursor.since } : {}) }
      : cursor;

    if (opts.baseline || relevant.length === 0) {
      const keys = opts.baseline ? relevant.flatMap((a) => (a.edits ?? []).map((e) => keyOf(a, e))) : [];
      if (nextCursor) await state.commitActivity(id, nextCursor, keys);
      return { events: 0, gap };
    }

    const seen = await this.seenSet(relevant, cursor?.since);
    const records = await this.loadRecords(relevant);
    const result = normalizeActivities({
      workspaceId,
      activities: relevant,
      records: (table, rid) => records.get(`${table}:${rid}`),
      isSeen: (k) => seen.has(k),
      ...(this.opts.isThisClient ? { isThisClient: this.opts.isThisClient } : {}),
      delivery: opts.delivery ?? "live",
      ...(this.opts.selfUserId ? { selfUserId: this.opts.selfUserId } : {}),
    });
    for (const d of result.drift) this.reportDrift(d.kind, d.sample);
    for (const event of result.events) this.deliverEvent(event);
    if (nextCursor) await state.commitActivity(id, nextCursor, result.editKeys);
    if (result.noAccess.some((x) => x.id === id)) await this.dropNoAccess(entity);
    return { events: result.events.length, gap };
  }

  /** Edit keys already delivered, plus edits older than the moment watching began. */
  private async seenSet(activities: readonly Activity[], since?: number): Promise<Set<string>> {
    const out = new Set<string>();
    for (const a of activities) for (const e of a.edits ?? []) {
      const k = keyOf(a, e);
      if ((since !== undefined && Number(e.timestamp ?? 0) < since) || (await this.opts.state.hasSeenEvent(k))) out.add(k);
    }
    return out;
  }

  /** Loads the records the mapping needs, then the parent blocks of those records. */
  private async loadRecords(activities: readonly Activity[]): Promise<Map<string, LoadedRecord>> {
    const out = new Map<string, LoadedRecord>();
    const load = async (pointers: RecordPointer[]) => {
      const todo = pointers.filter((p) => !out.has(`${p.table}:${p.id}`));
      if (todo.length === 0) return;
      const got = await this.opts.core.getRecords(todo);
      for (const p of todo) {
        const e = got.get(`${p.table}:${p.id}`);
        out.set(`${p.table}:${p.id}`, e ? { role: e.role, value: e.value as Record<string, unknown> } : { role: "none" });
      }
    };
    await load(recordsToLoad(activities, this.opts.workspaceId));
    const parents: RecordPointer[] = [];
    for (const r of out.values()) {
      const v = r.value;
      if (v?.parent_table === "block" && typeof v.parent_id === "string") parents.push({ table: "block", id: v.parent_id, spaceId: this.opts.workspaceId });
      if (v?.parent_table === "collection" && typeof v.parent_id === "string") parents.push({ table: "collection", id: v.parent_id, spaceId: this.opts.workspaceId });
    }
    await load(parents);
    return out;
  }

  private async checkAccess(entity: WatchedEntity): Promise<void> {
    const table = entity.kind === "page" ? "block" : "collection";
    const got = await this.opts.core.getRecords([{ table, id: entity.id, spaceId: this.opts.workspaceId }]).catch(() => undefined);
    const e = got?.get(`${table}:${entity.id}`);
    if (got && (!e || e.role === "none")) await this.dropNoAccess(entity);
  }

  /** `role: "none"`: stop watching; signals for it would leak only timing anyway (spec §9). */
  private async dropNoAccess(entity: WatchedEntity): Promise<void> {
    this.logger.info({ entityId: entity.id }, "no access; unwatching");
    await this.unwatch([entity.id]);
  }

  private async seedRecords(records: ReadonlyArray<{ table: RecordDiffTable; id: string }>): Promise<void> {
    const got = await this.opts.core.getRecords(records.map((r) => ({ table: r.table, id: r.id, spaceId: this.opts.workspaceId })));
    for (const r of records) {
      const w = this.watchedRecords.get(`${r.table}:${r.id}`);
      const e = got.get(`${r.table}:${r.id}`);
      if (w && e && e.role !== "none" && e.value) w.last = e.value as Record<string, unknown>;
    }
  }

  private async readRecord(table: RecordDiffTable, id: string): Promise<void> {
    const w = this.watchedRecords.get(`${table}:${id}`);
    if (!w) return;
    const got = await this.opts.core.getRecords([{ table, id, spaceId: this.opts.workspaceId }]);
    const e = got.get(`${table}:${id}`);
    if (!e || e.role === "none" || !e.value) {
      this.watchedRecords.delete(`${table}:${id}`);
      return;
    }
    const next = e.value as Record<string, unknown>;
    const prev = w.last;
    w.last = next;
    if (!prev) return;
    const event = diffRecord({ table, id, before: prev, after: next, workspaceId: this.opts.workspaceId, ...(this.opts.selfUserId ? { selfUserId: this.opts.selfUserId } : {}) });
    if (!event) return;
    if (event.origin === "self_other_client" && this.opts.isThisClientRecord?.(id, Number(next.version), Number(next.last_edited_time ?? 0))) event.origin = "this_client";
    this.deliverEvent({ ...event, delivery: this.currentDelivery() });
  }

  private reportDrift(kind: string, sample?: string): void {
    if (this.drifted.has(kind)) return;
    this.drifted.add(kind);
    this.logger.warn({ kind }, "protocol drift");
    this.opts.drift?.({ kind, ...(sample ? { sample } : {}) });
  }

  private fail(entityId: string, err: unknown): void {
    const code = isNotionError(err) ? err.code : err instanceof NotionError ? err.code : "UNKNOWN";
    this.lastError = { code, entityId, at: new Date(this.now()).toISOString() };
    this.logger.warn({ entityId, code }, "event read failed");
  }
}
