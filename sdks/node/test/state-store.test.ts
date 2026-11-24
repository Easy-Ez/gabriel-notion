import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileStateStore, defaultStateFile } from "../src/state/file.js";
import { MemoryStateStore, type StateStore } from "../src/state/store.js";
import { SEEN_EVENT_LIMIT, WatchState } from "../src/state/watch-state.js";
import { isNotionError } from "../src/errors.js";

const WS = "00000000-0000-4000-8000-00000000aaaa";
let dir: string;
const stores: StateStore[] = [];

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "gn-state-"));
});
afterEach(async () => {
  for (const s of stores.splice(0)) await s.close().catch(() => {});
  await chmod(dir, 0o700).catch(() => {});
  await rm(dir, { recursive: true, force: true });
});

function fileStore(opts: { file?: string; flushDelayMs?: number } = {}): FileStateStore {
  const s = new FileStateStore({ file: opts.file ?? path.join(dir, "state.json"), flushDelayMs: opts.flushDelayMs ?? 0 });
  stores.push(s);
  return s;
}

async function expectCode(p: Promise<unknown>, code: string): Promise<void> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(isNotionError(err) ? err.code : err).toBe(code);
}

describe.each([
  ["MemoryStateStore", () => new MemoryStateStore()],
  ["FileStateStore", () => fileStore()],
])("%s contract", (_name, make) => {
  it("gets, sets, deletes, batches and lists by prefix", async () => {
    const s = make();
    expect(await s.get("a")).toBeUndefined();
    await s.set("a", "1");
    await s.batch([{ key: "p/x", value: "2" }, { key: "p/y", value: "3" }, { key: "a" }]);
    expect(await s.get("a")).toBeUndefined();
    expect((await s.keys("p/")).sort()).toEqual(["p/x", "p/y"]);
    await s.delete("p/x");
    expect(await s.keys("p/")).toEqual(["p/y"]);
  });

  it("rejects bad keys and values with INVALID_ARGUMENT and applies nothing", async () => {
    const s = make();
    await expectCode(s.set("", "x"), "INVALID_ARGUMENT");
    await expectCode(s.batch([{ key: "ok", value: "1" }, { key: "bad", value: 3 as unknown as string }]), "INVALID_ARGUMENT");
    expect(await s.get("ok")).toBeUndefined();
  });

  it("rejects calls after close with INVALID_STATE", async () => {
    const s = make();
    await s.set("a", "1");
    await s.close();
    await expectCode(s.get("a"), "INVALID_STATE");
  });
});

describe("FileStateStore", () => {
  it("defaults to state.json in the config directory", () => {
    expect(defaultStateFile({ GABRIEL_NOTION_CONFIG_DIR: "/tmp/gn-TESTONLY" })).toBe("/tmp/gn-TESTONLY/state.json");
  });

  it("persists across instances with 0600 file and 0700 directory", async () => {
    const file = path.join(dir, "nested", "state.json");
    const a = fileStore({ file });
    await a.batch([{ key: "k1", value: "v1" }, { key: "k2", value: "v2" }]);
    await a.close();
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(path.dirname(file))).mode & 0o777).toBe(0o700);
    const b = fileStore({ file });
    expect(await b.get("k1")).toBe("v1");
    expect(await b.get("k2")).toBe("v2");
    expect(b.health()).toMatchObject({ persistent: true, pending: false });
  });

  it("debounces writes and flushes on close", async () => {
    const file = path.join(dir, "state.json");
    const s = fileStore({ file, flushDelayMs: 60_000 });
    await s.set("k", "v");
    expect(s.health().pending).toBe(true);
    await expect(stat(file)).rejects.toMatchObject({ code: "ENOENT" });
    await s.close();
    expect(JSON.parse(await readFile(file, "utf8")).entries).toEqual({ k: "v" });
  });

  it("never leaves a partial file: a crashed write's temp file is ignored and removed", async () => {
    const file = path.join(dir, "state.json");
    const a = fileStore({ file });
    await a.set("k", "good");
    await a.close();
    // A crash between writing the temp file and the rename leaves only a temp file behind.
    await writeFile(`${file}.4242.deadbeef.tmp`, '{"format":1,"entries":{"k":"hal', { mode: 0o600 });
    const b = fileStore({ file });
    expect(await b.get("k")).toBe("good");
    expect((await readdir(dir)).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  it("keeps the previous snapshot when a write fails, reports it, and recovers", async () => {
    const file = path.join(dir, "state.json");
    const s = fileStore({ file });
    await s.set("k", "v1");
    await chmod(dir, 0o500); // the temp file cannot be created
    await expectCode(s.set("k", "v2"), "STATE_STORE_UNAVAILABLE");
    expect(s.health()).toMatchObject({ lastError: "STATE_STORE_UNAVAILABLE", pending: true });
    expect(JSON.parse(await readFile(file, "utf8")).entries).toEqual({ k: "v1" });
    expect(await s.get("k")).toBe("v1"); // a rejected write is not applied
    await chmod(dir, 0o700);
    await s.set("k", "v2");
    expect(s.health()).toMatchObject({ pending: false });
    expect(s.health().lastError).toBeUndefined();
    expect(JSON.parse(await readFile(file, "utf8")).entries).toEqual({ k: "v2" });
  });

  it("after a failed background write, the next change rejects until storage is back", async () => {
    const file = path.join(dir, "state.json");
    const s = fileStore({ file, flushDelayMs: 5 });
    await s.open();
    await chmod(dir, 0o500);
    await s.set("k", "v1");
    await new Promise((r) => setTimeout(r, 50));
    expect(s.health().lastError).toBe("STATE_STORE_UNAVAILABLE");
    await expectCode(s.set("k", "v2"), "STATE_STORE_UNAVAILABLE");
    await chmod(dir, 0o700);
    await s.set("k", "v3");
    expect(s.health().lastError).toBeUndefined();
    expect(JSON.parse(await readFile(file, "utf8")).entries).toEqual({ k: "v3" });
  });

  it("throws STATE_STORE_UNAVAILABLE when the location is unusable or the file is corrupt", async () => {
    await writeFile(path.join(dir, "blocker"), "x");
    await expectCode(fileStore({ file: path.join(dir, "blocker", "state.json") }).get("k"), "STATE_STORE_UNAVAILABLE");
    const corrupt = path.join(dir, "corrupt.json");
    await writeFile(corrupt, "{not json");
    await expectCode(fileStore({ file: corrupt }).get("k"), "STATE_STORE_UNAVAILABLE");
    const foreign = path.join(dir, "foreign.json");
    await writeFile(foreign, JSON.stringify({ format: 99, entries: {} }));
    await expectCode(fileStore({ file: foreign }).get("k"), "STATE_STORE_UNAVAILABLE");
  });

  it("refuses a file another live store holds, and takes over a crashed owner's lock", async () => {
    const file = path.join(dir, "state.json");
    const a = fileStore({ file });
    await a.open();
    await expectCode(fileStore({ file }).get("k"), "STATE_STORE_UNAVAILABLE");
    await a.close();

    await writeFile(`${file}.lock`, String(process.pid === 1 ? 2 : 1)); // PID 1 is alive (launchd/init)
    await expectCode(fileStore({ file }).get("k"), "STATE_STORE_UNAVAILABLE");
    await writeFile(`${file}.lock`, "999999999"); // no such process
    const c = fileStore({ file });
    await c.set("k", "v");
    await c.close();
    await expect(stat(`${file}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("WatchState", () => {
  it("stores the page tree, subscription versions and activity cursors per workspace", async () => {
    const file = path.join(dir, "state.json");
    const store = fileStore({ file });
    const w = new WatchState(store, WS);
    await w.putNodes([
      { id: "p1", table: "block", type: "page", children: ["p2"] },
      { id: "p2", table: "block", type: "page", parent: { table: "block", id: "p1" } },
    ]);
    await w.setSubscriptionVersions([["versions/p1:block", 1732400000001], ["activity/p1", -1]]);
    await w.commitActivity("p1", { latestActivityId: "act-1", recent: [{ id: "act-1", version: 3 }] }, ["e1", "e2"]);
    await new WatchState(store, "other-workspace").putNodes([{ id: "x", table: "block" }]);
    await store.close();

    const reopened = new WatchState(fileStore({ file }), WS);
    expect((await reopened.listNodes()).map((n) => n.id).sort()).toEqual(["p1", "p2"]);
    expect(await reopened.getNode("p2")).toMatchObject({ parent: { id: "p1" } });
    expect(await reopened.subscriptionVersions()).toEqual(new Map([["versions/p1:block", 1732400000001], ["activity/p1", -1]]));
    expect(await reopened.getCursor("p1")).toMatchObject({ latestActivityId: "act-1", recent: [{ id: "act-1", version: 3 }] });
    expect(await reopened.hasSeenEvent("e2")).toBe(true);
    expect(await reopened.hasSeenEvent("e3")).toBe(false);
    await reopened.removeNodes(["p2"]);
    await reopened.removeSubscriptions(["activity/p1"]);
    expect((await reopened.listNodes()).map((n) => n.id)).toEqual(["p1"]);
    expect([...(await reopened.subscriptionVersions()).keys()]).toEqual(["versions/p1:block"]);
  });

  it("keeps at least the configured number of recent event IDs, evicting the oldest", async () => {
    expect(SEEN_EVENT_LIMIT).toBe(10_000);
    const w = new WatchState(new MemoryStateStore(), WS, 3);
    await w.commitActivity("p", { latestActivityId: "a1" }, ["e1", "e2"]);
    await w.commitActivity("p", { latestActivityId: "a2" }, ["e2", "e3", "e4"]);
    expect(await w.hasSeenEvent("e1")).toBe(false);
    for (const id of ["e2", "e3", "e4"]) expect(await w.hasSeenEvent(id)).toBe(true);
  });

  it("does not advance the cursor or the seen set when the write fails", async () => {
    const file = path.join(dir, "state.json");
    const store = fileStore({ file });
    const w = new WatchState(store, WS);
    await w.commitActivity("p", { latestActivityId: "a1" }, ["e1"]);
    await chmod(dir, 0o500);
    await expectCode(w.commitActivity("p", { latestActivityId: "a2" }, ["e2"]), "STATE_STORE_UNAVAILABLE");
    expect(await w.hasSeenEvent("e2")).toBe(false);
    expect(JSON.parse(await readFile(file, "utf8")).entries[`notion/${WS}/cursor/p`]).toContain('"a1"');
  });
});
