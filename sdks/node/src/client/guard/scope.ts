import { normalizeId } from "../../core/ids.js";
import { NotionError } from "../../errors.js";
import type { Logger } from "../../util/logger.js";
import type { NotionClient, PageWithContext } from "../client.js";
import type { ContentEdit, CreateCommentOptions, CreatePageOptions } from "../write-api.js";
import type { PropertyInput } from "../write.js";

/**
 * Least-privilege view for LLM tools (spec §11.3). Same read and write API as
 * `NotionClient`, limited by a policy; no `core`, no `on`, no `start`. Every call outside the
 * policy fails with `SCOPE_POLICY_VIOLATION` and is logged.
 */

export type ScopedWriteAction = "pages.create" | "pages.updateProperties" | "pages.updateContent" | "comments.create" | "comments.reply";

export interface ScopePolicy {
  read?: {
    /**
     * Pages and databases the view may use, each with everything under it. With neither `roots`
     * nor `teamspaces`, reads are not limited by location.
     */
    roots?: string[];
    /** Teamspaces whose pages the view may use. */
    teamspaces?: string[];
    /** Default true. Search hits outside the scope are left out. */
    allowSearch?: boolean;
    /** Member lists and profiles. Default true. */
    allowUsers?: boolean;
  };
  write?: {
    /** No writes at all. */
    readOnly?: boolean;
    /** Only these write methods. */
    allowedActions?: ScopedWriteAction[];
  };
  /** Consulted before every write; return false to refuse it. */
  approval?: (action: ScopedWriteAction, params: unknown) => Promise<boolean>;
}

type Client = NotionClient;

/** How far up the tree a page may sit below its root before the check gives up. */
const MAX_DEPTH = 64;
const CACHE_MS = 60_000;

export class ScopedNotionClient {
  readonly pages: {
    get(pageId: string, opts?: { format?: "markdown" | "blocks"; signal?: AbortSignal }): Promise<PageWithContext>;
    create(opts: CreatePageOptions): ReturnType<Client["pages"]["create"]>;
    updateProperties(pageId: string, properties: Record<string, PropertyInput>): ReturnType<Client["pages"]["updateProperties"]>;
    updateContent(pageId: string, edit: ContentEdit): ReturnType<Client["pages"]["updateContent"]>;
  };
  readonly databases: {
    get(dbId: string): ReturnType<Client["databases"]["get"]>;
    query(dbId: string, opts?: Parameters<Client["databases"]["query"]>[1]): ReturnType<Client["databases"]["query"]>;
  };
  readonly comments: {
    list(pageId: string, opts?: Parameters<Client["comments"]["list"]>[1]): ReturnType<Client["comments"]["list"]>;
    create(opts: CreateCommentOptions): ReturnType<Client["comments"]["create"]>;
    reply(discussionId: string, markdown: string): ReturnType<Client["comments"]["reply"]>;
  };
  readonly users: {
    list(opts?: Parameters<Client["users"]["list"]>[0]): ReturnType<Client["users"]["list"]>;
    search(query: string, opts?: Parameters<Client["users"]["search"]>[1]): ReturnType<Client["users"]["search"]>;
    get(userId: string): ReturnType<Client["users"]["get"]>;
  };

  private readonly roots: Set<string> | undefined;
  private readonly teams: Set<string> | undefined;
  private readonly cache = new Map<string, { ok: boolean; at: number }>();

  constructor(
    private readonly client: Client,
    private readonly policy: ScopePolicy,
    private readonly logger: Logger,
  ) {
    const r = policy.read;
    const limited = r?.roots !== undefined || r?.teamspaces !== undefined;
    this.roots = limited ? new Set((r?.roots ?? []).map((id) => normalizeId(id))) : undefined;
    this.teams = limited ? new Set((r?.teamspaces ?? []).map((id) => normalizeId(id))) : undefined;
    const self = this;

    this.pages = {
      async get(pageId, opts) {
        await self.checkRead("pages.get", pageId);
        return client.pages.get(pageId, opts);
      },
      async create(opts) {
        const p = opts.parent as Record<string, unknown>;
        if (typeof p.pageId === "string") await self.checkRead("pages.create", p.pageId);
        else if (typeof p.databaseId === "string") await self.checkRead("pages.create", p.databaseId);
        else if (typeof p.teamspaceId === "string") {
          if (self.teams && !self.teams.has(normalizeId(p.teamspaceId))) throw self.deny("pages.create", "the teamspace is outside the scope");
        } else if (self.roots) throw self.deny("pages.create", "the private section is outside the scope");
        await self.checkWrite("pages.create", opts);
        return client.pages.create(opts);
      },
      async updateProperties(pageId, properties) {
        await self.checkRead("pages.updateProperties", pageId);
        await self.checkWrite("pages.updateProperties", { pageId, properties });
        return client.pages.updateProperties(pageId, properties);
      },
      async updateContent(pageId, edit) {
        await self.checkRead("pages.updateContent", pageId);
        await self.checkWrite("pages.updateContent", { pageId, edit });
        return client.pages.updateContent(pageId, edit);
      },
    };

    this.databases = {
      async get(dbId) {
        await self.checkRead("databases.get", dbId);
        return client.databases.get(dbId);
      },
      async query(dbId, opts) {
        await self.checkRead("databases.query", dbId);
        return client.databases.query(dbId, opts);
      },
    };

    this.comments = {
      async list(pageId, opts) {
        await self.checkRead("comments.list", pageId);
        return client.comments.list(pageId, opts);
      },
      async create(opts) {
        await self.checkRead("comments.create", opts.pageId);
        await self.checkWrite("comments.create", opts);
        return client.comments.create(opts);
      },
      async reply(discussionId, markdown) {
        const id = normalizeId(discussionId, "discussionId");
        const disc = (await client.core.records.get<{ parent_id?: string }>({ table: "discussion", id })).value;
        if (!disc.parent_id) throw self.deny("comments.reply", "the discussion has no page");
        await self.checkRead("comments.reply", disc.parent_id);
        await self.checkWrite("comments.reply", { discussionId, markdown });
        return client.comments.reply(discussionId, markdown);
      },
    };

    const usersAllowed = () => {
      if (policy.read?.allowUsers === false) throw self.deny("users", "member lookups are disabled");
    };
    this.users = {
      async list(opts) {
        usersAllowed();
        return client.users.list(opts);
      },
      async search(query, opts) {
        usersAllowed();
        return client.users.search(query, opts);
      },
      async get(userId) {
        usersAllowed();
        return client.users.get(userId);
      },
    };
  }

  /** The account and its workspaces. */
  me(): ReturnType<Client["me"]> {
    return this.client.me();
  }

  /** Search, with hits outside the scope left out. */
  async search(query: string, opts?: Parameters<Client["search"]>[1]): ReturnType<Client["search"]> {
    if (this.policy.read?.allowSearch === false) throw this.deny("search", "search is disabled");
    const res = await this.client.search(query, opts);
    if (!this.roots) return res;
    const kept = [];
    for (const hit of res.results) if (await this.inScope(hit.id)) kept.push(hit);
    return { ...res, results: kept };
  }

  /** Whether a page, database or block lies inside the scope (cached for a minute). */
  async inScope(id: string): Promise<boolean> {
    if (!this.roots || !this.teams) return true;
    const start = normalizeId(id);
    await this.client.getWorkspace();
    const hit = this.cache.get(start);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.ok;
    let ok = false;
    let table = "block";
    let cur = start;
    for (let depth = 0; depth < MAX_DEPTH; depth++) {
      if (table === "block" && this.roots.has(cur)) {
        ok = true;
        break;
      }
      if (table === "team") {
        ok = this.teams.has(cur);
        break;
      }
      if (table !== "block" && table !== "collection") break;
      const entries = await this.client.core.getRecords([{ table, id: cur }]);
      const v = entries.get(`${table}:${cur}`);
      if (!v?.value || v.role === "none") break;
      const rec = v.value as { parent_id?: unknown; parent_table?: unknown };
      if (typeof rec.parent_id !== "string" || typeof rec.parent_table !== "string") break;
      table = rec.parent_table;
      cur = rec.parent_id;
    }
    this.cache.set(start, { ok, at: Date.now() });
    return ok;
  }

  private async checkRead(action: string, id: string): Promise<void> {
    if (!(await this.inScope(id))) throw this.deny(action, "the page is outside the scope");
  }

  private async checkWrite(action: ScopedWriteAction, params: unknown): Promise<void> {
    const w = this.policy.write;
    if (w?.readOnly) throw this.deny(action, "the view is read-only");
    if (w?.allowedActions && !w.allowedActions.includes(action)) throw this.deny(action, "the action is not allowed");
    if (this.policy.approval && !(await this.policy.approval(action, params))) throw this.deny(action, "the approval hook refused the write");
  }

  private deny(action: string, reason: string): NotionError {
    this.logger.warn({ action, reason }, "scope policy violation");
    return new NotionError("SCOPE_POLICY_VIOLATION", `${action}: ${reason}`);
  }
}
