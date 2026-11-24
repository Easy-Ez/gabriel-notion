import { createHash } from "node:crypto";
import { inspect } from "node:util";
import { NotionCore, type NotionCoreOptions } from "../core/core.js";
import type { SessionEvents } from "../core/session.js";
import { normalizeId } from "../core/ids.js";
import { unwrapRecord } from "../core/account.js";
import { normalizeEntry } from "../core/records.js";
import { NotionError } from "../errors.js";
import { plainText, renderRichText } from "../markdown/inline-render.js";
import { pageUrl, type BlockRecord, type CollectionRecord, type RichText } from "../markdown/model.js";
import { renderPage } from "../markdown/render.js";
import { Singleflight } from "../util/async.js";
import { Emitter } from "../util/emitter.js";
import { silentLogger, type Logger } from "../util/logger.js";
import { FileStateStore } from "../state/file.js";
import type { StateStore, StateStoreHealth } from "../state/store.js";
import { WatchState } from "../state/watch-state.js";
import { EventPipeline, type ConnectionGapEvent, type PipelineHealth, type PipelineOptions } from "./events/pipeline.js";
import { Discovery, type DiscoveryHealth, type WatchOptions } from "./watch/discovery.js";
import { LoopGuard, SelfWrites, handlerContext, writeTarget, type LoopDetectedEvent } from "./guard/origin.js";
import { attachLLMContext, eventToLLMContext, pageToLLMContext } from "./guard/llm-context.js";
import { ScopedNotionClient, type ScopePolicy } from "./guard/scope.js";
import type { EventType, NotionEvent, ProtocolDriftEvent } from "./events/types.js";
import { decodeProperties, propertyId, type PropertySchema } from "./properties.js";
import { RecordCache } from "./tree.js";
import { createComment, createPage, replyToDiscussion, updateContent, updateProperties, type ContentEdit, type CreateCommentOptions, type CreatePageOptions, type Internals } from "./write-api.js";
import type { PropertyInput } from "./write.js";
import type {
  Block,
  Comment,
  DatabaseMeta,
  Discussion,
  Filter,
  Page,
  PageMeta,
  PageResult,
  Parent,
  Row,
  SearchHit,
  Sort,
  User,
  ViewMeta,
  Workspace,
} from "./types.js";

export type { WatchOptions } from "./watch/discovery.js";

export interface NotionClientOptions extends NotionCoreOptions {
  /** The workspace this client acts in, by ID or exact name. Resolved on the first call. */
  workspace: string;
  /** Persistent watch state. Default: `FileStateStore` at its default path. */
  stateStore?: StateStore;
  watch?: WatchOptions;
  /** Agent safety guards (spec §11). */
  guards?: {
    /** Deliver events caused by this SDK instance's own writes (`origin: "this_client"`). Default false. */
    deliverThisClient?: boolean;
    /** Writes from event handlers per target page within `windowMs` (default 5 per 60 s). */
    loop?: { maxWrites?: number; windowMs?: number };
  };
  /** Tuning for the event pipeline (coalescing delay, re-read period, quiet period); mainly for tests. */
  events?: Pick<PipelineOptions, "coalesceMs" | "recordSignalDelayMs" | "rereadMs" | "quietMs" | "pageSize" | "maxPages" | "catchUpMs" | "aliveIntervalMs" | "now">;
}

export interface ClientEvents extends Record<string, unknown> {
  "*": NotionEvent;
  "guard.protocol_drift": ProtocolDriftEvent;
  "guard.loop_detected": LoopDetectedEvent;
  "connection.gap": ConnectionGapEvent;
  "auth.dead": SessionEvents["auth.dead"];
}

/** A change event with `toLLMContext()` attached (non-enumerable). */
export type DeliveredEvent<T extends EventType = EventType> = NotionEvent<T> & { toLLMContext(): string };
/** A page read with `toLLMContext()` attached (non-enumerable). */
export type PageWithContext = PageResult & { toLLMContext(): string };

export interface ClientHealth {
  status: "ok" | "degraded" | "dead";
  session: ReturnType<NotionCore["health"]>["session"];
  connections: NonNullable<ReturnType<NotionCore["health"]>["realtime"]>["connections"];
  lagSeconds: number;
  events?: PipelineHealth;
  watch?: DiscoveryHealth;
  state?: StateStoreHealth;
}

type BlockRec = BlockRecord & {
  created_time?: number;
  last_edited_time?: number;
  created_by_id?: string;
  last_edited_by_id?: string;
  view_ids?: string[];
  discussions?: string[];
};

interface CollectionRec extends CollectionRecord {
  schema?: Record<string, PropertySchema>;
  parent_id?: string;
}

const SEARCH_MAX = 1000;
/** Large enough to return every row ID of a data source in one query (12,000 rows take about 3 s). */
const QUERY_ID_LIMIT = 100_000;
const QUERY_CACHE_TTL_MS = 10 * 60_000;
const QUERY_CACHE_MAX = 20;

function toDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function parentOf(b: BlockRec, cache?: RecordCache): Parent | undefined {
  if (!b.parent_id) return undefined;
  switch (b.parent_table) {
    case "collection":
      return { type: "database", id: b.parent_id };
    case "team":
      return { type: "teamspace", id: b.parent_id };
    case "space":
      return { type: "workspace", id: b.parent_id };
    case "block": {
      const p = cache?.block(b.parent_id);
      return { type: p && p.type !== "page" && p.type !== "collection_view_page" ? "block" : "page", id: b.parent_id };
    }
    default:
      return undefined;
  }
}

export function pageMeta(b: BlockRec, cache?: RecordCache): PageMeta {
  const meta: PageMeta = {
    id: b.id,
    url: pageUrl(b.id),
    title: plainText(b.properties?.title as RichText | undefined),
    locked: b.format?.block_locked === true,
  };
  const parent = parentOf(b, cache);
  if (parent) meta.parent = parent;
  if (typeof b.format?.page_icon === "string") meta.icon = b.format.page_icon;
  if (typeof b.format?.page_cover === "string") meta.cover = b.format.page_cover;
  if (b.created_time) meta.createdTime = new Date(b.created_time).toISOString();
  if (b.last_edited_time) meta.lastEditedTime = new Date(b.last_edited_time).toISOString();
  if (b.created_by_id) meta.createdBy = b.created_by_id;
  if (b.last_edited_by_id) meta.lastEditedBy = b.last_edited_by_id;
  return meta;
}

/**
 * Semantic client (spec §2). Reads in v0.1-alpha.1: identity, users, search, pages,
 * databases and comments. One client acts as one account in one workspace.
 */
export class NotionClient {
  readonly core: NotionCore;
  private readonly workspaceArg: string;
  private readonly ready = new Singleflight<Workspace>();
  private bound?: Workspace;
  private readonly queryCache = new Map<string, { ids: string[]; at: number }>();
  private readonly emitter = new Emitter<Record<string, unknown>>();
  private readonly stateStore?: StateStore;
  private readonly watchOpts: WatchOptions;
  private readonly eventOpts: NotionClientOptions["events"];
  private store?: StateStore;
  private pipeline?: EventPipeline;
  private discovery?: Discovery;
  private starting?: Promise<void>;
  private readonly logger: Logger;
  private readonly selfWrites = new SelfWrites();
  private readonly loopGuard: LoopGuard;
  private readonly deliverThisClient: boolean;

  private constructor(opts: NotionClientOptions) {
    const { workspace, stateStore, watch, events, guards, ...coreOpts } = opts;
    if (typeof workspace !== "string" || workspace.trim() === "") throw new NotionError("INVALID_ARGUMENT", "workspace is required");
    this.workspaceArg = workspace;
    this.core = new NotionCore(coreOpts);
    if (stateStore) this.stateStore = stateStore;
    this.watchOpts = watch ?? { mode: "workspace" };
    this.eventOpts = events;
    this.logger = opts.logger ?? silentLogger;
    this.deliverThisClient = guards?.deliverThisClient === true;
    this.loopGuard = new LoopGuard(guards?.loop?.maxWrites ?? 5, guards?.loop?.windowMs ?? 60_000, (e) => {
      this.logger.warn({ target: e.target, count: e.count }, "loop detected; write refused");
      this.emitter.emit("guard.loop_detected", e);
    });
    // Every transaction: count it against the loop guard when a handler makes it directly
    // through Core (write methods count once, up front), then register it as our own write.
    this.core.beforeSubmit = (ops) => {
      if (!writeTarget.getStore() && ops[0]) this.loopGuard.check(ops[0].pointer.id);
      this.selfWrites.registerOperations(ops);
    };
    this.core.records.onVerified = (records) => this.selfWrites.registerVerified(records);
    this.core.onAuthDead((e) => this.emitter.emit("auth.dead", e));
  }

  /** Runs a write method: loop guard on the target page, then the write with the target recorded. */
  private guarded<T>(target: string, fn: () => Promise<T>): Promise<T> {
    try {
      this.loopGuard.check(target);
    } catch (err) {
      return Promise.reject(err);
    }
    return writeTarget.run(target, fn);
  }

  /**
   * A least-privilege view for LLM tools (spec §11.3): the same read and write API,
   * limited to the policy's pages and teamspaces, optionally read-only, without search, or with
   * an approval hook for every write. It has no `core`, `on` or `start`. Calls outside the policy
   * fail with `SCOPE_POLICY_VIOLATION`.
   */
  scope(policy: ScopePolicy): ScopedNotionClient {
    return new ScopedNotionClient(this, policy, this.logger);
  }

  /**
   * Subscribes to an event type, or `"*"` for every change event. Events are delivered only after
   * `start()`. Returns an unsubscribe function. Handler errors are logged and do not stop delivery.
   */
  on<T extends EventType>(type: T, handler: (event: DeliveredEvent<T>) => unknown): () => void;
  on(type: "*", handler: (event: DeliveredEvent) => unknown): () => void;
  /** The session died (§3): sign in again; nothing more is read or delivered. */
  on(type: "auth.dead", handler: (event: SessionEvents["auth.dead"]) => void): () => void;
  /** A handler kept writing to one page; the refused write threw `LOOP_DETECTED`. */
  on(type: "guard.loop_detected", handler: (event: LoopDetectedEvent) => void): () => void;
  on(type: "guard.protocol_drift", handler: (event: ProtocolDriftEvent) => void): () => void;
  /** End of every recovery after a disconnect or restart; `recovered: false` lists what could not be backfilled. */
  on(type: "connection.gap", handler: (event: ConnectionGapEvent) => void): () => void;
  on(type: string, handler: (event: never) => void): () => void {
    return this.emitter.on(type, handler as (p: unknown) => void);
  }

  /**
   * Validates the session, opens the state store, connects to the Message Store and starts
   * watching (spec §9): on the first run it walks the page tree from its roots (the whole
   * workspace, or `watch.roots`) and stores it; later runs watch the stored tree at once and
   * correct it in the background. Resolves once every subscription is acknowledged.
   */
  start(): Promise<void> {
    this.starting ??= this.doStart().catch(async (err) => {
      this.starting = undefined;
      await this.stop().catch(() => {});
      throw err;
    });
    return this.starting;
  }

  private async doStart(): Promise<void> {
    if (this.watchOpts.mode === "explicit" && (!Array.isArray(this.watchOpts.roots) || this.watchOpts.roots.length === 0)) {
      throw new NotionError("INVALID_ARGUMENT", "watch.roots must list at least one page or database");
    }
    const watch: WatchOptions = this.watchOpts.mode === "explicit" ? { ...this.watchOpts, roots: this.watchOpts.roots.map((r) => normalizeId(r)) } : this.watchOpts;
    const ws = await this.workspace();
    const store = this.stateStore ?? new FileStateStore();
    this.store = store;
    const state = new WatchState(store, ws.id);
    const self = this.core.health().userId;
    const deliver = (event: NotionEvent) => {
      if (event.origin === "this_client" && !this.deliverThisClient) return;
      attachLLMContext(event, eventToLLMContext);
      const onErr = (err: unknown) => this.logger.error({ type: event.type, err: err instanceof Error ? err.name : "error" }, "event handler threw");
      // Handlers run inside a context, so writes they make count against the loop guard.
      handlerContext.run({ eventId: event.id, entityId: event.entity.id }, () => {
        this.emitter.emit(event.type, event, onErr);
        this.emitter.emit("*", event, onErr);
      });
    };
    const pipeline = new EventPipeline({
      core: this.core,
      state,
      workspaceId: ws.id,
      ...(self ? { selfUserId: self } : {}),
      deliver,
      drift: (d) => this.emitter.emit("guard.protocol_drift", d),
      gap: (g) => this.emitter.emit("connection.gap", g),
      isThisClient: (a, e) => this.selfWrites.isThisClient(a, e),
      isThisClientRecord: (id, version, at) => this.selfWrites.isThisClientRecord(id, version, at),
      logger: this.logger,
      ...(this.eventOpts ?? {}),
    });
    this.pipeline = pipeline;
    pipeline.start();
    if (!self) throw new NotionError("INVALID_STATE", "the account is not known after binding the workspace");
    const discovery = new Discovery({ core: this.core, state, pipeline, workspaceId: ws.id, userId: self, watch, logger: this.logger, ...(this.eventOpts?.now ? { now: this.eventOpts.now } : {}) });
    this.discovery = discovery;
    await discovery.start();
  }

  /** Stops watching, closes the Message Store connections and flushes the state store. */
  async stop(): Promise<void> {
    this.discovery?.stop();
    this.discovery = undefined;
    await this.pipeline?.stop();
    this.pipeline = undefined;
    this.core.stopRealtime();
    this.starting = undefined;
    const store = this.store;
    this.store = undefined;
    if (store && !this.stateStore) await store.close();
    else if (store) await store.flush();
    await this.core.flushCredentials();
  }

  health(): ClientHealth {
    const core = this.core.health();
    const events = this.pipeline?.health();
    const connections = core.realtime?.connections ?? [];
    const dead = core.session.state === "AUTH_DEAD";
    const degraded =
      connections.some((c) => c.state !== "READY") || events?.recovering === true || events?.lastGap?.recovered === false || events?.lastError !== undefined || this.discovery?.health().lastError !== undefined || this.store?.health().lastError !== undefined;
    const h: ClientHealth = { status: dead ? "dead" : degraded ? "degraded" : "ok", session: core.session, connections, lagSeconds: events?.lagSeconds ?? 0 };
    if (events) h.events = events;
    if (this.discovery) h.watch = this.discovery.health();
    if (this.store) h.state = this.store.health();
    return h;
  }

  /** Creates a client from session cookies. Nothing is sent until the first call. */
  static fromCookies(opts: NotionClientOptions): NotionClient {
    return new NotionClient(opts);
  }

  /** The workspace this client acts in, resolved (and bound) on first use. */
  getWorkspace(): Promise<Workspace> {
    return this.workspace();
  }

  /** Binds the workspace once; an unknown workspace fails here with INVALID_ARGUMENT. */
  private async workspace(): Promise<Workspace> {
    if (this.bound) return this.bound;
    return this.ready.do("bind", async () => {
      const w = await this.core.bindWorkspace(this.workspaceArg);
      this.bound = w;
      return w;
    });
  }

  private cache(): RecordCache {
    return new RecordCache(this.core);
  }

  private internals(): Internals {
    return {
      core: this.core,
      workspace: () => this.workspace(),
      database: (id) => this.database(id),
      pageMeta: async (id) => pageMeta({ ...(await this.core.records.get<BlockRec>({ table: "block", id })).value, id }),
    };
  }

  // ---------------------------------------------------------------- identity and users

  async me(): Promise<User & { workspaces: Workspace[] }> {
    const acct = await this.core.account();
    const me: User & { workspaces: Workspace[] } = { id: acct.userId, workspaces: acct.workspaces };
    if (acct.name) me.name = acct.name;
    if (acct.email) me.email = acct.email;
    return me;
  }

  readonly users = {
    list: async (opts: { type?: "members" | "guests"; query?: string; cursor?: string; limit?: number } = {}): Promise<Page<User>> => {
      const ws = await this.workspace();
      const body: Record<string, unknown> = {
        spaceId: ws.id,
        membershipFilter: opts.type ?? "members",
        limit: opts.limit ?? 100,
        query: opts.query ?? "",
        includeAliasSearch: true,
      };
      if (opts.cursor) body.cursor = opts.cursor;
      const r = await this.core.callApi<{ users?: unknown[]; hasMore?: boolean; nextCursor?: string }>("listUsers", body);
      const page: Page<User> = { results: (r?.users ?? []).map(toUser).filter((u): u is User => u !== undefined), hasMore: r?.hasMore === true };
      if (r?.hasMore && r.nextCursor) page.nextCursor = r.nextCursor;
      return page;
    },
    search: async (query: string, opts: { limit?: number } = {}): Promise<User[]> => {
      const ws = await this.workspace();
      const r = await this.core.callApi<Record<string, unknown>>("searchUsers", { query, spaceId: ws.id, limit: opts.limit ?? 20 });
      const list = (r?.users ?? r?.results ?? []) as unknown[];
      return list.map(toUser).filter((u): u is User => u !== undefined);
    },
    get: async (userId: string): Promise<User> => {
      await this.workspace();
      const id = normalizeId(userId, "userId");
      const v = (await this.core.records.get<{ name?: string; email?: string }>({ table: "notion_user", id })).value;
      return { id, ...(v.name ? { name: v.name } : {}), ...(v.email ? { email: v.email } : {}) };
    },
  };

  // ---------------------------------------------------------------- search

  async search(
    query: string,
    opts: {
      titleOnly?: boolean;
      under?: string;
      sort?: "relevance" | "created" | "lastEdited";
      direction?: "asc" | "desc";
      createdBetween?: [Date, Date];
      editedBetween?: [Date, Date];
      limit?: number;
    } = {},
  ): Promise<{ results: SearchHit[]; truncated: boolean }> {
    const limit = opts.limit ?? 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > SEARCH_MAX) {
      throw new NotionError("INVALID_ARGUMENT", `limit must be 1–${SEARCH_MAX}: the server returns at most ${SEARCH_MAX} results and has no continuation`);
    }
    const ws = await this.workspace();
    const range = (r?: [Date, Date]) => (r ? { starting: { type: "date", start_date: toDay(r[0]) }, ending: { type: "date", start_date: toDay(r[1]) } } : {});
    const sort = !opts.sort || opts.sort === "relevance" ? { field: "relevance" } : { field: opts.sort, direction: opts.direction ?? "desc" };
    const body = {
      type: "BlocksInSpace",
      query,
      spaceId: ws.id,
      limit,
      source: "quick_find",
      sort,
      filters: {
        isDeletedOnly: false,
        excludeTemplates: false,
        navigableBlockContentOnly: opts.titleOnly === true,
        requireEditPermissions: false,
        includePublicPagesWithoutExplicitAccess: false,
        ancestors: opts.under ? [normalizeId(opts.under, "under")] : [],
        createdBy: [],
        editedBy: [],
        lastEditedTime: range(opts.editedBetween),
        createdTime: range(opts.createdBetween),
        inTeams: [],
      },
    };
    const r = await this.core.callApi<{ results?: Array<Record<string, unknown>>; recordMap?: Record<string, Record<string, unknown>> }>("search", body);
    const blocks = r?.recordMap?.block ?? {};
    const collections = r?.recordMap?.collection ?? {};
    const results: SearchHit[] = [];
    for (const item of r?.results ?? []) {
      const id = String(item.id ?? "");
      const b = normalizeEntry<BlockRec>(blocks[id])?.value;
      const meta = b ? pageMeta({ ...b, id }) : undefined;
      let title = meta?.title ?? "";
      if (b?.collection_id) title = plainText(normalizeEntry<CollectionRec>(collections[b.collection_id])?.value?.name) || title;
      const hit: SearchHit = { id, title, type: b?.type ?? "page", url: pageUrl(id) };
      if (meta?.parent) hit.parent = meta.parent;
      if (meta?.lastEditedTime) hit.lastEditedTime = meta.lastEditedTime;
      const hl = item.highlight as { text?: string; title?: string } | undefined;
      const excerpt = hl?.text ?? hl?.title;
      if (typeof excerpt === "string" && excerpt) hit.highlight = excerpt.replace(/<\/?[a-zA-Z][^>]*>/g, "");
      results.push(hit);
    }
    return { results, truncated: results.length >= limit };
  }

  // ---------------------------------------------------------------- pages

  readonly pages = {
    /**
     * Reads a page: metadata, decoded properties (database rows), and the body as
     * Notion-flavored Markdown (default) or as a block tree. The whole subtree is read.
     */
    get: async (pageId: string, opts: { format?: "markdown" | "blocks"; signal?: AbortSignal } = {}): Promise<PageWithContext> => {
      return attachLLMContext(await this.readPage(pageId, opts), pageToLLMContext) as PageWithContext;
    },

    /** Creates a page (or a database row) with an optional Markdown body; returns it with any skipped-block warnings. */
    create: (opts: CreatePageOptions) => this.guarded(writeTargetOf(opts.parent), () => createPage(this.internals(), opts)),

    /** Updates the title (any page) or properties (database rows) by property name; verified by read-back. */
    updateProperties: (pageId: string, properties: Record<string, PropertyInput>) => this.guarded(safeId(pageId), () => updateProperties(this.internals(), pageId, properties)),

    /**
     * Edits the body: `replace_all` (keeps subpages and inline databases), `insert` (after or before
     * a top-level block), or `update` (find and replace within one block's Markdown).
     */
    updateContent: (pageId: string, edit: ContentEdit) => this.guarded(safeId(pageId), () => updateContent(this.internals(), pageId, edit)),
  };

  private readPage = async (pageId: string, opts: { format?: "markdown" | "blocks"; signal?: AbortSignal } = {}): Promise<PageResult> => {
    {
      const ws = await this.workspace();
      const id = normalizeId(pageId, "pageId");
      const root = (await this.core.records.get<BlockRec>({ table: "block", id }, opts.signal)).value;
      const cache = this.cache();
      cache.blocks.set(id, { ...root, id });
      await cache.loadSubtree(id, opts.signal);
      const page = pageMeta({ ...root, id }, cache);

      let properties = {};
      if (root.parent_table === "collection" && root.parent_id) {
        await cache.loadCollections([root.parent_id], opts.signal);
        const coll = cache.collection(root.parent_id) as CollectionRec | undefined;
        if (coll?.schema) properties = decodeProperties({ ...root, id }, coll.schema);
      }

      const result: PageResult = { page, properties, unknownBlockIds: [] };
      if (opts.format === "blocks") {
        const build = (bid: string, depth: number): Block | undefined => {
          const b = cache.block(bid);
          if (!b || b.alive === false) return undefined;
          const node: Block = { ...b };
          const boundary = depth > 0 && (b.type === "page" || b.type === "collection_view" || b.type === "collection_view_page");
          if (!boundary && b.content?.length) node.children = b.content.map((c) => build(c, depth + 1)).filter((x): x is Block => x !== undefined);
          return node;
        };
        result.blocks = build(id, 0)?.children ?? [];
        return result;
      }

      for (let round = 0; ; round++) {
        const r = renderPage(id, cache, { spaceId: ws.id });
        const missing = r.missing.blocks.length + r.missing.users.length + r.missing.collections.length;
        if (missing === 0 || round === 2) {
          result.markdown = r.markdown;
          result.unknownBlockIds = r.unknownBlockIds;
          return result;
        }
        await Promise.all([cache.loadBlocks(r.missing.blocks, opts.signal), cache.loadUsers(r.missing.users, opts.signal), cache.loadCollections(r.missing.collections, opts.signal)]);
      }
    }
  };

  // ---------------------------------------------------------------- databases

  private async database(dbId: string, signal?: AbortSignal): Promise<{ meta: DatabaseMeta; schema: Record<string, PropertySchema>; viewIds: string[] }> {
    await this.workspace();
    const id = normalizeId(dbId, "databaseId");
    const entry = (await this.core.getRecords<BlockRec>([{ table: "block", id }], signal)).get(`block:${id}`);
    let block: BlockRec | undefined = entry?.value && entry.value.collection_id ? { ...entry.value, id } : undefined;
    let coll: CollectionRec | undefined;
    if (block) {
      coll = (await this.core.records.get<CollectionRec>({ table: "collection", id: block.collection_id! }, signal)).value;
    } else {
      // Not a database block: accept a data source (collection) ID as well.
      coll = (await this.core.records.get<CollectionRec>({ table: "collection", id }, signal).catch(() => undefined))?.value;
      if (!coll) throw new NotionError("NOT_FOUND", `${id} is not a database or data source, or is not accessible`);
      if (coll.parent_id) block = (await this.core.getRecords<BlockRec>([{ table: "block", id: coll.parent_id }], signal)).get(`block:${coll.parent_id}`)?.value;
      if (block) block = { ...block, id: coll.parent_id! };
    }
    const dataSourceId = block?.collection_id ?? id;
    const holder = block?.id ?? coll.parent_id ?? id;
    return {
      meta: { id: holder, dataSourceId, title: plainText(coll.name), url: pageUrl(holder), inline: block?.type === "collection_view" },
      schema: coll.schema ?? {},
      viewIds: block?.view_ids ?? [],
    };
  }

  readonly databases = {
    get: async (dbId: string): Promise<{ database: DatabaseMeta; schema: Record<string, PropertySchema>; views: ViewMeta[] }> => {
      const { meta, schema, viewIds } = await this.database(dbId);
      const views = viewIds.length ? await this.core.getRecords<{ type?: string; name?: string }>(viewIds.map((id) => ({ table: "collection_view", id }))) : new Map();
      return {
        database: meta,
        schema,
        views: viewIds.map((id) => {
          const v = views.get(`collection_view:${id}`)?.value;
          return { id, type: v?.type ?? "table", name: v?.name ?? "" };
        }),
      };
    },

    /**
     * Queries rows. The server has no continuation, but returns every matching row ID in one
     * call; the client caches that list for 10 minutes and pages through it with its own cursor,
     * so pages neither overlap nor skip while the cache lives. A cursor used after expiry re-runs
     * the query and continues at the same offset (rows changed meanwhile may shift).
     */
    query: async (dbId: string, opts: { filter?: Filter; sorts?: Sort[]; view?: string; limit?: number; cursor?: string; signal?: AbortSignal } = {}): Promise<Page<Row>> => {
      const ws = await this.workspace();
      const limit = opts.limit ?? 100;
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new NotionError("INVALID_ARGUMENT", "limit must be 1–1000");
      const { meta, schema, viewIds } = await this.database(dbId, opts.signal);
      const viewId = opts.view ? normalizeId(opts.view, "view") : viewIds[0];

      const resolveFilter = (f: Filter): unknown => {
        if ("filters" in f) return { operator: f.operator, filters: f.filters.map(resolveFilter) };
        const pid = propertyId(schema, f.property);
        if (!pid) throw new NotionError("INVALID_ARGUMENT", `unknown property "${f.property}"`);
        return { property: pid, filter: f.filter };
      };
      const filter = opts.filter ? resolveFilter("filters" in opts.filter ? opts.filter : { operator: "and", filters: [opts.filter] }) : undefined;
      const sort = (opts.sorts ?? []).map((s) => {
        const pid = propertyId(schema, s.property);
        if (!pid) throw new NotionError("INVALID_ARGUMENT", `unknown property "${s.property}"`);
        return { property: pid, direction: s.direction };
      });
      const hash = createHash("sha256").update(JSON.stringify([meta.dataSourceId, viewId, filter, sort])).digest("base64url").slice(0, 16);

      let offset = 0;
      if (opts.cursor) {
        let decoded: { h?: string; o?: number };
        try {
          decoded = JSON.parse(Buffer.from(opts.cursor, "base64url").toString("utf8")) as { h?: string; o?: number };
        } catch {
          throw new NotionError("INVALID_ARGUMENT", "invalid cursor");
        }
        if (decoded.h !== hash || !Number.isInteger(decoded.o) || decoded.o! < 0) throw new NotionError("INVALID_ARGUMENT", "the cursor belongs to a different query");
        offset = decoded.o!;
      }

      const cache = this.cache();
      let entry = this.queryCache.get(hash);
      if (!entry || Date.now() - entry.at > QUERY_CACHE_TTL_MS || !opts.cursor) {
        const loader: Record<string, unknown> = {
          userTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          reducers: { rows: { type: "results", limit: QUERY_ID_LIMIT } },
        };
        const userId = this.core.health().userId;
        if (userId) loader.userId = userId;
        if (filter) loader.filter = filter;
        if (sort.length) loader.sort = sort;
        const body: Record<string, unknown> = { clientType: "notion_app", source: { type: "collection", id: meta.dataSourceId, spaceId: ws.id }, loader };
        if (viewId) body.collectionView = { id: viewId, spaceId: ws.id };
        const r = await this.core.callApi<{ result?: { reducerResults?: { rows?: { blockIds?: string[] } } }; recordMap?: Record<string, Record<string, unknown>> }>(
          "queryCollection",
          body,
          opts.signal ? { signal: opts.signal } : {},
        );
        entry = { ids: r?.result?.reducerResults?.rows?.blockIds ?? [], at: Date.now() };
        for (const [rid, raw] of Object.entries(r?.recordMap?.block ?? {})) {
          const v = normalizeEntry<BlockRec>(raw)?.value;
          if (v) cache.blocks.set(rid, { ...v, id: rid });
        }
        this.queryCache.set(hash, entry);
        while (this.queryCache.size > QUERY_CACHE_MAX) this.queryCache.delete(this.queryCache.keys().next().value!);
      }

      const slice = entry.ids.slice(offset, offset + limit);
      await cache.loadBlocks(slice, opts.signal);
      const results: Row[] = slice
        .map((rid) => cache.block(rid) as BlockRec | undefined)
        .filter((b): b is BlockRec => b !== undefined)
        .map((b) => ({ ...pageMeta(b, cache), properties: decodeProperties(b, schema) }));
      const next = offset + limit;
      const page: Page<Row> = { results, hasMore: next < entry.ids.length };
      if (page.hasMore) page.nextCursor = Buffer.from(JSON.stringify({ h: hash, o: next })).toString("base64url");
      return page;
    },
  };

  // ---------------------------------------------------------------- comments

  readonly comments = {
    /** Discussions on the page and on any block in it, with their comments in order. */
    list: async (pageId: string, opts: { includeResolved?: boolean; signal?: AbortSignal } = {}): Promise<Discussion[]> => {
      await this.workspace();
      const id = normalizeId(pageId, "pageId");
      const root = (await this.core.records.get<BlockRec>({ table: "block", id }, opts.signal)).value;
      const cache = this.cache();
      cache.blocks.set(id, { ...root, id });
      await cache.loadSubtree(id, opts.signal);
      const discussionIds = [...cache.blocks.values()].flatMap((b) => (b as BlockRec).discussions ?? []);
      if (!discussionIds.length) return [];
      const dmap = await this.core.getRecords<{ parent_id?: string; resolved?: boolean; context?: RichText; comments?: string[]; alive?: boolean }>(
        discussionIds.map((did) => ({ table: "discussion", id: did })),
        opts.signal,
      );
      const discussions = discussionIds
        .map((did) => ({ id: did, v: dmap.get(`discussion:${did}`)?.value }))
        .filter((d) => d.v && d.v.alive !== false && (opts.includeResolved || d.v.resolved !== true));
      const commentIds = discussions.flatMap((d) => d.v!.comments ?? []);
      const cmap = commentIds.length
        ? await this.core.getRecords<{ text?: RichText; created_by_id?: string; created_time?: number; last_edited_time?: number; alive?: boolean }>(
            commentIds.map((cid) => ({ table: "comment", id: cid })),
            opts.signal,
          )
        : new Map();

      const mentioned = [...cmap.values()].flatMap((e) => (e.value?.text ?? []).flatMap((s: RichText[number]) => (s[1] ?? []).filter((a) => a[0] === "u").map((a) => String(a[1]))));
      await cache.loadUsers(mentioned, opts.signal);
      const missing = { blocks: new Set<string>(), users: new Set<string>(), collections: new Set<string>() };

      return discussions.map(({ id: did, v }) => {
        const blockId = v!.parent_id ?? id;
        const comments: Comment[] = (v!.comments ?? [])
          .map((cid) => ({ cid, c: cmap.get(`comment:${cid}`)?.value }))
          .filter((x) => x.c && x.c.alive !== false)
          .map(({ cid, c }) => {
            const text = (c!.text ?? []) as RichText;
            const comment: Comment = { id: cid, discussionId: did, text, markdown: renderRichText(text, { pageId: id, blockId, src: cache, missing }) };
            if (c!.created_by_id) comment.authorId = c!.created_by_id;
            if (c!.created_time) comment.createdTime = new Date(c!.created_time).toISOString();
            if (c!.last_edited_time) comment.lastEditedTime = new Date(c!.last_edited_time).toISOString();
            return comment;
          });
        const d: Discussion = { id: did, blockId, resolved: v!.resolved === true, comments };
        const ctx = plainText(v!.context);
        if (ctx) d.context = ctx;
        return d;
      });
    },

    /** Adds a page, block or inline (selection) comment in a new discussion. */
    create: (opts: CreateCommentOptions) => this.guarded(safeId(opts.pageId), () => createComment(this.internals(), opts)),

    /** Replies in an existing discussion. */
    reply: (discussionId: string, markdown: string) => this.guarded(safeId(discussionId), () => replyToDiscussion(this.internals(), discussionId, markdown)),
  };

  toJSON(): Record<string, unknown> {
    return { workspace: this.bound ?? this.workspaceArg, core: this.core.toJSON() };
  }

  [inspect.custom](): string {
    return `NotionClient ${inspect(this.toJSON())}`;
  }
}

function toUser(raw: unknown): User | undefined {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const inner = (unwrapRecord<Record<string, unknown>>(r) ?? r) as Record<string, unknown>;
  const src = typeof inner.id === "string" || typeof inner.userId === "string" ? inner : r;
  const id = (src.id ?? src.userId ?? src.user_id) as string | undefined;
  if (typeof id !== "string") return undefined;
  const user: User = { id };
  const name = src.name ?? src.given_name;
  if (typeof name === "string") user.name = name;
  if (typeof src.email === "string") user.email = src.email;
  const type = src.membership_type ?? src.membershipType ?? src.role;
  if (typeof type === "string") user.type = type;
  return user;
}

/** The page a write lands on, for the loop guard. */
function writeTargetOf(parent: CreatePageOptions["parent"]): string {
  const p = parent as Record<string, unknown>;
  const id = p.pageId ?? p.databaseId ?? p.teamspaceId;
  return typeof id === "string" ? safeId(id) : "private";
}

function safeId(id: string): string {
  try {
    return normalizeId(id);
  } catch {
    return String(id);
  }
}
