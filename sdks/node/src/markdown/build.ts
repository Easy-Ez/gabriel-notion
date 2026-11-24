import type { BlockRecord, BlockSpec, CollectionRecord } from "./model.js";

export interface BuiltRecords {
  /** Records for the specs, keyed by ID, children linked through `content`. */
  blocks: Map<string, BlockRecord>;
  collections: Map<string, CollectionRecord>;
  /** Top-level block IDs, in order. */
  topLevel: string[];
}

/**
 * Turns parsed specs into block records under `parentId`. A spec keeps the ID its Markdown
 * named (`ref.id`); others get `newId()`. This is the shape S6 writes with transactions; here it
 * also lets the renderer read parsed Markdown back for round-trip checks.
 */
export function specsToRecords(specs: readonly BlockSpec[], parentId: string, newId: () => string): BuiltRecords {
  const blocks = new Map<string, BlockRecord>();
  const collections = new Map<string, CollectionRecord>();

  const build = (spec: BlockSpec, parent: string): string => {
    const id = spec.ref?.id ?? newId();
    const rec: BlockRecord = { id, type: spec.type, parent_id: parent, parent_table: "block", alive: true };
    const properties: Record<string, unknown> = { ...(spec.properties ?? {}) };
    if (spec.title) properties.title = spec.title;
    if (Object.keys(properties).length) rec.properties = properties;
    if (spec.format) rec.format = { ...spec.format };
    if (spec.type === "collection_view" || spec.type === "collection_view_page") {
      const collId = spec.ref?.collectionId ?? newId();
      rec.collection_id = collId;
      collections.set(collId, { id: collId, ...(spec.title ? { name: spec.title } : {}) });
      delete rec.properties;
    }
    blocks.set(id, rec);
    if (spec.children?.length) rec.content = spec.children.map((c) => build(c, id));
    return id;
  };

  const topLevel = specs.map((s) => build(s, parentId));
  return { blocks, collections, topLevel };
}
