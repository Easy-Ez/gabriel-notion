import { describe, expect, it } from "vitest";
import { NotionCore } from "../src/core/core.js";
import { decodeBlockId, newBlockId, normalizeId } from "../src/core/ids.js";
import { normalizeEntry } from "../src/core/records.js";
import { SPACE_ID, SPACE_SHORT_ID, USER_ID, baseCookies, fakeFetch, json, spaceRecordResponse } from "./helpers/fake-fetch.js";

/** A synthetic block ID in the web client's v8 layout: created 2026-11-23, workspace short ID 12345678901. */
const ID = "4212dfdc-1c35-805a-9a5a-da5a5a5a5a5a";

describe("ID parsing", () => {
  it("accepts a UUID, 32 hex characters and Notion page URLs", () => {
    expect(normalizeId(ID.toUpperCase())).toBe(ID);
    expect(normalizeId(ID.replace(/-/g, ""))).toBe(ID);
    expect(normalizeId(`https://app.notion.com/p/WH2-shared-parent-${ID.replace(/-/g, "")}`)).toBe(ID);
    expect(normalizeId(`https://www.notion.so/acme/Some-Title-${ID.replace(/-/g, "")}?pvs=4`)).toBe(ID);
    expect(normalizeId(`https://www.notion.so/acme/db-0123456789abcdef0123456789abcdef?v=fedcba9876543210fedcba9876543210&p=${ID.replace(/-/g, "")}`)).toBe(ID);
  });

  it("rejects anything else", () => {
    for (const bad of ["", "not-an-id", "https://example.com/" + ID.replace(/-/g, ""), "1234"]) {
      expect(() => normalizeId(bad)).toThrow(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
    }
  });
});

describe("block IDs", () => {
  it("lay out date, workspace short ID and fixed bits like the web client", () => {
    const now = Date.UTC(2026, 10, 23, 12);
    const id = newBlockId(SPACE_SHORT_ID, now, new Uint8Array(16).fill(0xff));
    expect(decodeBlockId(id)).toEqual({ createdDay: "2026-11-23", spaceShortId: SPACE_SHORT_ID });
    const b = id.replace(/-/g, "").match(/../g)!.map((x) => parseInt(x, 16));
    expect(b[6]).toBe(0x80);
    expect(b[8]! & 0xc0).toBe(0x80);
    expect(b[10]! & 0xc0).toBe(0xc0);
  });

  it("decode a fixed v8 sample", () => {
    expect(decodeBlockId(ID)).toEqual({ createdDay: "2026-11-23", spaceShortId: SPACE_SHORT_ID });
    expect(decodeBlockId(crypto.randomUUID())).toBeUndefined();
  });

  it("refuse an invalid short ID", () => {
    expect(() => newBlockId(2 ** 36)).toThrow(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
  });
});

describe("record map entries", () => {
  it("normalize both response shapes and role-only entries", () => {
    expect(normalizeEntry({ spaceId: "s", value: { value: { id: "a" }, role: "editor" } })).toEqual({ role: "editor", value: { id: "a" } });
    expect(normalizeEntry({ value: { id: "a" }, role: "reader" })).toEqual({ role: "reader", value: { id: "a" } });
    expect(normalizeEntry({ spaceId: "s", value: { role: "none" } })).toEqual({ role: "none" });
    expect(normalizeEntry(undefined)).toBeUndefined();
  });
});

async function boundCore(script: Parameters<typeof fakeFetch>[0]) {
  const syncQueue = script.syncRecordValuesSpaceInitial ?? [];
  const { fetch, requests } = fakeFetch({
    getSpaces: [() => json(200, { [USER_ID]: { space: { [SPACE_ID]: { value: { value: { name: "Test WS" } } } } } })],
    authValidate: [() => json(200, {})],
    ...script,
    syncRecordValuesSpaceInitial: [spaceRecordResponse, ...syncQueue],
  });
  const core = new NotionCore({ cookies: baseCookies, fetch, maxRetries: 0 });
  await core.bindWorkspace("Test WS");
  requests.length = 0;
  return { core, requests };
}

describe("record reads", () => {
  it("batch at most 1,000 pointers per request and send user records through the main cell", async () => {
    const echo = (req: { body: unknown }) => {
      const r = (req.body as { requests: Array<{ pointer: { table: string; id: string } }> }).requests;
      const recordMap: Record<string, Record<string, unknown>> = {};
      for (const { pointer } of r) (recordMap[pointer.table] ??= {})[pointer.id] = { value: { value: { id: pointer.id }, role: "reader" } };
      return json(200, { recordMap });
    };
    const { core, requests } = await boundCore({ syncRecordValuesSpaceInitial: [echo], syncRecordValuesMain: [echo] });
    const pointers = Array.from({ length: 2500 }, () => ({ table: "block", id: crypto.randomUUID() }));
    const map = await core.getRecords([...pointers, { table: "notion_user", id: USER_ID }]);
    expect(map.size).toBe(2501);
    const sizes = requests.map((r) => [r.endpoint, (r.body as { requests: unknown[] }).requests.length]);
    expect(sizes).toEqual([
      ["syncRecordValuesSpaceInitial", 1000],
      ["syncRecordValuesSpaceInitial", 1000],
      ["syncRecordValuesSpaceInitial", 500],
      ["syncRecordValuesMain", 1],
    ]);
    const blockReq = (requests[0]!.body as { requests: Array<{ pointer: { spaceId?: string } }> }).requests[0]!;
    const userReq = (requests[3]!.body as { requests: Array<{ pointer: { spaceId?: string } }> }).requests[0]!;
    expect(blockReq.pointer.spaceId).toBe(SPACE_ID);
    expect(userReq.pointer.spaceId).toBeUndefined();
  });

  it("map role none to NOT_FOUND (missing and inaccessible look the same)", async () => {
    const { core } = await boundCore({ syncRecordValuesSpaceInitial: [() => json(200, { recordMap: { block: { [ID]: { spaceId: SPACE_ID, value: { role: "none" } } } } })] });
    await expect(core.records.get({ table: "block", id: ID })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("re-check the session before reporting a missing record", async () => {
    const { core, requests } = await boundCore({ syncRecordValuesSpaceInitial: [() => json(200, { recordMap: {} })] });
    await expect(core.records.get({ table: "block", id: ID })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(requests.map((r) => r.endpoint)).toEqual(["syncRecordValuesSpaceInitial", "authValidate"]);
  });

  it("report AUTH_DEAD when a missing record turns out to be a dead session", async () => {
    const { core } = await boundCore({
      syncRecordValuesSpaceInitial: [() => json(200, { recordMap: {} })],
      authValidate: [() => json(401, {})],
    });
    await expect(core.records.get({ table: "block", id: ID })).rejects.toMatchObject({ code: "AUTH_DEAD" });
  });
});

describe("transactions", () => {
  it("submit one transaction with the workspace filled into every pointer", async () => {
    const { core, requests } = await boundCore({ saveTransactionsFanout: [() => json(200, {})] });
    const blockId = core.newBlockId();
    expect(decodeBlockId(blockId)?.spaceShortId).toBe(SPACE_SHORT_ID);
    await core.submit([{ pointer: { table: "block", id: blockId }, path: [], command: "update", args: { alive: true } }], { userAction: "test" });
    const body = requests[0]!.body as { requestId: string; transactions: Array<{ id: string; spaceId: string; debug?: unknown; operations: Array<{ pointer: { spaceId: string } }> }> };
    expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.transactions).toHaveLength(1);
    expect(body.transactions[0]!.spaceId).toBe(SPACE_ID);
    expect(body.transactions[0]!.debug).toEqual({ userAction: "test" });
    expect(body.transactions[0]!.operations[0]!.pointer.spaceId).toBe(SPACE_ID);
  });

  it("refuse an empty transaction and require a bound workspace for IDs", async () => {
    const { core } = await boundCore({});
    await expect(core.submit([])).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    const unbound = new NotionCore({ cookies: baseCookies, fetch: fakeFetch({}).fetch });
    expect(() => unbound.newBlockId()).toThrow(expect.objectContaining({ code: "INVALID_STATE" }));
  });

  it("verify a write and fail with WRITE_NOT_APPLIED when the read-back disagrees", async () => {
    const { core } = await boundCore({
      syncRecordValuesSpaceInitial: [() => json(200, { recordMap: { block: { [ID]: { value: { value: { id: ID, format: { page_full_width: false } }, role: "editor" } } } } })],
    });
    await expect(
      core.records.verify([{ pointer: { table: "block", id: ID }, holds: (v) => (v as { format?: { page_full_width?: boolean } })?.format?.page_full_width === true, describe: "page_full_width" }]),
    ).rejects.toMatchObject({ code: "WRITE_NOT_APPLIED" });
  });
});
