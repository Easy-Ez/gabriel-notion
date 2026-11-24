import type { NotionCore } from "../../core/core.js";
import type { RecordEntry } from "../../core/records.js";
import { isNotionError } from "../../errors.js";
import { silentLogger, type Logger } from "../../util/logger.js";
import type { PageTreeNode, WatchState } from "../../state/watch-state.js";
import { eventId, parentOf, type LoadedRecord } from "../events/normalize.js";
import type { EventPipeline, WatchedEntity } from "../events/pipeline.js";
import type { NotionEvent } from "../events/types.js";

/**
 * Watch scope and discovery (spec §9). Walks the page tree from its roots, keeps it in the
 * StateStore, watches every page, database and data source in it, and follows new content:
 *
 * | New content in | Signal key | Read |
 * | --- | --- | --- |
 * | a watched page | `versions/<page>:block` | the page's `content`, through non-page blocks |
 * | a teamspace root | `versions/<team>:team` | `team.team_pages` |
 * | the private section | `versions/<spaceView>:space_view` | `space_view.private_pages` |
 * | the workspace root | `versions/<space>:space` | `space.pages` |
 * | shared with me | `user_shared_pages_in_space/<space>-<user>` | `getUserSharedPagesInSpace` |
 * | a new teamspace | `teams_in_space_v2/<space>` | `getTeamsV2` |
 *
 * Database rows are not watched one by one; their changes come through the data source.
 */

export type WatchOptions =
  | { mode: "workspace"; rescanIntervalMs?: number }
  /** Only these pages and databases and everything under them. */
  | { mode: "explicit"; roots: string[]; rescanIntervalMs?: number };

export const DEFAULT_RESCAN_INTERVAL_MS = 6 * 60 * 60_000;

export interface DiscoveryOptions {
  core: NotionCore;
  state: WatchState;
  pipeline: EventPipeline;
  workspaceId: string;
  userId: string;
  watch: WatchOptions;
  logger?: Logger;
  /** Delay that folds a burst of container or page signals into one read. Default 2,000 ms. */
  signalDelayMs?: number;
  now?: () => number;
}

export interface DiscoveryHealth {
  mode: WatchOptions["mode"];
  pages: number;
  dataSources: number;
  containers: number;
  scanning: boolean;
  scans: number;
  lastScanAt?: string;
  lastError?: { code: string; at: string };
}

type ContainerTable = "space" | "space_view" | "team" | "shared";

const PAGE = "page";
const DB_TYPES = new Set(["collection_view", "collection_view_page"]);
/** A page counts as newly created when it was created this close to (or after) the last check. */
const CREATED_SLACK_MS = 60_000;
const READ_BATCH = 1_000;
/** Parallel record reads while walking; reads of about 250/s were not throttled when measured. */
const READ_CONCURRENCY = 4;

interface Crawl {
  nodes: Map<string, PageTreeNode>;
  records: Map<string, LoadedRecord>;
}

function isEntityNode(n: PageTreeNode): boolean {
  return n.table === "block" || n.table === "collection";
}

export class Discovery {
  private readonly tree = new Map<string, PageTreeNode>();
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly signalDelayMs: number;
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private rescanTimer?: NodeJS.Timeout;
  private offSignal?: () => void;
  private running = false;
  private scanning: Promise<void> | undefined;
  private scans = 0;
  private lastScanAt?: number;
  private lastError?: DiscoveryHealth["lastError"];
  private spaceViewId?: string;

  constructor(private readonly opts: DiscoveryOptions) {
    this.logger = opts.logger ?? silentLogger;
    this.now = opts.now ?? Date.now;
    this.signalDelayMs = opts.signalDelayMs ?? 2_000;
  }

  /**
   * Cold start (empty tree): walks everything from the roots and watches it, without events.
   * Warm start: watches the stored tree at once, then corrects it in the background.
   */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const stored = await this.opts.state.listNodes();
    for (const n of stored) this.tree.set(n.id, n);
    this.offSignal = this.opts.core.messageStore.on("signal", (s) => this.onSignal(s.key, s.version, s.initial === true));
    if (stored.length === 0) {
      await this.scan({ emit: false });
    } else {
      // Restart: what changed while no process watched comes back as replayed signals when the
      // stored versions are resubscribed; the pipeline backfills those entities (spec §10).
      this.opts.pipeline.beginRecovery("restart", (await this.opts.pipeline.lastAlive()) ?? this.now());
      await this.opts.pipeline.watch(this.entities([...this.tree.values()]));
      await this.subscribeContainers();
      this.opts.pipeline.settleRecovery();
      const checked = stored.map((n) => n.checkedAt).filter((t): t is number => typeof t === "number");
      if (checked.length > 0) this.lastScanAt = Math.min(...checked);
      void this.rescan();
    }
    const every = this.opts.watch.rescanIntervalMs ?? DEFAULT_RESCAN_INTERVAL_MS;
    if (every > 0) {
      this.rescanTimer = setInterval(() => void this.rescan(), every);
      this.rescanTimer.unref?.();
    }
  }

  stop(): void {
    this.running = false;
    this.offSignal?.();
    clearInterval(this.rescanTimer);
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  health(): DiscoveryHealth {
    let pages = 0;
    let dataSources = 0;
    let containers = 0;
    for (const n of this.tree.values()) {
      if (n.table === "block") pages++;
      else if (n.table === "collection") dataSources++;
      else containers++;
    }
    const h: DiscoveryHealth = { mode: this.opts.watch.mode, pages, dataSources, containers, scanning: this.scanning !== undefined, scans: this.scans };
    if (this.lastScanAt) h.lastScanAt = new Date(this.lastScanAt).toISOString();
    if (this.lastError) h.lastError = { ...this.lastError };
    return h;
  }

  /** The background correction (default every 6 h): walks again and reconciles the tree. */
  rescan(): Promise<void> {
    return this.scan({ emit: true }).catch((err) => this.fail(err));
  }

  // ---------------------------------------------------------------------------------------
  // Full scans

  private scan(opts: { emit: boolean }): Promise<void> {
    this.scanning ??= this.doScan(opts).finally(() => {
      this.scanning = undefined;
    });
    return this.scanning;
  }

  private async doScan(opts: { emit: boolean }): Promise<void> {
    const startedAt = this.now();
    const containers = this.opts.watch.mode === "workspace" ? await this.readContainers() : [];
    const roots = this.opts.watch.mode === "explicit" ? this.opts.watch.roots : containers.flatMap((c) => c.children ?? []);
    const crawl = await this.crawl(roots, new Set());
    const next = new Map<string, PageTreeNode>();
    for (const c of containers) next.set(c.id, { ...c, checkedAt: startedAt });
    for (const n of crawl.nodes.values()) next.set(n.id, n);

    const added = [...next.values()].filter((n) => !this.tree.has(n.id));
    const removed = [...this.tree.values()].filter((n) => !next.has(n.id));
    const changed = [...next.values()].filter((n) => this.tree.has(n.id) && JSON.stringify(this.tree.get(n.id)) !== JSON.stringify(n));
    const since = this.lastScanAt ?? startedAt;
    this.tree.clear();
    for (const n of next.values()) this.tree.set(n.id, n);

    await this.opts.state.putNodes([...added, ...changed]);
    if (removed.length > 0) await this.opts.state.removeNodes(removed.map((n) => n.id));
    await this.opts.pipeline.watch(this.entities(added));
    const gone = removed.filter(isEntityNode).map((n) => n.id);
    if (gone.length > 0) await this.opts.pipeline.unwatch(gone);
    await this.subscribeContainers();
    if (opts.emit) {
      // Pages under a watched page are reported by its activity; only container roots have none.
      const fresh = added.filter((n) => n.table === "block" && this.isContainerChild(n));
      await this.emitCreated(fresh, crawl.records, since, "backfill");
    }
    this.scans++;
    this.lastScanAt = startedAt;
    this.logger.info({ pages: this.health().pages, added: added.length, removed: removed.length }, "page tree scanned");
  }

  // ---------------------------------------------------------------------------------------
  // Containers (workspace mode)

  private async readContainers(): Promise<PageTreeNode[]> {
    const { core, workspaceId: space, userId } = this.opts;
    const out: PageTreeNode[] = [];
    const spaceRec = (await core.getRecords([{ table: "space", id: space, spaceId: space }])).get(`space:${space}`);
    out.push({ id: space, table: "space", children: this.readable(spaceRec, "pages") });
    const sv = await this.findSpaceView();
    if (sv) out.push({ id: String(sv.id), table: "space_view", children: Array.isArray(sv.private_pages) ? (sv.private_pages as string[]) : [] });
    for (const team of await this.readTeams()) out.push(team);
    out.push({ id: `${space}-${userId}`, table: "shared", children: await this.readShared() });
    return out;
  }

  private readable(entry: RecordEntry | undefined, field: string): string[] {
    if (!entry || entry.role === "none" || !entry.value) return [];
    const v = (entry.value as Record<string, unknown>)[field];
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  }

  private async findSpaceView(): Promise<Record<string, unknown> | undefined> {
    const resp = await this.opts.core.callApi<Record<string, { space_view?: Record<string, unknown> }>>("getSpaces", {}, { spaceId: null });
    for (const e of Object.values(resp?.[this.opts.userId]?.space_view ?? {})) {
      const raw = e as { value?: { value?: Record<string, unknown> } & Record<string, unknown> };
      const v = (raw.value?.value ?? raw.value) as Record<string, unknown> | undefined;
      if (v?.space_id === this.opts.workspaceId && v.alive !== false) {
        this.spaceViewId = v.id as string;
        return v;
      }
    }
    return undefined;
  }

  /** Joined and unjoined active teamspaces the account can read (closed ones have role none). */
  private async readTeams(): Promise<PageTreeNode[]> {
    const resp = await this.opts.core.callApi<{ teams?: Array<{ id: string }>; recordMap?: { team?: Record<string, unknown> } }>("getTeamsV2", {
      spaceId: this.opts.workspaceId,
      teamTypes: ["Joined", "UnjoinedActive"],
    });
    const out: PageTreeNode[] = [];
    for (const t of resp.teams ?? []) {
      const raw = resp.recordMap?.team?.[t.id] as { value?: { value?: Record<string, unknown>; role?: string } } | undefined;
      const role = raw?.value?.role;
      const v = raw?.value?.value;
      if (!v || !role || role === "none") continue;
      out.push({ id: t.id, table: "team", children: Array.isArray(v.team_pages) ? (v.team_pages as string[]) : [] });
    }
    return out;
  }

  private async readShared(): Promise<string[]> {
    const resp = await this.opts.core.callApi<{ pages?: string[] }>("getUserSharedPagesInSpace", { spaceId: this.opts.workspaceId });
    return (resp.pages ?? []).filter((x) => typeof x === "string");
  }

  private containerKeys(): string[] {
    if (this.opts.watch.mode !== "workspace") return [];
    const { workspaceId: space, userId } = this.opts;
    const keys = [`teams_in_space_v2/${space}`, `user_shared_pages_in_space/${space}-${userId}`, `versions/${space}:space`];
    if (this.spaceViewId) keys.push(`versions/${this.spaceViewId}:space_view`);
    for (const n of this.tree.values()) if (n.table === "team") keys.push(`versions/${n.id}:team`);
    return keys;
  }

  private async subscribeContainers(): Promise<void> {
    if (this.opts.watch.mode === "workspace" && !this.spaceViewId) {
      const sv = [...this.tree.values()].find((n) => n.table === "space_view");
      if (sv) this.spaceViewId = sv.id;
    }
    const keys = this.containerKeys();
    if (keys.length === 0) return;
    const versions = await this.opts.state.subscriptionVersions();
    await this.opts.core.subscribe(keys.map((key) => ({ key, version: versions.get(key) ?? -1 })));
  }

  // ---------------------------------------------------------------------------------------
  // Signals

  private onSignal(key: string, version: number, initial: boolean): void {
    if (!this.running) return;
    const m = /^(versions|teams_in_space_v2|user_shared_pages_in_space)\/([^:]+)(?::([a-z_]+))?$/.exec(key);
    if (!m) return;
    const [, kind, id, table] = m as unknown as [string, string, string, string | undefined];
    let job: (() => Promise<void>) | undefined;
    if (kind === "teams_in_space_v2" && id === this.opts.workspaceId) job = () => this.refreshTeams();
    else if (kind === "user_shared_pages_in_space") job = () => this.refreshContainer(id, "shared");
    else if (kind === "versions" && table === "space" && id === this.opts.workspaceId) job = () => this.refreshContainer(id, "space");
    else if (kind === "versions" && table === "space_view" && id === this.spaceViewId) job = () => this.refreshContainer(id, "space_view");
    else if (kind === "versions" && table === "team" && this.tree.get(id)?.table === "team") job = () => this.refreshContainer(id, "team");
    else if (kind === "versions" && table === "block" && this.tree.get(id)?.table === "block") job = () => this.expand(id);
    if (!job) return;
    // Page keys are stored by the pipeline; container keys here.
    if (!(kind === "versions" && table === "block")) void this.opts.state.setSubscriptionVersions([[key, version]]).catch(() => {});
    if (initial) return; // current state in reply to subscribing, not a change
    this.debounce(key, job);
  }

  private debounce(key: string, job: () => Promise<void>): void {
    clearTimeout(this.timers.get(key));
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        if (this.running) void job().catch((err) => this.fail(err));
      }, this.signalDelayMs),
    );
  }

  /** A watched page changed: look for child pages and databases it did not have before. */
  private async expand(pageId: string): Promise<void> {
    const node = this.tree.get(pageId);
    if (!node || node.table !== "block") return;
    const known = new Set([...this.tree.keys()].filter((id) => id !== pageId));
    const crawl = await this.crawl([pageId], known);
    const fresh = crawl.nodes.get(pageId);
    if (!fresh) return; // no longer readable or not alive; the pipeline reports it
    await this.adopt(crawl, [pageId]);
  }

  private async refreshContainer(id: string, table: ContainerTable): Promise<void> {
    let children: string[];
    if (table === "shared") children = await this.readShared();
    else if (table === "team") {
      const t = (await this.opts.core.getRecords([{ table: "team", id, spaceId: this.opts.workspaceId }])).get(`team:${id}`);
      children = this.readable(t, "team_pages");
    } else if (table === "space") {
      children = this.readable((await this.opts.core.getRecords([{ table: "space", id, spaceId: id }])).get(`space:${id}`), "pages");
    } else {
      const sv = await this.findSpaceView();
      children = Array.isArray(sv?.private_pages) ? (sv!.private_pages as string[]) : [];
    }
    const nodeId = table === "shared" ? `${this.opts.workspaceId}-${this.opts.userId}` : id;
    const prev = this.tree.get(nodeId) ?? { id: nodeId, table, children: [] };
    const before = new Set(prev.children ?? []);
    const since = prev.checkedAt ?? this.lastScanAt ?? this.now();
    const node: PageTreeNode = { ...prev, children, checkedAt: this.now() };
    this.tree.set(nodeId, node);
    await this.opts.state.putNodes([node]);
    const added = children.filter((c) => !before.has(c) && !this.tree.has(c));
    if (added.length === 0) return;
    const crawl = await this.crawl(added, new Set(this.tree.keys()));
    const newNodes = await this.adopt(crawl, []);
    await this.emitCreated(newNodes.filter((n) => added.includes(n.id)), crawl.records, since, this.opts.pipeline.currentDelivery());
  }

  private async refreshTeams(): Promise<void> {
    const teams = await this.readTeams();
    const fresh = teams.filter((t) => !this.tree.has(t.id));
    for (const t of fresh) {
      this.tree.set(t.id, { ...t, checkedAt: this.now() });
    }
    if (fresh.length === 0) return;
    await this.opts.state.putNodes(fresh);
    await this.subscribeContainers();
    const pages = fresh.flatMap((t) => t.children ?? []).filter((c) => !this.tree.has(c));
    if (pages.length === 0) return;
    const crawl = await this.crawl(pages, new Set(this.tree.keys()));
    await this.adopt(crawl, []);
  }

  /** Adds crawled nodes to the tree, persists them and starts watching the new entities. */
  private async adopt(crawl: Crawl, refresh: string[]): Promise<PageTreeNode[]> {
    const added: PageTreeNode[] = [];
    const changed: PageTreeNode[] = [];
    for (const n of crawl.nodes.values()) {
      const prev = this.tree.get(n.id);
      if (!prev) added.push(n);
      else if (refresh.includes(n.id) && JSON.stringify(prev) !== JSON.stringify(n)) changed.push(n);
      else continue;
      this.tree.set(n.id, n);
    }
    if (added.length + changed.length > 0) await this.opts.state.putNodes([...added, ...changed]);
    if (added.length > 0) await this.opts.pipeline.watch(this.entities(added));
    return added;
  }

  // ---------------------------------------------------------------------------------------
  // Crawling

  /**
   * Reads `ids` and everything under them: pages and databases become nodes, other blocks are
   * walked through (columns, toggles, synced blocks) for the pages nested in them. IDs in `known`
   * are recorded as children but not descended into.
   */
  private async crawl(ids: readonly string[], known: ReadonlySet<string>): Promise<Crawl> {
    const nodes = new Map<string, PageTreeNode>();
    const records = new Map<string, LoadedRecord>();
    const visited = new Set<string>();
    let frontier: Array<{ id: string; within?: string }> = ids.map((id) => ({ id }));
    let rounds = 0;
    let read = 0;
    while (frontier.length > 0) {
      const batch = frontier.filter((f) => !visited.has(f.id));
      frontier = [];
      if (batch.length === 0) break;
      for (const f of batch) visited.add(f.id);
      const got = await this.readMany("block", batch.map((f) => f.id));
      read += batch.length;
      this.logger.debug({ round: ++rounds, blocks: batch.length, read, nodes: nodes.size }, "walking the page tree");
      const dataSources: string[] = [];
      for (const f of batch) {
        const e = got.get(`block:${f.id}`);
        if (!e || e.role === "none" || !e.value) continue;
        const v = e.value as Record<string, unknown>;
        const type = String(v.type ?? "");
        const content = Array.isArray(v.content) ? (v.content as string[]) : [];
        const isEntity = type === PAGE || DB_TYPES.has(type) || f.within === undefined;
        // Full records only for pages and databases (parents, events); a large workspace has
        // millions of other blocks, of which only the shape is needed.
        records.set(`block:${f.id}`, { role: e.role, value: isEntity ? v : { type, alive: v.alive, content } });
        if (v.alive === false) continue;
        if (!isEntity) {
          for (const c of content) frontier.push({ id: c, within: f.within! });
          continue;
        }
        if (f.within) nodes.get(f.within)?.children?.push(f.id);
        if (known.has(f.id) && !ids.includes(f.id)) continue; // already in the tree: listed as a child only
        const node: PageTreeNode = { id: f.id, table: "block", type, children: [] };
        if (typeof v.parent_id === "string" && typeof v.parent_table === "string") node.parent = { table: v.parent_table, id: v.parent_id };
        nodes.set(f.id, node);
        if (DB_TYPES.has(type) && typeof v.collection_id === "string") {
          node.children!.push(v.collection_id);
          dataSources.push(v.collection_id);
        }
        if (type === PAGE || f.within === undefined) for (const c of content) frontier.push({ id: c, within: f.id });
      }
      if (dataSources.length > 0) {
        const cols = await this.readMany("collection", dataSources);
        for (const id of dataSources) {
          const e = cols.get(`collection:${id}`);
          if (!e || e.role === "none" || !e.value) continue;
          const v = e.value as Record<string, unknown>;
          records.set(`collection:${id}`, { role: e.role, value: v });
          if (v.alive === false || known.has(id)) continue;
          nodes.set(id, { id, table: "collection", type: "data_source", parent: { table: String(v.parent_table ?? "block"), id: String(v.parent_id ?? "") } });
        }
      }
    }
    // Children in document order (the walk above is breadth-first).
    for (const node of nodes.values()) {
      if (node.table !== "block" || node.type !== PAGE) continue;
      const order: string[] = [];
      const walk = (blockId: string, depth: number) => {
        const v = records.get(`block:${blockId}`)?.value;
        for (const c of Array.isArray(v?.content) ? (v!.content as string[]) : []) {
          const cv = records.get(`block:${c}`)?.value;
          if (!cv || cv.alive === false) continue;
          const t = String(cv.type ?? "");
          if (t === PAGE || DB_TYPES.has(t)) order.push(c);
          else if (depth < 50) walk(c, depth + 1);
        }
      };
      walk(node.id, 0);
      const have = new Set(node.children);
      node.children = order.filter((c) => have.has(c));
    }
    return { nodes, records };
  }

  /** Reads records in batches of 1,000, up to `READ_CONCURRENCY` batches at a time. */
  private async readMany(table: string, ids: readonly string[]): Promise<Map<string, RecordEntry>> {
    const out = new Map<string, RecordEntry>();
    const chunks: string[][] = [];
    for (let i = 0; i < ids.length; i += READ_BATCH) chunks.push(ids.slice(i, i + READ_BATCH));
    let next = 0;
    const worker = async () => {
      while (next < chunks.length) {
        const chunk = chunks[next++]!;
        const got = await this.opts.core.getRecords(chunk.map((id) => ({ table, id, spaceId: this.opts.workspaceId })));
        for (const [k, v] of got) out.set(k, v);
      }
    };
    await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, chunks.length) }, worker));
    return out;
  }

  private entities(nodes: readonly PageTreeNode[]): WatchedEntity[] {
    const out: WatchedEntity[] = [];
    for (const n of nodes) {
      if (n.table === "block") out.push({ id: n.id, kind: "page" });
      else if (n.table === "collection") out.push({ id: n.id, kind: "data_source" });
    }
    return out;
  }

  private isContainerChild(n: PageTreeNode): boolean {
    for (const c of this.tree.values()) if (!isEntityNode(c) && c.children?.includes(n.id)) return true;
    return false;
  }

  /**
   * `page.created` / `database.created` for pages that appeared at a container root (workspace
   * root, teamspace root, private section, shared with me), which have no activity of their own
   * to report them. Pages created before `since` (moved in, or shared long after creation) are
   * watched without an event.
   */
  private async emitCreated(nodes: readonly PageTreeNode[], records: Map<string, LoadedRecord>, since: number, delivery: "live" | "backfill"): Promise<void> {
    const events: NotionEvent[] = [];
    const lookup = (table: string, id: string) => records.get(`${table}:${id}`);
    for (const n of nodes) {
      const v = records.get(`block:${n.id}`)?.value;
      if (!v) continue;
      const created = Number(v.created_time ?? 0);
      if (created < since - CREATED_SLACK_MS) continue;
      const type = DB_TYPES.has(String(v.type)) ? "database.created" : "page.created";
      const id = eventId([`discovery|${type}|${n.id}`]);
      if (await this.opts.state.hasSeenEvent(id)) continue;
      const author = typeof v.created_by_id === "string" ? v.created_by_id : undefined;
      const parent = parentOf(v, lookup);
      events.push({
        id,
        type,
        timestamp: new Date(created || this.now()).toISOString(),
        workspaceId: this.opts.workspaceId,
        entity: { id: n.id, type: type === "database.created" ? "database" : "page" },
        authors: author ? [{ id: author, type: v.created_by_table === "bot" ? "bot" : "person" }] : [],
        data: parent ? { parent } : {},
        origin: this.opts.pipeline.originOf(author, n.id, typeof v.version === "number" ? v.version : undefined, created),
        delivery,
        web: { after: v },
      } as NotionEvent);
    }
    if (events.length === 0) return;
    for (const e of events) this.opts.pipeline.deliverEvent(e);
    await this.opts.state.markSeen(events.map((e) => e.id));
  }

  private fail(err: unknown): void {
    const code = isNotionError(err) ? err.code : "UNKNOWN";
    this.lastError = { code, at: new Date(this.now()).toISOString() };
    this.logger.warn({ code }, "discovery failed");
  }
}
