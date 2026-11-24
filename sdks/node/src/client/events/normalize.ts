import { createHash } from "node:crypto";
import type { RecordPointer } from "../../core/records.js";
import type { EntityType, EventParent, EventType, NotionEvent, UpdatedBlock, UpdatedProperty } from "./types.js";

/**
 * Activity log → webhook-style events (spec §8). Pure: the caller loads the records
 * named by `recordsToLoad()` and passes them in, so the same mapping runs in the pipeline and in
 * the shared fixtures (`spec/fixtures/events`).
 */

export interface ActivityEdit {
  type: string;
  authors?: Array<{ id: string; table?: string }>;
  timestamp?: number;
  block_id?: string;
  block_data?: { block_value?: BlockValue; before?: { block_value?: BlockValue }; after?: { block_value?: BlockValue } };
  block_schema?: Record<string, { name?: string; type?: string }>;
  comment_id?: string;
  comment_data?: Record<string, unknown>;
  discussion_id?: string;
  collection_id?: string;
  collection_row_id?: string;
  collection_property_id?: string;
  collection_property_data?: { name?: string; type?: string };
  collection_view_id?: string;
  navigable_block_id?: string;
  top_level_block_id?: string;
  [k: string]: unknown;
}

export interface Activity {
  id: string;
  version?: number;
  type: string;
  parent_table?: string;
  parent_id?: string;
  start_time?: string | number;
  end_time?: string | number;
  space_id?: string;
  navigable_block_id?: string;
  collection_id?: string;
  collection_row_id?: string;
  top_level_block_id?: string;
  discussion_id?: string;
  collection_view_id?: string;
  edits?: ActivityEdit[];
  [k: string]: unknown;
}

export interface BlockValue {
  id?: string;
  type?: string;
  alive?: boolean;
  parent_id?: string;
  parent_table?: string;
  properties?: Record<string, unknown>;
  created_time?: number;
  [k: string]: unknown;
}

export interface LoadedRecord {
  role?: string;
  value?: Record<string, unknown>;
}

export type RecordLookup = (table: string, id: string) => LoadedRecord | undefined;

export interface NormalizeInput {
  workspaceId: string;
  /** The account the SDK acts as; its edits are `self_other_client` (S12 adds `this_client`). */
  selfUserId?: string;
  activities: readonly Activity[];
  records: RecordLookup;
  /** Edit keys already delivered (from the StateStore). */
  isSeen?: (editKey: string) => boolean;
  /** Whether an edit by `selfUserId` was made by this SDK instance (§11); its events are `this_client`. */
  isThisClient?: (activity: Activity, edit: ActivityEdit) => boolean;
  delivery?: "live" | "backfill";
}

export interface NormalizeResult {
  events: NotionEvent[];
  /** Every new edit key this read consumed, including dropped and cancelled ones. */
  editKeys: string[];
  /** Entities whose events were dropped because the account cannot read them. */
  noAccess: Array<{ table: string; id: string }>;
  /** Unknown activity or edit types (`activity.<type>`, `edit.<type>`). */
  drift: Array<{ kind: string; sample: string }>;
}

/** Activity types from the web client's renderer (2026-11-20 deployment). */
export const KNOWN_ACTIVITY_TYPES: ReadonlySet<string> = new Set([
  "block-edited",
  "top-level-block-created",
  "top-level-block-deleted",
  "page-locked",
  "page-unlocked",
  "page-deleted",
  "page-restored",
  "page-permanently-deleted",
  "collection-row-created",
  "collection-row-deleted",
  "collection-edited",
  "collection-property-edited",
  "collection-view-edited",
  "collection-page-layout-edited",
  "permissions-edited",
  "transcript-deleted",
  "commented",
]);

export const KNOWN_EDIT_TYPES: ReadonlySet<string> = new Set([
  ...KNOWN_ACTIVITY_TYPES,
  "block-created",
  "block-changed",
  "block-deleted",
  "comment-created",
  "comment-changed",
  "comment-deleted",
  "collection-created",
  "collection-changed",
  "collection-property-created",
  "collection-property-changed",
  "collection-property-deleted",
  "collection-view-created",
  "collection-view-changed",
  "collection-view-deleted",
]);

const PAGE_TYPES = new Set(["page"]);
const DATABASE_BLOCK_TYPES = new Set(["collection_view", "collection_view_page"]);
/** A child page whose block was created this long before the edit was moved in, not created. */
const MOVED_IN_AGE_MS = 60_000;
/** A page's first title, written right after it was created, is part of the creation. */
const INITIAL_TITLE_WINDOW_MS = 120_000;

/** `<activityId>|<editType>|<target>|<timestamp>`, the de-duplication unit (spec §8.1). */
export function editKey(activity: Activity, edit: ActivityEdit): string {
  const target =
    edit.block_id ??
    edit.comment_id ??
    edit.collection_row_id ??
    edit.collection_property_id ??
    edit.collection_view_id ??
    edit.top_level_block_id ??
    edit.navigable_block_id ??
    edit.collection_id ??
    activity.navigable_block_id ??
    activity.collection_id ??
    "";
  return `${activity.id}|${edit.type}|${target}|${edit.timestamp ?? ""}`;
}

/** Event ID: SHA-256 of the sorted edit keys joined by "\n", first 16 bytes as a UUID. */
export function eventId(editKeys: readonly string[]): string {
  const hex = createHash("sha256").update([...editKeys].sort().join("\n")).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** Records the mapping needs: entities (for `role` and parents), their parents' data sources, discussions. */
export function recordsToLoad(activities: readonly Activity[], spaceId: string): RecordPointer[] {
  const out = new Map<string, RecordPointer>();
  const add = (table: string, id: string | undefined) => {
    if (id) out.set(`${table}:${id}`, { table, id, spaceId });
  };
  for (const a of activities) {
    add("block", a.navigable_block_id);
    add("block", a.top_level_block_id);
    add("block", a.collection_row_id);
    add("collection", a.collection_id);
    for (const e of a.edits ?? []) {
      add("block", e.block_id);
      add("block", e.collection_row_id);
      add("block", e.top_level_block_id);
      add("collection", e.collection_id);
      add("discussion", e.discussion_id);
    }
  }
  return [...out.values()];
}

interface Draft {
  type: EventType;
  entity: { id: string; type: EntityType };
  /** Record that decides access. */
  access: { table: string; id: string };
  parent?: EventParent;
  parentFrom?: { table: string; id: string };
  editKeys: string[];
  edits: ActivityEdit[];
  activityId: string;
  authors: Map<string, "person" | "bot">;
  lastTs: number;
  blocks: Map<string, UpdatedBlock>;
  props: Map<string, UpdatedProperty>;
  propIds: Set<string>;
  extra: Record<string, unknown>;
  /** Every edit so far was made by this SDK instance. */
  thisClient: boolean;
}

function blockOf(edit: ActivityEdit): BlockValue | undefined {
  const d = edit.block_data;
  return d?.after?.block_value ?? d?.block_value ?? d?.before?.block_value;
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function normalizeActivities(input: NormalizeInput): NormalizeResult {
  const drafts = new Map<string, Draft>();
  const editKeys: string[] = [];
  const drift: NormalizeResult["drift"] = [];
  const driftSeen = new Set<string>();
  const report = (kind: string, sample: unknown) => {
    if (driftSeen.has(kind)) return;
    driftSeen.add(kind);
    drift.push({ kind, sample: JSON.stringify(sample).slice(0, 200) });
  };
  const isSeen = input.isSeen ?? (() => false);

  // Initial schema and views come with a new data source; database.created covers them.
  const createdCollections = new Set<string>();
  for (const a of input.activities) {
    for (const e of a.edits ?? []) if (e.type === "collection-created" && (e.collection_id ?? a.collection_id)) createdCollections.add((e.collection_id ?? a.collection_id)!);
  }

  const draft = (type: EventType, entity: Draft["entity"], access: Draft["access"], activity: Activity, key: string, edit: ActivityEdit): Draft => {
    // The SDK's own edits form their own event, so the account's other edits are never hidden
    // behind them (and are never mixed into a this_client event).
    const mine = (edit.authors ?? []).length > 0 && (edit.authors ?? []).every((a) => a.id === input.selfUserId) && (input.isThisClient?.(activity, edit) ?? false);
    const k = `${type}|${entity.id}|${mine ? "this" : "other"}`;
    let d = drafts.get(k);
    if (!d) {
      d = { type, entity, access, editKeys: [], edits: [], activityId: activity.id, authors: new Map(), lastTs: 0, blocks: new Map(), props: new Map(), propIds: new Set(), extra: {}, thisClient: mine };
      drafts.set(k, d);
    }
    d.editKeys.push(key);
    d.edits.push(edit);
    for (const a of edit.authors ?? []) d.authors.set(a.id, a.table === "bot" ? "bot" : "person");
    const ts = Number(edit.timestamp ?? 0);
    if (ts >= d.lastTs) {
      d.lastTs = ts;
      d.activityId = activity.id;
    }
    return d;
  };

  for (const activity of input.activities) {
    if (!KNOWN_ACTIVITY_TYPES.has(activity.type)) {
      report(`activity.${activity.type}`, { type: activity.type, edits: (activity.edits ?? []).map((e) => e.type) });
      continue;
    }
    const fresh: Array<{ edit: ActivityEdit; key: string }> = [];
    for (const edit of activity.edits ?? []) {
      if (!KNOWN_EDIT_TYPES.has(edit.type)) {
        report(`edit.${edit.type}`, { activity: activity.type, type: edit.type });
        continue;
      }
      const key = editKey(activity, edit);
      if (isSeen(key)) continue;
      fresh.push({ edit, key });
      editKeys.push(key);
    }
    // A block created and deleted within the same unread stretch of an activity cancels out.
    const created = new Set(fresh.filter((f) => f.edit.type === "block-created").map((f) => f.edit.block_id));
    const cancelled = new Set(fresh.filter((f) => f.edit.type === "block-deleted" && created.has(f.edit.block_id)).map((f) => f.edit.block_id));

    const nav = activity.navigable_block_id;
    for (const { edit, key } of fresh) {
      if (edit.block_id && cancelled.has(edit.block_id)) continue;
      const ts = Number(edit.timestamp ?? 0);
      switch (edit.type) {
        case "block-created":
        case "block-changed":
        case "block-deleted": {
          if (!nav || !edit.block_id) break;
          const block = blockOf(edit);
          if (edit.block_id === nav) {
            if (edit.type !== "block-changed") break; // the page's own creation or removal has its own events
            const before = edit.block_data?.before?.block_value;
            const after = edit.block_data?.after?.block_value;
            if (!before || !after) break;
            if (before.parent_id !== after.parent_id || before.parent_table !== after.parent_table) {
              draft("page.moved", { id: nav, type: "page" }, { table: "block", id: nav }, activity, key, edit);
              break;
            }
            if (!same(before.properties, after.properties)) {
              // The first title, written right after creation, belongs to page.created. The edit
              // spans the whole merged window, so other properties set since still count.
              const initial = before.properties === undefined && ts - Number(after.created_time ?? 0) < INITIAL_TITLE_WINDOW_MS;
              const keys = new Set([...Object.keys(before.properties ?? {}), ...Object.keys(after.properties ?? {})]);
              const changed = [...keys].filter((p) => !same(before.properties?.[p], after.properties?.[p]) && !(initial && p === "title"));
              if (changed.length === 0) break;
              const d = draft("page.properties_updated", { id: nav, type: "page" }, { table: "block", id: nav }, activity, key, edit);
              for (const p of changed) d.propIds.add(p);
            }
            break;
          }
          const type = block?.type ?? "";
          if (PAGE_TYPES.has(type) || DATABASE_BLOCK_TYPES.has(type)) {
            if (edit.type !== "block-created") break; // a child page's own activity reports its changes
            const isDb = DATABASE_BLOCK_TYPES.has(type);
            const movedIn = Number(block?.created_time ?? ts) < ts - MOVED_IN_AGE_MS;
            const evType: EventType = movedIn ? "page.moved" : isDb ? "database.created" : "page.created";
            const d = draft(evType, { id: edit.block_id, type: isDb ? "database" : "page" }, { table: "block", id: edit.block_id }, activity, key, edit);
            d.parent = { type: "page", id: nav };
            break;
          }
          const d = draft("page.content_updated", { id: nav, type: "page" }, { table: "block", id: nav }, activity, key, edit);
          d.blocks.set(edit.block_id, { id: edit.block_id, type: "block" });
          break;
        }
        case "page-locked":
        case "page-unlocked":
        case "page-deleted":
        case "page-restored": {
          const id = edit.navigable_block_id ?? nav;
          if (!id) break;
          const type = ({ "page-locked": "page.locked", "page-unlocked": "page.unlocked", "page-deleted": "page.deleted", "page-restored": "page.undeleted" } as const)[edit.type];
          draft(type, { id, type: "page" }, { table: "block", id }, activity, key, edit);
          break;
        }
        case "top-level-block-created": {
          const id = edit.top_level_block_id ?? activity.top_level_block_id;
          if (id) draft("page.created", { id, type: "page" }, { table: "block", id }, activity, key, edit);
          break;
        }
        case "comment-created":
        case "comment-changed":
        case "comment-deleted": {
          const page = edit.navigable_block_id ?? nav;
          if (!edit.comment_id || !page) break;
          const type = ({ "comment-created": "comment.created", "comment-changed": "comment.updated", "comment-deleted": "comment.deleted" } as const)[edit.type];
          const d = draft(type, { id: edit.comment_id, type: "comment" }, { table: "block", id: page }, activity, key, edit);
          d.extra.page_id = page;
          if (edit.discussion_id) {
            d.extra.discussion_id = edit.discussion_id;
            d.parentFrom = { table: "discussion", id: edit.discussion_id };
          }
          break;
        }
        case "collection-row-created":
        case "collection-row-deleted": {
          const row = edit.collection_row_id ?? activity.collection_row_id;
          const col = edit.collection_id ?? activity.collection_id;
          if (!row || !col) break;
          if (edit.type === "collection-row-created") {
            const p = draft("page.created", { id: row, type: "page" }, { table: "block", id: row }, activity, key, edit);
            p.parentFrom = { table: "collection", id: col };
          }
          const d = draft("data_source.content_updated", { id: col, type: "data_source" }, { table: "collection", id: col }, activity, key, edit);
          d.blocks.set(row, { id: row, type: "page" });
          break;
        }
        case "collection-property-created":
        case "collection-property-changed":
        case "collection-property-deleted": {
          const col = edit.collection_id ?? activity.collection_id;
          const prop = edit.collection_property_id;
          if (!col || !prop || createdCollections.has(col)) break;
          const action = ({ "collection-property-created": "created", "collection-property-changed": "updated", "collection-property-deleted": "deleted" } as const)[edit.type];
          const d = draft("data_source.schema_updated", { id: col, type: "data_source" }, { table: "collection", id: col }, activity, key, edit);
          const prev = d.props.get(prop);
          const name = edit.collection_property_data?.name;
          d.props.set(prop, { id: prop, ...(name ? { name } : prev?.name ? { name: prev.name } : {}), action: prev?.action === "created" && action !== "deleted" ? "created" : action });
          break;
        }
        case "collection-view-created":
        case "collection-view-changed":
        case "collection-view-deleted": {
          const view = edit.collection_view_id ?? activity.collection_view_id;
          const col = edit.collection_id ?? activity.collection_id;
          const db = edit.navigable_block_id ?? nav;
          if (!view || !db || (col && createdCollections.has(col))) break;
          const type = ({ "collection-view-created": "view.created", "collection-view-changed": "view.updated", "collection-view-deleted": "view.deleted" } as const)[edit.type];
          const d = draft(type, { id: view, type: "view" }, { table: "block", id: db }, activity, key, edit);
          d.parent = { type: "database", id: db };
          if (col) d.extra.data_source_id = col;
          break;
        }
        default:
          // Known but not mapped in v0.1 (collection-created, permissions, layout, transcript,
          // permanent deletion): consumed without an event.
          break;
      }
    }
  }

  const events: NotionEvent[] = [];
  const noAccess: NormalizeResult["noAccess"] = [];
  for (const d of drafts.values()) {
    const rec = input.records(d.access.table, d.access.id);
    if (!rec || !rec.role || rec.role === "none") {
      if (!noAccess.some((x) => x.table === d.access.table && x.id === d.access.id)) noAccess.push(d.access);
      continue;
    }
    if (d.type === "page.properties_updated" && d.propIds.size === 0) continue;
    const parent = d.parent ?? resolveParent(d, input.records);
    const data = buildData(d, parent);
    const authors = [...d.authors].map(([id, type]) => ({ id, type }));
    const self = authors.length > 0 && authors.every((a) => a.id === input.selfUserId);
    const origin = !self ? "other_user" : d.thisClient ? "this_client" : "self_other_client";
    const web: NotionEvent["web"] = { activityId: d.activityId, edits: d.edits.length };
    if (d.edits.length === 1) {
      const only = d.edits[0]!;
      const b = only.block_data;
      if (b?.before || b?.after) {
        web.before = b.before?.block_value;
        web.after = b.after?.block_value;
      } else if (b?.block_value) {
        web.after = b.block_value;
      } else if (only.comment_data) {
        web.after = only.comment_data;
      }
    }
    events.push({
      id: eventId(d.editKeys),
      type: d.type,
      timestamp: new Date(d.lastTs).toISOString(),
      workspaceId: input.workspaceId,
      entity: d.entity,
      authors,
      data,
      origin,
      delivery: input.delivery ?? "live",
      web,
    } as NotionEvent);
  }
  events.sort((a, b) => (a.timestamp === b.timestamp ? (a.id < b.id ? -1 : 1) : a.timestamp < b.timestamp ? -1 : 1));
  return { events, editKeys, noAccess, drift };
}

function buildData(d: Draft, parent: EventParent | undefined): NotionEvent["data"] {
  const base: Record<string, unknown> = {};
  if (d.type.startsWith("comment.")) base.page_id = d.extra.page_id;
  if (parent) base.parent = parent;
  if (d.extra.discussion_id) base.discussion_id = d.extra.discussion_id;
  if (d.extra.data_source_id) base.data_source_id = d.extra.data_source_id;
  switch (d.type) {
    case "page.content_updated":
    case "data_source.content_updated":
      base.updated_blocks = [...d.blocks.values()];
      break;
    case "page.properties_updated":
      base.updated_properties = [...d.propIds].sort();
      break;
    case "data_source.schema_updated":
      base.updated_properties = [...d.props.values()];
      break;
  }
  return base as NotionEvent["data"];
}

/** Parent of the event's entity from the loaded records (`parent_table` / `parent_id`). */
function resolveParent(d: Draft, records: RecordLookup): EventParent | undefined {
  if (d.parentFrom?.table === "discussion") {
    const disc = records("discussion", d.parentFrom.id)?.value;
    const page = d.extra.page_id as string;
    const on = disc?.parent_id as string | undefined;
    return on && on !== page ? { type: "block", id: on } : { type: "page", id: page };
  }
  if (d.parentFrom?.table === "collection") return collectionParent(d.parentFrom.id, records);
  if (d.entity.type === "data_source") {
    const col = records("collection", d.entity.id)?.value;
    if (col?.parent_table === "block" && typeof col.parent_id === "string") return { type: "database", id: col.parent_id };
    return undefined;
  }
  const rec = records("block", d.entity.id)?.value;
  if (!rec) return undefined;
  return parentOf(rec, records);
}

function collectionParent(collectionId: string, records: RecordLookup): EventParent {
  const col = records("collection", collectionId)?.value;
  const db = col?.parent_table === "block" && typeof col.parent_id === "string" ? col.parent_id : collectionId;
  return { type: "database", id: db, data_source_id: collectionId };
}

export function parentOf(rec: Record<string, unknown>, records: RecordLookup): EventParent | undefined {
  const id = rec.parent_id;
  if (typeof id !== "string") return undefined;
  switch (rec.parent_table) {
    case "collection":
      return collectionParent(id, records);
    case "space":
      return { type: "space", id };
    case "team":
      return { type: "team", id };
    case "block": {
      const parent = records("block", id)?.value;
      const t = parent?.type as string | undefined;
      if (t && DATABASE_BLOCK_TYPES.has(t)) return { type: "database", id };
      return { type: t === undefined || PAGE_TYPES.has(t) ? "page" : "block", id };
    }
    default:
      return undefined;
  }
}
