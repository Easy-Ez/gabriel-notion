/**
 * Change events (spec §8). Type names match the official Notion webhooks; Web-only
 * detail lives under `web`.
 */
export const EVENT_TYPES = [
  "page.created",
  "page.content_updated",
  "page.properties_updated",
  "page.moved",
  "page.deleted",
  "page.undeleted",
  "page.locked",
  "page.unlocked",
  "database.created",
  "data_source.schema_updated",
  "data_source.content_updated",
  "comment.created",
  "comment.updated",
  "comment.deleted",
  "view.created",
  "view.updated",
  "view.deleted",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export type EntityType = "page" | "block" | "database" | "data_source" | "view" | "comment";

/** Where an entity lives. `space` is the workspace root, `team` a teamspace root. */
export interface EventParent {
  type: "page" | "block" | "database" | "space" | "team";
  id: string;
  /** For database rows: the data source (collection) the row belongs to. */
  data_source_id?: string;
}

export interface UpdatedBlock {
  id: string;
  type: "block" | "page";
}

export interface UpdatedProperty {
  id: string;
  name?: string;
  action: "created" | "updated" | "deleted";
}

export interface EventDataMap {
  "page.created": { parent?: EventParent };
  "page.content_updated": { parent?: EventParent; updated_blocks: UpdatedBlock[] };
  "page.properties_updated": { parent?: EventParent; updated_properties: string[] };
  "page.moved": { parent?: EventParent };
  "page.deleted": { parent?: EventParent };
  "page.undeleted": { parent?: EventParent };
  "page.locked": { parent?: EventParent };
  "page.unlocked": { parent?: EventParent };
  "database.created": { parent?: EventParent };
  "data_source.schema_updated": { parent?: EventParent; updated_properties: UpdatedProperty[] };
  "data_source.content_updated": { parent?: EventParent; updated_blocks: UpdatedBlock[] };
  "comment.created": { page_id: string; parent?: EventParent; discussion_id?: string };
  "comment.updated": { page_id?: string; parent?: EventParent; discussion_id?: string };
  "comment.deleted": { page_id?: string; parent?: EventParent; discussion_id?: string };
  "view.created": { parent?: EventParent; data_source_id?: string };
  "view.updated": { parent?: EventParent; data_source_id?: string };
  "view.deleted": { parent?: EventParent; data_source_id?: string };
}

export type EventData<T extends EventType> = EventDataMap[T];

export type EventOrigin = "this_client" | "self_other_client" | "other_user";

export interface NotionEvent<T extends EventType = EventType> {
  /** Stable de-duplication key derived from the edits the event covers. */
  id: string;
  type: T;
  /** Time of the (last) edit, ISO 8601. */
  timestamp: string;
  workspaceId: string;
  entity: { id: string; type: EntityType };
  authors: Array<{ id: string; type: "person" | "bot" }>;
  data: EventData<T>;
  origin: EventOrigin;
  delivery: "live" | "backfill";
  web: {
    activityId?: string;
    /** Number of activity edits folded into this event. */
    edits?: number;
    /** Record before / after, when the event covers exactly one edit that carries them. */
    before?: unknown;
    after?: unknown;
  };
}

/** Emitted once per unknown activity type, edit type or frame kind (spec §8.2). */
export interface ProtocolDriftEvent {
  kind: string;
  /** Short redacted sample; the raw data is still available from Core. */
  sample?: string;
}
