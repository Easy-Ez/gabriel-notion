import type { Annotation, DateValue, RecordSource, RichText } from "./model.js";
import { pageUrl } from "./model.js";

export interface InlineContext {
  /** Page the text belongs to, for discussion URLs. */
  pageId: string;
  /** Block the text belongs to, for discussion URLs. */
  blockId: string;
  src: RecordSource;
  missing: { blocks: Set<string>; users: Set<string>; collections: Set<string> };
}

/**
 * Escapes text the way official output does. Verified: `[` and `]` become `\[` and `\]`.
 * From the spec: a literal tag-like `<` becomes `\<`. Nothing else is escaped, because no
 * official sample shows other escapes.
 */
export function escapeText(text: string): string {
  return text.replace(/[[\]]/g, (m) => `\\${m}`).replace(/<(?=[A-Za-z/!])/g, "\\<");
}

/** Official output does not escape `&` in attribute values; only a double quote would break the attribute. */
const attr = (value: string): string => value.replace(/"/g, "&quot;");

/** Plain text of rich text, ignoring annotations. */
export function plainText(text: RichText | undefined): string {
  return (text ?? []).map((s) => s[0]).join("");
}

function renderDate(d: DateValue): string {
  const parts = [`start="${attr(d.start_date)}"`];
  if (d.end_date) parts.push(`end="${attr(d.end_date)}"`);
  if (d.start_time) parts.push(`start-time="${attr(d.start_time)}"`);
  if (d.end_time) parts.push(`end-time="${attr(d.end_time)}"`);
  if (d.time_zone) parts.push(`time-zone="${attr(d.time_zone)}"`);
  return `<date ${parts.join(" ")} />`;
}

/** Color as written in Markdown: `red_background` → `red_bg`. */
export function colorAttr(color: string): string {
  return color.replace(/_background$/, "_bg");
}

function renderSegment(text: string, anns: Annotation[], ctx: InlineContext): string {
  const find = (code: string) => anns.find((a) => a[0] === code);
  const user = find("u");
  const page = find("p");
  const date = find("d");
  const eq = find("e");
  const isCode = anns.some((a) => a[0] === "c");

  let body: string;
  if (user) {
    const id = String(user[1]);
    const u = ctx.src.user(id);
    if (!u) ctx.missing.users.add(id);
    const url = u?.email ? `user://${id}/${u.email}` : `user://${id}`;
    body = `<mention url="${attr(url)}">${escapeText(u?.name ?? "")}</mention>`;
  } else if (page) {
    const id = String(page[1]);
    const b = ctx.src.block(id);
    if (!b) ctx.missing.blocks.add(id);
    const title = plainText(b?.properties?.title as RichText | undefined);
    body = `<mention url="${pageUrl(id)}">${escapeText(title)}</mention>`;
  } else if (date) {
    body = renderDate(date[1] as DateValue);
  } else if (eq) {
    body = `$${String(eq[1])}$`;
  } else {
    body = (isCode ? text : escapeText(text)).replace(/\n/g, "<br />");
  }

  let color: string | undefined;
  const discussions: string[] = [];
  for (const a of anns) {
    switch (a[0]) {
      case "b":
        body = `<b>${body}</b>`;
        break;
      case "i":
        body = `<i>${body}</i>`;
        break;
      case "s":
        body = `<s>${body}</s>`;
        break;
      case "_":
        body = `<u>${body}</u>`;
        break;
      case "c":
        body = `<code>${body}</code>`;
        break;
      case "a":
        body = `[${body}](${String(a[1])})`;
        break;
      case "h":
        color = colorAttr(String(a[1]));
        break;
      case "m":
        discussions.push(`discussion://${ctx.pageId}/${ctx.blockId}/${String(a[1])}`);
        break;
      default:
        break;
    }
  }
  if (color || discussions.length > 0) {
    const attrs = [color ? `color="${attr(color)}"` : "", discussions.length ? `discussion-urls="${attr(discussions.join(","))}"` : ""].filter(Boolean).join(" ");
    body = `<span ${attrs}>${body}</span>`;
  }
  return body;
}

/** Renders rich text to Notion-flavored Markdown inline content. */
export function renderRichText(text: RichText | undefined, ctx: InlineContext): string {
  return (text ?? []).map((seg) => renderSegment(seg[0], (seg[1] ?? []) as Annotation[], ctx)).join("");
}
