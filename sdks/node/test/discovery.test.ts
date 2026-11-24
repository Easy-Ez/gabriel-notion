import { afterEach, describe, expect, it, vi } from "vitest";
import { NotionClient } from "../src/client/client.js";
import type { NotionEvent } from "../src/client/events/types.js";
import { MemoryStateStore } from "../src/state/store.js";
import { WatchState } from "../src/state/watch-state.js";
import { fakeServer } from "./helpers/fake-socket.js";
import { SPACE_ID, SPACE_SHORT_ID, USER_ID, baseCookies, fakeFetch, json, type RecordedRequest } from "./helpers/fake-fetch.js";

const OTHER = "00000000-0000-4000-8000-0000000000bb";
const SV = "00000000-0000-4000-8000-0000000000cc";
const T1 = "00000000-0000-4000-8000-0000000000d1";
const T2 = "00000000-0000-4000-8000-0000000000d2";
const T3 = "00000000-0000-4000-8000-0000000000d3"; // closed teamspace: role none
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, A1, TXT, COLS, COL1, D, C, ROW, B, B1, P, S, HIDDEN, DEAD, A2, B2, B3, S2, P2, T2P] = Array.from({ length: 20 }, (_, i) => id(100 + i)) as [string, string, string, string, string, string, string, string, string, string, string, string, string, string, string, string, string, string, string, string];
const GHOST = id(199); // answered with a role but no value, as seen in a real workspace
const T0 = 1_732_400_000_000;

type Rec = Record<string, unknown>;

function workspace() {
  const blocks = new Map<string, Rec>([
    [A, { type: "page", parent_table: "space", parent_id: SPACE_ID, content: [TXT, COLS, D], created_time: T0 - 1e9 }],
    [TXT, { type: "text", parent_table: "block", parent_id: A }],
    [COLS, { type: "column_list", parent_table: "block", parent_id: A, content: [COL1] }],
    [COL1, { type: "column", parent_table: "block", parent_id: COLS, content: [A1] }],
    [A1, { type: "page", parent_table: "block", parent_id: COL1, content: [], created_time: T0 - 1e9 }],
    [D, { type: "collection_view", parent_table: "block", parent_id: A, collection_id: C, view_ids: [] }],
    [ROW, { type: "page", parent_table: "collection", parent_id: C }],
    [B, { type: "page", parent_table: "team", parent_id: T1, content: [B1, DEAD], created_time: T0 - 1e9 }],
    [B1, { type: "page", parent_table: "block", parent_id: B, content: [] }],
    [DEAD, { type: "page", parent_table: "block", parent_id: B, alive: false }],
    [P, { type: "page", parent_table: "space", parent_id: SPACE_ID, content: [] }],
    [S, { type: "page", parent_table: "space", parent_id: SPACE_ID, content: [] }],
  ]);
  const roles = new Map<string, string>([[HIDDEN, "none"]]);
  const ws = {
    blocks,
    roles,
    collections: new Map<string, Rec>([[C, { parent_table: "block", parent_id: D, schema: {} }]]),
    spacePages: [A, HIDDEN, GHOST],
    privatePages: [P],
    shared: [S],
    teams: new Map<string, { pages: string[]; role: string }>([
      [T1, { pages: [B], role: "read_and_write" }],
      [T3, { pages: [], role: "none" }],
    ]),
  };
  const calls: RecordedRequest[] = [];
  const recordsResponder = (req: RecordedRequest) => {
    calls.push(req);
    const reqs = (req.body as { requests: Array<{ pointer: { table: string; id: string } }> }).requests;
    const recordMap: Record<string, Record<string, unknown>> = {};
    for (const { pointer } of reqs) {
      let value: Rec | undefined;
      if (pointer.table === "space") value = { id: SPACE_ID, short_id_str: String(SPACE_SHORT_ID), pages: ws.spacePages };
      else if (pointer.table === "block") value = blocks.get(pointer.id);
      else if (pointer.table === "collection") value = ws.collections.get(pointer.id);
      else if (pointer.table === "team") value = ws.teams.has(pointer.id) ? { team_pages: ws.teams.get(pointer.id)!.pages } : undefined;
      const role = pointer.table === "team" ? ws.teams.get(pointer.id)?.role : roles.get(pointer.id) ?? "editor";
      if (pointer.id === GHOST) {
        (recordMap[pointer.table] ??= {})[pointer.id] = { spaceId: SPACE_ID, value: { role: "reader" } };
        continue;
      }
      (recordMap[pointer.table] ??= {})[pointer.id] = value && role !== "none" ? { spaceId: SPACE_ID, value: { value: { id: pointer.id, ...value }, role } } : { value: { role: "none" } };
    }
    return json(200, { recordMap });
  };
  const { fetch } = fakeFetch({
    getSpaces: [
      (req) => {
        calls.push(req);
        return json(200, {
          [USER_ID]: {
            space: { [SPACE_ID]: { value: { value: { name: "Test WS" } } } },
            space_view: { [SV]: { value: { value: { id: SV, space_id: SPACE_ID, alive: true, private_pages: ws.privatePages }, role: "editor" } } },
          },
        });
      },
    ],
    syncRecordValuesSpaceInitial: [recordsResponder],
    syncRecordValuesMain: [recordsResponder],
    getTeamsV2: [
      (req) => {
        calls.push(req);
        const teams = [...ws.teams.keys()].map((tid) => ({ id: tid, type: "Joined" }));
        const team = Object.fromEntries([...ws.teams].map(([tid, t]) => [tid, { spaceId: SPACE_ID, value: t.role === "none" ? { role: "none" } : { value: { id: tid, team_pages: t.pages }, role: t.role } }]));
        return json(200, { teams, recordMap: { team } });
      },
    ],
    getUserSharedPagesInSpace: [
      (req) => {
        calls.push(req);
        return json(200, { pages: ws.shared });
      },
    ],
    getActivityLog: [
      (req) => {
        calls.push(req);
        return json(200, { activityIds: [], recordMap: {} });
      },
    ],
  });
  return { ws, fetch, calls };
}

function client(opts: { store?: MemoryStateStore; watch?: ConstructorParameters<typeof Object>[0]; maxKeysPerConnection?: number; notifyInitial?: boolean } = {}) {
  const w = workspace();
  const { factory, sockets } = fakeServer({ notifyInitial: opts.notifyInitial ?? false });
  const store = opts.store ?? new MemoryStateStore();
  const c = NotionClient.fromCookies({
    cookies: baseCookies,
    fetch: w.fetch,
    workspace: "Test WS",
    webSocketFactory: factory,
    stateStore: store,
    maxRetries: 0,
    watch: (opts.watch as never) ?? { mode: "workspace" },
    ...(opts.maxKeysPerConnection ? { maxKeysPerConnection: opts.maxKeysPerConnection } : {}),
  });
  const events: NotionEvent[] = [];
  c.on("*", (e) => events.push(e));
  const keys = () => sockets.flatMap((s) => s.subscriptions().map((x) => x.key));
  return { c, w, sockets, store, events, keys };
}

const pageKeys = (pid: string) => [`versions/${pid}:block`, `activity/${pid}`];
const dsKeys = (cid: string) => [`collection/${cid}`, `activity/${cid}`, `versions/${cid}:collection`];

afterEach(() => vi.useRealTimers());

describe("discovery: cold start", () => {
  it("walks every root of the workspace, stores the tree and watches pages, databases and data sources", async () => {
    const t = client();
    await t.c.start();
    const keys = t.keys();
    for (const pid of [A, A1, D, B, B1, P, S]) expect(keys).toEqual(expect.arrayContaining(pageKeys(pid)));
    expect(keys).toEqual(expect.arrayContaining(dsKeys(C)));
    // Containers.
    expect(keys).toEqual(
      expect.arrayContaining([`teams_in_space_v2/${SPACE_ID}`, `user_shared_pages_in_space/${SPACE_ID}-${USER_ID}`, `versions/${SPACE_ID}:space`, `versions/${SV}:space_view`, `versions/${T1}:team`]),
    );
    // Not watched: rows, inner blocks, unreadable pages, trashed pages, closed teamspaces.
    for (const no of [ROW, TXT, COLS, COL1, HIDDEN, DEAD, GHOST]) expect(keys.some((k) => k.includes(no))).toBe(false);
    expect(keys).not.toContain(`versions/${T3}:team`);
    expect(t.events).toEqual([]);

    const state = new WatchState(t.store, SPACE_ID);
    const nodes = new Map((await state.listNodes()).map((n) => [n.id, n]));
    expect(nodes.get(A)).toMatchObject({ table: "block", type: "page", children: [A1, D] });
    expect(nodes.get(D)).toMatchObject({ type: "collection_view", children: [C] });
    expect(nodes.get(C)).toMatchObject({ table: "collection", parent: { table: "block", id: D } });
    expect(nodes.get(T1)).toMatchObject({ table: "team", children: [B] });
    expect(nodes.get(SPACE_ID)).toMatchObject({ table: "space", children: [A, HIDDEN, GHOST] });
    expect(t.c.health()).toMatchObject({ status: "ok", watch: { mode: "workspace", pages: 7, dataSources: 1, containers: 4, scans: 1 } });
    expect(t.c.health().connections).toEqual([expect.objectContaining({ state: "READY", keys: keys.length })]);
    await t.c.stop();
  });

  it("does not read activity for the current-state frames every new subscription gets", async () => {
    vi.useFakeTimers({ now: T0 });
    const t = client({ notifyInitial: true });
    await t.c.start();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(t.w.calls.filter((r) => r.endpoint === "getActivityLog")).toEqual([]);
    expect(t.c.health().watch?.scans).toBe(1);
    await t.c.stop();
  });

  it("explicit mode watches only the given subtree", async () => {
    const t = client({ watch: { mode: "explicit", roots: [A] } });
    await t.c.start();
    const keys = t.keys();
    expect(new Set(keys)).toEqual(new Set([...pageKeys(A), ...pageKeys(A1), ...pageKeys(D), ...dsKeys(C)]));
    expect(t.w.calls.some((r) => r.endpoint === "getTeamsV2" || r.endpoint === "getUserSharedPagesInSpace")).toBe(false);
    expect(t.c.health().watch).toMatchObject({ mode: "explicit", pages: 3, dataSources: 1, containers: 0 });
    await t.c.stop();
  });

  it("spreads keys over connections and reports each connection's key count", async () => {
    const t = client({ maxKeysPerConnection: 10 });
    await t.c.start();
    const conns = t.c.health().connections;
    expect(conns.length).toBeGreaterThan(1);
    expect(conns.every((c) => c.keys <= 10)).toBe(true);
    expect(conns.reduce((n, c) => n + c.keys, 0)).toBe(new Set(t.keys()).size);
    await t.c.stop();
  });
});

describe("discovery: new content", () => {
  async function started(watch?: unknown) {
    vi.useFakeTimers({ now: T0 });
    const t = client(watch ? { watch } : {});
    await t.c.start();
    const notify = (key: string, version: number) => {
      for (const s of t.sockets) s.serverMessage({ type: "notification", key, value: version, version });
    };
    return { ...t, notify };
  }

  it("finds a new child page under a watched page from its versions signal, without its own event", async () => {
    const t = await started();
    t.w.ws.blocks.set(A2, { type: "page", parent_table: "block", parent_id: A, content: [], created_time: T0 });
    t.w.ws.blocks.get(A)!.content = [TXT, COLS, D, A2];
    t.notify(`versions/${A}:block`, 2);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(t.keys()).toEqual(expect.arrayContaining(pageKeys(A2)));
    expect(t.events).toEqual([]); // the parent's activity reports page.created
    expect((await new WatchState(t.store, SPACE_ID).getNode(A))?.children).toEqual([A1, D, A2]);
    await t.c.stop();
  });

  it("reports pages created at a teamspace root, and only watches older pages moved there", async () => {
    const t = await started();
    vi.setSystemTime(T0 + 60_000);
    t.w.ws.blocks.set(B2, { type: "page", parent_table: "team", parent_id: T1, content: [], created_time: T0 + 30_000, created_by_id: OTHER });
    t.w.ws.blocks.set(B3, { type: "page", parent_table: "team", parent_id: T1, content: [], created_time: T0 - 1e9, created_by_id: OTHER });
    t.w.ws.teams.get(T1)!.pages = [B, B2, B3];
    t.notify(`versions/${T1}:team`, 2);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(t.keys()).toEqual(expect.arrayContaining([...pageKeys(B2), ...pageKeys(B3)]));
    expect(t.events.map((e) => [e.type, e.entity.id, e.data, e.origin, e.delivery])).toEqual([["page.created", B2, { parent: { type: "team", id: T1 } }, "other_user", "live"]]);
    // A second signal does not report it again.
    t.notify(`versions/${T1}:team`, 3);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(t.events).toHaveLength(1);
    await t.c.stop();
  });

  it("follows pages shared with the account, the private section, the workspace root and new teamspaces", async () => {
    const t = await started();
    vi.setSystemTime(T0 + 10_000);
    t.w.ws.blocks.set(S2, { type: "page", parent_table: "space", parent_id: SPACE_ID, content: [], created_time: T0 + 5_000, created_by_id: OTHER });
    t.w.ws.shared = [S, S2];
    t.notify(`user_shared_pages_in_space/${SPACE_ID}-${USER_ID}`, 2);
    t.w.ws.blocks.set(P2, { type: "page", parent_table: "space", parent_id: SPACE_ID, content: [], created_time: T0 + 6_000, created_by_id: USER_ID });
    t.w.ws.privatePages = [P, P2];
    t.notify(`versions/${SV}:space_view`, 2);
    t.w.ws.blocks.set(T2P, { type: "page", parent_table: "team", parent_id: T2, content: [], created_time: T0 + 7_000 });
    t.w.ws.teams.set(T2, { pages: [T2P], role: "read_and_write" });
    t.notify(`teams_in_space_v2/${SPACE_ID}`, 2);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(t.keys()).toEqual(expect.arrayContaining([...pageKeys(S2), ...pageKeys(P2), ...pageKeys(T2P), `versions/${T2}:team`]));
    expect(t.events.map((e) => [e.type, e.entity.id, e.origin]).sort()).toEqual(
      [
        ["page.created", P2, "self_other_client"],
        ["page.created", S2, "other_user"],
      ].sort(),
    );
    await t.c.stop();
  });
});

describe("discovery: restarts and correction", () => {
  it("a warm start watches the stored tree before re-walking it, and the correction runs on its interval", async () => {
    vi.useFakeTimers({ now: T0 });
    const store = new MemoryStateStore();
    const first = client({ store });
    await first.c.start();
    await first.c.stop();

    const second = client({ store, watch: { mode: "workspace", rescanIntervalMs: 60_000 } });
    const t0Calls = second.w.calls.length;
    await second.c.start();
    // Subscribed from the stored tree; the walk runs afterwards in the background.
    expect(second.keys()).toEqual(expect.arrayContaining([...pageKeys(A), ...pageKeys(B1), ...dsKeys(C)]));
    await vi.advanceTimersByTimeAsync(0);
    const teamsCalls = () => second.w.calls.filter((r) => r.endpoint === "getTeamsV2").length;
    const afterStart = teamsCalls();
    expect(afterStart).toBe(1);
    // A page created at the workspace root while nothing watched it is found by the correction.
    second.w.ws.blocks.set(A2, { type: "page", parent_table: "space", parent_id: SPACE_ID, content: [], created_time: T0 + 30_000 });
    second.w.ws.spacePages = [A, HIDDEN, GHOST, A2];
    await vi.advanceTimersByTimeAsync(60_000);
    expect(teamsCalls()).toBe(afterStart + 1);
    expect(second.keys()).toEqual(expect.arrayContaining(pageKeys(A2)));
    expect(second.events.map((e) => [e.type, e.entity.id, e.delivery])).toEqual([["page.created", A2, "backfill"]]);
    expect(second.w.calls.length).toBeGreaterThan(t0Calls);
    await second.c.stop();
  });

  it("drops pages that disappeared from the tree at the next correction", async () => {
    vi.useFakeTimers({ now: T0 });
    const t = client({ watch: { mode: "workspace", rescanIntervalMs: 60_000 } });
    await t.c.start();
    t.w.ws.blocks.get(A)!.content = [TXT, D]; // A1 removed
    t.w.ws.blocks.get(COL1)!.content = [];
    await vi.advanceTimersByTimeAsync(60_000);
    const unsub = t.sockets.flatMap((s) => s.messages().filter((m) => m.type === "/api/v1/unregisterBatchSubscriptions").flatMap((m) => m.keys as string[]));
    expect(unsub).toEqual(expect.arrayContaining(pageKeys(A1)));
    expect(await new WatchState(t.store, SPACE_ID).getNode(A1)).toBeUndefined();
    await t.c.stop();
  });

  it("rejects an explicit watch without roots", async () => {
    const t = client({ watch: { mode: "explicit", roots: [] } });
    await expect(t.c.start()).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });
});
