import { describe, expect, it } from "vitest";
import { NotionClient } from "../src/client/client.js";
import { SPACE_ID, USER_ID, baseCookies, fakeFetch, json, spaceRecordResponse, type RecordedRequest } from "./helpers/fake-fetch.js";

type Store = Record<string, Record<string, Record<string, unknown>>>;

/** Serves syncRecordValues* from an in-memory store; unknown IDs are answered with role "none". */
function recordServer(store: Store) {
  return (req: RecordedRequest) => {
    const reqs = (req.body as { requests: Array<{ pointer: { table: string; id: string } }> }).requests;
    if (reqs.length === 1 && reqs[0]!.pointer.table === "space") return spaceRecordResponse();
    const recordMap: Record<string, Record<string, unknown>> = {};
    for (const { pointer } of reqs) {
      const v = store[pointer.table]?.[pointer.id];
      (recordMap[pointer.table] ??= {})[pointer.id] = v ? { value: { value: { id: pointer.id, ...v }, role: "editor" } } : { value: { role: "none" } };
    }
    return json(200, { recordMap });
  };
}

const getSpaces = () => json(200, { [USER_ID]: { space: { [SPACE_ID]: { value: { value: { name: "Test WS" } } } } } });

function makeClient(store: Store, extra: Parameters<typeof fakeFetch>[0] = {}) {
  const server = recordServer(store);
  const { fetch, requests } = fakeFetch({
    getSpaces: [getSpaces],
    authValidate: [() => json(200, {})],
    syncRecordValuesSpaceInitial: [server],
    syncRecordValuesMain: [server],
    ...extra,
  });
  const client = NotionClient.fromCookies({ cookies: baseCookies, fetch, workspace: "Test WS", maxRetries: 0 });
  return { client, requests };
}

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe("workspace binding", () => {
  it("is lazy and fails on the first call for an unknown workspace", async () => {
    const { fetch, requests } = fakeFetch({ getSpaces: [getSpaces] });
    const client = NotionClient.fromCookies({ cookies: baseCookies, fetch, workspace: "Nope" });
    expect(requests).toHaveLength(0);
    await expect(client.search("x")).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });
});

describe("search", () => {
  it("rejects a limit above 1000 before sending anything", async () => {
    const { client, requests } = makeClient({});
    await expect(client.search("x", { limit: 1001 })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(requests).toHaveLength(0);
  });

  it("maps hits, uses data source names for databases, strips highlight markup and flags truncation", async () => {
    const PAGE = id(1), DB = id(2), COLL = id(3);
    const { client, requests } = makeClient(
      {},
      {
        search: [
          () =>
            json(200, {
              results: [{ id: PAGE, highlight: { text: "<gzkNfoUU>Alpha</gzkNfoUU> body" } }, { id: DB }],
              recordMap: {
                block: {
                  [PAGE]: { value: { value: { type: "page", properties: { title: [["Alpha page"]] }, parent_id: SPACE_ID, parent_table: "space" }, role: "editor" } },
                  [DB]: { value: { value: { type: "collection_view_page", collection_id: COLL, parent_id: PAGE, parent_table: "block" }, role: "editor" } },
                },
                collection: { [COLL]: { value: { value: { name: [["Alpha DB"]] }, role: "editor" } } },
              },
            }),
        ],
      },
    );
    const r = await client.search("Alpha", { limit: 2, titleOnly: true, under: PAGE });
    expect(r.truncated).toBe(true);
    expect(r.results.map((h) => [h.title, h.type, h.highlight])).toEqual([
      ["Alpha page", "page", "Alpha body"],
      ["Alpha DB", "collection_view_page", undefined],
    ]);
    const body = requests.find((q) => q.endpoint === "search")!.body as { filters: { navigableBlockContentOnly: boolean; ancestors: string[] } };
    expect(body.filters.navigableBlockContentOnly).toBe(true);
    expect(body.filters.ancestors).toEqual([PAGE]);
  });
});

describe("users", () => {
  it("lists with the server cursor and maps membership_type", async () => {
    const { client, requests } = makeClient(
      {},
      {
        listUsers: [() => json(200, { users: [{ id: id(9), name: "Syn", email: "syn@example.invalid", membership_type: "member" }], hasMore: true, nextCursor: "next-1" })],
      },
    );
    const page = await client.users.list({ limit: 1, cursor: "c0" });
    expect(page).toEqual({ results: [{ id: id(9), name: "Syn", email: "syn@example.invalid", type: "member" }], hasMore: true, nextCursor: "next-1" });
    expect((requests.find((q) => q.endpoint === "listUsers")!.body as { cursor: string }).cursor).toBe("c0");
  });
});

describe("pages.get", () => {
  const ROOT = id(10), TOGGLE = id(11), CHILD = id(12), SUBPAGE = id(13), USER = id(14), INNER = id(15);
  const store: Store = {
    block: {
      [ROOT]: { type: "page", properties: { title: [["Root"]] }, content: [TOGGLE, SUBPAGE], parent_id: SPACE_ID, parent_table: "space", alive: true },
      [TOGGLE]: { type: "toggle", properties: { title: [["T"]] }, content: [CHILD], parent_id: ROOT, parent_table: "block", alive: true },
      [CHILD]: { type: "text", properties: { title: [["hi "], ["‣", [["u", USER]]]] }, parent_id: TOGGLE, parent_table: "block", alive: true },
      [SUBPAGE]: { type: "page", properties: { title: [["Sub"]] }, content: [INNER], parent_id: ROOT, parent_table: "block", alive: true },
      [INNER]: { type: "text", properties: { title: [["must not be read"]] }, parent_id: SUBPAGE, parent_table: "block", alive: true },
    },
    notion_user: { [USER]: { name: "Syn", email: "syn@example.invalid" } },
  };

  it("reads the whole subtree, stops at child pages and fetches mentioned users", async () => {
    const { client, requests } = makeClient(store);
    const r = await client.pages.get(ROOT);
    expect(r.markdown).toBe(
      `<toggle>\nT\n\nhi <mention url="user://${USER}/syn@example.invalid">Syn</mention>\n</toggle>\n\n<page url="https://app.notion.com/p/${SUBPAGE.replace(/-/g, "")}">\nSub\n</page>`,
    );
    const read = requests.flatMap((q) => ((q.body as { requests?: Array<{ pointer: { id: string } }> }).requests ?? []).map((x) => x.pointer.id));
    expect(read).not.toContain(INNER);
    expect(r.page).toMatchObject({ id: ROOT, title: "Root", parent: { type: "workspace", id: SPACE_ID }, locked: false });
  });

  it("returns a block tree on request", async () => {
    const { client } = makeClient(store);
    const r = await client.pages.get(ROOT, { format: "blocks" });
    expect(r.blocks?.map((b) => b.type)).toEqual(["toggle", "page"]);
    expect(r.blocks?.[0]?.children?.[0]?.id).toBe(CHILD);
    expect(r.blocks?.[1]?.children).toBeUndefined();
  });

  it("decodes database row properties by schema", async () => {
    const ROW = id(20), COLL = id(21);
    const { client } = makeClient({
      block: { [ROW]: { type: "page", parent_id: COLL, parent_table: "collection", properties: { title: [["Row"]], n1: [["42"]], s1: [["Done"]], c1: [["Yes"]], m1: [["a,b"]] }, alive: true } },
      collection: { [COLL]: { name: [["DB"]], schema: { title: { name: "Name", type: "title" }, n1: { name: "Count", type: "number" }, s1: { name: "State", type: "status" }, c1: { name: "Ok", type: "checkbox" }, m1: { name: "Tags", type: "multi_select" }, f1: { name: "Calc", type: "formula" } } } },
    });
    const r = await client.pages.get(ROW);
    expect(r.page.parent).toEqual({ type: "database", id: COLL });
    expect(Object.fromEntries(Object.entries(r.properties).map(([k, v]) => [k, v.value]))).toEqual({ Name: "Row", Count: 42, State: "Done", Ok: true, Tags: ["a", "b"], Calc: null });
  });

  it("reports NOT_FOUND for an inaccessible or missing page", async () => {
    const { client } = makeClient({});
    await expect(client.pages.get(id(99))).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("databases.query local cursor", () => {
  const DB = id(30), COLL = id(31), VIEW = id(32);
  const rows = Array.from({ length: 2500 }, (_, k) => id(1000 + k));
  const store: Store = {
    block: {
      [DB]: { type: "collection_view_page", collection_id: COLL, view_ids: [VIEW], alive: true },
      ...Object.fromEntries(rows.map((r, k) => [r, { type: "page", parent_id: COLL, parent_table: "collection", properties: { title: [[`row ${k}`]], num: [[String(k)]] }, alive: true }])),
    },
    collection: { [COLL]: { name: [["Big"]], schema: { title: { name: "Name", type: "title" }, num: { name: "N", type: "number" } } } },
    collection_view: { [VIEW]: { type: "table", name: "All" } },
  };
  const query = () =>
    json(200, {
      result: { reducerResults: { rows: { blockIds: rows, hasMore: false } } },
      // Like the server: only the first 1,000 row records are embedded.
      recordMap: { block: Object.fromEntries(rows.slice(0, 1000).map((r) => [r, { value: { value: store.block![r], role: "editor" } }])) },
    });

  it("pages through every row exactly once, in order, with one server query", async () => {
    const { client, requests } = makeClient(store, { queryCollection: [query] });
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const p = await client.databases.query(DB, { limit: 1000, ...(cursor ? { cursor } : {}) });
      seen.push(...p.results.map((r) => r.id));
      expect(p.results[0]?.properties.N?.value).toBe(seen.length - p.results.length);
      cursor = p.nextCursor;
    } while (cursor);
    expect(seen).toEqual(rows);
    expect(requests.filter((q) => q.endpoint === "queryCollection")).toHaveLength(1);
    const body = requests.find((q) => q.endpoint === "queryCollection")!.body as { collectionView: { id: string } };
    expect(body.collectionView.id).toBe(VIEW);
  });

  it("resolves property names in filters and sorts, and rejects unknown ones and foreign cursors", async () => {
    const { client, requests } = makeClient(store, { queryCollection: [query] });
    const first = await client.databases.query(DB, { filter: { property: "N", filter: { operator: "number_greater_than", value: { type: "exact", value: 5 } } }, sorts: [{ property: "N", direction: "descending" }], limit: 10 });
    const loader = (requests.find((q) => q.endpoint === "queryCollection")!.body as { loader: { filter: unknown; sort: unknown } }).loader;
    expect(loader.filter).toEqual({ operator: "and", filters: [{ property: "num", filter: { operator: "number_greater_than", value: { type: "exact", value: 5 } } }] });
    expect(loader.sort).toEqual([{ property: "num", direction: "descending" }]);
    await expect(client.databases.query(DB, { filter: { property: "Nope", filter: { operator: "string_is" } } })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(client.databases.query(DB, { cursor: first.nextCursor! })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });
});

describe("comments.list", () => {
  it("collects discussions on the page and its blocks, skipping resolved ones by default", async () => {
    const ROOT = id(40), BLOCK = id(41), D1 = id(42), D2 = id(43), D3 = id(44), C1 = id(45), C2 = id(46), C3 = id(47);
    const store: Store = {
      block: {
        [ROOT]: { type: "page", properties: { title: [["P"]] }, content: [BLOCK], discussions: [D1], alive: true },
        [BLOCK]: { type: "text", properties: { title: [["x"]] }, parent_id: ROOT, parent_table: "block", discussions: [D2, D3], alive: true },
      },
      discussion: {
        [D1]: { parent_id: ROOT, resolved: false, comments: [C1] },
        [D2]: { parent_id: BLOCK, resolved: false, context: [["x"]], comments: [C2] },
        [D3]: { parent_id: BLOCK, resolved: true, comments: [C3] },
      },
      comment: {
        [C1]: { text: [["page ", ], ["bold", [["b"]]]], created_by_id: USER_ID, created_time: 1, alive: true },
        [C2]: { text: [["inline"]], alive: true },
        [C3]: { text: [["resolved"]], alive: true },
      },
    };
    const { client } = makeClient(store);
    const d = await client.comments.list(ROOT);
    expect(d.map((x) => [x.blockId, x.context, x.comments.map((c) => c.markdown)])).toEqual([
      [ROOT, undefined, ["page <b>bold</b>"]],
      [BLOCK, "x", ["inline"]],
    ]);
    expect((await client.comments.list(ROOT, { includeResolved: true })).length).toBe(3);
  });
});
