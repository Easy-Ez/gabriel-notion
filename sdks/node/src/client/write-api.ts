import type { NotionCore } from "../core/core.js";
import { normalizeId } from "../core/ids.js";
import type { Operation, RecordPointer } from "../core/records.js";
import { NotionError } from "../errors.js";
import { parseInline } from "../markdown/inline-parse.js";
import { plainText, renderRichText } from "../markdown/inline-render.js";
import type { Annotation, BlockRecord, BlockSpec, RichText, Segment } from "../markdown/model.js";
import { parseMarkdown } from "../markdown/parse.js";
import { decodeProperties, type PropertySchema } from "./properties.js";
import { RecordCache } from "./tree.js";
import type { Comment, DatabaseMeta, PageMeta, Workspace } from "./types.js";
import { editedMeta, encodeProperties, planBlocks, titleOp, type PropertyInput, type WriteContext } from "./write.js";

export interface Internals {
  core: NotionCore;
  workspace(): Promise<Workspace>;
  database(id: string): Promise<{ meta: DatabaseMeta; schema: Record<string, PropertySchema>; viewIds: string[] }>;
  pageMeta(id: string): Promise<PageMeta>;
}

export type BlockAnchor = string | { text: string };

export type ContentEdit =
  | { op: "replace_all"; markdown: string }
  | { op: "insert"; markdown: string; after?: BlockAnchor; before?: BlockAnchor }
  | { op: "update"; find: string; replace: string; all?: boolean };

export interface CreatePageOptions {
  parent: { pageId: string } | { databaseId: string } | { teamspaceId: string } | { private: true };
  title?: string;
  markdown?: string;
  properties?: Record<string, PropertyInput>;
  icon?: string;
  cover?: string;
}

/** Above this many operations a write is split into several transactions (each atomic). */
const MAX_OPS_PER_TRANSACTION = 900;
const KEEP_ON_REPLACE = new Set(["page", "collection_view", "collection_view_page"]);
const blockPtr = (id: string): RecordPointer => ({ table: "block", id });
type BlockRec = BlockRecord & { discussions?: string[] };

async function writeContext(intl: Internals): Promise<WriteContext> {
  const ws = await intl.workspace();
  const userId = intl.core.health().userId;
  if (!userId) throw new NotionError("INVALID_STATE", "no active user");
  return { spaceId: ws.id, userId, newBlockId: () => intl.core.newBlockId(), now: Date.now };
}

async function submitAll(core: NotionCore, ops: Operation[], userAction: string): Promise<void> {
  for (let i = 0; i < ops.length; i += MAX_OPS_PER_TRANSACTION) {
    await core.submit(ops.slice(i, i + MAX_OPS_PER_TRANSACTION), { userAction });
  }
}

function sameValues(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ------------------------------------------------------------------ pages.create

export async function createPage(intl: Internals, opts: CreatePageOptions): Promise<PageMeta & { warnings: string[] }> {
  const ctx = await writeContext(intl);
  const specs = parseMarkdown(opts.markdown ?? "");
  let title: RichText | undefined = opts.title !== undefined ? parseInline(opts.title).text : undefined;
  if (title === undefined && specs[0]?.type === "header") title = specs.shift()!.title;

  const page: BlockSpec = { type: "page", children: specs };
  const format: Record<string, unknown> = {};
  if (opts.icon) format.page_icon = opts.icon;
  if (opts.cover) format.page_cover = opts.cover;
  if (Object.keys(format).length) page.format = format;

  let parent: Parameters<typeof planBlocks>[2];
  let extra: Record<string, unknown> = {};
  const p = opts.parent as Record<string, unknown>;
  if (typeof p.pageId === "string") {
    const pid = normalizeId(p.pageId, "parent.pageId");
    parent = { id: pid, table: "block", listPointer: blockPtr(pid), listPath: ["content"] };
  } else if (typeof p.databaseId === "string") {
    const db = await intl.database(p.databaseId);
    parent = { id: db.meta.dataSourceId, table: "collection" };
    if (opts.properties) {
      const encoded = encodeProperties(db.schema, opts.properties, ctx.spaceId);
      if (encoded.title) {
        title = encoded.title;
        delete encoded.title;
      }
      if (Object.keys(encoded).length) page.properties = encoded;
    }
  } else if (typeof p.teamspaceId === "string") {
    const tid = normalizeId(p.teamspaceId, "parent.teamspaceId");
    parent = { id: tid, table: "team", listPointer: { table: "team", id: tid }, listPath: ["team_pages"] };
  } else if (p.private === true) {
    const spaces = await intl.core.callApi<Record<string, { space_view?: Record<string, unknown> }>>("getSpaces", {}, { spaceId: null });
    const views = Object.values(spaces?.[ctx.userId]?.space_view ?? {}).map((e) => {
      const v = (e as { value?: { value?: unknown } }).value;
      return ((v as { value?: unknown })?.value ?? v) as { id?: string; space_id?: string };
    });
    const sv = views.find((v) => v.space_id === ctx.spaceId);
    if (!sv?.id) throw new NotionError("NOT_FOUND", "no private section for this account in the workspace");
    parent = { id: ctx.spaceId, table: "space", listPointer: { table: "space_view", id: sv.id }, listPath: ["private_pages"] };
    extra = { permissions: [{ type: "user_permission", role: "editor", user_id: ctx.userId }] };
  } else {
    throw new NotionError("INVALID_ARGUMENT", "parent must be { pageId }, { databaseId }, { teamspaceId } or { private: true }");
  }
  if (opts.properties && typeof p.databaseId !== "string") {
    throw new NotionError("INVALID_ARGUMENT", "properties can only be set on database rows; use title for other pages");
  }
  if (title) page.title = title;

  const plan = planBlocks(ctx, [page], parent);
  const pageId = plan.created[0]!;
  if (Object.keys(extra).length) {
    const set = plan.operations.find((o) => o.command === "set" && o.pointer.id === pageId)!;
    Object.assign(set.args as Record<string, unknown>, extra);
  }
  await submitAll(intl.core, plan.operations, "gabriel-notion.pages.create");

  const childIds = plan.operations.filter((o) => o.pointer.id === pageId && o.command === "listAfter").map((o) => (o.args as { id: string }).id);
  await intl.core.records.verify<BlockRec>([
    {
      pointer: blockPtr(pageId),
      holds: (v) => v?.alive !== false && plainText(v?.properties?.title as RichText | undefined) === plainText(title) && childIds.every((c) => v?.content?.includes(c)),
      describe: "new page with its title and content",
    },
  ]);
  return { ...(await intl.pageMeta(pageId)), warnings: plan.warnings };
}

// ------------------------------------------------------------------ pages.updateProperties

export async function updateProperties(intl: Internals, pageId: string, input: Record<string, PropertyInput>): Promise<PageMeta> {
  const ctx = await writeContext(intl);
  const id = normalizeId(pageId, "pageId");
  const row = (await intl.core.records.get<BlockRec>({ table: "block", id })).value;
  let schema: Record<string, PropertySchema> = { title: { name: "title", type: "title" } };
  if (row.parent_table === "collection" && row.parent_id) schema = (await intl.database(row.parent_id)).schema;
  const encoded = encodeProperties(schema, input, ctx.spaceId);

  const ops: Operation[] = [];
  for (const [pid, value] of Object.entries(encoded)) {
    if (pid === "title") ops.push(titleOp(id, value));
    else ops.push({ pointer: blockPtr(id), path: ["properties"], command: "updateBlockPropertyValue", args: { primitiveOp: { command: "update", args: { [pid]: value } } } });
  }
  if (!ops.length) throw new NotionError("INVALID_ARGUMENT", "no properties to update");
  ops.push({ pointer: blockPtr(id), path: [], command: "update", args: editedMeta(ctx) });
  await intl.core.submit(ops, { userAction: "gabriel-notion.pages.updateProperties" });

  const subset = Object.fromEntries(Object.keys(encoded).map((pid) => [pid, schema[pid]!]));
  const want = decodeProperties({ id, type: "page", properties: encoded }, subset);
  await intl.core.records.verify<BlockRec>([
    {
      pointer: blockPtr(id),
      holds: (v) => !!v && sameValues(decodeProperties({ ...v, id }, subset), want),
      describe: `properties ${Object.values(subset).map((d) => d.name).join(", ")}`,
    },
  ]);
  return intl.pageMeta(id);
}

// ------------------------------------------------------------------ pages.updateContent

function resolveAnchor(cache: RecordCache, root: BlockRec, anchor: BlockAnchor, field: string): string {
  const children = (root.content ?? []).filter((c) => cache.block(c)?.alive !== false);
  if (typeof anchor === "string") {
    const id = normalizeId(anchor, field);
    if (!children.includes(id)) throw new NotionError("INVALID_ARGUMENT", `${field} is not a top-level block of this page`);
    return id;
  }
  const hits = children.filter((c) => plainText(cache.block(c)?.properties?.title as RichText | undefined).includes(anchor.text));
  if (hits.length !== 1) throw new NotionError("INVALID_ARGUMENT", `${field} text matches ${hits.length} blocks; it must match exactly one`);
  return hits[0]!;
}

/** Adds an annotation to the characters [start, end) of rich text, splitting segments as needed. */
export function annotateRange(text: RichText, start: number, end: number, ann: Annotation): RichText {
  const out: Segment[] = [];
  let pos = 0;
  for (const seg of text) {
    const s = seg[0];
    const anns = seg[1] ?? [];
    const segStart = pos;
    const segEnd = pos + s.length;
    pos = segEnd;
    const cuts = [segStart, Math.min(Math.max(start, segStart), segEnd), Math.min(Math.max(end, segStart), segEnd), segEnd];
    for (let k = 0; k < 3; k++) {
      const a = cuts[k]!;
      const b = cuts[k + 1]!;
      if (b <= a) continue;
      const piece = s.slice(a - segStart, b - segStart);
      const inRange = a >= start && b <= end;
      const pieceAnns = inRange ? [...anns, ann] : anns;
      out.push(pieceAnns.length ? [piece, pieceAnns] : [piece]);
    }
  }
  return out;
}

export async function updateContent(intl: Internals, pageId: string, edit: ContentEdit): Promise<{ changedBlockIds: string[]; warnings: string[] }> {
  const ctx = await writeContext(intl);
  const id = normalizeId(pageId, "pageId");
  const root = (await intl.core.records.get<BlockRec>({ table: "block", id })).value;
  const cache = new RecordCache(intl.core);
  cache.blocks.set(id, { ...root, id });
  await cache.loadSubtree(id);
  const content = (root.content ?? []).filter((c) => cache.block(c)?.alive !== false);
  const contentPtr = blockPtr(id);
  const ops: Operation[] = [];
  const changed: string[] = [];
  let warnings: string[] = [];
  let expectedOrder: string[] | undefined;

  if (edit.op === "replace_all") {
    const specs = parseMarkdown(edit.markdown);
    const existing = new Set(content);
    const reused = new Set(specs.map((s) => s.ref?.id).filter((r): r is string => !!r && existing.has(r)));
    for (const c of content) {
      ops.push({ pointer: contentPtr, path: ["content"], command: "listRemove", args: { id: c } });
      const b = cache.block(c)!;
      if (!KEEP_ON_REPLACE.has(b.type) && !reused.has(c)) ops.push({ pointer: blockPtr(c), path: [], command: "update", args: { alive: false, ...editedMeta(ctx) } });
    }
    let prev: string | undefined;
    const order: string[] = [];
    const place = (bid: string) => {
      ops.push({ pointer: contentPtr, path: ["content"], command: "listAfter", args: prev ? { id: bid, after: prev } : { id: bid } });
      prev = bid;
      order.push(bid);
    };
    for (const spec of specs) {
      const ref = spec.ref?.id;
      if (ref && reused.has(ref)) {
        const b = cache.block(ref)!;
        if (spec.title && b.type === spec.type && !KEEP_ON_REPLACE.has(b.type) && plainText(b.properties?.title as RichText | undefined) !== plainText(spec.title)) {
          ops.push(titleOp(ref, spec.title));
          changed.push(ref);
        }
        place(ref);
        continue;
      }
      const plan = planBlocks(ctx, [spec], { id, table: "block" });
      warnings.push(...plan.warnings);
      ops.push(...plan.operations);
      for (const bid of plan.created) {
        place(bid);
        changed.push(bid);
      }
    }
    for (const c of content) if (KEEP_ON_REPLACE.has(cache.block(c)!.type) && !reused.has(c)) place(c);
    expectedOrder = order;
  } else if (edit.op === "insert") {
    if (edit.after && edit.before) throw new NotionError("INVALID_ARGUMENT", "pass either after or before, not both");
    const parent: Parameters<typeof planBlocks>[2] = { id, table: "block", listPointer: contentPtr, listPath: ["content"] };
    if (edit.after) parent.after = resolveAnchor(cache, root, edit.after, "after");
    if (edit.before) parent.before = resolveAnchor(cache, root, edit.before, "before");
    const plan = planBlocks(ctx, parseMarkdown(edit.markdown), parent);
    ops.push(...plan.operations);
    changed.push(...plan.created);
    warnings = plan.warnings;
  } else if (edit.op === "update") {
    if (!edit.find) throw new NotionError("INVALID_ARGUMENT", "find must not be empty");
    const candidates = [...cache.blocks.values()].filter((b) => b.id !== id && b.alive !== false && Array.isArray(b.properties?.title));
    const users = candidates.flatMap((b) => (b.properties!.title as RichText).flatMap((s) => (s[1] ?? []).filter((a) => a[0] === "u").map((a) => String(a[1]))));
    await cache.loadUsers(users);
    const missing = { blocks: new Set<string>(), users: new Set<string>(), collections: new Set<string>() };
    const matches: Array<{ b: BlockRecord; source: string; count: number }> = [];
    for (const b of candidates) {
      const title = b.properties!.title as RichText;
      const source = b.type === "code" ? plainText(title) : renderRichText(title, { pageId: id, blockId: b.id, src: cache, missing });
      const count = source.split(edit.find).length - 1;
      if (count > 0) matches.push({ b, source, count });
    }
    const total = matches.reduce((n, m) => n + m.count, 0);
    if (total === 0) throw new NotionError("INVALID_ARGUMENT", "no match; find is matched within one block's Markdown, not across blocks");
    if (total > 1 && !edit.all) throw new NotionError("INVALID_ARGUMENT", `Found ${total} matches; pass all: true to replace every one`);
    for (const m of matches) {
      const next = edit.all ? m.source.split(edit.find).join(edit.replace) : m.source.replace(edit.find, () => edit.replace);
      const text: RichText = m.b.type === "code" ? [[next]] : parseInline(next).text;
      ops.push(titleOp(m.b.id, text), { pointer: blockPtr(m.b.id), path: [], command: "update", args: editedMeta(ctx) });
      changed.push(m.b.id);
    }
  }

  if (!ops.length) return { changedBlockIds: [], warnings };
  ops.push({ pointer: contentPtr, path: [], command: "update", args: editedMeta(ctx) });
  await submitAll(intl.core, ops, `gabriel-notion.pages.updateContent.${edit.op}`);

  await intl.core.records.verify<BlockRec>([
    {
      pointer: contentPtr,
      holds: (v) => {
        const now = (v?.content ?? []) as string[];
        if (expectedOrder) {
          const filtered = now.filter((c) => expectedOrder!.includes(c));
          return sameValues(filtered, expectedOrder);
        }
        return edit.op !== "insert" || changed.every((c) => now.includes(c));
      },
      describe: "page content after the edit",
    },
    ...(edit.op === "update"
      ? changed.map((bid) => ({ pointer: blockPtr(bid), holds: (v: BlockRec | undefined) => v?.alive !== false, describe: `block ${bid}` }))
      : []),
  ]);
  return { changedBlockIds: changed, warnings };
}

// ------------------------------------------------------------------ comments

export interface CreateCommentOptions {
  pageId: string;
  markdown: string;
  on?: { blockId: string } | { blockId: string; selection: string };
}

function commentArgs(ctx: WriteContext, id: string, discussionId: string, text: RichText): Record<string, unknown> {
  const now = ctx.now();
  return {
    id,
    parent_id: discussionId,
    parent_table: "discussion",
    space_id: ctx.spaceId,
    alive: true,
    created_by_id: ctx.userId,
    created_by_table: "notion_user",
    created_time: now,
    last_edited_time: now,
    text,
  };
}

function toComment(id: string, discussionId: string, text: RichText, ctx: WriteContext, pageId: string, blockId: string): Comment {
  const missing = { blocks: new Set<string>(), users: new Set<string>(), collections: new Set<string>() };
  const empty = { block: () => undefined, user: () => undefined, collection: () => undefined };
  return {
    id,
    discussionId,
    authorId: ctx.userId,
    createdTime: new Date(ctx.now()).toISOString(),
    text,
    markdown: renderRichText(text, { pageId, blockId, src: empty, missing }),
  };
}

export async function createComment(intl: Internals, opts: CreateCommentOptions): Promise<Comment> {
  const ctx = await writeContext(intl);
  const pageId = normalizeId(opts.pageId, "pageId");
  const target = opts.on ? normalizeId(opts.on.blockId, "on.blockId") : pageId;
  const block = (await intl.core.records.get<BlockRec>({ table: "block", id: target })).value;
  const text = parseInline(opts.markdown.trim()).text;
  if (!text.length) throw new NotionError("INVALID_ARGUMENT", "comment markdown must not be empty");
  const did = intl.core.newRecordId();
  const cid = intl.core.newRecordId();

  const ops: Operation[] = [];
  let context: RichText = [];
  if (opts.on && "selection" in opts.on) {
    const selection = opts.on.selection;
    const title = (block.properties?.title as RichText | undefined) ?? [];
    const plain = plainText(title);
    const at = plain.indexOf(selection);
    if (!selection || at < 0 || plain.indexOf(selection, at + 1) >= 0) {
      throw new NotionError("INVALID_ARGUMENT", "selection must occur exactly once in the block's text");
    }
    context = [[selection, [["m", did]]]];
    ops.push(titleOp(target, annotateRange(title, at, at + selection.length, ["m", did])));
  }
  ops.push(
    { pointer: { table: "discussion", id: did }, path: [], command: "update", args: { id: did, type: "default", parent_table: "block", parent_id: target, space_id: ctx.spaceId, resolved: false, context } },
    { pointer: { table: "comment", id: cid }, path: [], command: "update", args: commentArgs(ctx, cid, did, text) },
    { pointer: { table: "discussion", id: did }, path: ["comments"], command: "listAfter", args: { id: cid } },
    { pointer: blockPtr(target), path: ["discussions"], command: "listAfter", args: { id: did } },
  );
  await intl.core.submit(ops, { userAction: "gabriel-notion.comments.create" });
  await intl.core.records.verify<Record<string, unknown>>([
    { pointer: { table: "comment", id: cid }, holds: (v) => !!v && v.alive !== false, describe: "new comment" },
    { pointer: { table: "discussion", id: did }, holds: (v) => ((v?.comments as string[] | undefined) ?? []).includes(cid), describe: "discussion lists the comment" },
    { pointer: blockPtr(target), holds: (v) => ((v?.discussions as string[] | undefined) ?? []).includes(did), describe: "block lists the discussion" },
  ]);
  return toComment(cid, did, text, ctx, pageId, target);
}

export async function replyToDiscussion(intl: Internals, discussionId: string, markdown: string): Promise<Comment> {
  const ctx = await writeContext(intl);
  const did = normalizeId(discussionId, "discussionId");
  const discussion = (await intl.core.records.get<{ parent_id?: string }>({ table: "discussion", id: did })).value;
  const text = parseInline(markdown.trim()).text;
  if (!text.length) throw new NotionError("INVALID_ARGUMENT", "reply markdown must not be empty");
  const cid = intl.core.newRecordId();
  await intl.core.submit(
    [
      { pointer: { table: "comment", id: cid }, path: [], command: "update", args: commentArgs(ctx, cid, did, text) },
      { pointer: { table: "discussion", id: did }, path: ["comments"], command: "listAfter", args: { id: cid } },
    ],
    { userAction: "gabriel-notion.comments.reply" },
  );
  await intl.core.records.verify<Record<string, unknown>>([
    { pointer: { table: "discussion", id: did }, holds: (v) => ((v?.comments as string[] | undefined) ?? []).includes(cid), describe: "discussion lists the reply" },
  ]);
  return toComment(cid, did, text, ctx, discussion.parent_id ?? "", discussion.parent_id ?? "");
}
