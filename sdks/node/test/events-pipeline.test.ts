import { afterEach, describe, expect, it, vi } from "vitest";
import { NotionCore } from "../src/core/core.js";
import { EventPipeline } from "../src/client/events/pipeline.js";
import { diffRecord } from "../src/client/events/record-diff.js";
import type { Activity } from "../src/client/events/normalize.js";
import type { NotionEvent, ProtocolDriftEvent } from "../src/client/events/types.js";
import { MemoryStateStore } from "../src/state/store.js";
import { WatchState } from "../src/state/watch-state.js";
import { fakeServer } from "./helpers/fake-socket.js";
import { baseCookies, fakeFetch, json, type RecordedRequest } from "./helpers/fake-fetch.js";

const WS = "00000000-0000-4000-8000-0000000000aa";
const ME = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-0000000000bb";
const PAGE = "00000000-0000-4000-8000-000000000101";
const PARA = "00000000-0000-4000-8000-000000000102";
const PARA2 = "00000000-0000-4000-8000-000000000103";
const COL = "00000000-0000-4000-8000-000000000201";
const DB = "00000000-0000-4000-8000-000000000202";
const ROW = "00000000-0000-4000-8000-000000000203";
const T0 = 1_732_400_000_000;

const lock = (id: string, ts: number, type = "page-locked"): Activity => ({
  id,
  version: 1,
  type,
  navigable_block_id: PAGE,
  space_id: WS,
  edits: [{ type, authors: [{ id: OTHER, table: "notion_user" }], timestamp: ts, navigable_block_id: PAGE }],
});
const textEdit = (block: string, ts: number) => ({
  type: "block-created",
  authors: [{ id: OTHER, table: "notion_user" }],
  block_id: block,
  timestamp: ts,
  block_data: { block_value: { id: block, type: "text", parent_id: PAGE, parent_table: "block", created_time: ts } },
});
const edited = (id: string, version: number, edits: Activity["edits"]): Activity => ({ id, version, type: "block-edited", navigable_block_id: PAGE, space_id: WS, edits });

interface Backend {
  logs: Map<string, Activity[]>;
  roles: Map<string, string>;
  calls: RecordedRequest[];
}

function setup(opts: { coalesceMs?: number } = {}) {
  const backend: Backend = { logs: new Map(), roles: new Map(), calls: [] };
  const { fetch } = fakeFetch({
    getActivityLog: [
      (req) => {
        backend.calls.push(req);
        const body = req.body as { navigableBlock?: { id: string }; collections?: Array<{ id: string }>; limit: number; startingAfterId?: string };
        const scope = body.navigableBlock?.id ?? body.collections?.[0]?.id ?? "";
        if (backend.roles.get(scope) === "none") return json(400, { name: "ValidationError", message: "no access" });
        let list = backend.logs.get(scope) ?? [];
        if (body.startingAfterId) list = list.slice(list.findIndex((a) => a.id === body.startingAfterId) + 1);
        list = list.slice(0, body.limit);
        return json(200, { activityIds: list.map((a) => a.id), recordMap: { activity: Object.fromEntries(list.map((a) => [a.id, { spaceId: WS, value: { value: a, role: "reader" } }])) } });
      },
    ],
    syncRecordValuesSpaceInitial: [
      (req) => {
        const reqs = (req.body as { requests: Array<{ pointer: { table: string; id: string } }> }).requests;
        const recordMap: Record<string, Record<string, unknown>> = {};
        for (const { pointer } of reqs) {
          const role = backend.roles.get(pointer.id) ?? "editor";
          const value =
            pointer.table === "collection"
              ? { id: pointer.id, parent_id: DB, parent_table: "block", schema: {} }
              : { id: pointer.id, type: pointer.id === DB ? "collection_view" : "page", parent_id: WS, parent_table: "space", alive: true };
          (recordMap[pointer.table] ??= {})[pointer.id] = role === "none" ? { value: { role: "none" } } : { value: { value, role } };
        }
        return json(200, { recordMap });
      },
    ],
    authValidate: [() => json(200, {})],
  });
  const { factory, sockets } = fakeServer();
  const core = new NotionCore({ cookies: baseCookies, fetch, webSocketFactory: factory, maxRetries: 0 });
  const store = new MemoryStateStore();
  const state = new WatchState(store, WS);
  const events: NotionEvent[] = [];
  const drift: ProtocolDriftEvent[] = [];
  const pipeline = new EventPipeline({ core, state, workspaceId: WS, selfUserId: ME, deliver: (e) => events.push(e), drift: (d) => drift.push(d), coalesceMs: opts.coalesceMs ?? 1_000 });
  pipeline.start();
  const signal = (key: string, version: number, value: unknown = 1) => {
    for (const s of sockets) s.serverMessage({ type: "notification", key, value, version });
  };
  return { backend, core, state, store, pipeline, events, drift, sockets, signal };
}

afterEach(() => vi.useRealTimers());

describe("EventPipeline", () => {
  it("subscribes the page keys, takes a baseline without replaying history, then delivers new activity once", async () => {
    vi.useFakeTimers({ now: T0 });
    const t = setup();
    t.backend.logs.set(PAGE, [lock("a1", T0 - 60_000)]);
    await t.pipeline.watch([{ id: PAGE, kind: "page" }]);
    expect(t.sockets[0]!.subscriptions().map((s) => s.key)).toEqual([`versions/${PAGE}:block`, `activity/${PAGE}`]);
    expect(t.events).toEqual([]);
    expect(t.backend.calls).toHaveLength(0); // no read up front: the cursor starts empty at "now"
    expect(await t.state.getCursor(PAGE)).toMatchObject({ latestActivityId: "", since: T0 });

    t.backend.logs.set(PAGE, [lock("a2", T0 + 1_000, "page-unlocked"), lock("a1", T0 - 60_000)]);
    t.signal(`versions/${PAGE}:block`, 101);
    t.signal(`activity/${PAGE}`, 102, 7);
    await vi.advanceTimersByTimeAsync(999);
    expect(t.backend.calls).toHaveLength(0); // signals are coalesced
    await vi.advanceTimersByTimeAsync(1);
    expect(t.backend.calls).toHaveLength(1);
    expect(t.events.map((e) => [e.type, e.entity.id, e.origin, e.delivery])).toEqual([["page.unlocked", PAGE, "other_user", "live"]]);
    expect(t.events[0]!.data).toEqual({ parent: { type: "space", id: WS } });
    expect(await t.state.subscriptionVersions()).toEqual(new Map([[`versions/${PAGE}:block`, 101], [`activity/${PAGE}`, 102]]));

    // Re-reads every 90 s do not deliver it again.
    expect(await t.state.getCursor(PAGE)).toMatchObject({ latestActivityId: "a2", since: T0 });
    await vi.advanceTimersByTimeAsync(90_000);
    expect(t.backend.calls).toHaveLength(2);
    expect(t.events).toHaveLength(1);
  });

  it("ignores the current-state frames that answer a fresh subscription", async () => {
    vi.useFakeTimers({ now: T0 });
    const t = setup();
    await t.pipeline.watch([{ id: PAGE, kind: "page" }]);
    t.pipeline.onSignal(`activity/${PAGE}`, 7, true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(t.backend.calls).toHaveLength(0);
    expect((await t.state.subscriptionVersions()).get(`activity/${PAGE}`)).toBe(7);
  });

  it("keeps at most 8 activity reads in flight", async () => {
    vi.useFakeTimers({ now: T0 });
    const t = setup();
    const pages = Array.from({ length: 20 }, (_, i) => `00000000-0000-4000-8000-0000000003${String(i).padStart(2, "0")}`);
    await t.pipeline.watch(pages.map((id) => ({ id, kind: "page" as const })));
    let inFlight = 0;
    let peak = 0;
    const realCall = t.core.callApi.bind(t.core);
    vi.spyOn(t.core, "callApi").mockImplementation(async (name: string, body: unknown, o?: unknown) => {
      if (name !== "getActivityLog") return realCall(name, body, o as never);
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1_000));
      inFlight--;
      return { activityIds: [], recordMap: {} };
    });
    for (const id of pages) t.pipeline.onSignal(`activity/${id}`, 1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(peak).toBe(8);
    expect(t.pipeline.health().openWindows).toBe(20);
  });

  it("re-reads every 90 s while the window is open and closes it after 10 quiet minutes", async () => {
    vi.useFakeTimers({ now: T0 });
    const t = setup();
    await t.pipeline.watch([{ id: PAGE, kind: "page" }]);
    const pings = setInterval(() => t.sockets.forEach((s) => s.serverSend("2")), 20_000); // keep the connection alive
    t.signal(`versions/${PAGE}:block`, 1);
    await vi.advanceTimersByTimeAsync(5_000);
    const afterFirst = t.backend.calls.length;
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    const reads = t.backend.calls.length - afterFirst;
    expect(reads).toBe(Math.ceil((10 * 60_000 - 5_000) / 90_000)); // 7 re-reads, the last one closes it
    expect(t.pipeline.health().openWindows).toBe(0);
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(t.backend.calls.length - afterFirst).toBe(reads);
    clearInterval(pings);
  });

  it("delivers edits merged into an open activity on later re-reads, and only those", async () => {
    vi.useFakeTimers({ now: T0 });
    const t = setup();
    await t.pipeline.watch([{ id: PAGE, kind: "page" }]);
    t.backend.logs.set(PAGE, [edited("e1", 1, [textEdit(PARA, T0 + 500)])]);
    t.signal(`activity/${PAGE}`, 1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(t.events.map((e) => (e.data as { updated_blocks: unknown[] }).updated_blocks)).toEqual([[{ id: PARA, type: "block" }]]);
    // The page signal is throttled; the merged edit is found by the next 90 s re-read.
    t.backend.logs.set(PAGE, [edited("e1", 2, [textEdit(PARA, T0 + 500), textEdit(PARA2, T0 + 30_000)])]);
    await vi.advanceTimersByTimeAsync(90_000);
    expect(t.events).toHaveLength(2);
    expect((t.events[1]!.data as { updated_blocks: unknown[] }).updated_blocks).toEqual([{ id: PARA2, type: "block" }]);
    expect(t.events[0]!.id).not.toBe(t.events[1]!.id);
  });

  it("does not deliver events for an entity the account cannot read, and stops watching it", async () => {
    vi.useFakeTimers({ now: T0 });
    const t = setup();
    await t.pipeline.watch([{ id: PAGE, kind: "page" }]);
    t.backend.roles.set(PAGE, "none");
    t.signal(`activity/${PAGE}`, 1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(t.events).toEqual([]);
    expect(t.pipeline.isWatching(PAGE)).toBe(false);
    expect(t.sockets[0]!.messages().find((m) => m.type === "/api/v1/unregisterBatchSubscriptions")).toMatchObject({ keys: [`versions/${PAGE}:block`, `activity/${PAGE}`] });
    expect(await t.state.subscriptionVersions()).toEqual(new Map());
  });

  it("reports an unknown activity type once and keeps delivering known ones", async () => {
    vi.useFakeTimers({ now: T0 });
    const t = setup();
    await t.pipeline.watch([{ id: PAGE, kind: "page" }]);
    t.backend.logs.set(PAGE, [{ ...lock("x1", T0 + 100), type: "future-thing" }, lock("a1", T0 + 200)]);
    t.signal(`activity/${PAGE}`, 1);
    await vi.advanceTimersByTimeAsync(1_000);
    t.backend.logs.set(PAGE, [{ ...lock("x2", T0 + 300), type: "future-thing" }, { ...lock("x1", T0 + 100), type: "future-thing" }, lock("a1", T0 + 200)]);
    t.signal(`activity/${PAGE}`, 2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(t.drift.map((d) => d.kind)).toEqual(["activity.future-thing"]);
    expect(t.events.map((e) => e.type)).toEqual(["page.locked"]);
    t.sockets[0]!.serverMessage({ type: "presence", x: 1 });
    expect(t.drift.map((d) => d.kind)).toEqual(["activity.future-thing", "frame.presence"]);
  });

  it("walks back pages until it finds the cursor, and reports a gap when it cannot", async () => {
    vi.useFakeTimers({ now: T0 });
    const t = setup();
    t.backend.logs.set(PAGE, [lock("old", T0 - 1)]);
    await t.pipeline.watch([{ id: PAGE, kind: "page" }]);
    await t.pipeline.read(PAGE); // positions the cursor; "old" predates watching, so no event
    expect(t.events).toEqual([]);
    t.backend.calls.length = 0;
    const many = Array.from({ length: 45 }, (_, i) => lock(`n${44 - i}`, T0 + 44 - i, i % 2 ? "page-locked" : "page-unlocked"));
    t.backend.logs.set(PAGE, [...many, lock("old", T0 - 1)]);
    const r = await t.pipeline.read(PAGE);
    expect(r.gap).toBe(false);
    expect(t.backend.calls.filter((c) => (c.body as { startingAfterId?: string }).startingAfterId).length).toBe(2);
    expect(t.events.map((e) => e.type).sort()).toEqual(["page.locked", "page.unlocked"]);

    const pipelineSmall = new EventPipeline({ core: t.core, state: new WatchState(new MemoryStateStore(), WS), workspaceId: WS, deliver: () => {}, maxPages: 1 });
    await pipelineSmall.watch([{ id: PAGE, kind: "page" }]);
    await pipelineSmall.read(PAGE);
    t.backend.logs.set(PAGE, [...Array.from({ length: 30 }, (_, i) => lock(`m${i}`, T0 + 100 + i)), ...many]);
    expect((await pipelineSmall.read(PAGE)).gap).toBe(true);
  });

  it("reads data sources through `collections` and keeps only their own activities", async () => {
    vi.useFakeTimers({ now: T0 });
    const t = setup();
    await t.pipeline.watch([{ id: COL, kind: "data_source" }]);
    expect(t.sockets[0]!.subscriptions().map((s) => s.key)).toEqual([`collection/${COL}`, `activity/${COL}`, `versions/${COL}:collection`]);
    const rowCreated: Activity = {
      id: "r1",
      type: "collection-row-created",
      collection_id: COL,
      collection_row_id: ROW,
      edits: [{ type: "collection-row-created", authors: [{ id: ME, table: "notion_user" }], timestamp: T0 + 10, collection_id: COL, collection_row_id: ROW }],
    };
    t.backend.logs.set(COL, [rowCreated, lock("unrelated", T0 + 5)]);
    t.signal(`collection/${COL}`, 1);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(t.events).toEqual([]); // record-level signals wait for the activity log to catch up
    await vi.advanceTimersByTimeAsync(1);
    expect(t.events.map((e) => [e.type, e.entity.id, e.origin])).toEqual([
      ["page.created", ROW, "self_other_client"],
      ["data_source.content_updated", COL, "self_other_client"],
    ]);
    expect(t.events[0]!.data).toEqual({ parent: { type: "database", id: DB, data_source_id: COL } });
  });

  it("reports lag while a signal waits for its read", async () => {
    vi.useFakeTimers({ now: T0 });
    const t = setup({ coalesceMs: 5_000 });
    await t.pipeline.watch([{ id: PAGE, kind: "page" }]);
    t.signal(`activity/${PAGE}`, 1);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(t.pipeline.health()).toMatchObject({ watched: 1, openWindows: 1, lagSeconds: 3 });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(t.pipeline.health().lagSeconds).toBe(0);
  });

  it("records read failures in health and keeps the window for the next re-read", async () => {
    vi.useFakeTimers({ now: T0 });
    const t = setup();
    await t.pipeline.watch([{ id: PAGE, kind: "page" }]);
    t.backend.logs.set(PAGE, [lock("a1", T0 + 1)]);
    const realCall = t.core.callApi.bind(t.core);
    let fail = true;
    vi.spyOn(t.core, "callApi").mockImplementation(async (name: string, body: unknown, o?: unknown) => {
      if (fail && name === "getActivityLog") throw Object.assign(new Error("boom"), { code: "SERVER_ERROR" });
      return realCall(name, body, o as never);
    });
    t.signal(`activity/${PAGE}`, 1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(t.pipeline.health().lastError).toMatchObject({ entityId: PAGE });
    fail = false;
    await vi.advanceTimersByTimeAsync(90_000);
    expect(t.events.map((e) => e.type)).toEqual(["page.locked"]);
  });
});

describe("record diffs", () => {
  const base = { workspaceId: WS, selfUserId: ME };
  it("maps comment text changes and deletions", () => {
    const before = { id: "c1", version: 1, text: [["a"]], alive: true, parent_id: "d1" };
    expect(diffRecord({ ...base, table: "comment", id: "c1", before, after: { ...before, version: 2, text: [["b"]], last_edited_by_id: OTHER, last_edited_time: T0 } })).toMatchObject({
      type: "comment.updated",
      entity: { id: "c1", type: "comment" },
      data: { discussion_id: "d1" },
      authors: [{ id: OTHER, type: "person" }],
      origin: "other_user",
      timestamp: new Date(T0).toISOString(),
    });
    expect(diffRecord({ ...base, table: "comment", id: "c1", before, after: { ...before, version: 2, alive: false } })?.type).toBe("comment.deleted");
    expect(diffRecord({ ...base, table: "comment", id: "c1", before, after: { ...before, version: 2 } })).toBeUndefined();
    expect(diffRecord({ ...base, table: "comment", id: "c1", before, after: before })).toBeUndefined();
  });

  it("maps view edits and property renames, leaving creations and deletions to the activity", () => {
    const view = { id: "v1", version: 1, name: "Table", type: "table", parent_id: DB, alive: true };
    expect(diffRecord({ ...base, table: "collection_view", id: "v1", before: view, after: { ...view, version: 2, name: "Board" } })).toMatchObject({ type: "view.updated", data: { parent: { type: "database", id: DB } } });
    expect(diffRecord({ ...base, table: "collection_view", id: "v1", before: view, after: { ...view, version: 2, alive: false } })).toBeUndefined();
    const col = { id: COL, version: 1, parent_id: DB, parent_table: "block", schema: { title: { name: "Name", type: "title" }, ab: { name: "Note", type: "text" } } };
    const renamed = { ...col, version: 2, schema: { ...col.schema, ab: { name: "Notes", type: "text" }, cd: { name: "New", type: "number" } } };
    expect(diffRecord({ ...base, table: "collection", id: COL, before: col, after: renamed })).toMatchObject({
      type: "data_source.schema_updated",
      data: { parent: { type: "database", id: DB }, updated_properties: [{ id: "ab", name: "Notes", action: "updated" }] },
    });
  });

  it("delivers record diffs for watched records through the pipeline", async () => {
    vi.useFakeTimers({ now: T0 });
    const t = setup();
    let text = "a";
    let version = 1;
    vi.spyOn(t.core, "getRecords").mockImplementation(async (pointers) => new Map(pointers.map((p) => [`${p.table}:${p.id}`, { role: "editor" as const, value: { id: p.id, version, text: [[text]], alive: true, parent_id: "d1" } }])));
    const CID = "00000000-0000-4000-8000-00000000c001";
    await t.pipeline.watchRecords([{ table: "comment", id: CID }]);
    expect(t.sockets[0]!.subscriptions().map((s) => s.key)).toEqual([`versions/${CID}:comment:${WS}`]);
    text = "b";
    version = 2;
    t.signal(`versions/${CID}:comment:${WS}`, 5);
    await vi.advanceTimersByTimeAsync(0);
    expect(t.events.map((e) => [e.type, e.entity.id])).toEqual([["comment.updated", CID]]);
    t.signal(`versions/${CID}:comment:${WS}`, 6); // same record version: nothing new
    await vi.advanceTimersByTimeAsync(0);
    expect(t.events).toHaveLength(1);
    t.pipeline.onSignal(`versions/00000000-0000-4000-8000-00000000c002:comment:${WS}`, 5); // not watched
    await vi.advanceTimersByTimeAsync(0);
    expect(t.events).toHaveLength(1);
  });
});

describe("NotionClient events", () => {
  it("start() watches explicit roots, delivers typed and '*' events, and stop() closes everything", async () => {
    vi.useFakeTimers({ now: T0 });
    const { NotionClient } = await import("../src/client/client.js");
    const { SPACE_ID, USER_ID, spaceRecordResponse } = await import("./helpers/fake-fetch.js");
    const log: Activity[] = [];
    const { fetch } = fakeFetch({
      getSpaces: [() => json(200, { [USER_ID]: { space: { [SPACE_ID]: { value: { value: { name: "Test WS" } } } } } })],
      syncRecordValuesSpaceInitial: [
        (req) => {
          const reqs = (req.body as { requests: Array<{ pointer: { table: string; id: string } }> }).requests;
          if (reqs.length === 1 && reqs[0]!.pointer.table === "space") return spaceRecordResponse();
          const recordMap: Record<string, Record<string, unknown>> = {};
          for (const { pointer } of reqs) (recordMap[pointer.table] ??= {})[pointer.id] = { value: { value: { id: pointer.id, type: "page", parent_id: SPACE_ID, parent_table: "space" }, role: "editor" } };
          return json(200, { recordMap });
        },
      ],
      getActivityLog: [() => json(200, { activityIds: log.map((a) => a.id), recordMap: { activity: Object.fromEntries(log.map((a) => [a.id, { value: { value: a, role: "reader" } }])) } })],
    });
    const { factory, sockets } = fakeServer();
    const store = new MemoryStateStore();
    const client = NotionClient.fromCookies({ cookies: baseCookies, fetch, workspace: "Test WS", webSocketFactory: factory, stateStore: store, watch: { mode: "explicit", roots: [PAGE] } });
    const typed: string[] = [];
    const all: string[] = [];
    client.on("page.locked", (e) => typed.push(e.entity.id));
    client.on("*", (e) => all.push(e.type));
    await client.start();
    expect(sockets[0]!.subscriptions().map((s) => s.key)).toEqual([`versions/${PAGE}:block`, `activity/${PAGE}`]);
    log.unshift({ ...lock("a1", T0 + 1), space_id: SPACE_ID });
    sockets[0]!.serverMessage({ type: "notification", key: `activity/${PAGE}`, value: 1, version: 9 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(typed).toEqual([PAGE]);
    expect(all).toEqual(["page.locked"]);
    expect(client.health()).toMatchObject({ status: "ok", lagSeconds: 0, connections: [{ state: "READY", keys: 2 }], events: { watched: 1 }, state: { persistent: false } });
    await client.stop();
    expect(sockets[0]!.closedWith?.code).toBe(1000);
  });
});
