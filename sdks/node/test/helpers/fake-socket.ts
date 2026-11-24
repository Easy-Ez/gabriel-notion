import type { WebSocketFactory, WebSocketLike } from "../../src/core/msgstore.js";

type Listener = (ev?: any) => void;

/** A scripted socket: the test plays the server through the `server*` methods. */
export class FakeSocket implements WebSocketLike {
  readyState = 0;
  readonly sent: string[] = [];
  closedWith?: { code?: number; reason?: string };
  private readonly listeners = new Map<string, Listener[]>();

  constructor(
    readonly url: string,
    readonly headers: Record<string, string>,
    private readonly onSend?: (socket: FakeSocket, data: string) => void,
  ) {}

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  send(data: string): void {
    if (this.readyState !== 1) throw new Error("socket not open");
    this.sent.push(data);
    this.onSend?.(this, data);
  }

  close(code?: number, reason?: string): void {
    if (this.readyState >= 2) return;
    this.readyState = 3;
    this.closedWith = { code, reason };
    queueMicrotask(() => this.fire("close", { code: code ?? 1005, reason: reason ?? "" }));
  }

  // ---- server side ----

  serverOpen(open: { pingInterval?: number; pingTimeout?: number } = {}): void {
    this.readyState = 1;
    this.fire("open");
    this.serverSend("0" + JSON.stringify({ sid: "sid-TESTONLY", upgrades: [], pingInterval: open.pingInterval ?? 25_000, pingTimeout: open.pingTimeout ?? 20_000, maxPayload: 1_000_000 }));
  }

  serverSend(data: string): void {
    this.fire("message", { data });
  }

  serverMessage(obj: unknown): void {
    this.serverSend("4" + JSON.stringify(obj));
  }

  serverClose(code = 1005): void {
    this.readyState = 3;
    this.fire("close", { code, reason: "" });
  }

  /** Parsed application messages the client sent. */
  messages(): Array<Record<string, unknown>> {
    return this.sent.filter((d) => d.startsWith("4{")).map((d) => JSON.parse(d.slice(1)) as Record<string, unknown>);
  }

  subscriptions(): Array<{ key: string; version: number }> {
    return this.messages()
      .filter((m) => m.type === "/api/v1/registerBatchSubscriptions")
      .flatMap((m) => m.subscriptions as Array<{ key: string; version: number }>);
  }

  private fire(type: string, ev?: unknown): void {
    for (const l of this.listeners.get(type) ?? []) l(ev);
  }
}

export interface FakeServerOptions {
  /** Keys a socket accepts before answering `error` (models the ~50,000 server limit). */
  capPerSocket?: number;
  /** Answer every subscription request on these socket indexes with `error`. */
  rejectOnSockets?: number[];
  /** Open the Engine.IO session automatically. Default true. */
  autoOpen?: boolean;
  /** Answer subscription requests automatically. Default true. */
  autoRespond?: boolean;
  /** Like the real server for version -1: send each key's current state and report `wasNotified: true`. */
  notifyInitial?: boolean;
}

/** Server-side key state: `set` records a change and notifies open sockets subscribed to the key. */
export interface FakeServerState {
  set(key: string, version: number, value?: unknown): void;
}

/** A factory whose sockets behave like the Message Store unless told otherwise. */
export function fakeServer(opts: FakeServerOptions = {}): { factory: WebSocketFactory; sockets: FakeSocket[]; server: FakeServerState } {
  const sockets: FakeSocket[] = [];
  const counts = new Map<FakeSocket, number>();
  const versions = new Map<string, { version: number; value: unknown }>();
  const subscribed = new Map<FakeSocket, Set<string>>();
  const server: FakeServerState = {
    set(key, version, value = version) {
      versions.set(key, { version, value });
      for (const s of sockets) if (s.readyState === 1 && subscribed.get(s)?.has(key)) s.serverMessage({ type: "notification", key, value, version });
    },
  };
  const onSend = (socket: FakeSocket, data: string) => {
    if (opts.autoRespond === false || !data.startsWith("4{")) return;
    const msg = JSON.parse(data.slice(1)) as { type: string; requestId: string; subscriptions?: unknown[]; keys?: string[] };
    if (msg.type === "/api/v1/registerBatchSubscriptions") {
      const n = (counts.get(socket) ?? 0) + (msg.subscriptions?.length ?? 0);
      const index = sockets.indexOf(socket);
      const reject = (opts.capPerSocket !== undefined && n > opts.capPerSocket) || opts.rejectOnSockets?.includes(index);
      if (!reject) counts.set(socket, n);
      const subs = (msg.subscriptions ?? []) as Array<{ key: string; version: number }>;
      if (!reject) {
        const set = subscribed.get(socket) ?? new Set<string>();
        for (const x of subs) set.add(x.key);
        subscribed.set(socket, set);
      }
      queueMicrotask(() => {
        // Replay: a key resubscribed with an older version gets its latest state.
        if (!reject) for (const x of subs) {
          const cur = versions.get(x.key);
          if (cur && x.version >= 0 && cur.version > x.version) socket.serverMessage({ type: "notification", key: x.key, value: cur.value, version: cur.version });
        }
        if (!reject && opts.notifyInitial) for (const s of subs) if (s.version < 0) socket.serverMessage({ type: "notification", key: s.key, value: 1, version: 1_700_000_000_000 });
        socket.serverMessage(
          reject
            ? { type: "response", requestId: msg.requestId, status: "error" }
            : { type: "response", requestId: msg.requestId, status: "ok", result: { responses: subs.map((s) => ({ key: s.key, wasNotified: Boolean(opts.notifyInitial && s.version < 0) })) } },
        );
      });
    } else if (msg.type === "/api/v1/unregisterBatchSubscriptions") {
      queueMicrotask(() => socket.serverMessage({ type: "response", requestId: msg.requestId, status: "ok", result: { keys: msg.keys } }));
    }
  };
  const factory: WebSocketFactory = (url, init) => {
    const socket = new FakeSocket(url, init.headers, onSend);
    sockets.push(socket);
    if (opts.autoOpen !== false) queueMicrotask(() => socket.serverOpen());
    return socket;
  };
  return { factory, sockets, server };
}
