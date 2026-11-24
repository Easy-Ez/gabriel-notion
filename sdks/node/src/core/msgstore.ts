import { randomUUID } from "node:crypto";
import { NotionError, cancelledError } from "../errors.js";
import { fullJitterDelay } from "../util/async.js";
import { Emitter } from "../util/emitter.js";
import { silentLogger, type Logger } from "../util/logger.js";

/**
 * Message Store (Notion's realtime service) over Engine.IO v4 + Primus (spec §7). The connection only carries signals: "this key changed, here is its
 * new counter or record version". Content is always read over HTTP.
 */

export const DEFAULT_MESSAGE_STORE_URL = "wss://msgstore-001.app.notion.com/primus-v8/";
/** Server limit is about 50,000 keys per connection; the SDK leaves headroom (spec §9). */
export const DEFAULT_MAX_KEYS_PER_CONNECTION = 40_000;
/** Keys per `registerBatchSubscriptions` request; 5,000 and 10,000 were measured to work. */
export const DEFAULT_SUBSCRIBE_BATCH_SIZE = 5_000;
export const DEFAULT_MAX_CONNECTIONS = 4;
export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
/** Time allowed between the socket opening and the Engine.IO open packet. */
export const OPEN_TIMEOUT_MS = 15_000;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_CAP_MS = 30_000;
const DEFAULT_PING_INTERVAL_MS = 25_000;
const DEFAULT_PING_TIMEOUT_MS = 20_000;
const API = "/api/v1/";
const OPEN = 1;

/** The part of the WHATWG `WebSocket` the SDK uses; Node 22's global `WebSocket` satisfies it. */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(type: "message", listener: (ev: { data: unknown }) => void): void;
  addEventListener(type: "close", listener: (ev: { code: number; reason: string }) => void): void;
  addEventListener(type: "error", listener: (ev: unknown) => void): void;
}

export type WebSocketFactory = (url: string, init: { headers: Record<string, string> }) => WebSocketLike;

/** Uses Node's built-in `WebSocket` (undici), which accepts request headers in its init object. */
export const defaultWebSocketFactory: WebSocketFactory = (url, init) => {
  const Ctor = (globalThis as { WebSocket?: new (url: string, init: unknown) => WebSocketLike }).WebSocket;
  if (!Ctor) throw new NotionError("INVALID_STATE", "this runtime has no global WebSocket; use Node.js 22 or pass webSocketFactory");
  return new Ctor(url, init);
};

export type ConnectionState = "CONNECTING" | "SUBSCRIBING" | "READY" | "BACKOFF" | "STOPPED";

export interface MessageStoreSignal {
  key: string;
  /** Counter for `activity/` and `collection/` keys, record version for `versions/` keys. */
  value: unknown;
  /** Message version; resubscribing with it makes the server send only newer state. */
  version: number;
  connectionId: number;
  /**
   * Not a change: the current state the server sends in reply to a subscription with version -1,
   * or a frame with version -1 (the key has no state yet). Callers record the version and
   * otherwise ignore it.
   */
  initial?: boolean;
}

export interface MessageStoreEvents extends Record<string, unknown> {
  signal: MessageStoreSignal;
  /** A notification with `status: "error"` for one key. */
  "subscription.error": { key: string; error: unknown; connectionId: number };
  "connection.state": { connectionId: number; state: ConnectionState; previous: ConnectionState };
  /** All keys of a connection are (re)subscribed. After a reconnect, the caller should backfill. */
  "connection.ready": { connectionId: number; reconnect: boolean; downtimeMs?: number; keys: number };
  "connection.closed": { connectionId: number; code: number; reason: string };
  /** A batch the server answered with `error`; it is retried on a new connection. */
  "batch.rejected": { connectionId: number; keys: number; movedTo?: number; error?: string };
  /** A frame the SDK does not understand. Emitted once per kind. */
  "protocol.drift": { connectionId: number; kind: string; sample: string };
}

export interface ConnectionHealth {
  id: number;
  state: ConnectionState;
  keys: number;
  /** Keys this connection may hold; lowered when the server rejects a batch below the default. */
  capacity: number;
  connectedForMs?: number;
  reconnects: number;
  lastCloseCode?: number;
}

export interface MessageStoreHealth {
  keys: number;
  connections: ConnectionHealth[];
}

export interface MessageStoreOptions {
  url?: string;
  /**
   * Request headers for each connection attempt (origin, user agent, and the session cookie
   * unless the connection is anonymous). Called on every attempt so a dead session can be
   * dropped. Subscriptions do not need a session (2026-11-23 experiment).
   */
  headers?: () => Record<string, string>;
  webSocketFactory?: WebSocketFactory;
  maxKeysPerConnection?: number;
  maxConnections?: number;
  batchSize?: number;
  requestTimeoutMs?: number;
  logger?: Logger;
  /** Test hooks. */
  random?: () => number;
  now?: () => number;
}

export interface SubscribeEntry {
  key: string;
  /** Last message version seen for this key (e.g. from the StateStore); -1 for "send current state". */
  version?: number;
}

interface ResponseFrame {
  type: "response";
  requestId: string;
  status?: string;
  result?: unknown;
}

interface Pending {
  resolve: (frame: ResponseFrame) => void;
  reject: (err: unknown) => void;
  timer: NodeJS.Timeout;
}

interface Waiter {
  resolve: () => void;
  reject: (err: unknown) => void;
}

function closedError(): NotionError {
  return new NotionError("NETWORK_TIMEOUT", "the Message Store connection closed");
}

function isNotionHost(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  return host === "notion.com" || host.endsWith(".notion.com") || host === "notion.so" || host.endsWith(".notion.so");
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * One socket: Engine.IO handshake and heartbeat (`2` → `3`), Primus heartbeat
 * (`primus::ping::<t>` → `primus::pong::<t>`), request/response matching by `requestId`, and
 * reconnection with full-jitter backoff that resubscribes every key with its last version.
 */
class Connection {
  /** Desired keys and the version to subscribe them with. */
  readonly keys = new Map<string, number>();
  /** Keys the server acknowledged on the current socket. */
  private readonly acked = new Set<string>();
  /** Keys subscribed with version -1 whose current-state frame has not arrived yet. */
  private readonly awaitingInitial = new Set<string>();
  /**
   * Keys acknowledged on an earlier socket. Resubscribed with -1 after a reconnect (they had no
   * state then), any frame for them is a change made while disconnected, not an initial state.
   */
  private readonly everAcked = new Set<string>();
  capacity: number;
  private stateValue: ConnectionState = "CONNECTING";
  private socket?: WebSocketLike;
  private epoch = 0;
  private attempt = 0;
  private everReady = false;
  private readyAt?: number;
  private lostAt?: number;
  private reconnects = 0;
  private lastCloseCode?: number;
  private pingTimeoutMs = DEFAULT_PING_INTERVAL_MS + DEFAULT_PING_TIMEOUT_MS;
  private openTimer?: NodeJS.Timeout;
  private watchdog?: NodeJS.Timeout;
  private backoffTimer?: NodeJS.Timeout;
  private readonly pending = new Map<string, Pending>();
  private waiters: Waiter[] = [];
  /** Batches rejected while (re)subscribing, handed to the first waiting `sync()` caller. */
  private handoff?: { rejected: string[]; error?: string };
  private stopped = false;

  constructor(
    readonly id: number,
    private readonly pool: MessageStore,
    private readonly opts: Required<Pick<MessageStoreOptions, "url" | "headers" | "webSocketFactory" | "batchSize" | "requestTimeoutMs" | "random" | "now" | "logger">>,
    capacity: number,
  ) {
    this.capacity = capacity;
  }

  get state(): ConnectionState {
    return this.stateValue;
  }

  get room(): number {
    return Math.max(0, this.capacity - this.keys.size);
  }

  start(): void {
    this.connect();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    clearTimeout(this.backoffTimer);
    this.teardown(1000, "client stop");
    this.failWaiters(cancelledError("the Message Store was stopped"));
    this.setState("STOPPED");
  }

  health(): ConnectionHealth {
    const h: ConnectionHealth = { id: this.id, state: this.stateValue, keys: this.keys.size, capacity: this.capacity, reconnects: this.reconnects };
    if (this.stateValue === "READY" && this.readyAt !== undefined) h.connectedForMs = this.opts.now() - this.readyAt;
    if (this.lastCloseCode !== undefined) h.lastCloseCode = this.lastCloseCode;
    return h;
  }

  /** Subscribes the desired keys the server has not acknowledged yet. Returns the keys of rejected batches. */
  async sync(signal?: AbortSignal): Promise<{ rejected: string[]; error?: string }> {
    await this.whenReady(signal);
    const handed = this.handoff;
    this.handoff = undefined;
    const own = await this.sendMissing(signal);
    if (!handed) return own;
    const rejected = [...new Set([...handed.rejected, ...own.rejected])];
    const error = own.error ?? handed.error;
    return error === undefined ? { rejected } : { rejected, error };
  }

  async unregister(keys: readonly string[]): Promise<void> {
    for (const k of keys) {
      this.keys.delete(k);
      this.acked.delete(k);
    }
    if (this.stateValue !== "READY" || keys.length === 0) return;
    for (const batch of chunk(keys, this.opts.batchSize)) {
      try {
        await this.request("unregisterBatchSubscriptions", { keys: batch });
      } catch (err) {
        this.opts.logger.warn({ connectionId: this.id, code: (err as NotionError).code }, "unsubscribe failed; keys dropped locally");
      }
    }
  }

  /** Records a message version so a reconnect resumes from it. */
  noteVersion(key: string, version: number): boolean {
    if (!this.keys.has(key)) return false;
    if (Number.isFinite(version) && version >= 0) this.keys.set(key, version);
    return true;
  }

  /** Waits until the connection is READY, for at most the request timeout. */
  private whenReady(signal?: AbortSignal): Promise<void> {
    if (this.stateValue === "READY") return Promise.resolve();
    if (this.stopped) return Promise.reject(cancelledError("the Message Store was stopped"));
    if (signal?.aborted) return Promise.reject(cancelledError(signal.reason));
    return new Promise((resolve, reject) => {
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.waiters = this.waiters.filter((w) => w !== waiter);
      };
      const onAbort = () => {
        done();
        reject(cancelledError(signal?.reason));
      };
      const timer = setTimeout(() => {
        done();
        reject(new NotionError("NETWORK_TIMEOUT", `the Message Store did not connect within ${this.opts.requestTimeoutMs} ms; the keys stay registered`));
      }, this.opts.requestTimeoutMs);
      const waiter: Waiter = {
        resolve: () => {
          done();
          resolve();
        },
        reject: (err) => {
          done();
          reject(err);
        },
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  private failWaiters(err: unknown): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w.reject(err);
  }

  private setState(state: ConnectionState): void {
    const previous = this.stateValue;
    if (previous === state) return;
    this.stateValue = state;
    this.pool.emitEvent("connection.state", { connectionId: this.id, state, previous });
  }

  private connect(): void {
    if (this.stopped) return;
    const epoch = ++this.epoch;
    this.acked.clear();
    this.awaitingInitial.clear();
    this.setState("CONNECTING");
    const url = new URL(this.opts.url);
    url.searchParams.set("sessionId", randomUUID());
    url.searchParams.set("EIO", "4");
    url.searchParams.set("transport", "websocket");
    let socket: WebSocketLike;
    try {
      socket = this.opts.webSocketFactory(url.toString(), { headers: this.opts.headers() });
    } catch (err) {
      this.opts.logger.warn({ connectionId: this.id, err: err instanceof Error ? err.name : "error" }, "websocket creation failed");
      this.onGone(epoch, 1006, "creation failed");
      return;
    }
    this.socket = socket;
    socket.addEventListener("open", () => {
      if (epoch !== this.epoch) return;
      this.openTimer = setTimeout(() => {
        if (epoch !== this.epoch) return;
        this.opts.logger.warn({ connectionId: this.id }, "no Engine.IO open packet");
        this.restart(epoch, 4000, "open timeout");
      }, OPEN_TIMEOUT_MS);
    });
    socket.addEventListener("message", (ev) => {
      if (epoch !== this.epoch) return;
      this.onPacket(epoch, typeof ev.data === "string" ? ev.data : String(ev.data));
    });
    socket.addEventListener("close", (ev) => {
      if (epoch !== this.epoch) return;
      this.onGone(epoch, ev.code, ev.reason);
    });
    socket.addEventListener("error", () => {
      if (epoch !== this.epoch) return;
      this.opts.logger.debug({ connectionId: this.id }, "websocket error");
    });
  }

  private send(data: string): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== OPEN) throw closedError();
    socket.send(data);
  }

  private armWatchdog(epoch: number): void {
    clearTimeout(this.watchdog);
    this.watchdog = setTimeout(() => {
      if (epoch !== this.epoch) return;
      this.opts.logger.warn({ connectionId: this.id }, "no heartbeat from the server");
      this.restart(epoch, 4000, "heartbeat timeout");
    }, this.pingTimeoutMs);
    this.watchdog.unref?.();
  }

  private onPacket(epoch: number, data: string): void {
    this.armWatchdog(epoch);
    const type = data[0];
    const body = data.slice(1);
    switch (type) {
      case "0": {
        clearTimeout(this.openTimer);
        try {
          const open = JSON.parse(body) as { pingInterval?: number; pingTimeout?: number };
          const interval = Number(open.pingInterval) || DEFAULT_PING_INTERVAL_MS;
          const timeout = Number(open.pingTimeout) || DEFAULT_PING_TIMEOUT_MS;
          this.pingTimeoutMs = interval + timeout;
        } catch {
          this.pool.drift(this.id, "engineio.open", data);
        }
        this.armWatchdog(epoch);
        void this.resubscribe(epoch);
        return;
      }
      case "1":
        this.restart(epoch, 4000, "server close packet");
        return;
      case "2":
        this.trySend("3" + body);
        return;
      case "3":
      case "6":
        return;
      case "4":
        this.onMessage(epoch, body);
        return;
      default:
        this.pool.drift(this.id, `engineio.${type ?? "empty"}`, data);
    }
  }

  private trySend(data: string): void {
    try {
      this.send(data);
    } catch {
      /* closing; the close handler reconnects */
    }
  }

  private onMessage(epoch: number, body: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(body);
    } catch {
      this.pool.drift(this.id, "message.json", body);
      return;
    }
    if (typeof msg === "string") {
      if (msg.startsWith("primus::ping::")) {
        this.trySend("4" + JSON.stringify(`primus::pong::${msg.slice("primus::ping::".length)}`));
      } else if (msg.startsWith("primus::server::close")) {
        this.restart(epoch, 4000, "primus server close");
      } else {
        this.pool.drift(this.id, "primus.string", msg);
      }
      return;
    }
    const frame = msg as { type?: unknown; [k: string]: unknown };
    if (frame?.type === "response" && typeof frame.requestId === "string") {
      const p = this.pending.get(frame.requestId);
      if (!p) return;
      this.pending.delete(frame.requestId);
      clearTimeout(p.timer);
      p.resolve(frame as unknown as ResponseFrame);
      return;
    }
    if (frame?.type === "notification" && typeof frame.key === "string") {
      if (typeof frame.ackId === "string") {
        this.trySend("4" + JSON.stringify({ type: `${API}ackNotification`, requestId: randomUUID(), ackId: frame.ackId }));
      }
      if (frame.status === "error") {
        this.pool.emitEvent("subscription.error", { key: frame.key, error: frame.value, connectionId: this.id });
        return;
      }
      const version = Number(frame.version);
      // Version -1 means "no state yet": a reply to subscribing, never a change.
      const initial = this.awaitingInitial.delete(frame.key) || !(version >= 0);
      if (!this.noteVersion(frame.key, version)) return; // unsubscribed meanwhile
      this.pool.emitEvent("signal", { key: frame.key, value: frame.value, version, connectionId: this.id, ...(initial ? { initial } : {}) });
      return;
    }
    this.pool.drift(this.id, `frame.${typeof frame?.type === "string" ? frame.type : "untyped"}`, body);
  }

  private request(method: string, payload: Record<string, unknown>, signal?: AbortSignal): Promise<ResponseFrame> {
    const requestId = randomUUID();
    return new Promise<ResponseFrame>((resolve, reject) => {
      if (signal?.aborted) return reject(cancelledError(signal.reason));
      const onAbort = () => {
        if (!this.pending.delete(requestId)) return;
        clearTimeout(timer);
        reject(cancelledError(signal?.reason));
      };
      const timer = setTimeout(() => {
        if (!this.pending.delete(requestId)) return;
        signal?.removeEventListener("abort", onAbort);
        reject(new NotionError("NETWORK_TIMEOUT", `no Message Store response to ${method} within ${this.opts.requestTimeoutMs} ms`));
      }, this.opts.requestTimeoutMs);
      this.pending.set(requestId, {
        resolve: (f) => {
          signal?.removeEventListener("abort", onAbort);
          resolve(f);
        },
        reject: (e) => {
          signal?.removeEventListener("abort", onAbort);
          reject(e);
        },
        timer,
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        this.send("4" + JSON.stringify({ type: API + method, requestId, ...payload }));
      } catch (err) {
        this.pending.delete(requestId);
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  /** After the Engine.IO open packet: subscribe every desired key with its last version. */
  private async resubscribe(epoch: number): Promise<void> {
    this.setState("SUBSCRIBING");
    let result: { rejected: string[]; error?: string };
    try {
      result = await this.sendMissing();
    } catch (err) {
      if (epoch !== this.epoch) return;
      this.opts.logger.warn({ connectionId: this.id, code: (err as NotionError).code }, "resubscribe failed; reconnecting");
      this.restart(epoch, 4000, "resubscribe failed");
      return;
    }
    if (epoch !== this.epoch) return;
    const reconnect = this.everReady;
    const downtimeMs = reconnect && this.lostAt !== undefined ? this.opts.now() - this.lostAt : undefined;
    this.everReady = true;
    this.readyAt = this.opts.now();
    this.lostAt = undefined;
    this.attempt = 0;
    this.setState("READY");
    const waiters = this.waiters;
    this.waiters = [];
    if (result.rejected.length > 0 && waiters.length > 0) {
      // A subscribe() is waiting on this connection; it moves the rejected batches and reports
      // the outcome to its caller.
      this.handoff = result;
    } else if (result.rejected.length > 0) {
      this.pool.relocate(this, result.rejected, result.error).catch((err: unknown) => {
        this.opts.logger.error({ connectionId: this.id, code: (err as NotionError).code }, "could not resubscribe a rejected batch");
      });
    }
    for (const w of waiters) w.resolve();
    const ready: MessageStoreEvents["connection.ready"] = { connectionId: this.id, reconnect, keys: this.keys.size };
    if (downtimeMs !== undefined) ready.downtimeMs = downtimeMs;
    this.pool.emitEvent("connection.ready", ready);
  }

  private async sendMissing(signal?: AbortSignal): Promise<{ rejected: string[]; error?: string }> {
    const epoch = this.epoch;
    const rejected: string[] = [];
    let error: string | undefined;
    // Re-read the missing keys after each batch: keys may be added or removed meanwhile.
    for (;;) {
      const missing = [...this.keys].filter(([k]) => !this.acked.has(k) && !rejected.includes(k)).slice(0, this.opts.batchSize);
      if (missing.length === 0) break;
      for (const [k, v] of missing) if (v < 0 && !this.everAcked.has(k)) this.awaitingInitial.add(k);
      const res = await this.request("registerBatchSubscriptions", { subscriptions: missing.map(([key, version]) => ({ key, version })) }, signal);
      if (epoch !== this.epoch) throw closedError();
      if (res.status === "ok") {
        for (const [k] of missing) {
          this.acked.add(k);
          this.everAcked.add(k);
        }
        // `wasNotified: false`: no current-state frame is coming for that key.
        const responses = (res.result as { responses?: Array<{ key?: string; wasNotified?: boolean }> } | undefined)?.responses;
        if (Array.isArray(responses)) {
          for (const r of responses) if (r.key && r.wasNotified === false) this.awaitingInitial.delete(r.key);
        } else {
          for (const [k] of missing) this.awaitingInitial.delete(k);
        }
      } else {
        for (const [k] of missing) this.awaitingInitial.delete(k);
        // The whole batch failed without explanation, e.g. past the per-connection key limit.
        error = typeof res.status === "string" ? res.status : "error";
        for (const [k] of missing) rejected.push(k);
      }
    }
    return error === undefined ? { rejected } : { rejected, error };
  }

  /** Closes the current socket and schedules a reconnect. */
  private restart(epoch: number, code: number, reason: string): void {
    if (epoch !== this.epoch) return;
    this.teardown(code, reason);
    this.onGone(epoch, code, reason);
  }

  private teardown(code: number, reason: string): void {
    clearTimeout(this.openTimer);
    clearTimeout(this.watchdog);
    const socket = this.socket;
    this.socket = undefined;
    if (socket) {
      try {
        socket.close(code, reason);
      } catch {
        /* already closed */
      }
    }
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const p of pending) {
      clearTimeout(p.timer);
      p.reject(closedError());
    }
  }

  private onGone(epoch: number, code: number, reason: string): void {
    if (epoch !== this.epoch) return;
    this.epoch++; // ignore anything the old socket still delivers
    this.teardown(code, reason);
    this.lastCloseCode = code;
    if (this.stateValue === "READY") this.lostAt = this.opts.now();
    this.lostAt ??= this.opts.now();
    this.pool.emitEvent("connection.closed", { connectionId: this.id, code, reason });
    if (this.stopped) return;
    const delay = Math.max(250, fullJitterDelay(this.attempt, BACKOFF_BASE_MS, BACKOFF_CAP_MS, this.opts.random));
    this.attempt++;
    this.reconnects++;
    this.setState("BACKOFF");
    this.opts.logger.info({ connectionId: this.id, code, delayMs: delay }, "Message Store connection lost; reconnecting");
    this.backoffTimer = setTimeout(() => this.connect(), delay);
  }
}

/**
 * A pool of Message Store connections (spec §7): at most `maxKeysPerConnection`
 * keys each; a batch the server rejects is retried on a new connection; every connection
 * reconnects on its own and resubscribes with the last message versions.
 */
export class MessageStore {
  private readonly connections: Connection[] = [];
  private readonly events = new Emitter<MessageStoreEvents>();
  private readonly drifted = new Set<string>();
  /** Keys whose rejected batch is being retried on a new connection. */
  private readonly moving = new Map<string, Promise<void>>();
  private nextId = 1;
  private stopped = false;
  private readonly opts: Required<Pick<MessageStoreOptions, "url" | "headers" | "webSocketFactory" | "batchSize" | "requestTimeoutMs" | "random" | "now" | "logger">>;
  private readonly maxKeys: number;
  private readonly maxConnections: number;

  constructor(options: MessageStoreOptions = {}) {
    const url = options.url ?? DEFAULT_MESSAGE_STORE_URL;
    const parsed = new URL(url);
    if (parsed.protocol !== "wss:" && !(parsed.protocol === "ws:" && ["localhost", "127.0.0.1"].includes(parsed.hostname))) {
      throw new NotionError("INVALID_ARGUMENT", "the Message Store URL must use wss:");
    }
    this.opts = {
      url,
      headers: options.headers ?? (() => ({})),
      webSocketFactory: options.webSocketFactory ?? defaultWebSocketFactory,
      batchSize: Math.max(1, options.batchSize ?? DEFAULT_SUBSCRIBE_BATCH_SIZE),
      requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      random: options.random ?? Math.random,
      now: options.now ?? Date.now,
      logger: options.logger ?? silentLogger,
    };
    this.maxKeys = Math.max(1, options.maxKeysPerConnection ?? DEFAULT_MAX_KEYS_PER_CONNECTION);
    this.maxConnections = Math.max(1, options.maxConnections ?? DEFAULT_MAX_CONNECTIONS);
  }

  on<K extends keyof MessageStoreEvents>(event: K, listener: (payload: MessageStoreEvents[K]) => void): () => void {
    return this.events.on(event, listener);
  }

  /**
   * Subscribes keys, spreading them over connections. Resolves once the server acknowledged
   * every key. Keys already subscribed are left as they are. If the connection is down, the keys
   * stay registered and are subscribed when it comes back; the call itself fails after the
   * request timeout or when `signal` aborts.
   */
  async subscribe(entries: ReadonlyArray<string | SubscribeEntry>, opts: { signal?: AbortSignal } = {}): Promise<void> {
    if (this.stopped) throw new NotionError("INVALID_STATE", "the Message Store was stopped");
    const wanted = new Map<string, number>();
    for (const e of entries) {
      const entry = typeof e === "string" ? { key: e } : e;
      if (typeof entry.key !== "string" || entry.key.length === 0) throw new NotionError("INVALID_ARGUMENT", "subscription keys must be non-empty strings");
      if (this.owner(entry.key)) continue;
      wanted.set(entry.key, Number.isFinite(entry.version) ? (entry.version as number) : -1);
    }
    if (wanted.size === 0) return;
    const total = this.keyCount() + wanted.size;
    if (total > this.maxKeys * this.maxConnections) {
      throw new NotionError("SUBSCRIPTION_CAP_EXCEEDED", `${total} keys exceed ${this.maxConnections} connections × ${this.maxKeys} keys`);
    }
    const touched = new Set<Connection>();
    let rest = [...wanted];
    for (const conn of this.connections) {
      if (rest.length === 0) break;
      const take = rest.slice(0, conn.room);
      if (take.length === 0) continue;
      for (const [k, v] of take) conn.keys.set(k, v);
      rest = rest.slice(take.length);
      touched.add(conn);
    }
    while (rest.length > 0) {
      const conn = this.openConnection();
      const take = rest.slice(0, conn.room);
      for (const [k, v] of take) conn.keys.set(k, v);
      rest = rest.slice(take.length);
      touched.add(conn);
    }
    const results = await Promise.all([...touched].map(async (conn) => ({ conn, ...(await conn.sync(opts.signal)) })));
    const moves = results.filter((r) => r.rejected.length > 0).map((r) => this.relocate(r.conn, r.rejected, r.error, opts.signal));
    await Promise.all(moves);
    // Batches rejected while a connection was (re)subscribing are moved in the background;
    // wait for the ones that carry this call's keys so their failure reaches the caller.
    const inflight = new Set<Promise<void>>();
    for (const k of wanted.keys()) {
      const p = this.moving.get(k);
      if (p) inflight.add(p);
    }
    await Promise.all(inflight);
  }

  /** Unsubscribes keys; connections left without keys are closed. */
  async unsubscribe(keys: readonly string[]): Promise<void> {
    const byConn = new Map<Connection, string[]>();
    for (const k of keys) {
      const conn = this.owner(k);
      if (conn) byConn.set(conn, [...(byConn.get(conn) ?? []), k]);
    }
    await Promise.all([...byConn].map(([conn, ks]) => conn.unregister(ks)));
    for (const conn of [...byConn.keys()]) if (conn.keys.size === 0) this.dropConnection(conn);
  }

  /** Last message version per subscribed key, for persisting in the StateStore. */
  versions(): Map<string, number> {
    const out = new Map<string, number>();
    for (const c of this.connections) for (const [k, v] of c.keys) out.set(k, v);
    return out;
  }

  has(key: string): boolean {
    return this.owner(key) !== undefined;
  }

  health(): MessageStoreHealth {
    return { keys: this.keyCount(), connections: this.connections.map((c) => c.health()) };
  }

  /** Closes every connection; later `subscribe` calls fail with `INVALID_STATE`. */
  stop(): void {
    this.stopped = true;
    for (const c of this.connections.splice(0)) c.stop();
  }

  /** @internal */
  emitEvent<K extends keyof MessageStoreEvents>(event: K, payload: MessageStoreEvents[K]): void {
    this.events.emit(event, payload, (err) => this.opts.logger.error({ event, err: err instanceof Error ? err.name : "error" }, "Message Store listener threw"));
  }

  /** @internal Reports an unknown frame once per kind, with a short sample (frames carry no credentials). */
  drift(connectionId: number, kind: string, sample: string): void {
    if (this.drifted.has(kind)) return;
    this.drifted.add(kind);
    this.opts.logger.warn({ connectionId, kind }, "unknown Message Store frame");
    this.emitEvent("protocol.drift", { connectionId, kind, sample: sample.slice(0, 200) });
  }

  /**
   * @internal A batch was answered with `error`: the connection is treated as full at its
   * current size, and the batch is retried on a new connection. A second rejection there is not
   * a capacity problem and fails.
   */
  relocate(from: Connection, keys: readonly string[], error?: string, signal?: AbortSignal): Promise<void> {
    const p = this.moveBatch(from, keys, error, signal);
    for (const k of keys) this.moving.set(k, p);
    const clear = () => {
      for (const k of keys) if (this.moving.get(k) === p) this.moving.delete(k);
    };
    p.then(clear, clear);
    return p;
  }

  private async moveBatch(from: Connection, keys: readonly string[], error?: string, signal?: AbortSignal): Promise<void> {
    const versions = keys.map((k) => [k, from.keys.get(k) ?? -1] as const);
    for (const k of keys) from.keys.delete(k);
    from.capacity = Math.min(from.capacity, from.keys.size);
    if (this.stopped) return;
    if (this.connections.length >= this.maxConnections) {
      this.emitEvent("batch.rejected", { connectionId: from.id, keys: keys.length, ...(error ? { error } : {}) });
      throw new NotionError("SUBSCRIPTION_CAP_EXCEEDED", `the server rejected ${keys.length} keys and all ${this.maxConnections} connections are in use`);
    }
    const to = this.openConnection();
    this.emitEvent("batch.rejected", { connectionId: from.id, keys: keys.length, movedTo: to.id, ...(error ? { error } : {}) });
    this.opts.logger.warn({ from: from.id, to: to.id, keys: keys.length }, "subscription batch rejected; retrying on a new connection");
    for (const [k, v] of versions) to.keys.set(k, v);
    const result = await to.sync(signal);
    if (result.rejected.length > 0) {
      for (const k of result.rejected) to.keys.delete(k);
      if (to.keys.size === 0) this.dropConnection(to);
      throw new NotionError("NOTION_API_ERROR", `the Message Store rejected ${result.rejected.length} keys on a new connection`, { rawError: result.error });
    }
  }

  private openConnection(): Connection {
    const conn = new Connection(this.nextId++, this, this.opts, this.maxKeys);
    this.connections.push(conn);
    conn.start();
    return conn;
  }

  private dropConnection(conn: Connection): void {
    const i = this.connections.indexOf(conn);
    if (i >= 0) this.connections.splice(i, 1);
    conn.stop();
  }

  private owner(key: string): Connection | undefined {
    return this.connections.find((c) => c.keys.has(key));
  }

  private keyCount(): number {
    return this.connections.reduce((n, c) => n + c.keys.size, 0);
  }
}

/** Default request headers for a Message Store connection. Cookies go only to Notion hosts over wss. */
export function messageStoreHeaders(url: string, opts: { userAgent: string; cookie?: string }): Record<string, string> {
  const headers: Record<string, string> = { origin: "https://app.notion.com", "user-agent": opts.userAgent };
  const u = new URL(url);
  if (opts.cookie && u.protocol === "wss:" && isNotionHost(u)) headers.cookie = opts.cookie;
  return headers;
}
