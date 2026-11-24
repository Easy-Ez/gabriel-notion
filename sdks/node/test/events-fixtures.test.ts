import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { eventId, normalizeActivities, type Activity, type LoadedRecord } from "../src/client/events/normalize.js";
import { EVENT_TYPES, type NotionEvent } from "../src/client/events/types.js";

const DIR = path.resolve(__dirname, "../../../spec/fixtures/events");

interface Fixture {
  description: string;
  workspaceId: string;
  selfUserId?: string;
  records: Array<{ table: string; id: string; role?: string; value?: Record<string, unknown> }>;
  reads: Array<{ activities: Activity[]; expected: { events: unknown[]; noAccess: unknown[]; drift: string[] } }>;
}

const files = readdirSync(DIR).filter((f) => f.endsWith(".json")).sort();

describe("spec/fixtures/events", () => {
  it("has the recorded cases", () => {
    expect(files.length).toBeGreaterThanOrEqual(15);
  });

  it.each(files)("%s", (file) => {
    const fx = JSON.parse(readFileSync(path.join(DIR, file), "utf8")) as Fixture;
    const records = new Map<string, LoadedRecord>(fx.records.map((r) => [`${r.table}:${r.id}`, { ...(r.role ? { role: r.role } : {}), ...(r.value ? { value: r.value } : {}) }]));
    const seen = new Set<string>();
    for (const read of fx.reads) {
      const res = normalizeActivities({
        workspaceId: fx.workspaceId,
        ...(fx.selfUserId ? { selfUserId: fx.selfUserId } : {}),
        activities: read.activities,
        records: (t, id) => records.get(`${t}:${id}`),
        isSeen: (k) => seen.has(k),
      });
      for (const k of res.editKeys) seen.add(k);
      const events = res.events.map(({ web, ...e }) => ({ ...e, web: { activityId: web.activityId, edits: web.edits } }));
      expect(events).toEqual(read.expected.events);
      expect(res.noAccess).toEqual(read.expected.noAccess);
      expect(res.drift.map((d) => d.kind)).toEqual(read.expected.drift);
      for (const e of res.events) expect(EVENT_TYPES).toContain(e.type);
    }
  });

  it("never delivers the same edit twice when an activity is read again", () => {
    for (const file of files) {
      const fx = JSON.parse(readFileSync(path.join(DIR, file), "utf8")) as Fixture;
      const records = new Map<string, LoadedRecord>(fx.records.map((r) => [`${r.table}:${r.id}`, { ...(r.role ? { role: r.role } : {}), ...(r.value ? { value: r.value } : {}) }]));
      const seen = new Set<string>();
      const ids = new Set<string>();
      for (const read of [...fx.reads, ...fx.reads]) {
        const res = normalizeActivities({ workspaceId: fx.workspaceId, activities: read.activities, records: (t, id) => records.get(`${t}:${id}`), isSeen: (k) => seen.has(k) });
        for (const k of res.editKeys) seen.add(k);
        for (const e of res.events as NotionEvent[]) {
          expect(ids.has(e.id)).toBe(false);
          ids.add(e.id);
        }
      }
    }
  });
});

describe("event IDs", () => {
  it("are the SHA-256 of the sorted edit keys, formatted as a UUID", () => {
    expect(eventId(["b", "a"])).toBe(eventId(["a", "b"]));
    expect(eventId(["a|block-created|x|1"])).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    // Fixed vector so other SDKs can check their implementation.
    expect(eventId(["act-1|page-locked|page-1|1732400000000"])).toBe("cb019182-2500-685e-42ad-640a98fe6bc0");
  });
});

describe("spec/schema", () => {
  it("every expected fixture event and every record-diff event validates against its type's schema", async () => {
    const { default: Ajv2020 } = await import("ajv/dist/2020.js");
    const { diffRecord } = await import("../src/client/events/record-diff.js");
    const SCHEMA_DIR = path.resolve(__dirname, "../../../spec/schema");
    const ajv = new (Ajv2020 as unknown as new (o: object) => { addSchema(s: object): void; getSchema(id: string): ((d: unknown) => boolean) & { errors?: unknown } })({ strict: false, validateFormats: false });
    for (const f of readdirSync(SCHEMA_DIR)) ajv.addSchema(JSON.parse(readFileSync(path.join(SCHEMA_DIR, f), "utf8")));
    const check = (e: { type: string }) => {
      const validate = ajv.getSchema(`https://gabriel-notion.invalid/schema/${e.type}.schema.json`);
      expect(validate, e.type).toBeTypeOf("function");
      const ok = validate!(e);
      expect(validate!.errors ?? null, `${e.type}: ${JSON.stringify(validate!.errors)}`).toBeNull();
      expect(ok).toBe(true);
    };
    const types = new Set<string>();
    for (const file of files) {
      const fx = JSON.parse(readFileSync(path.join(DIR, file), "utf8")) as Fixture;
      for (const read of fx.reads) for (const e of read.expected.events as Array<{ type: string }>) {
        check(e);
        types.add(e.type);
      }
    }
    const WS = "00000000-0000-4000-8000-00000000a000";
    const c = { id: "c", version: 1, text: [["a"]], parent_id: "d" };
    for (const e of [
      diffRecord({ table: "comment", id: "c", workspaceId: WS, before: c, after: { ...c, version: 2, text: [["b"]] } }),
      diffRecord({ table: "comment", id: "c", workspaceId: WS, before: c, after: { ...c, version: 2, alive: false } }),
      diffRecord({ table: "collection_view", id: "v", workspaceId: WS, before: { version: 1, name: "a", parent_id: "db" }, after: { version: 2, name: "b", parent_id: "db" } }),
    ]) {
      check(e!);
      types.add(e!.type);
    }
    expect(types.size).toBeGreaterThanOrEqual(14);
    // The schemas do reject malformed events.
    const locked = ajv.getSchema("https://gabriel-notion.invalid/schema/page.locked.schema.json")!;
    const good = { id: "cb019182-2500-685e-42ad-640a98fe6bc0", type: "page.locked", timestamp: "2026-11-24T00:00:00.000Z", workspaceId: WS, entity: { id: "p", type: "page" }, authors: [], data: {}, origin: "other_user", delivery: "live", web: {} };
    expect(locked(good)).toBe(true);
    expect(locked({ ...good, origin: "someone" })).toBe(false);
    expect(locked({ ...good, entity: { id: "p", type: "comment" } })).toBe(false);
    expect(locked({ ...good, data: { updated_blocks: [] } })).toBe(false);
    for (const t of EVENT_TYPES) expect(ajv.getSchema(`https://gabriel-notion.invalid/schema/${t}.schema.json`), t).toBeTypeOf("function");
  });
});
