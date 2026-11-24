import { createHash } from "node:crypto";
import type { Operation, RecordPointer } from "../core/records.js";
import { NotionError } from "../errors.js";
import { parseInline } from "../markdown/inline-parse.js";
import type { BlockSpec, DateValue, RichText } from "../markdown/model.js";
import type { PropertySchema } from "./properties.js";

/** Block types whose `properties.title` is a CRDT text. */
const TITLE_TYPES = new Set([
  "text", "header", "sub_header", "sub_sub_header", "bulleted_list", "numbered_list", "to_do", "quote",
  "callout", "toggle", "code", "equation", "page",
]);
/** Types the Markdown can only point at; they are never created from Markdown. */
const REFERENCE_ONLY = new Set(["collection_view", "collection_view_page", "transclusion_container", "transclusion_reference", "file"]);

/**
 * `textInstanceId`: the first 16 bytes of SHA-256("<blockId>/title"), base64 with `/` → `-` and
 * `+` → `_`, no padding (checked against records the web client wrote).
 */
export function textInstanceId(blockId: string): string {
  return createHash("sha256").update(`${blockId}/title`).digest().subarray(0, 16).toString("base64").replace(/\//g, "-").replace(/\+/g, "_").replace(/=+$/, "");
}

/** The empty CRDT tree a new block's title starts from. */
export function initialTitleTree(blockId: string): Record<string, unknown> {
  const x = textInstanceId(blockId);
  const r = `${x},"start","end"`;
  return { r, n: { [r]: { s: { x, i: [{ t: "s" }, { t: "e" }], l: "" }, c: [] } } };
}

export interface WriteContext {
  spaceId: string;
  userId: string;
  newBlockId: () => string;
  now: () => number;
}

export interface PlannedBlocks {
  operations: Operation[];
  /** IDs of the blocks created at the top level, in order. */
  created: string[];
  /** Every block ID created, nested ones included. */
  allCreated: string[];
  warnings: string[];
}

const blockPtr = (id: string): RecordPointer => ({ table: "block", id });

export function editedMeta(ctx: WriteContext): Record<string, unknown> {
  return { last_edited_time: ctx.now(), last_edited_by_id: ctx.userId, last_edited_by_table: "notion_user" };
}

/** Title write for a block, as the web client does it. */
export function titleOp(blockId: string, title: RichText): Operation {
  return { pointer: blockPtr(blockId), path: [], command: "replaceTextInBlock", args: { textValue: title }, opVersion: 2 };
}

/**
 * Plans the operations that create `specs` under a parent. `attach` adds each top-level block to
 * the parent's list (e.g. `content`, `team_pages`); `after` places the first one after that block.
 * Specs that only name an existing block (subpage, database, synced block, file) are skipped with a
 * warning: they cannot be created from Markdown.
 */
export function planBlocks(
  ctx: WriteContext,
  specs: readonly BlockSpec[],
  parent: { id: string; table: "block" | "team" | "space" | "collection"; listPointer?: RecordPointer; listPath?: string[]; after?: string; before?: string },
): PlannedBlocks {
  const ops: Operation[] = [];
  const allCreated: string[] = [];
  const warnings: string[] = [];

  const create = (spec: BlockSpec, parentId: string, parentTable: string): string | undefined => {
    if (REFERENCE_ONLY.has(spec.type)) {
      warnings.push(`skipped ${spec.type}${spec.ref?.id ? ` ${spec.ref.id}` : ""}: it can only reference an existing block`);
      return undefined;
    }
    if (spec.type === "page" && spec.ref?.id) {
      warnings.push(`skipped existing subpage ${spec.ref.id}: creating content never moves existing pages`);
      return undefined;
    }
    const id = ctx.newBlockId();
    const now = ctx.now();
    const args: Record<string, unknown> = {
      id,
      type: spec.type,
      version: 1,
      alive: true,
      parent_id: parentId,
      parent_table: parentTable,
      space_id: ctx.spaceId,
      created_time: now,
      created_by_id: ctx.userId,
      created_by_table: "notion_user",
      last_edited_time: now,
      last_edited_by_id: ctx.userId,
      last_edited_by_table: "notion_user",
    };
    if (spec.properties && Object.keys(spec.properties).length) args.properties = { ...spec.properties };
    if (spec.format) args.format = { ...spec.format };
    if (TITLE_TYPES.has(spec.type)) {
      args.crdt_format_version = 1;
      args.crdt_data = { title: initialTitleTree(id) };
    }
    ops.push({ pointer: blockPtr(id), path: [], command: "set", args });
    if (TITLE_TYPES.has(spec.type) && spec.title?.length) ops.push(titleOp(id, spec.title));
    allCreated.push(id);
    for (const child of spec.children ?? []) {
      const cid = create(child, id, "block");
      if (cid) ops.push({ pointer: blockPtr(id), path: ["content"], command: "listAfter", args: { id: cid } });
    }
    return id;
  };

  const created: string[] = [];
  let prev = parent.after;
  for (const spec of specs) {
    const id = create(spec, parent.id, parent.table);
    if (!id) continue;
    created.push(id);
    if (parent.listPointer && parent.listPath) {
      if (prev) ops.push({ pointer: parent.listPointer, path: parent.listPath, command: "listAfter", args: { id, after: prev } });
      else if (parent.before) ops.push({ pointer: parent.listPointer, path: parent.listPath, command: "listBefore", args: { id, before: parent.before } });
      else ops.push({ pointer: parent.listPointer, path: parent.listPath, command: "listAfter", args: { id } });
      prev = id;
    }
  }
  return { operations: ops, created, allCreated, warnings };
}

// ------------------------------------------------------------------ properties

export type PropertyInput =
  | string
  | number
  | boolean
  | null
  | string[]
  | { start: string; end?: string }
  | { users: string[] }
  | { pages: string[] };

function joinMentions(items: Array<[string, unknown[]]>): RichText {
  const out: RichText = [];
  items.forEach((seg, k) => {
    if (k > 0) out.push([","]);
    out.push(seg as RichText[number]);
  });
  return out;
}

const READ_ONLY = new Set(["formula", "rollup", "created_time", "last_edited_time", "created_by", "last_edited_by", "unique_id", "button"]);

/**
 * Encodes a property value for a data source column. Read-only and file properties are rejected.
 */
export function encodeProperty(def: PropertySchema, input: PropertyInput, spaceId: string): RichText {
  if (READ_ONLY.has(def.type)) throw new NotionError("INVALID_ARGUMENT", `property "${def.name}" (${def.type}) is read-only`);
  if (def.type === "file") throw new NotionError("INVALID_ARGUMENT", `property "${def.name}" is a file property; upload files with the files API`);
  if (input === null) return [];
  switch (def.type) {
    case "title":
    case "text":
      return parseInline(String(input)).text;
    case "url":
    case "email":
    case "phone_number":
    case "select":
    case "status":
      return [[String(input)]];
    case "number": {
      const n = typeof input === "number" ? input : Number(input);
      if (!Number.isFinite(n)) throw new NotionError("INVALID_ARGUMENT", `property "${def.name}" needs a number`);
      return [[String(n)]];
    }
    case "multi_select":
      return [[(Array.isArray(input) ? input : [String(input)]).join(",")]];
    case "checkbox":
      return [[input === true || input === "Yes" || input === "true" ? "Yes" : "No"]];
    case "date": {
      const v = typeof input === "string" ? { start: input } : (input as { start: string; end?: string });
      if (!v || typeof v.start !== "string") throw new NotionError("INVALID_ARGUMENT", `property "${def.name}" needs a date like "2026-11-23" or { start, end }`);
      const d: DateValue = { type: v.end ? "daterange" : "date", start_date: v.start };
      if (v.end) d.end_date = v.end;
      return [["‣", [["d", d]]]];
    }
    case "person": {
      const ids = Array.isArray(input) ? input : (input as { users?: string[] }).users;
      if (!Array.isArray(ids)) throw new NotionError("INVALID_ARGUMENT", `property "${def.name}" needs user IDs`);
      return joinMentions(ids.map((id) => ["‣", [["u", id]]]));
    }
    case "relation": {
      const ids = Array.isArray(input) ? input : (input as { pages?: string[] }).pages;
      if (!Array.isArray(ids)) throw new NotionError("INVALID_ARGUMENT", `property "${def.name}" needs page IDs`);
      return joinMentions(ids.map((id) => ["‣", [["p", id, spaceId]]]));
    }
    default:
      throw new NotionError("INVALID_ARGUMENT", `writing "${def.type}" properties is not supported yet`);
  }
}

/** Resolves `{ name: value }` against a schema into `{ propertyId: richText }`, title included. */
export function encodeProperties(schema: Record<string, PropertySchema>, input: Record<string, PropertyInput>, spaceId: string): Record<string, RichText> {
  const out: Record<string, RichText> = {};
  for (const [key, value] of Object.entries(input)) {
    const entry = Object.entries(schema).find(([pid, def]) => pid === key || def.name === key);
    if (!entry) throw new NotionError("INVALID_ARGUMENT", `unknown property "${key}"`);
    out[entry[0]] = encodeProperty(entry[1], value, spaceId);
  }
  return out;
}
