import type { Annotation, BlockRecord, DateValue, RichText } from "../markdown/model.js";
import { plainText } from "../markdown/inline-render.js";

/** One entry of a data source's `schema`. */
export interface PropertySchema {
  name: string;
  type: string;
  options?: Array<{ id?: string; value: string; color?: string }>;
  [key: string]: unknown;
}

export type PropertyValue =
  | { id: string; type: "title" | "text" | "url" | "email" | "phone_number"; value: string }
  | { id: string; type: "number"; value: number | null }
  | { id: string; type: "select" | "status"; value: string | null }
  | { id: string; type: "multi_select"; value: string[] }
  | { id: string; type: "checkbox"; value: boolean }
  | { id: string; type: "date"; value: DateValue | null }
  | { id: string; type: "person"; value: string[] }
  | { id: string; type: "relation"; value: string[] }
  | { id: string; type: "file"; value: Array<{ name: string; source: string }> }
  | { id: string; type: "created_time" | "last_edited_time"; value: string | null }
  | { id: string; type: "created_by" | "last_edited_by"; value: string | null }
  | { id: string; type: "formula" | "rollup"; value: number | null; computed: boolean }
  | { id: string; type: string; value: unknown };

const anns = (text: RichText | undefined): Annotation[] => (text ?? []).flatMap((s) => s[1] ?? []);

/**
 * Decodes a row's stored property values by schema.
 * Formula and rollup values are not stored with the row; they come back as `null` with
 * `computed: false` unless the caller fills them (numeric formulas via aggregation).
 */
export function decodeProperties(row: BlockRecord, schema: Record<string, PropertySchema>): Record<string, PropertyValue> {
  const out: Record<string, PropertyValue> = {};
  const props = (row.properties ?? {}) as Record<string, RichText | undefined>;
  const rec = row as BlockRecord & { created_time?: number; last_edited_time?: number; created_by_id?: string; last_edited_by_id?: string };
  for (const [id, def] of Object.entries(schema)) {
    const raw = props[id];
    const text = plainText(raw);
    let value: PropertyValue;
    switch (def.type) {
      case "title":
      case "text":
      case "url":
      case "email":
      case "phone_number":
        value = { id, type: def.type, value: text };
        break;
      case "number": {
        const n = text.trim() === "" ? null : Number(text);
        value = { id, type: "number", value: n !== null && Number.isFinite(n) ? n : null };
        break;
      }
      case "select":
      case "status":
        value = { id, type: def.type, value: text === "" ? null : text };
        break;
      case "multi_select":
        value = { id, type: "multi_select", value: text === "" ? [] : text.split(",").map((s) => s.trim()).filter(Boolean) };
        break;
      case "checkbox":
        value = { id, type: "checkbox", value: text === "Yes" };
        break;
      case "date": {
        const d = anns(raw).find((a) => a[0] === "d");
        value = { id, type: "date", value: d ? (d[1] as DateValue) : null };
        break;
      }
      case "person":
        value = { id, type: "person", value: anns(raw).filter((a) => a[0] === "u").map((a) => String(a[1])) };
        break;
      case "relation":
        value = { id, type: "relation", value: anns(raw).filter((a) => a[0] === "p").map((a) => String(a[1])) };
        break;
      case "file":
        value = {
          id,
          type: "file",
          value: (raw ?? []).map((seg) => ({ name: seg[0], source: String((seg[1] ?? []).find((a) => a[0] === "a")?.[1] ?? "") })),
        };
        break;
      case "created_time":
        value = { id, type: "created_time", value: rec.created_time ? new Date(rec.created_time).toISOString() : null };
        break;
      case "last_edited_time":
        value = { id, type: "last_edited_time", value: rec.last_edited_time ? new Date(rec.last_edited_time).toISOString() : null };
        break;
      case "created_by":
        value = { id, type: "created_by", value: rec.created_by_id ?? null };
        break;
      case "last_edited_by":
        value = { id, type: "last_edited_by", value: rec.last_edited_by_id ?? null };
        break;
      case "formula":
      case "rollup":
        value = { id, type: def.type, value: null, computed: false };
        break;
      default:
        value = { id, type: def.type, value: raw ?? null };
    }
    out[def.name] = value;
  }
  return out;
}

/** Resolves a property given by name or ID to its schema ID. */
export function propertyId(schema: Record<string, PropertySchema>, nameOrId: string): string | undefined {
  if (schema[nameOrId]) return nameOrId;
  return Object.entries(schema).find(([, def]) => def.name === nameOrId)?.[0];
}
