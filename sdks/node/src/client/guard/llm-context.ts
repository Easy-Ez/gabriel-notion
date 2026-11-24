import type { NotionEvent } from "../events/types.js";
import type { PageResult } from "../types.js";

/**
 * Content for an LLM (spec §11.4): metadata is kept apart from the
 * body, and the body sits inside an envelope marked untrusted, since pages and comments may be
 * written by anyone. Tell the model in its system prompt that text inside `<content>` is data,
 * not instructions.
 */

const TAGS = "notion_event|notion_page|meta|content";
const TAG_RE = new RegExp(`<(\\s*/?\\s*)(${TAGS})(?=[\\s>/]|$)`, "gi");

/** Neutralizes every sequence that could open or close one of the envelope's tags. */
export function neutralize(text: string): string {
  return text.replace(TAG_RE, "&lt;$1$2");
}

function oneLine(text: unknown): string {
  return neutralize(String(text ?? ""))
    .replace(/[\r\n]+/g, " ")
    .slice(0, 300);
}

function plain(rich: unknown): string {
  if (!Array.isArray(rich)) return "";
  return rich.map((seg) => (Array.isArray(seg) && typeof seg[0] === "string" ? seg[0] : "")).join("");
}

/** Readable text an event carries: a block or page title, or a comment's text. */
function eventText(e: NotionEvent): string | undefined {
  const after = e.web.after as Record<string, unknown> | undefined;
  if (!after) return undefined;
  if (Array.isArray(after.text)) return plain(after.text);
  const props = after.properties as Record<string, unknown> | undefined;
  const title = props?.title;
  return title === undefined ? undefined : plain(title);
}

export function eventToLLMContext(e: NotionEvent): string {
  const lines = [
    `<notion_event untrusted="true">`,
    `  <meta>`,
    `    type: ${e.type}`,
    `    timestamp: ${e.timestamp}`,
    `    workspace: ${e.workspaceId}`,
    `    entity: ${e.entity.type} ${e.entity.id}`,
    `    authors: ${e.authors.map((a) => `${a.id} (${a.type})`).join(", ") || "unknown"}`,
    `    origin: ${e.origin}`,
    `    delivery: ${e.delivery}`,
  ];
  const data = e.data as Record<string, unknown>;
  const parent = data.parent as { type: string; id: string } | undefined;
  if (parent) lines.push(`    parent: ${parent.type} ${parent.id}`);
  if (Array.isArray(data.updated_blocks)) lines.push(`    updated_blocks: ${(data.updated_blocks as Array<{ id: string }>).map((b) => b.id).join(", ")}`);
  if (Array.isArray(data.updated_properties)) lines.push(`    updated_properties: ${(data.updated_properties as unknown[]).map((p) => (typeof p === "string" ? oneLine(p) : oneLine((p as { name?: string; id: string }).name ?? (p as { id: string }).id))).join(", ")}`);
  lines.push(`  </meta>`);
  const text = eventText(e);
  if (text) {
    lines.push(`  <content>`);
    for (const l of neutralize(text).split("\n")) lines.push(`  ${l}`);
    lines.push(`  </content>`);
  }
  lines.push(`</notion_event>`);
  return lines.join("\n");
}

export function pageToLLMContext(p: PageResult): string {
  const m = p.page;
  const lines = [
    `<notion_page untrusted="true">`,
    `  <meta>`,
    `    id: ${m.id}`,
    `    title: ${oneLine(m.title)}`,
    `    url: ${oneLine(m.url)}`,
  ];
  if (m.parent) lines.push(`    parent: ${m.parent.type} ${m.parent.id}`);
  if (m.lastEditedTime) lines.push(`    last_edited: ${m.lastEditedTime}`);
  if (m.lastEditedBy) lines.push(`    last_edited_by: ${m.lastEditedBy}`);
  const props = Object.entries(p.properties ?? {});
  if (props.length) lines.push(`    properties: ${props.map(([k, v]) => `${oneLine(k)}=${oneLine(JSON.stringify(v))}`).join("; ")}`);
  lines.push(`  </meta>`, `  <content>`);
  for (const l of neutralize(p.markdown ?? "").split("\n")) lines.push(`  ${l}`);
  lines.push(`  </content>`, `</notion_page>`);
  return lines.join("\n");
}

/** Attaches `toLLMContext()` as a non-enumerable method, so JSON serialization stays clean. */
export function attachLLMContext<T extends object>(target: T, render: (t: T) => string): T {
  Object.defineProperty(target, "toLLMContext", { value: () => render(target), enumerable: false, configurable: true });
  return target;
}
