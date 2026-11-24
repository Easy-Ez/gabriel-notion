import { inspect } from "node:util";
import type { Logger } from "../util/logger.js";
import { silentLogger } from "../util/logger.js";
import { fetchAccount, resolveWorkspace, type AccountInfo, type WorkspaceInfo } from "./account.js";
import { CookieJar, type CookieInput } from "./cookies.js";
import { DEFAULT_USER_AGENT, HttpClient, type CallOptions, type FetchLike } from "./http.js";
import { DEFAULT_MESSAGE_STORE_URL, MessageStore, messageStoreHeaders, type MessageStoreHealth, type MessageStoreSignal, type SubscribeEntry, type WebSocketFactory } from "./msgstore.js";
import { NotionError, isNotionError } from "../errors.js";
import type { CredentialStore } from "./credentials.js";
import { newBlockId, newRandomId, normalizeId } from "./ids.js";
import { Records, type Operation, type RecordEntry, type RecordPointer } from "./records.js";
import type { SessionCheckTrigger, SessionEvents, SessionHealth, SessionState } from "./session.js";

export interface NotionCoreOptions {
  /** Session cookies from the caller's secret store or `signInWithBrowser()`. */
  cookies: readonly CookieInput[] | Record<string, string>;
  /** Account to act as when the session holds several. */
  userId?: string;
  fetch?: FetchLike;
  apiBase?: string;
  userAgent?: string;
  clientVersion?: string;
  logger?: Logger;
  maxRetries?: number;
  timeoutMs?: number;
  /**
   * Optional place to write the cookies back when a session cookie changes (e.g. a rotated
   * `token_v2`), so the next run starts from the current values. Off by default.
   */
  credentialStore?: CredentialStore;
  /** Debounce for credential write-back. Default 1,000 ms. */
  credentialSaveDelayMs?: number;
  /** Creates the Message Store sockets; defaults to Node's built-in `WebSocket`. */
  webSocketFactory?: WebSocketFactory;
  messageStoreUrl?: string;
  /**
   * Connect to the Message Store without cookies. Subscriptions do not need a session, so this
   * works the same; by default the session cookie is sent while the session is valid, like the
   * web client, and dropped once it is `AUTH_DEAD`.
   */
  anonymousRealtime?: boolean;
  /** Per-connection key limit (default 40,000) and connection count (default 4). */
  maxKeysPerConnection?: number;
  maxConnections?: number;
}

export interface CredentialHealth {
  lastSavedAt?: string;
  /** Error code of the last failed save; cleared by the next successful one. */
  lastError?: string;
}

export interface CoreHealth {
  session: SessionHealth;
  userId?: string;
  workspaceId?: string;
  credentials?: CredentialHealth;
  /** Message Store connections, once anything was subscribed. */
  realtime?: MessageStoreHealth;
}

/**
 * Protocol layer (spec §2): session, HTTP and, in later slices, records, transactions and
 * the Message Store connection. It makes no requests of its own beyond what callers ask for
 * (plus the session check on 401) and returns server responses unmodified.
 */
export class NotionCore {
  private readonly jar: CookieJar;
  private readonly http: HttpClient;
  private workspaceInfo?: WorkspaceInfo;
  private spaceShortId?: number;
  private readonly logger: Logger;
  private readonly credentialStore?: CredentialStore;
  private readonly credentialSaveDelayMs: number;
  private credentialTimer?: NodeJS.Timeout;
  private credentialSave: Promise<void> = Promise.resolve();
  private credentialHealth: CredentialHealth = {};
  /** Record reads, transactions and read-back verification. */
  readonly records: Records;
  private readonly opts: NotionCoreOptions;
  private realtime?: MessageStore;

  constructor(opts: NotionCoreOptions) {
    const logger = opts.logger ?? silentLogger;
    this.logger = logger;
    this.opts = opts;
    this.jar = new CookieJar(opts.cookies);
    this.credentialSaveDelayMs = opts.credentialSaveDelayMs ?? 1_000;
    if (opts.credentialStore) {
      this.credentialStore = opts.credentialStore;
      this.jar.onSessionCookieChange((names) => {
        this.logger.info({ cookies: names }, "session cookies changed; scheduling write-back");
        this.scheduleCredentialSave();
      });
    }
    const httpOpts: ConstructorParameters<typeof HttpClient>[0] = { cookies: this.jar, logger };
    if (opts.fetch) httpOpts.fetch = opts.fetch;
    if (opts.apiBase) httpOpts.apiBase = opts.apiBase;
    if (opts.userAgent) httpOpts.userAgent = opts.userAgent;
    if (opts.clientVersion) httpOpts.clientVersion = opts.clientVersion;
    if (opts.maxRetries !== undefined) httpOpts.maxRetries = opts.maxRetries;
    if (opts.timeoutMs !== undefined) httpOpts.timeoutMs = opts.timeoutMs;
    this.http = new HttpClient(httpOpts);
    if (opts.userId) this.http.setActiveUser(opts.userId);
    this.records = new Records(this.http);
  }

  /** Calls any `/api/v3/<endpoint>` with the session, workspace header and retry policy applied. */
  callApi<T = unknown>(endpoint: string, body: unknown, opts?: CallOptions): Promise<T> {
    return this.http.call<T>(endpoint, body, opts);
  }

  /** Reads the account and its workspaces, and makes that account the active user. */
  async account(): Promise<AccountInfo> {
    const info = await fetchAccount(this.http, this.http.activeUser());
    this.http.setActiveUser(info.userId);
    return info;
  }

  /** Binds the workspace used for `x-notion-space-id`, given by ID or exact name. */
  async bindWorkspace(workspace: string): Promise<WorkspaceInfo> {
    const info = resolveWorkspace(await this.account(), workspace);
    this.http.setWorkspace(info.id);
    const space = await this.records.get<{ short_id_str?: string; short_id?: number }>({ table: "space", id: info.id, spaceId: info.id });
    const short = Number(space.value.short_id_str ?? space.value.short_id);
    if (!Number.isSafeInteger(short)) throw new NotionError("NOTION_API_ERROR", "the workspace record has no short ID");
    this.spaceShortId = short;
    this.workspaceInfo = info;
    return info;
  }

  workspace(): WorkspaceInfo | undefined {
    return this.workspaceInfo;
  }

  /** Reads records in batches of at most 1,000 pointers; see `records.get` for single reads. */
  getRecords<T = Record<string, unknown>>(pointers: readonly RecordPointer[], signal?: AbortSignal): Promise<Map<string, RecordEntry<T>>> {
    return this.records.getMany<T>(pointers.map((p) => ({ ...p, id: normalizeId(p.id) })), signal);
  }

  /**
   * Called before every transaction is sent (after `submit` validated nothing else). The client
   * uses it to register its own writes and to enforce the loop guard; a hook that throws stops
   * the write.
   */
  beforeSubmit?: (operations: readonly Operation[]) => void;

  /** Submits one transaction atomically. */
  async submit(operations: readonly Operation[], opts?: { userAction?: string; signal?: AbortSignal }): Promise<void> {
    this.beforeSubmit?.(operations);
    return this.records.submit(operations, opts);
  }

  /** A new block ID (UUID v8 carrying the bound workspace's short ID). */
  newBlockId(): string {
    if (this.spaceShortId === undefined) throw new NotionError("INVALID_STATE", "no workspace is bound; call bindWorkspace() first");
    return newBlockId(this.spaceShortId);
  }

  /** A new ID for discussion, comment, collection and collection_view records (UUID v4). */
  newRecordId(): string {
    return newRandomId();
  }

  /**
   * Re-validates the session, e.g. after a read returned 200 without its record (spec §3).
   * Resolves to "VALID" or "AUTH_DEAD".
   */
  confirmSession(trigger: SessionCheckTrigger = "manual"): Promise<SessionState> {
    return this.http.session.confirm(trigger);
  }

  /** Writes any pending credential change to the store now (call before exiting). */
  async flushCredentials(): Promise<void> {
    if (this.credentialTimer) {
      clearTimeout(this.credentialTimer);
      this.credentialTimer = undefined;
      this.runCredentialSave();
    }
    await this.credentialSave;
  }

  private scheduleCredentialSave(): void {
    if (this.credentialTimer) clearTimeout(this.credentialTimer);
    this.credentialTimer = setTimeout(() => {
      this.credentialTimer = undefined;
      this.runCredentialSave();
    }, this.credentialSaveDelayMs);
    this.credentialTimer.unref?.();
  }

  private runCredentialSave(): void {
    const store = this.credentialStore;
    if (!store) return;
    this.credentialSave = this.credentialSave.then(async () => {
      try {
        await store.save(this.jar.snapshot());
        this.credentialHealth = { lastSavedAt: new Date().toISOString() };
        this.logger.info({}, "session cookies written back");
      } catch (err) {
        const code = isNotionError(err) ? err.code : "STATE_STORE_UNAVAILABLE";
        this.credentialHealth = { ...this.credentialHealth, lastError: code };
        this.logger.error({ code }, "credential write-back failed");
      }
    });
  }

  /**
   * The Message Store connection pool (spec §7, §9), created on first use. Signals are
   * delivered whether or not the session is valid; their content must be read over HTTP.
   */
  get messageStore(): MessageStore {
    if (!this.realtime) {
      const url = this.opts.messageStoreUrl ?? DEFAULT_MESSAGE_STORE_URL;
      const userAgent = this.opts.userAgent ?? DEFAULT_USER_AGENT;
      const headers = () => {
        const anonymous = this.opts.anonymousRealtime === true || this.http.session.current() === "AUTH_DEAD";
        const cookie = anonymous ? undefined : this.jar.headerFor(new URL(url.replace(/^ws/, "http")));
        return messageStoreHeaders(url, cookie === undefined ? { userAgent } : { userAgent, cookie });
      };
      this.realtime = new MessageStore({
        url,
        headers,
        logger: this.logger,
        ...(this.opts.webSocketFactory ? { webSocketFactory: this.opts.webSocketFactory } : {}),
        ...(this.opts.maxKeysPerConnection !== undefined ? { maxKeysPerConnection: this.opts.maxKeysPerConnection } : {}),
        ...(this.opts.maxConnections !== undefined ? { maxConnections: this.opts.maxConnections } : {}),
      });
    }
    return this.realtime;
  }

  /** Subscribes Message Store keys, e.g. `versions/<pageId>:block` or `activity/<pageId>`. */
  subscribe(keys: ReadonlyArray<string | SubscribeEntry>, opts?: { signal?: AbortSignal }): Promise<void> {
    return this.messageStore.subscribe(keys, opts);
  }

  unsubscribe(keys: readonly string[]): Promise<void> {
    return this.messageStore.unsubscribe(keys);
  }

  /** Raw Message Store signals: key, message version and value (counter or record version). */
  onSignal(handler: (key: string, version: number, value: unknown, signal: MessageStoreSignal) => void): () => void {
    return this.messageStore.on("signal", (s) => handler(s.key, s.version, s.value, s));
  }

  /** Closes the Message Store connections. */
  stopRealtime(): void {
    this.realtime?.stop();
    this.realtime = undefined;
  }

  onAuthDead(listener: (payload: SessionEvents["auth.dead"]) => void): () => void {
    return this.http.session.events.on("auth.dead", listener);
  }

  health(): CoreHealth {
    const h: CoreHealth = { session: this.http.session.health() };
    const user = this.http.activeUser();
    if (user) h.userId = user;
    if (this.workspaceInfo) h.workspaceId = this.workspaceInfo.id;
    if (this.credentialStore) h.credentials = { ...this.credentialHealth };
    if (this.realtime) h.realtime = this.realtime.health();
    return h;
  }

  toJSON(): Record<string, unknown> {
    return { ...this.health(), cookies: this.jar.names() };
  }

  [inspect.custom](): string {
    return `NotionCore ${inspect(this.toJSON())}`;
  }
}
