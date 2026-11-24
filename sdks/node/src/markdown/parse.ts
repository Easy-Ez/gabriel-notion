import { parseInline } from "./inline-parse.js";
import { languageName } from "./languages.js";
import type { BlockSpec, RichText } from "./model.js";

const FENCE = /^(\s*)(`{3,}|~{3,})(.*)$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const DIVIDER = /^\s*([-*_])(\s*\1){2,}\s*$/;
const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(?:\[( |x|X)\]\s+)?(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;
const IMAGE = /^!\[(.*)\]\((\S*?)\)\s*$/;
const OPEN_TAG = /^<([a-z][a-z-]*)(\s[^>]*?)?(\/?)>\s*$/i;
const SELF_CLOSING = /^<([a-z][a-z-]*)(\s[^>]*?)?\s*\/>\s*$/i;

function attrsOf(src: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of (src ?? "").matchAll(/([a-zA-Z_:-]+)="([^"]*)"/g)) out[m[1]!] = m[2]!.replace(/&quot;/g, '"').replace(/&amp;/g, "&");
  return out;
}

function idFromUrl(url: string | undefined, part: "page" | "fragment" = "page"): string | undefined {
  if (!url) return undefined;
  const [base, frag] = url.split("#");
  const source = part === "fragment" ? frag : base;
  const m = /([0-9a-f]{32})(?![0-9a-f])/i.exec(source ?? "");
  if (!m) return undefined;
  const h = m[1]!.toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const color = (c: string | undefined): string | undefined => (c ? c.replace(/_bg$/, "_background") : undefined);

/** Inline text → title; a discussion anchor naming this block becomes `ref.id` (the block already exists). */
function withTitle(spec: BlockSpec, text: string): BlockSpec {
  const { text: rich, anchors } = parseInline(text);
  if (rich.length) spec.title = rich;
  const owner = anchors[0]?.blockId;
  if (owner && /^[0-9a-f-]{36}$/i.test(owner)) spec.ref = { ...spec.ref, id: owner.toLowerCase() };
  return spec;
}

const isBlank = (l: string): boolean => l.trim() === "";

/** Index just past the closing tag that matches an opening `<tag ...>` at `start`. */
function findClosing(lines: string[], start: number, tag: string): number {
  let depth = 0;
  for (let i = start; i < lines.length; i++) {
    const l = lines[i]!.trim();
    const open = OPEN_TAG.exec(l);
    if (open && open[1]!.toLowerCase() === tag && open[3] !== "/") depth++;
    if (l.toLowerCase() === `</${tag}>`) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Splits a container body into its title (first paragraph) and the remaining lines. */
function titleAndRest(body: string[]): { title: string; rest: string[] } {
  let i = 0;
  while (i < body.length && !isBlank(body[i]!)) i++;
  return { title: body.slice(0, i).join("\n"), rest: body.slice(i) };
}

function splitRow(line: string): string[] {
  const t = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let cur = "";
  for (let i = 0; i < t.length; i++) {
    if (t[i] === "\\" && t[i + 1] === "|") {
      cur += "|";
      i++;
    } else if (t[i] === "|") {
      cells.push(cur.trim());
      cur = "";
    } else cur += t[i];
  }
  cells.push(cur.trim());
  return cells;
}

function tableSpec(rows: string[][], header: boolean): BlockSpec {
  const width = Math.max(0, ...rows.map((r) => r.length));
  const cols = Array.from({ length: width }, (_, k) => `c${k}`);
  return {
    type: "table",
    format: { table_block_column_order: cols, table_block_column_header: header },
    children: rows.map((r) => ({
      type: "table_row",
      properties: Object.fromEntries(cols.map((c, k) => [c, parseInline(r[k] ?? "").text])),
    })),
  };
}

function xmlTableSpec(body: string[]): BlockSpec {
  const html = body.join("\n");
  const rows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((m) => [...m[1]!.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) => c[1]!.trim()));
  return tableSpec(rows, false);
}

function blockTag(tag: string, attrs: Record<string, string>, body: string[]): BlockSpec | BlockSpec[] | undefined {
  switch (tag) {
    case "toggle":
    case "callout":
    case "quote": {
      const { title, rest } = titleAndRest(body);
      const spec: BlockSpec = { type: tag };
      if (title !== "<p />") withTitle(spec, title);
      const format: Record<string, unknown> = {};
      if (attrs.icon) format.page_icon = attrs.icon;
      if (attrs.color) format.block_color = color(attrs.color);
      if (Object.keys(format).length) spec.format = format;
      const children = parseLines(rest);
      if (children.length) spec.children = children;
      return spec;
    }
    case "columns":
      return { type: "column_list", children: parseLines(body).filter((c) => c.type === "column") };
    case "column": {
      const spec: BlockSpec = { type: "column", children: parseLines(body) };
      if (attrs.ratio) spec.format = { column_ratio: Number(attrs.ratio) / 100 };
      return spec;
    }
    case "page": {
      const spec: BlockSpec = { type: "page" };
      withTitle(spec, body.join("\n").trim());
      const id = idFromUrl(attrs.url);
      if (id) spec.ref = { ...spec.ref, id, url: attrs.url! };
      return spec;
    }
    case "database": {
      const spec: BlockSpec = { type: attrs.inline === "false" ? "collection_view_page" : "collection_view" };
      withTitle(spec, body.join("\n").trim());
      const ref: NonNullable<BlockSpec["ref"]> = {};
      const id = idFromUrl(attrs.url);
      if (id) ref.id = id;
      const coll = /^collection:\/\/([0-9a-f-]{36})/i.exec(attrs["data-source-url"] ?? "")?.[1];
      if (coll) ref.collectionId = coll.toLowerCase();
      if (Object.keys(ref).length) spec.ref = ref;
      return spec;
    }
    case "synced-block": {
      const spec: BlockSpec = { type: "transclusion_container", children: parseLines(body) };
      const id = idFromUrl(attrs.url, "fragment");
      if (id) spec.ref = { id };
      return spec;
    }
    case "synced-block-reference": {
      const id = idFromUrl(attrs.url, "fragment");
      return id ? { type: "transclusion_reference", format: { transclusion_reference_pointer: { id, table: "block" } } } : undefined;
    }
    case "table":
      return xmlTableSpec(body);
    case "p": {
      const spec: BlockSpec = { type: "text" };
      if (body.length) withTitle(spec, body.join("\n"));
      return spec;
    }
    default:
      return undefined;
  }
}

function selfClosing(tag: string, attrs: Record<string, string>): BlockSpec | undefined {
  switch (tag) {
    case "p":
      return { type: "text" };
    case "bookmark":
      return { type: "bookmark", properties: { link: [[attrs.source ?? ""]] } };
    case "file": {
      const src = attrs.source ?? "";
      const m = /^notion-file-block:\/\/([0-9a-f-]{36})\/([0-9a-f-]{36})\?(.*)$/i.exec(src);
      if (m) {
        const q = new URLSearchParams(m[3]!);
        const name = q.get("name") ?? "file";
        const ref: NonNullable<BlockSpec["ref"]> = { id: m[1]!.toLowerCase(), fileId: m[2]!.toLowerCase() };
        const space = q.get("space_id");
        if (space) ref.spaceId = space;
        return { type: "file", title: [[name]], properties: { source: [[`attachment:${ref.fileId}:${name}`]] }, ref };
      }
      return { type: "file", properties: { source: [[src]] } };
    }
    case "image": {
      const spec: BlockSpec = { type: "image", properties: { source: [[attrs.source ?? ""]] }, format: { display_source: attrs.source ?? "" } };
      return spec;
    }
    case "synced-block-reference":
      return blockTag(tag, attrs, []) as BlockSpec | undefined;
    case "divider":
      return { type: "divider" };
    default:
      return undefined;
  }
}

function startsBlock(line: string): boolean {
  return (
    FENCE.test(line) ||
    HEADING.test(line) ||
    DIVIDER.test(line) ||
    LIST_ITEM.test(line) ||
    /^\s*>/.test(line) ||
    /^\s*\$\$\s*$/.test(line) ||
    /^\s*\|/.test(line) ||
    IMAGE.test(line.trim()) ||
    OPEN_TAG.test(line.trim()) ||
    SELF_CLOSING.test(line.trim())
  );
}

function dedent(lines: string[], by: number): string[] {
  return lines.map((l) => (l.slice(0, by).trim() === "" ? l.slice(by) : l.trimStart()));
}

function parseList(lines: string[], start: number): { specs: BlockSpec[]; next: number } {
  const specs: BlockSpec[] = [];
  const baseIndent = LIST_ITEM.exec(lines[start]!)![1]!.length;
  let i = start;
  while (i < lines.length) {
    const m = LIST_ITEM.exec(lines[i]!);
    if (!m || m[1]!.length !== baseIndent) break;
    const marker = m[2]!;
    const checkbox = m[3];
    const spec: BlockSpec = { type: checkbox !== undefined ? "to_do" : /\d/.test(marker) ? "numbered_list" : "bulleted_list" };
    if (checkbox === "x" || checkbox === "X") spec.properties = { checked: [["Yes"]] };
    withTitle(spec, m[4]!);
    i++;
    const childLines: string[] = [];
    while (i < lines.length) {
      const l = lines[i]!;
      if (isBlank(l)) {
        const nextNonBlank = lines.slice(i).find((x) => !isBlank(x));
        if (nextNonBlank === undefined || nextNonBlank.length - nextNonBlank.trimStart().length <= baseIndent) break;
        childLines.push(l);
        i++;
        continue;
      }
      if (l.length - l.trimStart().length <= baseIndent) break;
      childLines.push(l);
      i++;
    }
    if (childLines.length) {
      const children = parseLines(dedent(childLines, baseIndent + 2));
      if (children.length) spec.children = children;
    }
    specs.push(spec);
    // A blank line between items of the same list is allowed.
    if (i < lines.length && isBlank(lines[i]!)) {
      const j = lines.findIndex((x, k) => k > i && !isBlank(x));
      const nm = j > 0 ? LIST_ITEM.exec(lines[j]!) : null;
      if (nm && nm[1]!.length === baseIndent && sameListKind(nm, m)) i = j;
      else break;
    }
  }
  return { specs, next: i };
}

function sameListKind(a: RegExpExecArray, b: RegExpExecArray): boolean {
  const kind = (m: RegExpExecArray) => (m[3] !== undefined ? "todo" : /\d/.test(m[2]!) ? "num" : "bullet");
  return kind(a) === kind(b);
}

function parseLines(lines: string[]): BlockSpec[] {
  const out: BlockSpec[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (trimmed === "") {
      i++;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[2]!;
      const body: string[] = [];
      i++;
      while (i < lines.length && !(lines[i]!.trim().startsWith(marker[0]!.repeat(marker.length)) && lines[i]!.trim().replace(new RegExp(`^\\${marker[0]}+`), "") === "")) {
        body.push(lines[i]!);
        i++;
      }
      i++;
      out.push({ type: "code", title: [[body.join("\n")]], properties: { language: [[languageName(fence[3])]] } });
      continue;
    }

    if (/^\$\$\s*$/.test(trimmed)) {
      const body: string[] = [];
      i++;
      while (i < lines.length && lines[i]!.trim() !== "$$") body.push(lines[i++]!);
      i++;
      out.push({ type: "equation", title: [[body.join("\n")]] });
      continue;
    }

    if (DIVIDER.test(line)) {
      out.push({ type: "divider" });
      i++;
      continue;
    }

    const heading = HEADING.exec(trimmed);
    if (heading) {
      const level = heading[1]!.length;
      out.push(withTitle({ type: level === 1 ? "header" : level === 2 ? "sub_header" : "sub_sub_header" }, heading[2]!));
      i++;
      continue;
    }

    const self = SELF_CLOSING.exec(trimmed);
    if (self) {
      const spec = selfClosing(self[1]!.toLowerCase(), attrsOf(self[2]));
      if (spec) {
        out.push(spec);
        i++;
        continue;
      }
    }

    const open = OPEN_TAG.exec(trimmed);
    if (open && open[3] !== "/") {
      const tag = open[1]!.toLowerCase();
      const end = findClosing(lines, i, tag);
      if (end > i) {
        const spec = blockTag(tag, attrsOf(open[2]), lines.slice(i + 1, end));
        if (spec) {
          out.push(...(Array.isArray(spec) ? spec : [spec]));
          i = end + 1;
          continue;
        }
      }
    }

    if (LIST_ITEM.test(line)) {
      const { specs, next } = parseList(lines, i);
      out.push(...specs);
      i = next;
      continue;
    }

    if (/^\|/.test(trimmed) && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]!)) {
      const rows = [splitRow(line)];
      i += 2;
      while (i < lines.length && /^\s*\|/.test(lines[i]!)) rows.push(splitRow(lines[i++]!));
      out.push(tableSpec(rows, true));
      continue;
    }

    if (/^>/.test(trimmed)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i]!)) body.push(lines[i++]!.trim().replace(/^>\s?/, ""));
      out.push(withTitle({ type: "quote" }, body.join("\n")));
      continue;
    }

    const image = IMAGE.exec(trimmed);
    if (image) {
      const spec: BlockSpec = { type: "image", properties: { source: [[image[2]!]] }, format: { display_source: image[2]! } };
      if (image[1]) spec.properties!.caption = parseInline(image[1]).text;
      out.push(spec);
      i++;
      continue;
    }

    // Paragraph: consecutive non-blank lines. A newline is a soft break (a space) unless it
    // follows a trailing backslash; `<br />` inside the text is a hard break.
    const para: string[] = [line.replace(/\s+$/, "")];
    i++;
    while (i < lines.length && !isBlank(lines[i]!) && !startsBlock(lines[i]!)) para.push(lines[i++]!.replace(/\s+$/, ""));
    const joined = para.map((l, k) => (k < para.length - 1 ? (l.endsWith("\\") ? `${l.slice(0, -1)}\n` : `${l} `) : l)).join("");
    out.push(withTitle({ type: "text" }, joined));
  }
  return out;
}

/** Parses Notion-flavored Markdown into block specs (no IDs, except ones the Markdown names). */
export function parseMarkdown(markdown: string): BlockSpec[] {
  return parseLines(markdown.replace(/\r\n?/g, "\n").split("\n"));
}

export type { RichText };
