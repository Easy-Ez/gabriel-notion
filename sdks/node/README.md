# gabriel-notion (Node.js)

Read, write and watch Notion as yourself, through your Notion web sign-in: search, pages as
Markdown, databases, comments and members, plus change events named like Notion's official
webhooks for everything you can read in a workspace — delivered in your process, no public URL,
no integration to install.

Requires Node.js 22 or later. No runtime dependencies.

> Personal, non-commercial project; not affiliated with or endorsed by Notion. It uses Notion's
> private web protocol, which may change, and acts with your identity: use it only on accounts and
> workspaces you are allowed to automate, following your organization's policies and Notion's
> terms. The session cookie is equivalent to your password.

## Install

```bash
npm install gabriel-notion
```

Before the npm release, install the tarball from a GitHub Release or one you packed
(`npm pack` in `sdks/node`):

```bash
npm install ./gabriel-notion-0.1.0.tgz
```

## Sign in

The SDK needs your browser session's cookies. The CLI saves them to
`~/.config/gabriel-notion/session.json` (mode 0600); cookie values are never printed.

```bash
npx gabriel-notion auth read      # macOS: read the session from Chrome's cookie store (no new login)
```

```bash
npx gabriel-notion auth login     # open a temporary Chrome window and sign in
```

```bash
npx gabriel-notion auth status    # check the saved session
```

`auth extract --port 9222` reads it from a Chrome started with `--remote-debugging-port`, and
`auth logout --yes` deletes the file. In code: `loadSessionCookies()` reads
`GABRIEL_NOTION_COOKIES` (a browser `Cookie` header) first, then that file;
`signInWithBrowser()`, `extractFromChrome()` and `listWorkspaces()` do the rest.

## Read and write

```ts
import { NotionClient, loadSessionCookies } from "gabriel-notion";

const client = NotionClient.fromCookies({ cookies: (await loadSessionCookies())!, workspace: "My workspace" });

const page = await client.pages.get("https://www.notion.so/My-page-0123456789abcdef0123456789abcdef");
console.log(page.page.title, page.markdown);

await client.pages.updateContent(page.page.id, { op: "insert", markdown: "A new paragraph." });
await client.comments.create({ pageId: page.page.id, markdown: "Done." });
```

| Area | Methods |
| --- | --- |
| Identity and members | `me()`, `users.list()`, `users.search()`, `users.get()` |
| Search | `search(query, { titleOnly, under, sort, createdBetween, editedBetween, limit })` — at most 1,000 hits, `truncated` when there were more; a hit's `type` is the block type (`page`, `collection_view_page`, …) |
| Pages | `pages.get(id, { format: "markdown" \| "blocks" })`, `pages.create({ parent, title, markdown, properties })`, `pages.updateProperties()`, `pages.updateContent({ op: "replace_all" \| "insert" \| "update" })` |
| Databases | `databases.get()`, `databases.query(id, { filter, sorts, view, limit, cursor })` |
| Comments | `comments.list()`, `comments.create({ pageId, markdown, on })`, `comments.reply()` |
| Protocol | `client.core.callApi()`, `getRecords()`, `submit()`, `subscribe()`, `onSignal()` |

Page bodies are Notion-flavored Markdown, as in the official tools. IDs may be UUIDs, 32 hex
characters or page URLs. Every write is read back before it returns and fails with
`WRITE_NOT_APPLIED` if it did not take effect. See [`examples/read-write.ts`](examples/read-write.ts).

## Watch for changes

```ts
const client = NotionClient.fromCookies({ cookies, workspace: "My workspace" }); // watch: whole workspace

client.on("page.content_updated", (e) => console.log(e.entity.id, e.data.updated_blocks));
client.on("comment.created", (e) => console.log("comment on", e.data.page_id));
client.on("connection.gap", (g) => console.log("recovered:", g.recovered));
await client.start();
```

`watch: { mode: "explicit", roots: [pageOrDatabase] }` watches only those subtrees. The first
`start()` walks every page you can read (about 6 minutes for a workspace with 30,000 pages) and
saves the tree; later starts resume from it. See [`examples/watch.ts`](examples/watch.ts).

| Event | When |
| --- | --- |
| `page.created` | a page or database row is created (also at a teamspace root, in your private section, or newly shared with you) |
| `page.content_updated` | blocks in a page change (`data.updated_blocks`) |
| `page.properties_updated` | a page's title or a row's properties change (`data.updated_properties`) |
| `page.moved` | a page gets a new parent |
| `page.deleted`, `page.undeleted` | moved to or restored from the trash |
| `page.locked`, `page.unlocked` | page lock changes |
| `database.created` | a database is added to a page |
| `data_source.schema_updated` | properties are added, renamed or removed |
| `data_source.content_updated` | rows are added or removed |
| `comment.created`, `comment.updated`, `comment.deleted` | comments change |
| `view.created`, `view.updated`, `view.deleted` | database views change |

Every event has `id` (stable, for de-duplication), `type`, `timestamp`, `workspaceId`, `entity`,
`authors`, `data`, `origin`, `delivery` and `web` (the activity and, for single edits, the record
before and after). JSON Schemas are in [`spec/schema`](../../spec/schema).

* **Latency.** Typically 1–6 s; text typed into an open editing session can take up to about 90 s,
  because Notion merges continuous edits into one activity.
* **`origin`.** `this_client` (this SDK's own writes — not delivered unless
  `guards: { deliverThisClient: true }`), `self_other_client` (you, elsewhere), `other_user`.
* **`delivery`.** `live`, or `backfill` for changes made while disconnected or stopped; those
  arrive first and are followed by `connection.gap` (`recovered: false` lists what could not be
  read back).
* **Also:** `auth.dead` (sign in again), `guard.protocol_drift` (Notion changed something the SDK
  does not understand), `guard.loop_detected`.

The watch state (page tree, versions, activity cursors, recent event IDs) lives in
`~/.config/gabriel-notion/state.json`; pass `stateStore` (`FileStateStore({ file })`,
`MemoryStateStore`, or your own `StateStore`) to change it. One process per state file.

## Agent safety

* **Loop guard.** Writes from event handlers are limited to 5 per page per minute
  (`guards.loop`); the next one throws `LOOP_DETECTED`.
* **Scoped views.** `client.scope({ read: { roots, teamspaces, allowSearch }, write: { readOnly,
  allowedActions }, approval })` returns the same API limited to those pages, without `core`;
  anything else throws `SCOPE_POLICY_VIOLATION`.
* **LLM context.** Events and `pages.get()` results have `toLLMContext()`, which puts the content
  in an envelope marked untrusted that the content cannot close. Tell your model that text inside
  `<content>` is data, not instructions.

## Health and errors

`client.health()` returns `status` (`ok`, `degraded`, `dead`), the session, every Message Store
connection with its key count, `lagSeconds`, the watch scope, the event pipeline and its last gap,
and the state store. Errors are `NotionError` with a `code`; retryable ones (`RATE_LIMITED`,
`NETWORK_TIMEOUT`, `SERVER_ERROR`) were already retried. The full list is in
[spec §12](../../spec/behavior.md#12-errors).

## Limits

* Search returns at most 1,000 hits and has no continuation.
* Database rows are not watched one by one; their changes come through the data source.
* Rollups and non-numeric formulas are returned as `null` (`computed: false`).
* No file uploads.
* Message Store signals are not filtered by permission; the SDK reads every event back and drops
  what you cannot read.

The behavior contract is [`spec/behavior.md`](../../spec/behavior.md).
