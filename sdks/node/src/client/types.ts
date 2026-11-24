import type { BlockRecord, DateValue, RichText } from "../markdown/model.js";
import type { PropertySchema, PropertyValue } from "./properties.js";

export interface User {
  id: string;
  name?: string;
  email?: string;
  /** "member" or "guest" when the source says so. */
  type?: string;
}

export interface Workspace {
  id: string;
  name: string;
}

export interface Page<T> {
  results: T[];
  hasMore: boolean;
  nextCursor?: string;
}

export interface Parent {
  type: "page" | "block" | "database" | "teamspace" | "workspace";
  id: string;
}

export interface PageMeta {
  id: string;
  url: string;
  title: string;
  parent?: Parent;
  icon?: string;
  cover?: string;
  locked: boolean;
  createdTime?: string;
  lastEditedTime?: string;
  createdBy?: string;
  lastEditedBy?: string;
}

export interface Block extends BlockRecord {
  children?: Block[];
}

export interface PageResult {
  page: PageMeta;
  /** Decoded values when the page is a database row; empty otherwise. */
  properties: Record<string, PropertyValue>;
  markdown?: string;
  blocks?: Block[];
  /** Blocks of a type the Markdown renderer does not support (left out of `markdown`). */
  unknownBlockIds: string[];
}

export interface SearchHit {
  id: string;
  title: string;
  type: string;
  url: string;
  parent?: Parent;
  lastEditedTime?: string;
  /** Matching excerpt, when the server returned one. */
  highlight?: string;
}

export interface DatabaseMeta {
  /** The block that holds the database (`collection_view_page` or inline `collection_view`). */
  id: string;
  /** The data source (`collection`) ID. */
  dataSourceId: string;
  title: string;
  url: string;
  inline: boolean;
}

export interface ViewMeta {
  id: string;
  type: string;
  name: string;
}

export interface Row extends PageMeta {
  properties: Record<string, PropertyValue>;
}

/**
 * A filter in the web client's loader format, except that `property` may be a property name;
 * it is resolved to the schema ID. Leaves must sit inside a group.
 */
export type Filter =
  | { operator: "and" | "or"; filters: Filter[] }
  | { property: string; filter: { operator: string; value?: unknown } };

export interface Sort {
  property: string;
  direction: "ascending" | "descending";
}

export interface Comment {
  id: string;
  discussionId: string;
  authorId?: string;
  createdTime?: string;
  lastEditedTime?: string;
  markdown: string;
  text: RichText;
}

export interface Discussion {
  id: string;
  /** The block the discussion is attached to (the page itself for page-level comments). */
  blockId: string;
  resolved: boolean;
  /** The selected text an inline comment refers to. */
  context?: string;
  comments: Comment[];
}

export type { DateValue, PropertySchema, PropertyValue };
