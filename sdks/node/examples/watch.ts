/**
 * Receive change events for a page tree (or the whole workspace).
 *
 *   npx gabriel-notion auth read            # or: auth login
 *   NOTION_WORKSPACE="My workspace" NOTION_ROOT=<page URL or ID> npx tsx examples/watch.ts
 *
 * Without NOTION_ROOT the whole workspace is watched; the first start walks every page you can
 * read (minutes for a large workspace) and later starts resume from the saved state.
 */
import { NotionClient, consoleLogger, loadSessionCookies } from "gabriel-notion";

const cookies = await loadSessionCookies();
if (!cookies) throw new Error("no saved session: run `npx gabriel-notion auth read` or `auth login` first");

const root = process.env.NOTION_ROOT;
const client = NotionClient.fromCookies({
  cookies,
  workspace: process.env.NOTION_WORKSPACE ?? "",
  watch: root ? { mode: "explicit", roots: [root] } : { mode: "workspace" },
  logger: consoleLogger("warn"),
});

client.on("page.content_updated", (e) => {
  console.log(`[${e.delivery}] ${e.entity.id}: ${e.data.updated_blocks.length} block(s) changed by ${e.authors.map((a) => a.id).join(", ")}`);
});
client.on("comment.created", async (e) => {
  console.log("new comment on", e.data.page_id);
  // Writes from handlers are limited per page (LOOP_DETECTED) so a bot cannot answer itself forever.
});
client.on("*", (e) => console.log(e.type, e.entity.type, e.entity.id, e.origin));
client.on("connection.gap", (g) => console.log(`gap ${g.kind}: recovered=${g.recovered}`, g.failed));
client.on("auth.dead", () => console.error("session ended: sign in again"));

await client.start();
console.log("watching", client.health().watch);

process.on("SIGINT", async () => {
  await client.stop();
  process.exit(0);
});
