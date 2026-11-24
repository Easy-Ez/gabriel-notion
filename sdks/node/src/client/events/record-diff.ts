import { eventId } from "./normalize.js";
import type { NotionEvent, UpdatedProperty } from "./types.js";

/**
 * Changes that open no activity (spec §8.2): comment edits and deletions, view edits, and
 * data source property renames. They are found by comparing two versions of the record that a
 * `versions/<id>:<table>` signal announced.
 */

export type RecordDiffTable = "comment" | "collection_view" | "collection";

export interface RecordDiffInput {
  table: RecordDiffTable;
  id: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  workspaceId: string;
  selfUserId?: string;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Fields of a view whose change is a `view.updated`. */
const VIEW_FIELDS = ["name", "type", "format", "query2", "page_sort", "parent_id", "alive"];

export function diffRecord(input: RecordDiffInput): NotionEvent | undefined {
  const { table, id, before, after } = input;
  if (Number(after.version ?? 0) <= Number(before.version ?? 0)) return undefined;
  const editor = (after.last_edited_by_id as string | undefined) ?? undefined;
  const authors = editor ? [{ id: editor, type: (after.last_edited_by_table === "bot" ? "bot" : "person") as "person" | "bot" }] : [];
  const ts = Number(after.last_edited_time ?? 0) || Date.now();
  const base = {
    id: eventId([`record|${table}|${id}|${after.version}`]),
    timestamp: new Date(ts).toISOString(),
    workspaceId: input.workspaceId,
    authors,
    origin: (editor && editor === input.selfUserId ? "self_other_client" : "other_user") as NotionEvent["origin"],
    delivery: "live" as const,
    web: { before, after },
  };

  if (table === "comment") {
    const discussion = typeof after.parent_id === "string" ? after.parent_id : undefined;
    const data = discussion ? { discussion_id: discussion } : {};
    if (before.alive !== false && after.alive === false) return { ...base, type: "comment.deleted", entity: { id, type: "comment" }, data } as NotionEvent;
    if (after.alive !== false && !same(before.text, after.text)) return { ...base, type: "comment.updated", entity: { id, type: "comment" }, data } as NotionEvent;
    return undefined;
  }

  if (table === "collection_view") {
    if (before.alive === false || after.alive === false) return undefined; // creation and deletion come from the activity
    if (!VIEW_FIELDS.some((f) => !same(before[f], after[f]))) return undefined;
    const parent = typeof after.parent_id === "string" ? { type: "database" as const, id: after.parent_id } : undefined;
    return { ...base, type: "view.updated", entity: { id, type: "view" }, data: parent ? { parent } : {} } as NotionEvent;
  }

  // collection: renamed or retyped properties. Created and deleted ones come from the activity.
  const bs = (before.schema ?? {}) as Record<string, { name?: string; type?: string; alive?: boolean }>;
  const as = (after.schema ?? {}) as Record<string, { name?: string; type?: string; alive?: boolean }>;
  const updated: UpdatedProperty[] = [];
  for (const [pid, p] of Object.entries(as)) {
    const q = bs[pid];
    if (!q || q.alive === false || p.alive === false) continue;
    if (q.name !== p.name || q.type !== p.type) updated.push({ id: pid, ...(p.name ? { name: p.name } : {}), action: "updated" });
  }
  if (updated.length === 0) return undefined;
  const parent = after.parent_table === "block" && typeof after.parent_id === "string" ? { type: "database" as const, id: after.parent_id } : undefined;
  return { ...base, type: "data_source.schema_updated", entity: { id, type: "data_source" }, data: { ...(parent ? { parent } : {}), updated_properties: updated } } as NotionEvent;
}
