# gabriel-notion

[![npm](https://img.shields.io/npm/v/gabriel-notion)](https://www.npmjs.com/package/gabriel-notion)

Read, write and watch Notion as yourself, through your Notion web sign-in: search, pages as
Markdown, databases, comments and members, plus change events named like Notion's official
webhooks for everything you can read in a workspace — delivered in your process, no public URL,
no integration to install.

Node.js 22 or later. No runtime dependencies. 中文使用指南见 [docs/zh-CN/guide.md](../../docs/zh-CN/guide.md).

> [!IMPORTANT]
> Personal, non-commercial project; not affiliated with or endorsed by Notion. It uses Notion's
> private web protocol, which may change, and acts with your identity: use it only on accounts and
> workspaces you are allowed to automate, following your organization's policies and Notion's
> terms. The session cookie is equivalent to your password.

## Contents

- [Install](#install)
- [Credentials](#credentials)
- [Quick start](#quick-start)
- [The client](#the-client)
- [Identity and members](#identity-and-members)
- [Search](#search)
- [Pages](#pages)
- [Property values](#property-values)
- [Databases](#databases)
- [Comments](#comments)
- [Markdown](#markdown)
- [Events](#events)
- [Watching](#watching)
- [Reliability](#reliability)
- [AI safety](#ai-safety)
- [Health](#health)
- [Errors](#errors)
- [Low-level core](#low-level-core)
- [Configuration reference](#configuration-reference)
- [CLI](#cli)
- [Limits](#limits)

## Install

```bash
npm install gabriel-notion
```

## Credentials

The only credential is your browser session's cookie set (`token_v2` and its companions). The SDK
keeps it in memory, never logs it, and sends it only to `https` / `wss` Notion hosts.

The CLI saves a session to `~/.config/gabriel-notion/session.json` (mode 0600):

| Command | What it does |
| --- | --- |
| `npx gabriel-notion auth read [--profile <name>]` | macOS: decrypt the session from Chrome's cookie store; picks the only signed-in profile, lists them when several are |
| `npx gabriel-notion auth login [--google] [--email <a>]` | Open a Chrome window with a temporary profile; sign in; the window closes |
| `npx gabriel-notion auth extract [--port 9222]` | Read the session from a Chrome you started with `--remote-debugging-port` |
| `npx gabriel-notion auth status` | Verify the saved session and list its workspaces |
| `npx gabriel-notion auth logout --yes` | Delete the saved file (the session itself stays valid on Notion's side) |

In code:

```ts
import { loadSessionCookies, signInWithBrowser, extractFromChrome, listWorkspaces } from "gabriel-notion";

const cookies = await loadSessionCookies();             // GABRIEL_NOTION_COOKIES, then the saved file
const signedIn = await signInWithBrowser({ timeoutMs: 300_000 }); // { cookies, userId, workspaces }
const fromChrome = await extractFromChrome();            // macOS + Google Chrome
const { workspaces } = await listWorkspaces({ cookies: cookies! }); // verify stored cookies
```

| Function | Returns | Notes |
| --- | --- | --- |
| `loadSessionCookies({ env?, store? })` | `CookieInput[] \| undefined` | `GABRIEL_NOTION_COOKIES` (a browser `Cookie` header, must contain `token_v2`), then the store (default: the CLI's file) |
| `signInWithBrowser({ email?, provider?: "google", timeoutMs?, signal?, browserPath?, onStatus? })` | `{ cookies, userId, workspaces }` | Fails with `BROWSER_NOT_FOUND`, `SIGN_IN_TIMEOUT`, `CANCELLED` or `AUTH_DEAD` |
| `extractFromChrome({ profile? })` / `listChromeSessions()` | `ChromeSession` / `ChromeSession[]` | `{ profile, profileName?, userId, email?, workspaces, cookies }`; one Keychain read; app-bound (`v20`) cookies are not supported |
| `extractFromDebugChrome({ port? = 9222 })` | `{ cookies, userId, workspaces }` | Talks only to `127.0.0.1` |
| `listWorkspaces({ cookies, userId? })` | `{ userId, workspaces }` | `AUTH_DEAD` when the session is gone |
| `new FileCredentialStore(file?)` | `CredentialStore` | `load()` / `save()` / `clear()`; 0600 file, atomic writes |

Notion may rotate `token_v2`. Pass `credentialStore` to the client to have every rotation written
back (debounced, 1 s), so the next run starts from the current value.

## Quick start

```ts
import { NotionClient, loadSessionCookies } from "gabriel-notion";

const client = NotionClient.fromCookies({ cookies: (await loadSessionCookies())!, workspace: "My workspace" });

// Read and write
const page = await client.pages.get("https://www.notion.so/My-page-0123456789abcdef0123456789abcdef");
console.log(page.page.title, page.markdown);
await client.pages.updateContent(page.page.id, { op: "insert", markdown: "A new paragraph." });

// Watch
client.on("page.content_updated", (e) => console.log(e.entity.id, e.data.updated_blocks));
client.on("comment.created", (e) => console.log("new comment on", e.data.page_id));
await client.start();
```

Runnable versions: [`examples/read-write.ts`](examples/read-write.ts), [`examples/watch.ts`](examples/watch.ts).

## The client

```ts
const client = NotionClient.fromCookies(options); // see Configuration reference
```

`fromCookies` is synchronous and sends nothing. One client acts as one account in one workspace,
given by ID or exact name and resolved on the first call (`INVALID_ARGUMENT` if the account is not
a member). Read and write methods work without `start()`; events are delivered only after it.

IDs in every method may be a hyphenated UUID, 32 hex characters, or a Notion page URL (including
`?p=` peek URLs). IDs in results are lower-case hyphenated UUIDs.

| Member | |
| --- | --- |
| `start(): Promise<void>` | Validate the session, open the state store, walk or resume the page tree, subscribe |
| `stop(): Promise<void>` | Close connections, flush state and credentials |
| `on(type, handler): () => void` | Subscribe to an event; returns an unsubscribe function |
| `health(): ClientHealth` | See [Health](#health) |
| `scope(policy): ScopedNotionClient` | See [Scoped views](#scoped-views) |
| `getWorkspace(): Promise<Workspace>` | The bound workspace `{ id, name }` |
| `core: NotionCore` | See [Low-level core](#low-level-core) |

## Identity and members

```ts
client.me(): Promise<User & { workspaces: Workspace[] }>
client.users.list({ type?: "members" | "guests", query?, cursor?, limit? = 100 }): Promise<Page<User>>
client.users.search(query, { limit? = 20 }): Promise<User[]>
client.users.get(userId): Promise<User>
```

`User` is `{ id, name?, email?, type? }`. `Page<T>` is `{ results: T[], hasMore, nextCursor? }`;
`users.list` uses the server's cursor.

## Search

```ts
client.search(query, {
  titleOnly?: boolean,
  under?: string,                                   // a page or database: search inside it
  sort?: "relevance" | "created" | "lastEdited", direction?: "asc" | "desc",
  createdBetween?: [Date, Date], editedBetween?: [Date, Date],
  limit?: number,                                   // 1–1000, default 20
}): Promise<{ results: SearchHit[]; truncated: boolean }>
```

`SearchHit` is `{ id, title, type, url, parent?, lastEditedTime?, highlight? }`; `type` is the
block type (`page`, `collection_view_page`, …) and `highlight` the matching excerpt as plain text.

The server returns at most 1,000 hits and has no continuation, so the SDK does not invent a cursor.
When `truncated` is `true`, narrow the query (`under`, date ranges) instead of paging.

## Pages

### `pages.get`

```ts
client.pages.get(id, { format?: "markdown" | "blocks", signal? }): Promise<PageResult>
```

| Field | Type | |
| --- | --- | --- |
| `page` | `PageMeta` | `{ id, url, title, parent?, icon?, cover?, locked, createdTime?, lastEditedTime?, createdBy?, lastEditedBy? }` |
| `properties` | `Record<string, PropertyValue>` | Database rows only, keyed by property name; see [Property values](#property-values) |
| `markdown` | `string` | Default format: the whole page as [Notion-flavored Markdown](#markdown) |
| `blocks` | `Block[]` | With `format: "blocks"`: the raw block records as a tree (`children`), stopping at child pages and databases |
| `unknownBlockIds` | `string[]` | Blocks the Markdown renderer does not support (left out) |
| `toLLMContext()` | `() => string` | Non-enumerable; see [LLM context](#llm-context) |

The whole subtree is read, however large (a page of 5,000 blocks takes a few seconds).
`parent.type` is `page`, `block`, `database`, `teamspace` or `workspace`.

### `pages.create`

```ts
client.pages.create({
  parent: { pageId } | { databaseId } | { teamspaceId } | { private: true },
  title?: string,
  markdown?: string,
  properties?: Record<string, PropertyInput>,      // database rows: by property name
  icon?: string, cover?: string,
}): Promise<PageMeta & { warnings: string[] }>
```

* Without `title`, a leading `# Heading` in the Markdown becomes the title (not a block), as in the
  official tools.
* Elements that can only refer to existing blocks — existing subpages, databases, synced blocks,
  files — are not created; each is reported in `warnings`.
* The page is read back before the call returns.

### `pages.updateProperties`

```ts
client.pages.updateProperties(id, { title: "New title", Status: "Done", Due: { start: "2026-12-01" } }): Promise<PageMeta>
```

Sets the title of any page and the properties of a database row, by property name (the title is
also reachable as `title`). Read-only properties (formula, rollup, created / edited time and by,
unique ID, button) and file properties fail with `INVALID_ARGUMENT`.

### `pages.updateContent`

```ts
client.pages.updateContent(id, edit): Promise<{ changedBlockIds: string[]; warnings: string[] }>
```

| `edit` | Effect | Official equivalent |
| --- | --- | --- |
| `{ op: "replace_all", markdown }` | Replace every ordinary block; child pages and inline databases stay. Blocks the Markdown names (for example a paragraph carrying a comment anchor) are kept in place and rewritten, not recreated. One transaction | `replace_content` |
| `{ op: "insert", markdown, after?, before? }` | Insert blocks after / before a top-level block, or at the end | `insert_content` |
| `{ op: "update", find, replace, all? }` | Find and replace inside one block's inline Markdown; keeps discussion anchors so comments stay attached. `all` replaces every match | `update_content` |

`after` / `before` take a `BlockAnchor`: a top-level block ID, or `{ text }` matching exactly one
top-level block's text. A `find` that spans blocks fails with `INVALID_ARGUMENT`.

Every write is read back before it returns and fails with `WRITE_NOT_APPLIED` if the server
answered 200 but the change is not there.

## Property values

Reading (`PropertyValue`, in `PageResult.properties` and `Row.properties`): every value is
`{ id, type, value }`.

| `type` | `value` |
| --- | --- |
| `title`, `text`, `url`, `email`, `phone_number` | `string` |
| `number` | `number \| null` |
| `select`, `status` | `string \| null` |
| `multi_select` | `string[]` |
| `checkbox` | `boolean` |
| `date` | `{ start_date, end_date?, … } \| null` |
| `person`, `relation` | `string[]` (user or page IDs) |
| `file` | `Array<{ name, source }>` |
| `created_time`, `last_edited_time` | ISO string |
| `created_by`, `last_edited_by` | user ID |
| `formula`, `rollup` | `number \| null`, with `computed: boolean` — numeric formulas are computed; other formulas and rollups are `null` with `computed: false` |

Writing (`PropertyInput`):

| Property type | Input |
| --- | --- |
| `title`, `text` | `string` (inline Markdown allowed) |
| `url`, `email`, `phone_number`, `select`, `status` | `string` |
| `number` | `number` (or a numeric string) |
| `checkbox` | `boolean` |
| `multi_select` | `string[]` |
| `date` | `"2026-12-01"` or `{ start, end? }` |
| `person` | `{ users: string[] }` (or `string[]`) |
| `relation` | `{ pages: string[] }` |
| any writable type | `null` clears the value |

## Databases

```ts
client.databases.get(id): Promise<{ database: DatabaseMeta; schema: Record<string, PropertySchema>; views: ViewMeta[] }>
client.databases.query(id, { filter?, sorts?, view?, limit? = 100, cursor?, signal? }): Promise<Page<Row>>
```

* `id` is the database's block (full-page or inline). `DatabaseMeta` is
  `{ id, dataSourceId, title, url, inline }`; `ViewMeta` is `{ id, type, name }`;
  `PropertySchema` is `{ name, type, options? }` keyed by property ID.
* `Row` is `PageMeta` plus `properties`. `limit` is 1–1000.
* `view` picks the view whose context the query runs in; default the first view.
* Filters use the web client's format, with property **names** instead of IDs:

```ts
await client.databases.query(db, {
  filter: {
    operator: "and",
    filters: [
      { property: "Status", filter: { operator: "enum_is", value: { type: "exact", value: "Done" } } },
      { property: "Estimate", filter: { operator: "number_greater_than", value: { type: "exact", value: 5 } } },
    ],
  },
  sorts: [{ property: "Due", direction: "ascending" }],
  limit: 50,
});
```

A single leaf filter is wrapped in an `and` group for you. Unknown property names fail with
`INVALID_ARGUMENT`.

**Paging.** The server has no continuation, but returns every matching row ID at once (12,000 rows
in about 3 s). The first page caches that list for 10 minutes and `nextCursor` encodes the query and
the offset, so pages never overlap or skip while the cache lives. After it expires the same cursor
re-runs the query and resumes at the offset.

## Comments

```ts
client.comments.list(pageId, { includeResolved? = false }): Promise<Discussion[]>
client.comments.create({ pageId, markdown, on?: { blockId } | { blockId, selection } }): Promise<Comment>
client.comments.reply(discussionId, markdown): Promise<Comment>
```

* `Discussion` is `{ id, blockId, resolved, context?, comments: Comment[] }`; `context` is the text an
  inline comment refers to.
* `Comment` is `{ id, discussionId, authorId?, createdTime?, lastEditedTime?, markdown, text }`.
* Without `on` the comment is page-level; `{ blockId }` attaches it to a block;
  `{ blockId, selection }` makes an inline comment on that exact text inside the block.

## Markdown

Page bodies are read and written as Notion-flavored Markdown, the format Notion's official tools
use; reading reproduces their output byte for byte on the shared fixtures.

| Element | Markdown |
| --- | --- |
| Paragraph, headings, lists, to-do, quote, divider, code, equation, table | Standard Markdown (`#`, `- `, `1. `, `- [x] `, `> `, `---`, fenced code with language, `$$…$$`, pipe tables) |
| Inline styles | `<b>`, `<i>`, `<s>`, `<u>`, `<code>`, `[text](url)`, `$math$`; plain `**`, `*`, `~~` and backticks are accepted when writing |
| Colors | `<span color="red">…</span>`, `<callout icon="💡" color="yellow_bg">` |
| Toggle, callout, columns, synced block | `<toggle>`, `<callout>`, `<columns><column>`, `<synced-block>` — title on the line after the tag, then a blank line, then children |
| Mentions and dates | `<mention url="user://…">Name</mention>`, `<mention url="https://…/p/…">Page</mention>`, `<date start="2026-11-18" />` |
| Child page, database | `<page url="…">Title</page>`, `<database url="…" inline="true">Title</database>` |
| Files, images, bookmarks | `<file source="…" />`, `![](url)`, `<bookmark source="…" />` |
| Comment anchors | `<span discussion-urls="discussion://…">text</span>` |

Block types the renderer does not know are left out and listed in `unknownBlockIds`. The codec is
also exported as `markdown` (`renderPage`, `parseMarkdown`, `parseInline`, `plainText`).

## Events

```ts
client.on("page.content_updated", (e) => { … });   // one type
client.on("*", (e) => { … });                       // every change event
```

Handlers may be async; errors they throw are logged and do not stop delivery.

| Event | When | `data` |
| --- | --- | --- |
| `page.created` | A page or row is created — under a watched page, in a database, at a teamspace root, in your private section, or a page newly shared with you | `parent` |
| `page.content_updated` | Blocks in a page are added, changed or removed | `parent`, `updated_blocks: [{ id, type: "block" }]` |
| `page.properties_updated` | The title or row properties change | `parent`, `updated_properties: [propertyId]` |
| `page.moved` | A page gets a new parent | `parent` (the new one) |
| `page.deleted` / `page.undeleted` | Moved to / restored from the trash | `parent` |
| `page.locked` / `page.unlocked` | Page lock changes | `parent` |
| `database.created` | A database is added to a page | `parent` |
| `data_source.schema_updated` | Properties added, renamed / retyped, or removed | `parent`, `updated_properties: [{ id, name?, action: "created" \| "updated" \| "deleted" }]` |
| `data_source.content_updated` | Rows added or removed | `parent`, `updated_blocks: [{ id, type: "page" }]` |
| `comment.created` / `.updated` / `.deleted` | Comments change | `page_id`, `parent`, `discussion_id` |
| `view.created` / `.updated` / `.deleted` | Database views change | `parent`, `data_source_id` |

`parent` is `{ type: "page" | "block" | "database" | "space" | "team", id, data_source_id? }`
(`space` is the workspace root, `team` a teamspace root; rows carry `data_source_id`).

Every event (`NotionEvent`, JSON Schemas in [`spec/schema`](../../spec/schema)):

| Field | |
| --- | --- |
| `id` | Stable ID for de-duplication: a hash of the edits the event covers |
| `type`, `timestamp` | Event type; time of the (last) edit, ISO 8601 |
| `workspaceId`, `entity` | `{ id, type: "page" \| "block" \| "database" \| "data_source" \| "view" \| "comment" }` |
| `authors` | `[{ id, type: "person" \| "bot" }]` |
| `origin` | `this_client` (this SDK instance's own writes — **not delivered** unless `guards.deliverThisClient`), `self_other_client` (your account, elsewhere), `other_user` |
| `delivery` | `live`, or `backfill` for changes made while disconnected or stopped |
| `web` | `{ activityId, edits, before?, after? }` — the record before / after, when the event covers one edit |
| `toLLMContext()` | Non-enumerable; see [LLM context](#llm-context) |

Several edits of the same kind to the same entity found in one read become one event (for
example one `page.content_updated` listing several blocks).

Other events: `connection.gap` ([Reliability](#reliability)), `auth.dead` (sign in again),
`guard.protocol_drift` (Notion sent something the SDK does not understand: `{ kind, sample? }`),
`guard.loop_detected` ([Loop guard](#loop-guard)).

**Latency.** Most changes arrive in 1–6 s. Text typed continuously in Notion's editor is merged
into one activity, and part of it can take up to about 90 s.

## Watching

```ts
NotionClient.fromCookies({ …, watch: { mode: "workspace" } })                   // default
NotionClient.fromCookies({ …, watch: { mode: "explicit", roots: [pageOrDb, …] } })
```

* `workspace` covers what you can read: the workspace root, your private section, every teamspace
  you can read, pages shared with you, and everything under them. New pages, databases, shared
  pages and teamspaces are picked up as they appear.
* `explicit` covers the given pages and databases and everything under them.
* Database rows are not watched one by one; their changes arrive through the data source.
* The first `start()` walks the whole tree (a workspace with 30,000 pages takes about 6 minutes)
  and saves it. Later starts subscribe to the saved tree at once and re-walk in the background.
  `rescanIntervalMs` (default 6 h, `0` disables) re-walks periodically to catch anything missed.
* Pages you cannot read produce no events, even though Notion's realtime signals reach the SDK.

**State.** The tree, subscription versions, activity cursors and the last 10,000 event IDs live in
a `StateStore`:

| Store | |
| --- | --- |
| `new FileStateStore({ file?, flushDelayMs? = 1000 })` | Default; `~/.config/gabriel-notion/state.json`. Atomic writes (temp file, fsync, rename), one process per file |
| `new MemoryStateStore()` | Nothing survives a restart; for tests and short jobs |
| your own | Implement `get`, `set`, `delete`, `batch`, `keys`, `flush`, `close`, `health` |

## Reliability

* The connection answers both heartbeat layers and reconnects with backoff (1 s to 30 s).
* After a disconnect or a restart, the SDK resubscribes with the versions it last saw; Notion then
  signals only what changed meanwhile, and those pages are read back. Their events arrive with
  `delivery: "backfill"`, **before** any live event, and the recovery ends with:

```ts
client.on("connection.gap", (g) => {
  // { kind: "reconnect" | "restart", from, to, recovered, failed: [entityId], entities, events }
  if (!g.recovered) console.warn("could not read back", g.failed);
});
```

* Events are de-duplicated by `id`, and the read position is saved with the delivered events in
  one atomic write, so a crash neither skips nor repeats them.
* After `auth.dead` the SDK stops reading; sign in again and start a new client.

## AI safety

### Origin

Writes by this SDK instance are registered before they are sent; the events they cause are marked
`this_client` and not delivered (set `guards: { deliverThisClient: true }` to see them). Your own
edits from the browser or another client stay `self_other_client`. A bot that should only react to
other people checks `e.origin === "other_user"`.

### Loop guard

Writes made inside an event handler (and anything it awaits) are limited to **5 per page per
minute**. The next one throws `LOOP_DETECTED` before anything is sent and emits
`guard.loop_detected` `{ target, count, windowMs, eventId }`. Tune with
`guards: { loop: { maxWrites, windowMs } }`.

### Scoped views

```ts
const tools = client.scope({
  read: { roots: [projectPage], teamspaces: [teamId], allowSearch: true, allowUsers: false },
  write: { readOnly: false, allowedActions: ["comments.create", "pages.updateContent"] },
  approval: async (action, params) => askAHuman(action, params),
});
```

The view has the read and write API (`me`, `users`, `search`, `pages`, `databases`, `comments`)
but no `core`, `on`, `start` or `stop`. A page is in scope when it sits under a root or in an
allowed teamspace; search hits outside are dropped. Anything else throws
`SCOPE_POLICY_VIOLATION` before a request is sent. `allowedActions` take `pages.create`,
`pages.updateProperties`, `pages.updateContent`, `comments.create`, `comments.reply`.

### LLM context

```ts
const prompt = page.toLLMContext();      // or event.toLLMContext()
```

```text
<notion_page untrusted="true">
  <meta>
    id: …
    title: …
  </meta>
  <content>
  …the page's Markdown…
  </content>
</notion_page>
```

Metadata is kept apart from the body, and any text in the content that could open or close these
tags is defused. Tell the model that text inside `<content>` is data, not instructions.

## Health

```ts
client.health(): {
  status: "ok" | "degraded" | "dead",
  session: { state: "VALID" | "CHECKING" | "AUTH_DEAD", … },
  connections: [{ id, state, keys, capacity, connectedForMs?, reconnects, lastCloseCode? }],
  lagSeconds: number,        // age of the oldest change not yet delivered
  events?: { watched, openWindows, lagSeconds, recovering, lastGap?, lastError? },
  watch?: { mode, pages, dataSources, containers, scanning, scans, lastScanAt?, lastError? },
  state?: { persistent, pending, lastFlushedAt?, lastError? },
}
```

`degraded` means a connection is not ready, a recovery is running or did not recover everything,
or a read or the state store failed. Nothing in `health()` contains cookie values.

## Errors

Every rejection is a `NotionError` with `code`, `message`, `retryable`, and for HTTP failures
`status` and `rawError` (the server's error name and message). Retryable codes have already been
retried with backoff; do not wrap calls in another retry loop.

```ts
import { isNotionError } from "gabriel-notion";

try {
  await client.pages.get(id);
} catch (err) {
  if (isNotionError(err, "NOT_FOUND")) console.log("missing, or not shared with you");
  else throw err;
}
```

| Code | Meaning |
| --- | --- |
| `RATE_LIMITED`, `NETWORK_TIMEOUT`, `SERVER_ERROR` | Retryable; retries exhausted |
| `AUTH_DEAD` | The session is gone; sign in again |
| `NOT_FOUND` | Does not exist **or** you cannot read it (Notion does not distinguish) |
| `PERMISSION_DENIED` | 403, or your role is too low for the write |
| `WRITE_REJECTED` | The server refused the transaction |
| `WRITE_NOT_APPLIED` | The server said 200 but the read-back does not show the change |
| `INVALID_ARGUMENT`, `INVALID_STATE` | Bad input, or the call does not fit the current state |
| `CANCELLED` | Aborted through a `signal` |
| `BROWSER_NOT_FOUND`, `SIGN_IN_TIMEOUT` | Interactive sign-in |
| `SCOPE_POLICY_VIOLATION`, `LOOP_DETECTED` | Guards |
| `SUBSCRIPTION_CAP_EXCEEDED`, `STATE_STORE_UNAVAILABLE` | Watching |
| `NOTION_API_ERROR` | Anything else the server answered |

## Low-level core

`client.core` (`NotionCore`) speaks the protocol directly, for what the client does not cover:

| Member | |
| --- | --- |
| `callApi(endpoint, body, { spaceId?, retry?, timeoutMs?, signal? })` | Any `/api/v3/<endpoint>` with session, workspace header and retries |
| `getRecords([{ table, id, spaceId? }])` | Record reads in batches of 1,000; `Map<"table:id", { role, value }>` |
| `records.get({ table, id })` | One record; `NOT_FOUND` when unreadable |
| `submit(operations, { userAction? })` | One atomic transaction (registered for origin and the loop guard) |
| `newBlockId()` / `newRecordId()` | IDs in the web client's layouts |
| `subscribe(keys)` / `unsubscribe(keys)` / `onSignal((key, version, value) => …)` | Raw realtime signals, e.g. `versions/<pageId>:block` |
| `messageStore` | The connection pool (`health()`, events) |
| `confirmSession()` / `onAuthDead(listener)` | Session checks |

`NotionCore` can also be constructed on its own with the client's options minus `workspace`; call
`bindWorkspace(id)` before writes.

## Configuration reference

`NotionClient.fromCookies(options)`:

| Option | Default | |
| --- | --- | --- |
| `cookies` | required | `CookieInput[]` or a name → value map |
| `workspace` | required | Workspace ID or exact name |
| `userId` | `notion_user_id` cookie | Account to act as when the session holds several |
| `watch` | `{ mode: "workspace" }` | `{ mode: "explicit", roots }`; both take `rescanIntervalMs` (6 h) |
| `stateStore` | `FileStateStore` | See [Watching](#watching) |
| `guards` | — | `{ deliverThisClient?: false, loop?: { maxWrites?: 5, windowMs?: 60_000 } }` |
| `credentialStore` | — | Write rotated cookies back; `credentialSaveDelayMs` 1,000 |
| `logger` | silent | pino-style `{ debug, info, warn, error }(obj, msg)`; `consoleLogger(level)` is exported |
| `fetch` | global `fetch` | Inject for tests or proxies |
| `webSocketFactory` | Node's `WebSocket` | `(url, { headers }) => WebSocketLike` |
| `timeoutMs` / `maxRetries` | 30,000 / 3 | HTTP |
| `userAgent`, `clientVersion`, `apiBase`, `messageStoreUrl` | browser-like | Rarely needed |
| `anonymousRealtime` | `false` | Connect to the realtime service without cookies (it does not need them) |
| `maxKeysPerConnection` / `maxConnections` | 40,000 / 4 | Realtime subscription sharding |
| `events` | — | Tuning: `coalesceMs` 1,000, `recordSignalDelayMs` 5,000, `rereadMs` 90,000, `quietMs` 600,000, `catchUpMs` 5,000 |

## CLI

```text
gabriel-notion auth login [--google] [--email <address>]
gabriel-notion auth read [--profile <name>]
gabriel-notion auth profiles
gabriel-notion auth extract [--port <n>]
gabriel-notion auth status
gabriel-notion auth logout --yes
```

Cookie values are never printed. `GABRIEL_NOTION_CONFIG_DIR` (or `XDG_CONFIG_HOME`) moves the saved
session and the default state file.

## Limits

* Search returns at most 1,000 hits, without continuation.
* Rollups and non-numeric formulas are not computed (`computed: false`).
* No file uploads; file blocks named in Markdown must already exist.
* Notion's realtime service signals changes without checking permissions; the SDK reads every
  event back and drops what you cannot read, but anyone who knows a page ID can learn when it
  changes.
* The protocol is private and can change; `guard.protocol_drift` reports what the SDK no longer
  understands.

The behavior contract every Gabriel Notion SDK follows is [`spec/behavior.md`](../../spec/behavior.md);
how this one is built is in [`docs/architecture.md`](../../docs/architecture.md).

## License

[MIT](LICENSE)
