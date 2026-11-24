import type { NotionCore } from "../core/core.js";
import type { BlockRecord, CollectionRecord, RecordSource, UserRecord } from "../markdown/model.js";

/** Child pages and databases are boundaries: their content belongs to them, not to the page. */
const BOUNDARY = new Set(["page", "collection_view", "collection_view_page"]);

/**
 * A record cache for one read: blocks of a page subtree plus the users, pages and data sources
 * its Markdown refers to. Implements the renderer's `RecordSource`.
 */
export class RecordCache implements RecordSource {
  readonly blocks = new Map<string, BlockRecord>();
  readonly users = new Map<string, UserRecord>();
  readonly collections = new Map<string, CollectionRecord>();

  constructor(private readonly core: NotionCore) {}

  block(id: string): BlockRecord | undefined {
    return this.blocks.get(id);
  }
  user(id: string): UserRecord | undefined {
    return this.users.get(id);
  }
  collection(id: string): CollectionRecord | undefined {
    return this.collections.get(id);
  }

  async loadBlocks(ids: readonly string[], signal?: AbortSignal): Promise<void> {
    const want = [...new Set(ids)].filter((id) => !this.blocks.has(id));
    if (!want.length) return;
    const map = await this.core.getRecords<BlockRecord>(want.map((id) => ({ table: "block", id })), signal);
    for (const id of want) {
      const v = map.get(`block:${id}`)?.value;
      if (v) this.blocks.set(id, { ...v, id });
    }
  }

  async loadUsers(ids: readonly string[], signal?: AbortSignal): Promise<void> {
    const want = [...new Set(ids)].filter((id) => !this.users.has(id));
    if (!want.length) return;
    const map = await this.core.getRecords<UserRecord>(want.map((id) => ({ table: "notion_user", id })), signal);
    for (const id of want) {
      const v = map.get(`notion_user:${id}`)?.value;
      if (v) this.users.set(id, { id, ...(v.name ? { name: v.name } : {}), ...(v.email ? { email: v.email } : {}) });
    }
  }

  async loadCollections(ids: readonly string[], signal?: AbortSignal): Promise<void> {
    const want = [...new Set(ids)].filter((id) => !this.collections.has(id));
    if (!want.length) return;
    const map = await this.core.getRecords<CollectionRecord & Record<string, unknown>>(want.map((id) => ({ table: "collection", id })), signal);
    for (const id of want) {
      const v = map.get(`collection:${id}`)?.value;
      if (v) this.collections.set(id, { ...v, id });
    }
  }

  /**
   * Reads the whole subtree under `rootId`, level by level, following `content` until no
   * unread ID is left. Child pages and databases are read
   * as single blocks; their own content is not.
   */
  async loadSubtree(rootId: string, signal?: AbortSignal): Promise<void> {
    let level = [rootId];
    const seen = new Set<string>();
    while (level.length) {
      await this.loadBlocks(level, signal);
      const next: string[] = [];
      for (const id of level) {
        if (seen.has(id)) continue;
        seen.add(id);
        const b = this.blocks.get(id);
        if (!b || b.alive === false) continue;
        if (id !== rootId && BOUNDARY.has(b.type)) continue;
        for (const child of b.content ?? []) if (!seen.has(child)) next.push(child);
      }
      level = next;
    }
  }
}
