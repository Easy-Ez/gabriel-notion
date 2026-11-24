import { afterEach, describe, expect, it, vi } from "vitest";
import { NotionClient } from "../src/client/client.js";
import { NotionCore } from "../src/core/core.js";
import { EventPipeline, type ConnectionGapEvent } from "../src/client/events/pipeline.js";
import type { Activity } from "../src/client/events/normalize.js";
import type { NotionEvent } from "../src/client/events/types.js";
import { MemoryStateStore } from "../src/state/store.js";
import { WatchState } from "../src/state/watch-state.js";
import { fakeServer } from "./helpers/fake-socket.js";
import { SPACE_ID, SPACE_SHORT_ID, USER_ID, baseCookies, fakeFetch, json, type RecordedRequest } from "./helpers/fake-fetch.js";

const OTHER = "00000000-0000-4000-8000-0000000000bb";
const PAGE = "00000000-0000-4000-8000-000000000101";
const PAGE2 = "00000000-0000-4000-8000-000000000102";
const T0 = 1_732_400_000_000;

const lock = (id: string, page: string, ts: number, type = "page-locked"): Activity => ({
  id,
  version: 1,
  type,
  navigable_block_id: page,
  edits: [{ type, authors: [{ id: OTHER, table: "notion_user" }], timestamp: ts, navigable_block_id: page }],
});

/** A fake workspace: activity logs per page, records, and a Message Store that replays. */
function backend() {
  const logs = new Map<string, Activity[]>();
  const slow = new Map<string, number>();
  const failing = new Set<string>();
  const calls: RecordedRequest[] = [];
  const records = (req: RecordedRequest) => {
    const reqs = (req.body as { requests: Array<{ pointer: { table: string; id: string } }> }).requests;
    const recordMap: Record<string, Record<string, unknown>> = {};
    for (const { pointer } of reqs) {
      const value = pointer.table === "space" ? { id: SPACE_ID, short_id_str: String(SPACE_SHORT_ID) } : { id: pointer.id, type: "page", parent_table: "space", parent_id: SPACE_ID, alive: true, content: [] };
      (recordMap[pointer.table] ??= {})[pointer.id] = { spaceId: SPACE_ID, value: { value, role: "editor" } };
    }
    return json(200, { recordMap });
  };
  const { fetch } = fakeFetch({
    getSpaces: [() => json(200, { [USER_ID]: { space: { [SPACE_ID]: { value: { value: { name: "Test WS" } } } } } })],
    syncRecordValuesSpaceInitial: [records],
    syncRecordValuesMain: [records],
    getActivityLog: [
      async (req) => {
        calls.push(req);
        const page = (req.body as { navigableBlock: { id: string } }).navigableBlock.id;
        const delay = slow.get(page);
        if (delay) await new Promise((r) => setTimeout(r, delay));
        if (failing.has(page)) return json(500, { name: "ServerError" });
        const list = logs.get(page) ?? [];
        return json(200, { activityIds: list.map((a) => a.id), recordMap: { activity: Object.fromEntries(list.map((a) => [a.id, { value: { value: a, role: "reader" } }])) } });
      },
    ],
  });
  const ms = fakeServer({ notifyInitial: true });
  const change = (page: string, activity: Activity, version: number) => {
    logs.set(page, [activity, ...(logs.get(page) ?? [])]);
    ms.server.set(`activity/${page}`, version);
  };
  return { logs, slow, failing, calls, fetch, ms, change };
}

type Log = Array<[string, string, string?]>;

function pipelineSetup(b: ReturnType<typeof backend>) {
  const core = new NotionCore({ cookies: baseCookies, fetch: b.fetch, webSocketFactory: b.ms.factory, maxRetries: 0 });
  const state = new WatchState(new MemoryStateStore(), SPACE_ID);
  const log: Log = [];
  const gaps: ConnectionGapEvent[] = [];
  const pipeline = new EventPipeline({
    core,
    state,
    workspaceId: SPACE_ID,
    selfUserId: USER_ID,
    deliver: (e) => log.push(["event", `${e.type}:${e.entity.id.slice(-3)}`, e.delivery]),
    gap: (g) => {
      gaps.push(g);
      log.push(["gap", g.recovered ? "recovered" : "not recovered"]);
    },
  });
  pipeline.start();
  return { core, state, pipeline, log, gaps };
}

afterEach(() => vi.useRealTimers());

describe("recovery after a disconnect", () => {
  it("backfills what changed while disconnected, before live events, and reports the gap", async () => {
    vi.useFakeTimers({ now: T0 });
    const b = backend();
    const t = pipelineSetup(b);
    await t.pipeline.watch([
      { id: PAGE, kind: "page" },
      { id: PAGE2, kind: "page" },
    ]);
    // A live change first.
    vi.setSystemTime(T0 + 10_000);
    b.change(PAGE, lock("a1", PAGE, T0 + 10_000), 101);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(t.log).toEqual([["event", "page.locked:101", "live"]]);

    // Disconnect; PAGE changes while no socket is open.
    b.ms.sockets[0]!.serverClose(1006);
    expect(t.pipeline.health().recovering).toBe(true);
    b.change(PAGE, lock("a2", PAGE, T0 + 10_500, "page-unlocked"), 102);
    expect(t.pipeline.health().lagSeconds).toBeGreaterThanOrEqual(0);

    // Reconnect (backoff ≤ 1 s); the resubscription replays activity/PAGE. Its backfill read is
    // slow, and PAGE2 changes live meanwhile.
    b.slow.set(PAGE, 3_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(b.ms.sockets).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(5_000); // catch-up window ends; backfill read starts
    b.change(PAGE2, lock("b1", PAGE2, T0 + 17_000), 201);
    await vi.advanceTimersByTimeAsync(1_000); // PAGE2's live read finishes first, but is held
    expect(t.log.filter((x) => x[1]?.endsWith("102"))).toEqual([]);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(t.log).toEqual([
      ["event", "page.locked:101", "live"],
      ["event", "page.unlocked:101", "backfill"],
      ["gap", "recovered"],
      ["event", "page.locked:102", "live"],
    ]);
    expect(t.gaps[0]).toMatchObject({ kind: "reconnect", recovered: true, failed: [], entities: 1, events: 1 });
    expect(Date.parse(t.gaps[0]!.from)).toBe(T0 + 11_000);
    expect(t.pipeline.health()).toMatchObject({ recovering: false, lagSeconds: 0, lastGap: { recovered: true } });
    await t.pipeline.stop();
  });

  it("reports recovered: false with the entities it could not backfill", async () => {
    vi.useFakeTimers({ now: T0 });
    const b = backend();
    const t = pipelineSetup(b);
    await t.pipeline.watch([{ id: PAGE, kind: "page" }]);
    b.change(PAGE, lock("a1", PAGE, T0 + 100), 101);
    await vi.advanceTimersByTimeAsync(1_000);
    b.ms.sockets[0]!.serverClose(1006);
    b.change(PAGE, lock("a2", PAGE, T0 + 1_500, "page-unlocked"), 102);
    b.failing.add(PAGE);
    await vi.advanceTimersByTimeAsync(1_000 + 5_000);
    expect(t.gaps).toEqual([expect.objectContaining({ kind: "reconnect", recovered: false, failed: [PAGE], entities: 1, events: 0 })]);
    expect(t.pipeline.health().lastGap?.recovered).toBe(false);
    await t.pipeline.stop();
  });

  it("includes pages whose activity window was open, even without a replayed signal", async () => {
    vi.useFakeTimers({ now: T0 });
    const b = backend();
    const t = pipelineSetup(b);
    await t.pipeline.watch([{ id: PAGE, kind: "page" }]);
    b.change(PAGE, lock("a1", PAGE, T0 + 100), 101);
    await vi.advanceTimersByTimeAsync(1_000);
    const before = b.calls.length;
    b.ms.sockets[0]!.serverClose(1006);
    await vi.advanceTimersByTimeAsync(1_000 + 5_000);
    expect(b.calls.length).toBe(before + 1);
    expect(t.gaps).toEqual([expect.objectContaining({ recovered: true, entities: 1, events: 0 })]);
    await t.pipeline.stop();
  });

  it("does not start a recovery when the SDK closes a connection itself", async () => {
    vi.useFakeTimers({ now: T0 });
    const b = backend();
    const t = pipelineSetup(b);
    await t.pipeline.watch([{ id: PAGE, kind: "page" }]);
    await t.pipeline.unwatch([PAGE]); // the emptied connection is closed with 1000
    await vi.advanceTimersByTimeAsync(10_000);
    expect(t.pipeline.health().recovering).toBe(false);
    expect(t.gaps).toEqual([]);
    await t.pipeline.stop();
  });
});

describe("recovery after a restart", () => {
  it("backfills changes made while the process was down and reports a restart gap from the last alive time", async () => {
    vi.useFakeTimers({ now: T0 });
    const b = backend();
    const store = new MemoryStateStore();
    const make = () => {
      const c = NotionClient.fromCookies({ cookies: baseCookies, fetch: b.fetch, workspace: "Test WS", webSocketFactory: b.ms.factory, stateStore: store, maxRetries: 0, watch: { mode: "explicit", roots: [PAGE] } });
      const events: NotionEvent[] = [];
      const gaps: ConnectionGapEvent[] = [];
      c.on("*", (e) => events.push(e));
      c.on("connection.gap", (g) => gaps.push(g));
      return { c, events, gaps };
    };
    const first = make();
    await first.c.start();
    b.change(PAGE, lock("a1", PAGE, T0 + 100), 101);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(first.events.map((e) => [e.type, e.delivery])).toEqual([["page.locked", "live"]]);
    await first.c.stop();
    const stoppedAt = Date.now();

    // Down for 10 minutes; two changes meanwhile.
    vi.setSystemTime(stoppedAt + 5 * 60_000);
    b.change(PAGE, lock("a2", PAGE, Date.now(), "page-unlocked"), 102);
    b.change(PAGE, lock("a3", PAGE, Date.now() + 1, "page-locked"), 103);
    vi.setSystemTime(stoppedAt + 10 * 60_000);

    const second = make();
    await second.c.start();
    expect(second.c.health()).toMatchObject({ status: "degraded", events: { recovering: true } });
    expect(second.c.health().lagSeconds).toBe(600);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(second.events.map((e) => [e.type, e.delivery])).toEqual([
      ["page.unlocked", "backfill"],
      ["page.locked", "backfill"],
    ]);
    expect(second.gaps).toEqual([expect.objectContaining({ kind: "restart", recovered: true, entities: 1, events: 2, from: new Date(stoppedAt).toISOString() })]);
    expect(second.c.health()).toMatchObject({ status: "ok", lagSeconds: 0 });
    await second.c.stop();
  });

  it("a restart with nothing changed still reports an empty, recovered gap", async () => {
    vi.useFakeTimers({ now: T0 });
    const b = backend();
    const store = new MemoryStateStore();
    const c1 = NotionClient.fromCookies({ cookies: baseCookies, fetch: b.fetch, workspace: "Test WS", webSocketFactory: b.ms.factory, stateStore: store, watch: { mode: "explicit", roots: [PAGE] } });
    await c1.start();
    await c1.stop();
    const c2 = NotionClient.fromCookies({ cookies: baseCookies, fetch: b.fetch, workspace: "Test WS", webSocketFactory: b.ms.factory, stateStore: store, watch: { mode: "explicit", roots: [PAGE] } });
    const gaps: ConnectionGapEvent[] = [];
    c2.on("connection.gap", (g) => gaps.push(g));
    await c2.start();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(gaps).toEqual([expect.objectContaining({ kind: "restart", recovered: true, entities: 0, events: 0 })]);
    await c2.stop();
  });
});
