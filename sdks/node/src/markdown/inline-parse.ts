import type { Annotation, DateValue, RichText, Segment } from "./model.js";

const MENTION_CHAR = "‣"; // ‣, the placeholder text of user/page/date mentions
const EQUATION_CHAR = "⁍"; // ⁍, the placeholder text of inline equations

interface Ctx {
  out: Segment[];
  /** Annotation stack, outermost first. */
  stack: Annotation[];
  /** Discussion anchors seen, as `{ blockId, discussionId }` from `discussion://page/block/id`. */
  anchors: Array<{ blockId: string; discussionId: string }>;
}

function annotations(ctx: Ctx, extra: Annotation[] = []): Annotation[] {
  // The renderer applies annotations inner → outer, so the innermost comes first.
  return [...extra, ...[...ctx.stack].reverse()];
}

function push(ctx: Ctx, text: string, extra: Annotation[] = []): void {
  if (text === "") return;
  const anns = annotations(ctx, extra);
  const last = ctx.out[ctx.out.length - 1];
  if (last && extra.length === 0 && sameAnns(last[1] ?? [], anns) && !isPlaceholder(last)) {
    last[0] += text;
    return;
  }
  ctx.out.push(anns.length ? [text, anns] : [text]);
}

const isPlaceholder = (seg: Segment): boolean => (seg[1] ?? []).some((a) => ["u", "p", "d", "e"].includes(a[0]));
const sameAnns = (a: Annotation[], b: Annotation[]): boolean => JSON.stringify(a) === JSON.stringify(b);

function parseAttrs(src: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const m of src.matchAll(/([a-zA-Z_:-]+)="([^"]*)"/g)) attrs[m[1]!] = m[2]!.replace(/&quot;/g, '"').replace(/&amp;/g, "&");
  return attrs;
}

const STYLE_TAGS: Record<string, Annotation> = {
  b: ["b"],
  strong: ["b"],
  i: ["i"],
  em: ["i"],
  s: ["s"],
  del: ["s"],
  u: ["_"],
};

/** Finds the index of `close` at the same nesting depth of `open`, starting after the opener. */
function findClose(text: string, from: number, open: string, close: string): number {
  let depth = 1;
  for (let i = from; i < text.length; i++) {
    if (text[i] === "\\") {
      i++;
      continue;
    }
    if (text.startsWith(open, i)) depth++;
    else if (text.startsWith(close, i) && --depth === 0) return i;
  }
  return -1;
}

function pageIdFromUrl(url: string): string | undefined {
  const m = /([0-9a-f]{32})(?![0-9a-f])/i.exec(url.split("#")[0]!.split("?")[0]!);
  if (!m) return undefined;
  const h = m[1]!.toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function dateValue(attrs: Record<string, string>): DateValue {
  const hasTime = Boolean(attrs["start-time"]);
  const range = Boolean(attrs.end);
  const d: DateValue = { type: hasTime ? (range ? "datetimerange" : "datetime") : range ? "daterange" : "date", start_date: attrs.start ?? "" };
  if (attrs.end) d.end_date = attrs.end;
  if (attrs["start-time"]) d.start_time = attrs["start-time"];
  if (attrs["end-time"]) d.end_time = attrs["end-time"];
  if (attrs["time-zone"]) d.time_zone = attrs["time-zone"];
  return d;
}

function run(ctx: Ctx, text: string): void {
  let buf = "";
  const flush = () => {
    push(ctx, buf);
    buf = "";
  };
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    const rest = text.slice(i);

    if (ch === "\\" && i + 1 < text.length && /[!-/:-@[-`{-~]/.test(text[i + 1]!)) {
      buf += text[i + 1];
      i += 2;
      continue;
    }
    if (ch === "\\" && text[i + 1] === "\n") {
      buf += "\n";
      i += 2;
      continue;
    }

    if (ch === "<") {
      const br = /^<br\s*\/?>/i.exec(rest);
      if (br) {
        buf += "\n";
        i += br[0].length;
        continue;
      }
      const code = /^<code>/i.exec(rest);
      if (code) {
        const end = rest.indexOf("</code>");
        if (end > 0) {
          flush();
          push(ctx, rest.slice(code[0].length, end).replace(/<br\s*\/?>/gi, "\n"), [["c"]]);
          i += end + "</code>".length;
          continue;
        }
      }
      const style = /^<(b|strong|i|em|s|del|u)>/i.exec(rest);
      if (style) {
        const tag = style[1]!.toLowerCase();
        const close = findClose(rest, style[0].length, `<${tag}>`, `</${tag}>`);
        if (close > 0) {
          flush();
          ctx.stack.push(STYLE_TAGS[tag]!);
          run(ctx, rest.slice(style[0].length, close));
          ctx.stack.pop();
          i += close + tag.length + 3;
          continue;
        }
      }
      const span = /^<span\s+([^>]*)>/i.exec(rest);
      if (span) {
        const close = findClose(rest, span[0].length, "<span", "</span>");
        if (close > 0) {
          flush();
          const attrs = parseAttrs(span[1]!);
          const pushed: Annotation[] = [];
          if (attrs.color) pushed.push(["h", attrs.color.replace(/_bg$/, "_background")]);
          for (const url of (attrs["discussion-urls"] ?? "").split(",").filter(Boolean)) {
            const parts = url.replace(/^discussion:\/\//, "").split("/");
            const discussionId = parts[parts.length - 1]!;
            if (parts.length >= 3) ctx.anchors.push({ blockId: parts[parts.length - 2]!, discussionId });
            pushed.push(["m", discussionId]);
          }
          // Outermost first on the stack: discussions outside color, matching the renderer.
          for (const a of [...pushed].reverse()) ctx.stack.push(a);
          run(ctx, rest.slice(span[0].length, close));
          for (let k = 0; k < pushed.length; k++) ctx.stack.pop();
          i += close + "</span>".length;
          continue;
        }
      }
      const mention = /^<mention\s+([^>]*?)(\/>|>)/i.exec(rest);
      if (mention) {
        const attrs = parseAttrs(mention[1]!);
        let consumed = mention[0].length;
        if (mention[2] === ">") {
          const end = rest.indexOf("</mention>", consumed);
          consumed = end >= 0 ? end + "</mention>".length : consumed;
        }
        const url = attrs.url ?? "";
        let ann: Annotation | undefined;
        const user = /^user:\/\/([0-9a-f-]{36})/i.exec(url);
        if (user) ann = ["u", user[1]!.toLowerCase()];
        else {
          const id = pageIdFromUrl(url) ?? /^collection:\/\/([0-9a-f-]{36})/i.exec(url)?.[1];
          if (id) ann = ["p", id];
        }
        if (ann) {
          flush();
          push(ctx, MENTION_CHAR, [ann]);
          i += consumed;
          continue;
        }
      }
      const date = /^<date\s+([^>]*?)\/>/i.exec(rest);
      if (date) {
        flush();
        push(ctx, MENTION_CHAR, [["d", dateValue(parseAttrs(date[1]!))]]);
        i += date[0].length;
        continue;
      }
    }

    if (ch === "$" && text[i + 1] !== "$" && i + 1 < text.length && !/\s/.test(text[i + 1]!)) {
      const end = text.indexOf("$", i + 1);
      if (end > i + 1 && !/\s/.test(text[end - 1]!) && !/[0-9]/.test(text[end + 1] ?? "")) {
        flush();
        push(ctx, EQUATION_CHAR, [["e", text.slice(i + 1, end)]]);
        i = end + 1;
        continue;
      }
    }

    if (ch === "[") {
      const close = findClose(text, i + 1, "[", "]");
      if (close > i && text[close + 1] === "(") {
        const urlEnd = text.indexOf(")", close + 2);
        if (urlEnd > close) {
          flush();
          ctx.stack.push(["a", text.slice(close + 2, urlEnd)]);
          run(ctx, text.slice(i + 1, close));
          ctx.stack.pop();
          i = urlEnd + 1;
          continue;
        }
      }
    }

    if (ch === "`") {
      const ticks = /^`+/.exec(rest)![0];
      const end = text.indexOf(ticks, i + ticks.length);
      if (end > i) {
        flush();
        push(ctx, text.slice(i + ticks.length, end), [["c"]]);
        i = end + ticks.length;
        continue;
      }
    }

    const delim = /^(\*\*|__|~~|\*|_)/.exec(rest);
    if (delim && !/\s/.test(text[i + delim[0].length] ?? " ")) {
      const d = delim[0];
      const end = text.indexOf(d, i + d.length);
      const wordInside = d === "_" && /[A-Za-z0-9]/.test(text[i - 1] ?? "");
      if (end > i + d.length && !/\s/.test(text[end - 1]!) && !wordInside) {
        flush();
        ctx.stack.push(d === "~~" ? ["s"] : d.length === 2 ? ["b"] : ["i"]);
        run(ctx, text.slice(i + d.length, end));
        ctx.stack.pop();
        i = end + d.length;
        continue;
      }
    }

    buf += ch;
    i++;
  }
  flush();
}

export interface InlineParseResult {
  text: RichText;
  anchors: Array<{ blockId: string; discussionId: string }>;
}

/**
 * Parses Notion-flavored Markdown inline content into rich text segments. Handles the tag
 * forms official output uses (`<b>`, `<span color discussion-urls>`, `<mention>`, `<date />`,
 * `<br />`) and plain Markdown emphasis, code spans, links and `$…$` math.
 */
export function parseInline(text: string): InlineParseResult {
  const ctx: Ctx = { out: [], stack: [], anchors: [] };
  run(ctx, text);
  return { text: ctx.out, anchors: ctx.anchors };
}
