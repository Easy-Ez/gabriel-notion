import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageStore, type MessageStoreEvents, type MessageStoreOptions } from "../src/core/msgstore.js";
import { NotionCore } from "../src/core/core.js";
import { isNotionError } from "../src/errors.js";
import { fakeServer, type FakeServerOptions } from "./helpers/fake-socket.js";
import { fakeFetch, json } from "./helpers/fake-fetch.js";

const P1 = "11111111-1111-4111-8111-111111111111";
const stores: MessageStore[] = [];

afterEach(() => {
  for (const s of stores.splice(0)) s.stop();
  vi.useRealTimers();
});

function setup(server: FakeServerOptions = {}, opts: Partial<MessageStoreOptions> = {}) {
  const { factory, sockets } = fakeServer(server);
  const store = new MessageStore({ webSocketFactory: factory, random: () => 1, ...opts });
  stores.push(store);
  const events: Array<{ event: keyof MessageStoreEvents; payload: unknown }> = [];
  for (const e of ["signal", "subscription.error", "connection.ready", "connection.closed", "batch.rejected", "protocol.drift"] as const) {
    store.on(e, (payload) => events.push({ event: e, payload }));
  }
  const of = <K extends keyof MessageStoreEvents>(e: K) => events.filter((x) => x.event === e).map((x) => x.payload as MessageStoreEvents[K]);
  return { store, sockets, events, of };
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

async function code(p: Promise<unknown>): Promise<string | undefined> {
  return p.then(
    () => undefined,
    (e: unknown) => (isNotionError(e) ? e.code : String(e)),
  );
}

describe("MessageStore connection", () => {
  it("connects over Engine.IO v4 websocket with origin and user agent, and no cookie unless given", async () => {
    const { store, sockets } = setup({}, { headers: () => ({ origin: "https://app.notion.com", "user-agent": "UA-TESTONLY" }) });
    await store.subscribe([`versions/${P1}:block`]);
    const url = new URL(sockets[0]!.url);
    expect(url.origin + url.pathname).toBe("wss://msgstore-001.app.notion.com/primus-v8/");
    expect(url.searchParams.get("EIO")).toBe("4");
    expect(url.searchParams.get("transport")).toBe("websocket");
    expect(url.searchParams.get("sessionId")).toMatch(/^[0-9a-f-]{36}$/);
    expect(sockets[0]!.headers).toEqual({ origin: "https://app.notion.com", "user-agent": "UA-TESTONLY" });
  });

  it("subscribes with registerBatchSubscriptions in batches and version -1 by default", async () => {
    const { store, sockets } = setup({}, { batchSize: 2 });
    await store.subscribe([`versions/${P1}:block`, `activity/${P1}`, { key: "collection/c1", version: 1732400000005 }]);
    const reqs = sockets[0]!.messages();
    expect(reqs).toHaveLength(2);
    expect(reqs[0]).toMatchObject({ type: "/api/v1/registerBatchSubscriptions", subscriptions: [{ key: `versions/${P1}:block`, version: -1 }, { key: `activity/${P1}`, version: -1 }] });
    expect(typeof reqs[0]!.requestId).toBe("string");
    expect(reqs[1]).toMatchObject({ subscriptions: [{ key: "collection/c1", version: 1732400000005 }] });
    expect(store.health()).toMatchObject({ keys: 3, connections: [{ id: 1, state: "READY", keys: 3, capacity: 40_000 }] });
    // Already subscribed keys are not sent again.
    await store.subscribe([`activity/${P1}`]);
    expect(sockets[0]!.messages()).toHaveLength(2);
  });

  it("answers the Engine.IO ping and the Primus ping", async () => {
    const { store, sockets } = setup();
    await store.subscribe(["activity/a"]);
    const s = sockets[0]!;
    s.serverSend("2");
    s.serverMessage("primus::ping::1732400000123");
    expect(s.sent).toContain("3");
    expect(s.sent).toContain('4"primus::pong::1732400000123"');
  });

  it("emits signals, records versions, acks notifications that ask for it, and reports error notifications", async () => {
    const { store, sockets, of } = setup();
    await store.subscribe(["activity/a", "versions/b:block"]);
    const s = sockets[0]!;
    s.serverMessage({ type: "notification", key: "activity/a", value: 3, version: 1732400000010 });
    s.serverMessage({ type: "notification", key: "versions/b:block", value: 7, version: 1732400000011, ackId: "ack-1" });
    s.serverMessage({ type: "notification", key: "versions/b:block", status: "error", value: { name: "Oops" }, version: -1 });
    s.serverMessage({ type: "notification", key: "activity/not-mine", value: 1, version: 5 });
    expect(of("signal")).toEqual([
      { key: "activity/a", value: 3, version: 1732400000010, connectionId: 1 },
      { key: "versions/b:block", value: 7, version: 1732400000011, connectionId: 1 },
    ]);
    expect(of("subscription.error")).toEqual([{ key: "versions/b:block", error: { name: "Oops" }, connectionId: 1 }]);
    expect(s.messages().find((m) => m.type === "/api/v1/ackNotification")).toMatchObject({ ackId: "ack-1" });
    expect(store.versions()).toEqual(new Map([["activity/a", 1732400000010], ["versions/b:block", 1732400000011]]));
  });

  it("marks the current-state frame that answers a version -1 subscription as initial", async () => {
    const { store, sockets, of } = setup({ notifyInitial: true });
    await store.subscribe(["activity/a", { key: "activity/b", version: 5 }]);
    sockets[0]!.serverMessage({ type: "notification", key: "activity/a", value: 2, version: 1_700_000_000_001 });
    expect(of("signal").map((x) => [x.key, x.initial ?? false])).toEqual([
      ["activity/a", true],
      ["activity/a", false],
    ]);
    expect(store.versions().get("activity/a")).toBe(1_700_000_000_001);
    // A key without state answers with version -1, which is never a change.
    sockets[0]!.serverMessage({ type: "notification", key: "activity/b", value: null, version: -1 });
    expect(of("signal").at(-1)).toMatchObject({ key: "activity/b", initial: true });
  });

  it("reports unknown frames once per kind", async () => {
    const { store, sockets, of } = setup();
    await store.subscribe(["activity/a"]);
    sockets[0]!.serverMessage({ type: "presence", x: 1 });
    sockets[0]!.serverMessage({ type: "presence", x: 2 });
    sockets[0]!.serverSend("5weird");
    expect(of("protocol.drift").map((d) => d.kind)).toEqual(["frame.presence", "engineio.5"]);
  });

  it("unsubscribes and closes a connection left without keys", async () => {
    const { store, sockets } = setup();
    await store.subscribe(["activity/a", "activity/b"]);
    await store.unsubscribe(["activity/a"]);
    expect(sockets[0]!.messages().at(-1)).toMatchObject({ type: "/api/v1/unregisterBatchSubscriptions", keys: ["activity/a"] });
    expect(store.has("activity/a")).toBe(false);
    await store.unsubscribe(["activity/b"]);
    expect(sockets[0]!.closedWith?.code).toBe(1000);
    expect(store.health().connections).toEqual([]);
  });
});

describe("MessageStore sharding", () => {
  it("puts at most maxKeysPerConnection keys on one connection", async () => {
    const { store, sockets } = setup({}, { maxKeysPerConnection: 3 });
    await store.subscribe(["k1", "k2", "k3", "k4", "k5", "k6", "k7"]);
    expect(sockets.map((s) => s.subscriptions().length)).toEqual([3, 3, 1]);
    await store.subscribe(["k8", "k9"]);
    expect(sockets.map((s) => s.subscriptions().length)).toEqual([3, 3, 3]);
    expect(store.health().connections.map((c) => c.keys)).toEqual([3, 3, 3]);
  });

  it("defaults to 40,000 keys per connection", async () => {
    const { store, sockets } = setup();
    await store.subscribe(Array.from({ length: 40_001 }, (_, i) => `activity/k${i}`));
    expect(sockets.map((s) => s.subscriptions().length)).toEqual([40_000, 1]);
  });

  it("retries a batch the server answers with error on a new connection", async () => {
    const { store, sockets, of } = setup({ capPerSocket: 4 }, { batchSize: 2 });
    await store.subscribe(["k1", "k2", "k3", "k4", "k5", "k6"]);
    // Socket 0 accepts k1..k4, rejects the batch [k5, k6]; it moves whole to socket 1.
    expect(sockets).toHaveLength(2);
    expect(sockets[1]!.subscriptions().map((s) => s.key)).toEqual(["k5", "k6"]);
    expect(of("batch.rejected")).toEqual([{ connectionId: 1, keys: 2, movedTo: 2, error: "error" }]);
    expect(store.health().connections.map((c) => [c.keys, c.capacity])).toEqual([[4, 4], [2, 40_000]]);
    // The first connection is now treated as full.
    await store.subscribe(["k7"]);
    expect(sockets[1]!.subscriptions().map((s) => s.key)).toEqual(["k5", "k6", "k7"]);
  });

  it("fails when a fresh connection rejects the batch too", async () => {
    const { store } = setup({ rejectOnSockets: [0, 1] });
    expect(await code(store.subscribe(["k1"]))).toBe("NOTION_API_ERROR");
    expect(store.has("k1")).toBe(false);
  });

  it("refuses more keys than the connections can hold", async () => {
    const { store, sockets } = setup({}, { maxKeysPerConnection: 2, maxConnections: 2 });
    expect(await code(store.subscribe(["a", "b", "c", "d", "e"]))).toBe("SUBSCRIPTION_CAP_EXCEEDED");
    expect(sockets).toHaveLength(0);
  });
});

describe("MessageStore reconnection", () => {
  it("reconnects with backoff and resubscribes every key with its last message version", async () => {
    vi.useFakeTimers();
    const { store, sockets, of } = setup();
    await store.subscribe(["activity/a", "versions/b:block"]);
    sockets[0]!.serverMessage({ type: "notification", key: "activity/a", value: 2, version: 1732400000020 });
    sockets[0]!.serverClose(1006);
    expect(store.health().connections[0]).toMatchObject({ state: "BACKOFF", reconnects: 1, lastCloseCode: 1006 });
    await vi.advanceTimersByTimeAsync(999);
    expect(sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets).toHaveLength(2);
    expect(sockets[1]!.subscriptions()).toEqual([
      { key: "activity/a", version: 1732400000020 },
      { key: "versions/b:block", version: -1 },
    ]);
    expect(of("connection.ready").map((r) => [r.reconnect, r.downtimeMs])).toEqual([
      [false, undefined],
      [true, 1000],
    ]);
    expect(store.health().connections[0]!.state).toBe("READY");
  });

  it("backs off exponentially while the server is unreachable, then resets", async () => {
    vi.useFakeTimers();
    const { factory, sockets } = fakeServer({ autoOpen: false });
    const store = new MessageStore({ webSocketFactory: factory, random: () => 1, requestTimeoutMs: 600_000 });
    stores.push(store);
    const pending = store.subscribe(["activity/a"]);
    const delays: number[] = [];
    let last = 0;
    for (let i = 0; i < 6; i++) {
      const before = sockets.length;
      sockets.at(-1)!.serverClose(1006);
      const t0 = Date.now();
      while (sockets.length === before) await vi.advanceTimersByTimeAsync(100);
      delays.push(Date.now() - t0);
      last = sockets.length;
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 30000]);
    sockets[last - 1]!.serverOpen();
    await pending;
    sockets[last - 1]!.serverClose(1006);
    const before = sockets.length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(sockets.length).toBe(before + 1);
  });

  it("reconnects when the server stops sending heartbeats", async () => {
    vi.useFakeTimers();
    const { store, sockets } = setup();
    await store.subscribe(["activity/a"]);
    await vi.advanceTimersByTimeAsync(44_999);
    expect(sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets[0]!.closedWith?.code).toBe(4000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(sockets).toHaveLength(2);
  });

  it("stays connected for 30 minutes while both heartbeats are answered", async () => {
    vi.useFakeTimers();
    const { store, sockets, of } = setup();
    await store.subscribe(["activity/a"]);
    const s = sockets[0]!;
    for (let t = 0; t < 30 * 60_000; t += 25_000) {
      await vi.advanceTimersByTimeAsync(25_000);
      s.serverSend("2");
      s.serverMessage(`primus::ping::${1732400000000 + t}`);
    }
    expect(sockets).toHaveLength(1);
    expect(of("connection.closed")).toEqual([]);
    expect(s.sent.filter((d) => d === "3")).toHaveLength(72);
    expect(s.sent.filter((d) => d.startsWith('4"primus::pong::'))).toHaveLength(72);
    expect(store.health().connections[0]).toMatchObject({ state: "READY", reconnects: 0, connectedForMs: 30 * 60_000 });
  });

  it("reconnects when the Engine.IO open packet never arrives", async () => {
    vi.useFakeTimers();
    const { factory, sockets } = fakeServer({ autoOpen: false });
    const store = new MessageStore({ webSocketFactory: factory, random: () => 1 });
    stores.push(store);
    void store.subscribe(["activity/a"]).catch(() => {});
    await vi.advanceTimersByTimeAsync(0);
    sockets[0]!.readyState = 1;
    (sockets[0] as unknown as { fire(t: string): void }).fire("open");
    await vi.advanceTimersByTimeAsync(15_000);
    expect(sockets[0]!.closedWith?.code).toBe(4000);
  });

  it("stops without reconnecting", async () => {
    vi.useFakeTimers();
    const { store, sockets } = setup();
    await store.subscribe(["activity/a"]);
    store.stop();
    expect(sockets[0]!.closedWith?.code).toBe(1000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sockets).toHaveLength(1);
    expect(await code(store.subscribe(["activity/b"]))).toBe("INVALID_STATE");
  });
});

describe("NotionCore realtime", () => {
  it("sends the session cookie while valid, none when anonymous, and reports connections in health()", async () => {
    const { factory, sockets } = fakeServer();
    const cookies = [
      { name: "token_v2", value: "v02-TESTONLY", domain: ".notion.com" },
      { name: "notion_user_id", value: "u-TESTONLY", domain: ".app.notion.com" },
    ];
    const core = new NotionCore({ cookies, webSocketFactory: factory, userAgent: "UA-TESTONLY" });
    const seen: string[] = [];
    core.onSignal((key, version) => seen.push(`${key}@${version}`));
    await core.subscribe(["activity/a"]);
    expect(sockets[0]!.headers).toEqual({ origin: "https://app.notion.com", "user-agent": "UA-TESTONLY", cookie: "token_v2=v02-TESTONLY; notion_user_id=u-TESTONLY" });
    sockets[0]!.serverMessage({ type: "notification", key: "activity/a", value: 1, version: 9 });
    expect(seen).toEqual(["activity/a@9"]);
    expect(core.health().realtime).toMatchObject({ keys: 1, connections: [{ state: "READY", keys: 1 }] });
    expect(JSON.stringify(core.health())).not.toContain("v02-TESTONLY");
    core.stopRealtime();

    const anon = new NotionCore({ cookies, webSocketFactory: factory, anonymousRealtime: true });
    await anon.subscribe(["activity/a"]);
    expect(sockets[1]!.headers.cookie).toBeUndefined();
    anon.stopRealtime();
  });

  it("drops the cookie on reconnect once the session is AUTH_DEAD", async () => {
    vi.useFakeTimers();
    const { factory, sockets } = fakeServer();
    const { fetch } = fakeFetch({ authValidate: [() => json(401, { name: "UnauthorizedError" })] });
    const core = new NotionCore({ cookies: [{ name: "token_v2", value: "v02-TESTONLY", domain: ".notion.com" }], webSocketFactory: factory, fetch });
    await core.subscribe(["activity/a"]);
    expect(sockets[0]!.headers.cookie).toContain("token_v2=");
    expect(await core.confirmSession("manual")).toBe("AUTH_DEAD");
    sockets[0]!.serverClose(1006);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sockets).toHaveLength(2);
    expect(sockets[1]!.headers.cookie).toBeUndefined();
    expect(core.health().realtime?.connections[0]?.state).toBe("READY");
    core.stopRealtime();
  });

  it("works with no cookies at all", async () => {
    const { factory, sockets } = fakeServer();
    const core = new NotionCore({ cookies: [], webSocketFactory: factory });
    await core.subscribe([`versions/${P1}:block`]);
    expect(sockets[0]!.headers.cookie).toBeUndefined();
    await tick();
    core.stopRealtime();
  });
});
