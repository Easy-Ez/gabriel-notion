/**
 * Read and write a page.
 *
 *   npx gabriel-notion auth read            # or: auth login
 *   NOTION_WORKSPACE="My workspace" NOTION_PAGE=<page URL or ID> npx tsx examples/read-write.ts
 *
 * Writes go to NOTION_PAGE: use a page you may change.
 */
import { NotionClient, isNotionError, loadSessionCookies } from "gabriel-notion";

const cookies = await loadSessionCookies();
if (!cookies) throw new Error("no saved session: run `npx gabriel-notion auth read` or `auth login` first");

const client = NotionClient.fromCookies({ cookies, workspace: process.env.NOTION_WORKSPACE ?? "" });
const pageId = process.env.NOTION_PAGE ?? "";

// Read: metadata, properties (database rows) and the body as Notion-flavored Markdown.
const page = await client.pages.get(pageId);
console.log(page.page.title, page.page.url);
console.log(page.markdown?.split("\n").slice(0, 5).join("\n"));

// Search (at most 1,000 hits; `truncated` says when there were more).
const { results, truncated } = await client.search("meeting notes", { limit: 10 });
console.log(results.length, "hits", truncated ? "(truncated)" : "");

// Write: append a paragraph, then comment on the page. Every write is read back before it returns.
try {
  await client.pages.updateContent(pageId, { op: "insert", markdown: "Added by gabriel-notion." });
  await client.comments.create({ pageId, markdown: "Looks good." });
} catch (err) {
  if (isNotionError(err)) console.error(err.code, err.message);
  else throw err;
}

// Hand page content to an LLM inside an envelope marked untrusted.
console.log(page.toLLMContext().slice(0, 300));
