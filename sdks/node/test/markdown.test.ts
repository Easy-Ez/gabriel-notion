import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseInline, parseMarkdown, renderPage, specsToRecords, type BlockRecord, type CollectionRecord, type RecordSource, type UserRecord } from "../src/markdown/index.js";

interface Fixture {
  name: string;
  rootId: string;
  spaceId: string;
  records: { block: Record<string, BlockRecord>; notion_user: Record<string, UserRecord>; collection: Record<string, CollectionRecord> };
  markdown: string;
}

const DIR = path.resolve(__dirname, "../../../spec/fixtures/markdown");
const fixtures: Fixture[] = readdirSync(DIR)
  .filter((f) => f.endsWith(".json"))
  .map((f) => JSON.parse(readFileSync(path.join(DIR, f), "utf8")) as Fixture);

const sourceOf = (f: Fixture): RecordSource => ({
  block: (id) => f.records.block[id],
  user: (id) => f.records.notion_user[id],
  collection: (id) => f.records.collection[id],
});

describe("records → Markdown matches official output", () => {
  it("has fixtures", () => expect(fixtures.length).toBeGreaterThanOrEqual(2));
  for (const f of fixtures) {
    it(f.name, () => {
      const r = renderPage(f.rootId, sourceOf(f), { spaceId: f.spaceId });
      expect(r.unknownBlockIds).toEqual([]);
      expect(r.missing).toEqual({ blocks: [], users: [], collections: [] });
      expect(r.markdown).toBe(f.markdown);
    });
  }
});

describe("Markdown → records → Markdown round trip", () => {
  for (const f of fixtures) {
    it(f.name, () => {
      let n = 0;
      const newId = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
      const built = specsToRecords(parseMarkdown(f.markdown), f.rootId, newId);
      const root: BlockRecord = { id: f.rootId, type: "page", content: built.topLevel, properties: f.records.block[f.rootId]!.properties ?? {} };
      const src: RecordSource = {
        block: (id) => (id === f.rootId ? root : built.blocks.get(id) ?? f.records.block[id]),
        user: (id) => f.records.notion_user[id],
        collection: (id) => built.collections.get(id),
      };
      const r = renderPage(f.rootId, src, { spaceId: f.spaceId });
      expect(r.markdown).toBe(f.markdown);
    });
  }
});

describe("parser details", () => {
  it("reads plain Markdown emphasis, code, links and math", () => {
    expect(parseInline("a **b** *i* ~~s~~ `c` [l](https://x.test/) $x$").text).toEqual([
      ["a "], ["b", [["b"]]], [" "], ["i", [["i"]]], [" "], ["s", [["s"]]], [" "], ["c", [["c"]]], [" "],
      ["l", [["a", "https://x.test/"]]], [" "], ["⁍", [["e", "x"]]],
    ]);
  });

  it("keeps nested tag order inner-first, as the renderer expects", () => {
    expect(parseInline("<i><b>bi</b></i>").text).toEqual([["bi", [["b"], ["i"]]]]);
  });

  it("treats a newline as a soft break and a trailing backslash or <br /> as a hard break", () => {
    const [a, b] = parseMarkdown("one\ntwo\n\nthree\\\nfour<br />five");
    expect(a!.title).toEqual([["one two"]]);
    expect(b!.title).toEqual([["three\nfour\nfive"]]);
  });

  it("parses nested lists, to-dos and numbered lists", () => {
    const specs = parseMarkdown("- a\n  - b\n- [x] done\n1. one\n2. two");
    expect(specs.map((s) => s.type)).toEqual(["bulleted_list", "to_do", "numbered_list", "numbered_list"]);
    expect(specs[0]!.children?.[0]).toMatchObject({ type: "bulleted_list", title: [["b"]] });
    expect(specs[1]!.properties).toEqual({ checked: [["Yes"]] });
  });

  it("maps fence tags to Notion languages", () => {
    expect(parseMarkdown("```ts\nx\n```")[0]!.properties).toEqual({ language: [["TypeScript"]] });
    expect(parseMarkdown("```\nx\n```")[0]!.properties).toEqual({ language: [["Plain Text"]] });
  });

  it("parses an empty paragraph and a header-less table", () => {
    expect(parseMarkdown("<p />")).toEqual([{ type: "text" }]);
    const t = parseMarkdown('<table header-row="false">\n<tr>\n<td>a</td>\n<td>b</td>\n</tr>\n</table>')[0]!;
    expect(t.format).toMatchObject({ table_block_column_header: false });
    expect(t.children?.[0]?.properties).toEqual({ c0: [["a"]], c1: [["b"]] });
  });
});
