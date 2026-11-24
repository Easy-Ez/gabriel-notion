import { NotionError } from "../errors.js";
import type { StateStore, StateWrite } from "./store.js";

/** A node of the watched page tree (spec §9), as recorded by discovery. */
export interface PageTreeNode {
  id: string;
  /** `block` (pages, databases), `collection` (data sources), or a container: `space`, `space_view`, `team`, `shared`. */
  table: string;
  /** Block type or a finer kind, e.g. `page`, `collection_view_page`. */
  type?: string;
  parent?: { table: string; id: string };
  /** Child node IDs, in the parent's order. */
  children?: string[];
  /** Containers (workspace root, teamspace, private section, shared list): when the list was last read (ms). */
  checkedAt?: number;
}

/**
 * Where activity reads resume for one page or data source (spec §10). Activities are
 * newest first; `getActivityLog` with `endingBeforeId: latestActivityId` returns newer ones.
 * A merging activity keeps its ID and bumps its version, so the last few are kept with versions.
 */
export interface ActivityCursor {
  /** Newest activity read so far; empty until the first read. */
  latestActivityId: string;
  recent?: Array<{ id: string; version: number }>;
  /** When watching began (ms): older edits are history, not events. */
  since?: number;
  updatedAt?: string;
}

export const SEEN_EVENT_LIMIT = 10_000;

const TREE = "tree/";
const SUB = "sub/";
const CURSOR = "cursor/";
const SEEN = "seen";
const META = "meta/";

function parse<T>(raw: string | undefined, key: string): T | undefined {
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    throw new NotionError("STATE_STORE_UNAVAILABLE", `state entry ${key} is not valid JSON`, { cause: err });
  }
}

/**
 * Typed view of a `StateStore` for one workspace: page tree, subscription versions, activity
 * cursors and the recent event IDs used for de-duplication (spec §1.1, at least 10,000).
 * Keys are namespaced `notion/<workspaceId>/…`, so several workspaces can share one store.
 */
export class WatchState {
  private readonly ns: string;
  private seen?: { list: string[]; set: Set<string> };

  constructor(
    readonly store: StateStore,
    readonly workspaceId: string,
    private readonly seenLimit: number = SEEN_EVENT_LIMIT,
  ) {
    if (!workspaceId) throw new NotionError("INVALID_ARGUMENT", "WatchState needs a workspace ID");
    this.ns = `notion/${workspaceId}/`;
  }

  // ---- metadata ----

  /** Small named values, e.g. `aliveAt` (last time the watcher was known to run, ms). */
  async getMeta(name: string): Promise<string | undefined> {
    return this.store.get(this.ns + META + name);
  }

  async setMeta(name: string, value: string): Promise<void> {
    await this.store.set(this.ns + META + name, value);
  }

  // ---- page tree ----

  async getNode(id: string): Promise<PageTreeNode | undefined> {
    const key = this.ns + TREE + id;
    return parse<PageTreeNode>(await this.store.get(key), key);
  }

  async putNodes(nodes: readonly PageTreeNode[]): Promise<void> {
    await this.store.batch(nodes.map((n) => ({ key: this.ns + TREE + n.id, value: JSON.stringify(n) })));
  }

  async removeNodes(ids: readonly string[]): Promise<void> {
    await this.store.batch(ids.map((id) => ({ key: this.ns + TREE + id })));
  }

  async listNodes(): Promise<PageTreeNode[]> {
    const out: PageTreeNode[] = [];
    for (const key of await this.store.keys(this.ns + TREE)) {
      const node = parse<PageTreeNode>(await this.store.get(key), key);
      if (node) out.push(node);
    }
    return out;
  }

  // ---- subscription versions ----

  /** Last Message Store version per subscription key; -1 for keys that never had a frame. */
  async subscriptionVersions(): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    const prefix = this.ns + SUB;
    for (const key of await this.store.keys(prefix)) {
      const v = Number(await this.store.get(key));
      out.set(key.slice(prefix.length), Number.isFinite(v) ? v : -1);
    }
    return out;
  }

  async setSubscriptionVersions(entries: Iterable<readonly [string, number]>): Promise<void> {
    const writes: StateWrite[] = [];
    for (const [key, version] of entries) writes.push({ key: this.ns + SUB + key, value: String(version) });
    await this.store.batch(writes);
  }

  async removeSubscriptions(keys: readonly string[]): Promise<void> {
    await this.store.batch(keys.map((k) => ({ key: this.ns + SUB + k })));
  }

  // ---- activity cursors and seen events ----

  async getCursor(entityId: string): Promise<ActivityCursor | undefined> {
    const key = this.ns + CURSOR + entityId;
    return parse<ActivityCursor>(await this.store.get(key), key);
  }

  /** Gives entities that have no cursor yet an empty one starting at `since` (lazy baseline). */
  async initCursors(entityIds: readonly string[], since: number): Promise<string[]> {
    const created: string[] = [];
    const writes: StateWrite[] = [];
    for (const id of entityIds) {
      if (await this.getCursor(id)) continue;
      created.push(id);
      writes.push({ key: this.ns + CURSOR + id, value: JSON.stringify({ latestActivityId: "", since, updatedAt: new Date(since).toISOString() }) });
    }
    await this.store.batch(writes);
    return created;
  }

  /** Remembers event IDs produced outside an activity read (discovery, record diffs). */
  async markSeen(eventIds: readonly string[]): Promise<void> {
    const seen = await this.loadSeen();
    const list = [...seen.list];
    const set = new Set(seen.set);
    for (const id of eventIds) {
      if (set.has(id)) continue;
      set.add(id);
      list.push(id);
    }
    while (list.length > this.seenLimit) set.delete(list.shift()!);
    await this.store.batch([{ key: this.ns + SEEN, value: JSON.stringify(list) }]);
    this.seen = { list, set };
  }

  async hasSeenEvent(eventId: string): Promise<boolean> {
    return (await this.loadSeen()).set.has(eventId);
  }

  /**
   * Records that one activity read was processed: advances the cursor and remembers the event
   * IDs it produced, in one atomic write, so a crash can neither skip nor re-deliver them.
   */
  async commitActivity(entityId: string, cursor: ActivityCursor, eventIds: readonly string[] = []): Promise<void> {
    const seen = await this.loadSeen();
    const list = [...seen.list];
    const set = new Set(seen.set);
    for (const id of eventIds) {
      if (set.has(id)) continue;
      set.add(id);
      list.push(id);
    }
    while (list.length > this.seenLimit) set.delete(list.shift()!);
    const writes: StateWrite[] = [{ key: this.ns + CURSOR + entityId, value: JSON.stringify({ ...cursor, updatedAt: cursor.updatedAt ?? new Date().toISOString() }) }];
    if (eventIds.length > 0) writes.push({ key: this.ns + SEEN, value: JSON.stringify(list) });
    await this.store.batch(writes);
    this.seen = { list, set };
  }

  private async loadSeen(): Promise<{ list: string[]; set: Set<string> }> {
    if (!this.seen) {
      const key = this.ns + SEEN;
      const list = parse<unknown>(await this.store.get(key), key);
      const ids = Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : [];
      this.seen = { list: ids, set: new Set(ids) };
    }
    return this.seen;
  }
}
