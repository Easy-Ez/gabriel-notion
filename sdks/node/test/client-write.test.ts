import { describe, expect, it } from "vitest";
import { NotionClient } from "../src/client/client.js";
import { annotateRange } from "../src/client/write-api.js";
import { encodeProperty, initialTitleTree, planBlocks, textInstanceId, type WriteContext } from "../src/client/write.js";
import { parseMarkdown } from "../src/markdown/parse.js";
import { SPACE_ID, USER_ID, baseCookies, fakeFetch, json, spaceRecordResponse, type RecordedRequest } from "./helpers/fake-fetch.js";

type Store = Record<string, Record<string, Record<string, unknown>>>;
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** A tiny Notion: serves record reads and applies submitted operations to the store. */
function notion(store: Store) {
  const transactions: Array<Array<{ pointer: { table: string; id: string }; path: string[]; command: string; args: Record<string, unknown> }>> = [];
  const get = (t: string, i: string) => ((store[t] ??= {})[i] ??= {});
  const list = (obj: Record<string, unknown>, path: string[]) => {
    let cur = obj;
    for (const p of path.slice(0, -1)) cur = (cur[p] ??= {}) as Record<string, unknown>;
    const key = path[path.length - 1]!;
    return { arr: ((cur[key] ??= []) as string[]), set: (a: string[]) => (cur[key] = a) };
  };
  const sync = (req: RecordedRequest) => {
    const reqs = (req.body as { requests: Array<{ pointer: { table: string; id: string } }> }).requests;
    if (reqs.length === 1 && reqs[0]!.pointer.table === "space") return spaceRecordResponse();
    const recordMap: Record<string, Record<string, unknown>> = {};
    for (const { pointer } of reqs) {
      const v = store[pointer.table]?.[pointer.id];
      (recordMap[pointer.table] ??= {})[pointer.id] = v ? { value: { value: { id: pointer.id, ...v }, role: "editor" } } : { value: { role: "none" } };
    }
    return json(200, { recordMap });
  };
  const save = (req: RecordedRequest) => {
    const ops = (req.body as { transactions: Array<{ operations: (typeof transactions)[number] }> }).transactions[0]!.operations;
    transactions.push(ops);
    for (const op of ops) {
      const rec = get(op.pointer.table, op.pointer.id);
      switch (op.command) {
        case "set":
          store[op.pointer.table]![op.pointer.id] = { ...op.args };
          break;
        case "update":
          Object.assign(op.path.length ? list(rec, op.path).arr : rec, op.args);
          break;
        case "replaceTextInBlock":
          rec.properties = { ...(rec.properties as object), title: op.args.textValue };
          break;
        case "updateBlockPropertyValue":
          rec.properties = { ...(rec.properties as object), ...((op.args.primitiveOp as { args: object }).args) };
          break;
        case "listAfter":
        case "listBefore": {
          const { arr, set } = list(rec, op.path);
          const without = arr.filter((x) => x !== op.args.id);
          const anchor = (op.args.after ?? op.args.before) as string | undefined;
          const at = anchor ? without.indexOf(anchor) : -1;
          if (at < 0) set(op.command === "listAfter" ? [...without, op.args.id as string] : [op.args.id as string, ...without]);
          else set([...without.slice(0, op.command === "listAfter" ? at + 1 : at), op.args.id as string, ...without.slice(op.command === "listAfter" ? at + 1 : at)]);
          break;
        }
        case "listRemove": {
          const { arr, set } = list(rec, op.path);
          set(arr.filter((x) => x !== op.args.id));
          break;
        }
        default:
          throw new Error(`unhandled command ${op.command}`);
      }
    }
    return json(200, {});
  };
  const { fetch } = fakeFetch({
    getSpaces: [() => json(200, { [USER_ID]: { space: { [SPACE_ID]: { value: { value: { name: "Test WS" } } } }, space_view: { [id(500)]: { value: { value: { id: id(500), space_id: SPACE_ID } } } } } })],
    authValidate: [() => json(200, {})],
    syncRecordValuesSpaceInitial: [sync],
    syncRecordValuesMain: [sync],
    saveTransactionsFanout: [save],
  });
  const client = NotionClient.fromCookies({ cookies: baseCookies, fetch, workspace: "Test WS", maxRetries: 0 });
  return { client, transactions, store };
}

const ctx: WriteContext = { spaceId: SPACE_ID, userId: USER_ID, newBlockId: (() => { let n = 100; return () => id(n++); })(), now: () => 1 };

describe("block planning", () => {
  it("derives the CRDT text instance in the web client's base64 alphabet", () => {
    const x = textInstanceId(id(1));
    expect(x).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(initialTitleTree(id(1))).toEqual({ r: `${x},"start","end"`, n: { [`${x},"start","end"`]: { s: { x, i: [{ t: "s" }, { t: "e" }], l: "" }, c: [] } } });
  });

  it("creates blocks with CRDT titles, links children, chains positions and skips references", () => {
    const specs = parseMarkdown("- a\n  - b\n\n---\n\n<page url=\"https://app.notion.com/p/0123456789abcdef0123456789abcdef\">\nOld\n</page>");
    const plan = planBlocks(ctx, specs, { id: id(1), table: "block", listPointer: { table: "block", id: id(1) }, listPath: ["content"], after: id(2) });
    const cmds = plan.operations.map((o) => `${o.command}:${o.pointer.id.slice(-3)}`);
    expect(cmds).toEqual(["set:100", "replaceTextInBlock:100", "set:101", "replaceTextInBlock:101", "listAfter:100", "listAfter:001", "set:102", "listAfter:001"]);
    const setA = plan.operations[0]!.args as Record<string, unknown>;
    expect(setA).toMatchObject({ type: "bulleted_list", parent_id: id(1), crdt_format_version: 1 });
    expect((plan.operations[6]!.args as Record<string, unknown>).crdt_data).toBeUndefined(); // divider has no title
    expect(plan.operations[5]!.args).toEqual({ id: id(100), after: id(2) });
    expect(plan.operations[7]!.args).toEqual({ id: id(102), after: id(100) });
    expect(plan.warnings).toHaveLength(1);
  });
});

describe("property encoding", () => {
  const def = (type: string) => ({ name: "P", type });
  it("encodes the supported types", () => {
    expect(encodeProperty(def("number"), 42, SPACE_ID)).toEqual([["42"]]);
    expect(encodeProperty(def("checkbox"), false, SPACE_ID)).toEqual([["No"]]);
    expect(encodeProperty(def("multi_select"), ["a", "b"], SPACE_ID)).toEqual([["a,b"]]);
    expect(encodeProperty(def("date"), { start: "2026-11-23", end: "2026-11-24" }, SPACE_ID)).toEqual([["‣", [["d", { type: "daterange", start_date: "2026-11-23", end_date: "2026-11-24" }]]]]);
    expect(encodeProperty(def("person"), [id(7), id(8)], SPACE_ID)).toEqual([["‣", [["u", id(7)]]], [","], ["‣", [["u", id(8)]]]]);
    expect(encodeProperty(def("relation"), { pages: [id(9)] }, SPACE_ID)).toEqual([["‣", [["p", id(9), SPACE_ID]]]]);
  });
  it("rejects read-only and file properties", () => {
    expect(() => encodeProperty(def("formula"), 1, SPACE_ID)).toThrow(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
    expect(() => encodeProperty(def("file"), "x", SPACE_ID)).toThrow(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
  });
});

describe("annotateRange", () => {
  it("splits segments and adds the annotation only inside the range", () => {
    expect(annotateRange([["abc "], ["def", [["b"]]]], 2, 6, ["m", "d1"])).toEqual([["ab"], ["c ", [["m", "d1"]]], ["de", [["b"], ["m", "d1"]]], ["f", [["b"]]]]);
  });
});

describe("pages.create", () => {
  it("creates a page with title and body in one transaction and verifies it", async () => {
    const PARENT = id(10);
    const n = notion({ block: { [PARENT]: { type: "page", content: [], alive: true } } });
    const page = await n.client.pages.create({ parent: { pageId: PARENT }, markdown: "# From heading\n\nbody" });
    expect(page.title).toBe("From heading");
    expect(n.transactions).toHaveLength(1);
    expect(n.store.block![PARENT]!.content).toEqual([page.id]);
    expect((await n.client.pages.get(page.id)).markdown).toBe("body");
  });

  it("creates a private page with an editor permission in the space view", async () => {
    const n = notion({ space_view: { [id(500)]: { private_pages: [] } } });
    const page = await n.client.pages.create({ parent: { private: true }, title: "Mine" });
    expect(n.store.space_view![id(500)]!.private_pages).toEqual([page.id]);
    expect(n.store.block![page.id]!.permissions).toEqual([{ type: "user_permission", role: "editor", user_id: USER_ID }]);
  });

  it("creates and updates database rows by property name", async () => {
    const DB = id(20), COLL = id(21), VIEW = id(22);
    const n = notion({
      block: { [DB]: { type: "collection_view_page", collection_id: COLL, view_ids: [VIEW], alive: true } },
      collection: { [COLL]: { name: [["DB"]], schema: { title: { name: "Name", type: "title" }, n1: { name: "Count", type: "number" }, f1: { name: "Calc", type: "formula" } } } },
    });
    const row = await n.client.pages.create({ parent: { databaseId: DB }, properties: { Name: "Row", Count: 3 } });
    expect(n.store.block![row.id]).toMatchObject({ parent_id: COLL, parent_table: "collection", properties: { title: [["Row"]], n1: [["3"]] } });
    await n.client.pages.updateProperties(row.id, { Count: 4 });
    expect((await n.client.pages.get(row.id)).properties.Count?.value).toBe(4);
    await expect(n.client.pages.updateProperties(row.id, { Calc: 1 })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });

  it("fails with WRITE_NOT_APPLIED when the server accepts the write but nothing changes", async () => {
    const PARENT = id(30);
    const n = notion({ block: { [PARENT]: { type: "page", content: [], alive: true } } });
    const original = n.client.core.submit.bind(n.client.core);
    n.client.core.submit = async () => {}; // the server "accepts" but applies nothing
    await expect(n.client.pages.create({ parent: { pageId: PARENT }, title: "Lost" })).rejects.toMatchObject({ code: "WRITE_NOT_APPLIED" });
    n.client.core.submit = original;
  });
});

describe("pages.updateContent", () => {
  function pageWith() {
    const ROOT = id(40), P1 = id(41), P2 = id(42), SUB = id(43);
    const n = notion({
      block: {
        [ROOT]: { type: "page", properties: { title: [["Root"]] }, content: [P1, P2, SUB], alive: true },
        [P1]: { type: "text", properties: { title: [["alpha beta"]] }, parent_id: ROOT, parent_table: "block", alive: true },
        [P2]: { type: "text", properties: { title: [["beta gamma"]] }, parent_id: ROOT, parent_table: "block", alive: true },
        [SUB]: { type: "page", properties: { title: [["Sub"]] }, parent_id: ROOT, parent_table: "block", content: [], alive: true },
      },
    });
    return { n, ROOT, P1, P2, SUB };
  }

  it("update replaces within a block, and refuses zero or several matches without all", async () => {
    const { n, ROOT, P1 } = pageWith();
    await expect(n.client.pages.updateContent(ROOT, { op: "update", find: "delta", replace: "x" })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(n.client.pages.updateContent(ROOT, { op: "update", find: "beta", replace: "x" })).rejects.toMatchObject({ message: expect.stringContaining("Found 2 matches") });
    const r = await n.client.pages.updateContent(ROOT, { op: "update", find: "alpha", replace: "<b>ALPHA</b>" });
    expect(r.changedBlockIds).toEqual([P1]);
    expect(n.store.block![P1]!.properties).toEqual({ title: [["ALPHA", [["b"]]], [" beta"]] });
    await n.client.pages.updateContent(ROOT, { op: "update", find: "beta", replace: "B", all: true });
    expect((await n.client.pages.get(ROOT)).markdown!.startsWith("<b>ALPHA</b> B\n\nB gamma")).toBe(true);
  });

  it("insert places blocks after or before an anchor", async () => {
    const { n, ROOT, P1, P2, SUB } = pageWith();
    const a = await n.client.pages.updateContent(ROOT, { op: "insert", markdown: "after one", after: P1 });
    const b = await n.client.pages.updateContent(ROOT, { op: "insert", markdown: "before sub", before: { text: "Sub" } });
    expect(n.store.block![ROOT]!.content).toEqual([P1, a.changedBlockIds[0], P2, b.changedBlockIds[0], SUB]);
  });

  it("replace_all swaps the body and keeps subpages", async () => {
    const { n, ROOT, P1, P2, SUB } = pageWith();
    const r = await n.client.pages.updateContent(ROOT, { op: "replace_all", markdown: "new body" });
    expect(n.store.block![ROOT]!.content).toEqual([r.changedBlockIds[0], SUB]);
    expect(n.store.block![P1]!.alive).toBe(false);
    expect(n.store.block![P2]!.alive).toBe(false);
    expect(n.store.block![SUB]!.alive).toBe(true);
  });
});

describe("comments", () => {
  it("creates page, inline and reply comments with the discussion wiring", async () => {
    const ROOT = id(60), P1 = id(61);
    const n = notion({
      block: {
        [ROOT]: { type: "page", content: [P1], alive: true },
        [P1]: { type: "text", properties: { title: [["pick this word"]] }, parent_id: ROOT, parent_table: "block", alive: true },
      },
    });
    const c1 = await n.client.comments.create({ pageId: ROOT, markdown: "hello <b>there</b>" });
    expect(c1.markdown).toBe("hello <b>there</b>");
    expect(n.store.block![ROOT]!.discussions).toEqual([c1.discussionId]);
    const c2 = await n.client.comments.create({ pageId: ROOT, markdown: "on a word", on: { blockId: P1, selection: "this" } });
    expect(n.store.block![P1]!.properties).toEqual({ title: [["pick "], ["this", [["m", c2.discussionId]]], [" word"]] });
    expect(n.store.discussion![c2.discussionId]!.context).toEqual([["this", [["m", c2.discussionId]]]]);
    await n.client.comments.reply(c1.discussionId, "reply");
    expect((n.store.discussion![c1.discussionId]!.comments as string[]).length).toBe(2);
    await expect(n.client.comments.create({ pageId: ROOT, markdown: "x", on: { blockId: P1, selection: "absent" } })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });
});
