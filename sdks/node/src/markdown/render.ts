import { colorAttr, escapeText, plainText, renderRichText, type InlineContext } from "./inline-render.js";
import { languageTag } from "./languages.js";
import { APP_ORIGIN, compactId, pageUrl, type BlockRecord, type RecordSource, type RichText } from "./model.js";

export interface RenderOptions {
  /** Workspace ID, used in file references. */
  spaceId: string;
}

export interface RenderResult {
  markdown: string;
  /** Records the output refers to but the source did not have; fetch them and render again. */
  missing: { blocks: string[]; users: string[]; collections: string[] };
  /** Blocks of a type the renderer does not support; they are left out of `markdown`. */
  unknownBlockIds: string[];
}

const LIST_TYPES = new Set(["bulleted_list", "numbered_list", "to_do"]);

interface State {
  src: RecordSource;
  spaceId: string;
  rootId: string;
  missing: InlineContext["missing"];
  unknown: string[];
}

/** Official output does not escape `&` in attribute values; only a double quote would break the attribute. */
const attr = (value: string): string => value.replace(/"/g, "&quot;");
const title = (b: BlockRecord): RichText | undefined => b.properties?.title as RichText | undefined;
const prop = (b: BlockRecord, key: string): string => plainText(b.properties?.[key] as RichText | undefined);

function indent(text: string, by: string): string {
  return text
    .split("\n")
    .map((line) => (line === "" ? line : by + line))
    .join("\n");
}

function inline(st: State, b: BlockRecord, text: RichText | undefined): string {
  return renderRichText(text, { pageId: st.rootId, blockId: b.id, src: st.src, missing: st.missing });
}

/** Title for a container tag; an empty title is `<p />` per the spec. */
function containerTitle(st: State, b: BlockRecord): string {
  const t = inline(st, b, title(b));
  return t === "" ? "<p />" : t;
}

function container(tag: string, attrs: string, head: string | undefined, children: string): string {
  const open = `<${tag}${attrs ? ` ${attrs}` : ""}>`;
  const body = [head, children].filter((x) => x !== undefined && x !== "").join("\n\n");
  return body === "" ? `${open}\n</${tag}>` : `${open}\n${body}\n</${tag}>`;
}

function childIds(st: State, b: BlockRecord): string[] {
  return (b.content ?? []).filter((id) => {
    const c = st.src.block(id);
    if (!c) st.missing.blocks.add(id);
    return c !== undefined && c.alive !== false;
  });
}

function renderChildren(st: State, ids: readonly string[]): string {
  const parts: string[] = [];
  let prevType: string | undefined;
  let number = 0;
  for (const id of ids) {
    const b = st.src.block(id);
    if (!b || b.alive === false) continue;
    number = b.type === "numbered_list" && prevType === "numbered_list" ? number + 1 : 1;
    const out = renderBlock(st, b, number);
    if (out === undefined) continue;
    const sep = parts.length === 0 ? "" : LIST_TYPES.has(b.type) && b.type === prevType ? "\n" : "\n\n";
    parts.push(sep + out);
    prevType = b.type;
  }
  return parts.join("");
}

function renderListItem(st: State, b: BlockRecord, marker: string): string {
  const head = `${marker}${inline(st, b, title(b))}`;
  const kids = childIds(st, b);
  if (kids.length === 0) return head;
  const first = st.src.block(kids[0]!);
  const sep = first && LIST_TYPES.has(first.type) ? "\n" : "\n\n";
  return head + sep + indent(renderChildren(st, kids), "  ");
}

function renderTable(st: State, b: BlockRecord): string {
  const cols = (b.format?.table_block_column_order as string[] | undefined) ?? [];
  const header = b.format?.table_block_column_header === true;
  const rows = childIds(st, b).map((id) => st.src.block(id)!);
  const cell = (row: BlockRecord, col: string) => inline(st, row, row.properties?.[col] as RichText | undefined);
  if (header) {
    const lines = rows.map((row) => `| ${cols.map((c) => cell(row, c).replace(/\|/g, "\\|")).join(" | ")} |`);
    if (lines.length === 0) return "";
    lines.splice(1, 0, `| ${cols.map(() => "---").join(" | ")} |`);
    return lines.join("\n");
  }
  const body = rows.map((row) => `<tr>\n${cols.map((c) => `<td>${cell(row, c)}</td>`).join("\n")}\n</tr>`).join("\n");
  return `<table header-row="false">\n${body}\n</table>`;
}

function codeFence(content: string): string {
  const longest = Math.max(0, ...[...content.matchAll(/`+/g)].map((m) => m[0].length));
  return "`".repeat(Math.max(3, longest + 1));
}

function fileReference(st: State, b: BlockRecord): string {
  const source = prop(b, "source");
  const m = /^attachment:([0-9a-f-]{36}):(.+)$/i.exec(source);
  if (m) return `notion-file-block://${b.id}/${m[1]}?space_id=${st.spaceId}&name=${encodeURIComponent(m[2]!)}`;
  return source;
}

/** The page that contains a block, walking up parent pointers. */
function containingPage(st: State, id: string): string | undefined {
  let cur = st.src.block(id);
  for (let i = 0; cur && i < 50; i++) {
    if (cur.type === "page" || cur.type === "collection_view_page") return cur.id;
    if (cur.parent_table !== "block" || !cur.parent_id) return undefined;
    const parentId: string = cur.parent_id;
    const next = st.src.block(parentId);
    if (!next) st.missing.blocks.add(parentId);
    cur = next;
  }
  return undefined;
}

function renderBlock(st: State, b: BlockRecord, number: number): string | undefined {
  const color = typeof b.format?.block_color === "string" ? colorAttr(b.format.block_color) : undefined;
  switch (b.type) {
    case "text": {
      const t = inline(st, b, title(b));
      const kids = childIds(st, b);
      const head = t === "" ? "<p />" : t;
      return kids.length ? head + "\n\n" + indent(renderChildren(st, kids), "  ") : head;
    }
    case "header":
      return `# ${inline(st, b, title(b))}`;
    case "sub_header":
      return `## ${inline(st, b, title(b))}`;
    case "sub_sub_header":
      return `### ${inline(st, b, title(b))}`;
    case "bulleted_list":
      return renderListItem(st, b, "- ");
    case "numbered_list":
      return renderListItem(st, b, `${number}. `);
    case "to_do":
      return renderListItem(st, b, prop(b, "checked") === "Yes" ? "- [x] " : "- [ ] ");
    case "quote": {
      const kids = childIds(st, b);
      if (kids.length === 0 && !color) return `> ${inline(st, b, title(b))}`;
      return container("quote", color ? `color="${attr(color)}"` : "", containerTitle(st, b), renderChildren(st, kids));
    }
    case "toggle":
      return container("toggle", color ? `color="${attr(color)}"` : "", containerTitle(st, b), renderChildren(st, childIds(st, b)));
    case "callout": {
      const icon = typeof b.format?.page_icon === "string" ? `icon="${attr(b.format.page_icon)}"` : "";
      const attrs = [icon, color ? `color="${attr(color)}"` : ""].filter(Boolean).join(" ");
      return container("callout", attrs, inline(st, b, title(b)), renderChildren(st, childIds(st, b)));
    }
    case "code": {
      const content = plainText(title(b));
      const fence = codeFence(content);
      return `${fence}${languageTag(prop(b, "language") || undefined)}\n${content}\n${fence}`;
    }
    case "equation":
      return `$$\n${plainText(title(b))}\n$$`;
    case "divider":
      return "---";
    case "bookmark":
      return `<bookmark source="${attr(prop(b, "link"))}" />`;
    case "image": {
      const source = (b.format?.display_source as string | undefined) ?? prop(b, "source");
      return `![${escapeText(prop(b, "caption"))}](${source})`;
    }
    case "file":
      return `<file source="${attr(fileReference(st, b))}" />`;
    case "table":
      return renderTable(st, b);
    case "column_list":
      return `<columns>\n${childIds(st, b).map((id) => renderBlock(st, st.src.block(id)!, 1)).filter((x) => x !== undefined).join("\n")}\n</columns>`;
    case "column": {
      const ratio = typeof b.format?.column_ratio === "number" ? `ratio="${Math.round(b.format.column_ratio * 100)}"` : "";
      return container("column", ratio, undefined, renderChildren(st, childIds(st, b)));
    }
    case "page":
      return `<page url="${pageUrl(b.id)}">\n${escapeText(plainText(title(b)))}\n</page>`;
    case "collection_view":
    case "collection_view_page": {
      const coll = b.collection_id ? st.src.collection(b.collection_id) : undefined;
      if (b.collection_id && !coll) st.missing.collections.add(b.collection_id);
      const attrs = [`url="${pageUrl(b.id)}"`, b.collection_id ? `data-source-url="collection://${b.collection_id}"` : "", `inline="${b.type === "collection_view"}"`].filter(Boolean).join(" ");
      return `<database ${attrs}>\n${escapeText(plainText(coll?.name))}\n</database>`;
    }
    case "transclusion_container":
      return container("synced-block", `url="${pageUrl(st.rootId)}#${compactId(b.id)}"`, undefined, renderChildren(st, childIds(st, b)));
    case "transclusion_reference": {
      const pointer = b.format?.transclusion_reference_pointer as { id?: string } | undefined;
      if (!pointer?.id) return undefined;
      const page = containingPage(st, pointer.id);
      if (!page) return undefined;
      return container("synced-block-reference", `url="${APP_ORIGIN}/p/${compactId(page)}#${compactId(pointer.id)}"`, undefined, "");
    }
    default:
      st.unknown.push(b.id);
      return undefined;
  }
}

/**
 * Renders a page's body (its children, not its title) as Notion-flavored Markdown, matching
 * the official `fetch` output for the block types covered by spec/fixtures/markdown.
 */
export function renderPage(rootId: string, src: RecordSource, opts: RenderOptions): RenderResult {
  const st: State = { src, spaceId: opts.spaceId, rootId, missing: { blocks: new Set(), users: new Set(), collections: new Set() }, unknown: [] };
  const root = src.block(rootId);
  if (!root) {
    return { markdown: "", missing: { blocks: [rootId], users: [], collections: [] }, unknownBlockIds: [] };
  }
  const markdown = renderChildren(st, childIds(st, root));
  return {
    markdown,
    missing: { blocks: [...st.missing.blocks], users: [...st.missing.users], collections: [...st.missing.collections] },
    unknownBlockIds: st.unknown,
  };
}
