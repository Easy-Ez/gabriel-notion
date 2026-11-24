/**
 * Shapes shared by the Markdown renderer and parser.
 *
 * Rich text is the web client's segment array: `[[text, annotations?], ...]`, where each
 * annotation is `[code, ...args]`.
 */
export type Annotation =
  | ["b"]
  | ["i"]
  | ["s"]
  | ["_"]
  | ["c"]
  | ["a", string]
  | ["h", string]
  | ["u", string]
  | ["p", string, string?]
  | ["d", DateValue]
  | ["e", string]
  | ["m", string]
  | [string, ...unknown[]];

export type Segment = [string] | [string, Annotation[]];
export type RichText = Segment[];

export interface DateValue {
  type: "date" | "daterange" | "datetime" | "datetimerange";
  start_date: string;
  end_date?: string;
  start_time?: string;
  end_time?: string;
  time_zone?: string;
}

/** The fields of a `block` record the codec reads or writes. */
export interface BlockRecord {
  id: string;
  type: string;
  properties?: Record<string, unknown>;
  format?: Record<string, unknown>;
  content?: string[];
  parent_id?: string;
  parent_table?: string;
  collection_id?: string;
  alive?: boolean;
}

export interface UserRecord {
  id: string;
  name?: string;
  email?: string;
}

export interface CollectionRecord {
  id: string;
  name?: RichText;
}

/** Record lookups the renderer needs; missing records are reported, not fetched. */
export interface RecordSource {
  block(id: string): BlockRecord | undefined;
  user(id: string): UserRecord | undefined;
  collection(id: string): CollectionRecord | undefined;
}

/**
 * A block parsed from Markdown, before it has an ID. S6 turns these into transactions.
 * `ref` carries IDs the Markdown already names (an existing subpage, database, synced block,
 * file block, or the block a discussion anchor sits on) so edits can keep them.
 */
export interface BlockSpec {
  type: string;
  title?: RichText;
  properties?: Record<string, unknown>;
  format?: Record<string, unknown>;
  children?: BlockSpec[];
  ref?: { id?: string; url?: string; collectionId?: string; fileId?: string; spaceId?: string };
}

export const APP_ORIGIN = "https://app.notion.com";

export const compactId = (id: string): string => id.replace(/-/g, "");
export const pageUrl = (id: string): string => `${APP_ORIGIN}/p/${compactId(id)}`;
