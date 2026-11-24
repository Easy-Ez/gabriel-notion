# Gabriel Notion SDK Behavior Specification

Status: v0.1 (2026-11-24). The rules are derived from observing the Notion web client and from
tests against real workspaces; where a rule rests on an inference, it says so.
The key words MUST, SHOULD and MAY are used as in RFC 2119.

## 1. Scope

A Gabriel Notion SDK acts as one person through the session of their Notion web sign-in. It
reads and writes pages, databases and comments with the same capabilities as Notion's official
REST API and MCP server, and delivers change events named like the official webhooks for
everything the person can read in one workspace, in the calling process. It uses Notion's
private web protocol, which may change; protocol drift is reported (§8.2), not hidden.

Out of scope for v0.1: file uploads, official-API compatibility of request shapes, sharing one
watcher between processes, and workspaces other than the bound one.

### 1.1 State

SDKs persist the watch state through a replaceable `StateStore` so a restart resumes instead of
re-walking the workspace: the page tree, the last Message Store version of every subscription
key, the activity cursor of every watched page and data source, and the most recent event IDs
(at least **10,000**) used for de-duplication.

* The store is a string key/value map with `get`, `set`, `delete`, `batch` (several writes as one
  unit), `keys(prefix)`, `flush`, `close` and `health()`. Keys are namespaced per workspace
  (`notion/<workspaceId>/…`), so one store can serve several clients.
* Every write is atomic: after a crash, storage holds the state before the call or after it,
  never part of it. A write MAY be buffered briefly; a crash can then lose the last buffered
  writes but never tear one. The activity cursor and the event IDs it produced MUST be written in
  one `batch`, so a crash can neither skip nor re-deliver those events.
* When storage cannot be read or written, calls reject with `STATE_STORE_UNAVAILABLE`, the
  failure is reported in `health()`, and a rejected write is not applied.
* SDKs ship two stores:
  * `MemoryStateStore`: not persistent; for tests and short-lived jobs.
  * `FileStateStore` (default): one JSON file, by default `state.json` next to the credential
    file (§3). It writes a whole snapshot to a temporary file in the same directory, fsyncs it,
    renames it over the old file and fsyncs the directory; the file is 0600 and the directory
    0700. Writes are debounced (default 1 s); after a failed write the next change retries at once
    and rejects if storage is still down. Leftover temporary files are deleted on load; a corrupt
    or unknown-format file is not overwritten but fails with `STATE_STORE_UNAVAILABLE`. A
    `<file>.lock` holding the owner's PID admits one process at a time; a lock whose process is
    gone is taken over.

## 2. Layers

* **Core** (`NotionCore`) speaks the protocol: session and cookies (§3), HTTP and retries (§4),
  records, transactions and IDs (§5), and the Message Store connection (§7). It sends nothing on
  its own beyond what callers ask for, plus the session check on 401, and returns server
  responses unmodified.
* **Client** (`NotionClient`) builds on Core only: the read and write API with Markdown (§6), the
  event pipeline (§8), watch scope (§9), recovery (§10) and guards (§11). It exposes Core as
  `client.core`; scoped views (§11.3) do not.
* One client acts as one account in one workspace. The workspace is resolved on first use, by ID
  or exact name.
* Every public call rejects with an error carrying one of the codes in §12; errors, logs, events
  and `health()` never contain cookie values (§3).
* `health()` reports `status` (`ok`, `degraded`, `dead`), the session state, every Message Store
  connection with its key count, `lagSeconds`, the watch scope (§9), the event pipeline and its
  last gap (§10), and the state store (§1.1).

## 3. Credentials and session

1. The only credential is the browser session's cookie set (`token_v2` and its companions). SDKs
   MUST keep it in memory only, apply every `Set-Cookie` from responses (including deletions via
   `Max-Age=0` or a past `Expires`), and match cookies by domain and path (`file_token` is scoped
   to `/f`).
   * SDKs MUST NOT write the cookies anywhere by default. When the caller configures a
     credential store, the SDK MUST call `save(snapshot)` (debounced, default 1 s) whenever the
     value of a session cookie changes or it is removed: `token_v2`, `__Host-session_binding`,
     `notion_user_id`, `notion_users`, `file_token`. Other cookies do not trigger a save. A failed
     save MUST NOT fail requests; it is reported by error code in `health()`.
   * The built-in file store uses a 0700 directory and a 0600 file written atomically, and MUST
     refuse to load a file other users can read. `loadSessionCookies()` reads
     `GABRIEL_NOTION_COOKIES` (a browser `Cookie` header, must contain `token_v2`) first, then the
     store.
   * Sign-in: SDKs open a Chrome / Chromium window with a fresh temporary profile and
     `--remote-debugging-port=0`, read the DevTools endpoint from `DevToolsActivePort`, and poll
     `Storage.getCookies` until a Notion-domain `token_v2` appears. The cookies are verified with
     `getSpaces`; an `AUTH_DEAD` result is tolerated for 30 s (SSO redirects) before it fails the
     sign-in. Only `notion.com` / `notion.so` cookies are returned. The window is closed and the
     profile deleted on every outcome; nothing is printed or written elsewhere. Errors:
     `BROWSER_NOT_FOUND`, `SIGN_IN_TIMEOUT` (default 300 s), `CANCELLED` (aborted, or the window
     closed), `AUTH_DEAD`.
   * Extraction from a profile's cookie store (macOS) reads the Chromium `Cookies` SQLite DB,
     decrypts `v10` values with the key derived from the "Chrome Safe Storage" Keychain item
     (PBKDF2-HMAC-SHA1, salt "saltysalt", 1003 iterations, AES-128-CBC), keeps only
     `notion.com` / `notion.so` cookies, and verifies them. SDKs SHOULD enumerate every
     profile (one Keychain read, shared across profiles), return only sessions that verify, and
     auto-pick when exactly one is signed in. App-bound (`v20`) cookies are not
     supported; fall back to sign-in. Chrome's cookie files are copied, never written.
   * Extraction from a running browser reads `Storage.getCookies` through the DevTools endpoint of
     a Chrome the person started with `--remote-debugging-port`, contacting only `127.0.0.1`, and
     verifies the result like sign-in. SDKs MUST NOT read the browser's cookie files on disk.
2. One session can hold several accounts. The active account is the caller's `userId`, else the
   `notion_user_id` cookie, else the only account `getSpaces` returns; otherwise fail with
   `INVALID_ARGUMENT`. A client binds one workspace, given by ID or exact name.
3. Session state machine: `VALID → CHECKING → VALID | AUTH_DEAD`.
   * Triggers: an HTTP 401 on any request, or a read that returned 200 without its record.
   * The check is `POST /api/v3/authValidate` with an empty body: 200 means valid, 401 means dead.
     A transport failure during the check leaves the state unchanged and surfaces to the caller.
   * Concurrent triggers MUST collapse into one check (singleflight). After a passing check the
     failed request is replayed once; a second 401 surfaces as `NOTION_API_ERROR`.
   * `AUTH_DEAD` is terminal: emit `auth.dead` once and fail every later HTTP call with
     `AUTH_DEAD` without sending it. SDKs MUST NOT re-login on their own.
4. Errors, logs, events, `health()` and object inspection MUST NOT contain cookie values; only
   cookie names may appear.

## 4. HTTP

* Requests: `POST https://app.notion.com/api/v3/<endpoint>`, JSON body, headers
  `content-type: application/json`, `x-notion-active-user-header: <userId>` and
  `x-notion-space-id: <spaceId>` (omitted only for account-level calls such as `getSpaces` and
  `authValidate`). `notion-client-version` is optional. Default timeout **30 s**.
* Credentials MUST only be sent to `https` hosts under `notion.com` or `notion.so`.
* Retry classes, with full-jitter exponential backoff (base 500 ms, cap 8 s, at most 3 retries):
  * Read-only endpoints (`get*`, `load*`, `sync*`, `search*`, `query*`, `list*`, `find*`,
    `check*`, `authValidate`) are retried on 429, 5xx and network errors.
  * Every other endpoint is a write and is retried only on 429. Replaying a transaction is not
    proven safe: it bumps record versions, and replaying list operations was never tested.
  * 429 honors `Retry-After` when present.
* Status mapping: 403 → `PERMISSION_DENIED`, 404 → `NOT_FOUND`, 413 → `INVALID_ARGUMENT`,
  400 `ValidationError` on a write → `WRITE_REJECTED`, 5xx → `SERVER_ERROR`, other non-2xx →
  `NOTION_API_ERROR`. `rawError` keeps only `name`, `message`, `errorId`, `debugMessage` and
  `clientData.type` from the server's error body.

## 5. Records, transactions and IDs

* IDs in inputs MAY be hyphenated UUIDs, 32 hex characters, or Notion page URLs (the last 32-hex
  run in the path, or the `p` query parameter of a peek URL). Outputs are lower-case hyphenated.
* Reads use `syncRecordValuesSpaceInitial` with `{ pointer: { table, id, spaceId }, version: -1 }`
  per record, at most **1,000** pointers per call (5,000 returned 413). `notion_user` records use
  `syncRecordValuesMain` without `spaceId`.
* Record map entries come as `{ value, role }` or `{ spaceId, value: { value, role } }`; SDKs MUST
  accept both. `role` is one of `editor`, `read_and_write`, `comment_only`, `reader`, `none`.
* A single-record read maps:
  * `role: "none"` → `NOT_FOUND` ("does not exist or is not accessible"); the server returns
    `none` for both cases.
  * entry absent → re-check the session (§3); `VALID` → `NOT_FOUND`, otherwise `AUTH_DEAD`.
* Writes: `saveTransactionsFanout` with `{ requestId, transactions: [{ id, spaceId, operations,
  debug?: { userAction } }] }`, fresh UUID v4 for `requestId` and transaction `id`. Every operation
  pointer carries `spaceId`. A transaction applies atomically or not at all.
* Creating a block: `set` the record with `crdt_format_version: 1` and the initial
  `crdt_data.title` tree when the type has a title, write the title with `replaceTextInBlock`
  (`opVersion: 2`), then `listAfter` / `listBefore` it into the parent's list. The text instance
  ID is the first 16 bytes of SHA-256(`<blockId>/title`), base64 with `/` → `-`, `+` → `_`, no
  padding; the initial tree is `{ r: "<id>,\"start\",\"end\"", n: { [r]: { s: { x: <id>, i:
  [{t:"s"},{t:"e"}], l: "" }, c: [] } } }`.
* Writes larger than 900 operations are split into several transactions, in order.
* Every write method MUST read its records back before returning and fail with
  `WRITE_NOT_APPLIED` when they do not show the intended change.
* Data source queries use `queryCollection` with `source`, a `collectionView` (required; 400
  without it) and a `results` reducer large enough for every row ID. SDKs page locally: the first
  page caches the ID list for 10 minutes and cursors encode the query hash and offset, so pages
  never overlap or skip while the cache lives. Row records beyond those embedded in the response
  are read in batches.
* Search sends at most `limit` 1,000 and reports `truncated` when the result count reaches the
  limit; SDKs MUST NOT invent a continuation cursor.
* Block IDs use the web client's UUID v8 layout: bytes 0–5 hold the days since
  2024-01-01 UTC (high 12 bits) and the workspace short ID from the space record's `short_id_str`
  (low 36 bits); byte 6 is `0x80`; byte 8 has high bits `10`; byte 10 has high bits `11`; all
  other bits are random. `discussion`, `comment`, `collection` and `collection_view` use random
  UUID v4.

## 6. Markdown

* Page bodies are read and written as Notion-flavored Markdown. Reading MUST reproduce the
  official `fetch` output byte for byte for every case in [`fixtures/markdown`](fixtures/markdown):
  each fixture holds the Web records of a synthetic page (IDs remapped, user name and email
  replaced) and the official output for it.
* Block separation: consecutive list items of the same kind (bulleted, numbered, to-do) are joined
  by one newline; every other pair of blocks by a blank line. List children are indented by two
  spaces. Container tags (`<toggle>`, `<callout>`, `<quote>`, `<column>`, `<synced-block>`) put the
  title on the line after the opening tag, then a blank line, then the children.
* Inline: annotations apply inner to outer in array order; colour and discussion anchors share
  one `<span color discussion-urls>`; a newline is `<br />`; `[` and `]` are escaped; attribute
  values escape only `"`.
* Unsupported block types are left out and reported as `unknownBlockIds`; records the output
  refers to but the caller did not supply are reported as `missing` rather than fetched.
* Parsing MUST accept the reading format and plain Markdown (`**`, `*`, `~~`, backticks, links,
  `$…$`). A newline inside a paragraph is a soft break; a trailing `\` or `<br />` is a hard break.
  IDs named in the Markdown (subpages, databases, synced blocks, file blocks, a discussion
  anchor's block) are kept so edits preserve those blocks. Parsing a fixture's Markdown and
  rendering the result MUST give the fixture's Markdown back.

## 7. Message Store connection

The Message Store only signals that a key changed; event content is always read over HTTP (§8).
Subscriptions are not authenticated and not filtered by permission, so a signal is never evidence
of access.

* Transport: `wss://msgstore-001.app.notion.com/primus-v8/?sessionId=<fresh UUID>&EIO=4&transport=websocket`
  (Engine.IO v4 over WebSocket, Primus framing), headers `origin: https://app.notion.com` and a
  browser `user-agent`. SDKs SHOULD send the session cookie while the session is `VALID` and MUST
  NOT send it once it is `AUTH_DEAD` or when the caller asks for an anonymous connection; a
  connection without cookies MUST work the same. Cookies go only to `wss` Notion hosts.
* Engine.IO packets: `0<json>` opens the session (`pingInterval`, `pingTimeout`); `2` MUST be
  answered with `3` (echoing any suffix); `1` means the server closed the session; `4<json>`
  carries a Primus message.
* Primus heartbeat: the message `"primus::ping::<t>"` MUST be answered with
  `"primus::pong::<t>"` (same `<t>`). Without it the server closes the connection with 1005 after
  about 35 s. `"primus::server::close"` is treated as a close.
* A connection is considered dead when no packet arrives for `pingInterval + pingTimeout`
  (45 s by default), or when the open packet does not arrive within 15 s of the socket opening.
* Requests are `4{"type": "/api/v1/<method>", "requestId": <UUID>, ...}` and are matched to
  `{"type": "response", "requestId", "status", "result"}`; `status: "ok"` is success, anything
  else is failure. Default request timeout 60 s.
  * `registerBatchSubscriptions` with `subscriptions: [{ key, version }]`, where `version` is the
    last message version seen for the key or `-1` ("send the current state").
  * `unregisterBatchSubscriptions` with `keys: [...]`.
  * `ackNotification` with `ackId`, sent for every notification that carries an `ackId`.
* A subscription with version `-1` makes the server send the key's current state at once (the
  response reports `wasNotified: true` for it). SDKs MUST mark that first frame as `initial` and
  MUST NOT treat it as a change; its version is still stored. Without this, a cold start over tens
  of thousands of keys turns into as many activity reads.
* Notifications are `{"type": "notification", key, value, version}`. `version` is the message
  version (monotonic; resubscribe with it); `value` is a counter for `activity/` and
  `collection/` keys and the record version for `versions/` keys. `status: "error"` marks a
  failed key and does not update its version. Notifications for keys no longer subscribed are
  dropped. Other frames are reported once per kind (`guard.protocol_drift`, §8).
* Sharding: at most **40,000** keys per connection (the server limit is about 50,000), sent in
  batches of at most 5,000 keys per request. The server answers a batch past its limit with
  `status: "error"` and no explanation, and the whole batch is not applied while existing
  subscriptions continue. SDKs MUST then treat that connection as full at its current size and
  retry the batch on a new connection; a second rejection on the fresh connection fails with
  `NOTION_API_ERROR`. More keys than `maxConnections` × 40,000 (default 4 connections) fail with
  `SUBSCRIPTION_CAP_EXCEEDED` before anything is sent.
* Reconnection: every connection reconnects on its own after a close, an error, a heartbeat
  timeout or an open timeout, with full-jitter exponential backoff (base 1 s, cap 30 s, at least
  250 ms), reset after a successful resubscribe. It resubscribes every key with the last message
  version received for it; the server then sends only each key's latest state, not every missed
  change, so callers MUST backfill over HTTP after a reconnect (the `connection.ready` event
  carries `reconnect: true` and the downtime).
* `health()` reports, per connection: state (`CONNECTING`, `SUBSCRIBING`, `READY`, `BACKOFF`,
  `STOPPED`), key count, capacity, time connected, reconnect count and last close code.

## 8. Events

Events are built from the activity log (`POST /api/v3/getActivityLog`), never from signals alone.
Each event follows [`schema/`](schema/) (`event.schema.json` plus one schema per type), and the
shared cases in [`fixtures/events`](fixtures/events) MUST produce exactly the expected events.

### 8.1 Envelope

`{ id, type, timestamp, workspaceId, entity: { id, type }, authors: [{ id, type }], data, origin,
delivery, web: { activityId, edits, before?, after? } }`.

* **Edit key**: `<activityId>|<editType>|<target>|<timestamp>`, where `target` is the first of
  `block_id`, `comment_id`, `collection_row_id`, `collection_property_id`, `collection_view_id`,
  `top_level_block_id`, `navigable_block_id`, `collection_id` on the edit, then
  `navigable_block_id`, `collection_id` on the activity, else empty; `timestamp` is the edit's.
* **Event ID**: SHA-256 of the event's edit keys, sorted and joined with `\n`; the first 16 bytes
  in hex formatted as `8-4-4-4-12`. Example: the single key
  `act-1|page-locked|page-1|1732400000000` gives `cb019182-2500-685e-42ad-640a98fe6bc0`.
* **Aggregation**: within one read, edits of the same event type on the same entity form one
  event; `timestamp` is the latest edit's (ISO 8601); `authors` is the union (`notion_user` →
  `person`, `bot` → `bot`); `web.edits` is the count; `web.before` / `web.after` are set only
  when the event covers one edit that carries them.
* **Origin**: `self_other_client` when every author is the SDK's account, else `other_user`.
  (`this_client` is added by the guards, §11.)
* **De-duplication**: the edit keys of every read are stored with the activity cursor in one
  atomic write (§1.1); edits already stored are skipped, so reading an activity again yields
  only edits merged into it since.

### 8.2 Mapping

`nav` is the activity's `navigable_block_id`; "child" means an edit whose `block_id` is not
`nav`.

| Activity edit | Event | Entity | Notes |
| --- | --- | --- | --- |
| `block-created` of a child `page` | `page.created` | child | `page.moved` instead when the child's `created_time` is more than 60 s before the edit |
| `block-created` of a child `collection_view` / `collection_view_page` | `database.created` | child | |
| `block-created` / `block-changed` / `block-deleted` of a child that is not a page or database | `page.content_updated` | `nav` | `data.updated_blocks` lists the blocks |
| `block-changed` / `block-deleted` of a child page or database | — | | reported by that page's own activity |
| `block-changed` of `nav` with a different parent | `page.moved` | `nav` | |
| `block-changed` of `nav` with different `properties` | `page.properties_updated` | `nav` | `data.updated_properties` lists property IDs; when `before` had no properties and the edit is within 120 s of `created_time`, `title` is part of the creation and left out |
| `block-created` / `block-deleted` of `nav` | — | | covered by the parent's activity and `page-deleted` |
| `page-locked`, `page-unlocked`, `page-deleted`, `page-restored` | `page.locked`, `page.unlocked`, `page.deleted`, `page.undeleted` | `nav` | |
| `top-level-block-created` | `page.created` | `top_level_block_id` | |
| `comment-created` / `comment-changed` / `comment-deleted` | `comment.created` / `.updated` / `.deleted` | comment | `data.page_id` is `nav`; `data.parent` is the discussion's block when it is not `nav` |
| `collection-row-created` | `page.created` and `data_source.content_updated` | row; data source | row parent `{ type: "database", id, data_source_id }` |
| `collection-row-deleted` | `data_source.content_updated` | data source | |
| `collection-property-created` / `-changed` / `-deleted` | `data_source.schema_updated` | data source | `{ id, name, action }`; skipped when the same read creates the data source |
| `collection-view-created` / `-changed` / `-deleted` | `view.created` / `.updated` / `.deleted` | view | skipped when the same read creates the data source |
| other known types (`collection-created`, `permissions-edited`, layout, transcript, permanent deletion) | — | | consumed without an event |

* **Cancellation**: a block created and deleted among the unread edits of one activity produces
  nothing. Edits cancelled by the server never reach the log.
* **Parents** come from the entity's record: `parent_table` `space` → `space`, `team` → `team`,
  `collection` → `database` (the data source's block) with `data_source_id`, `block` → `page`,
  or `database` when the parent block is a `collection_view*`, otherwise `block`.
* **Access**: the record that decides access is the page (`nav`, the child, the row), the data
  source, or the database block for views. Events whose record is missing or `role: "none"` are
  dropped; when that record is the watched entity itself, it is unwatched.
* **Changes without activity** come from comparing two versions of a record announced by its
  `versions/` key: a comment whose `text` changed (`comment.updated`) or that became
  `alive: false` (`comment.deleted`); a view whose `name`, `type`, `format`, `query2`,
  `page_sort` or `parent_id` changed (`view.updated`); a data source property whose `name` or
  `type` changed (`data_source.schema_updated` with `action: "updated"`). Their event ID is built
  from the single key `record|<table>|<id>|<version>`.
* **Protocol drift**: an unknown activity type, edit type, or Message Store frame emits
  `guard.protocol_drift` once per kind (`activity.<type>`, `edit.<type>`, `frame.<type>`, …) and
  produces no event; the raw data remains available from Core.

### 8.3 Signals, windows and reads

* A watched page subscribes `versions/<id>:block` and `activity/<id>`; a watched data source
  `collection/<id>`, `activity/<id>` and `versions/<id>:collection`. Keys are subscribed with the
  versions stored in the StateStore, and every signal stores its key's new version.
* Any signal for a watched entity opens or extends its window. The first read happens **1 s**
  after an `activity/` signal and **5 s** after a record-level signal (`versions/`,
  `collection/`), whichever comes first: the activity log is written about 4 s after the record,
  so an earlier read misses edits merged into an open activity, which raise no `activity/`
  signal. While the window is open the entity is read every **90 s**; it closes once
  **10 minutes** pass with neither a signal nor a delivered event. A signal arriving during a
  read schedules one more read 5 s after it.
* A read requests the 20 newest activities (`navigableBlock` for pages, `collections` for data
  sources, keeping only activities of that data source). If the stored cursor is not among them
  it pages back with `startingAfterId`, at most 10 pages, then reports a gap. It processes the
  activities up to the cursor plus the five most recent ones kept in the cursor, whose versions
  may have grown.
* The first read of a newly watched entity is a **baseline**: it stores the cursor and marks its
  edits as seen without delivering anything, so history is not replayed.
* At most **8** activity reads are in flight at once across all entities.
* `health()` reports the open windows and `lagSeconds`, the age of the oldest signal not yet
  read back.

## 9. Watch scope and discovery

* `watch: { mode: "workspace" }` (default) covers what the account can read in the workspace;
  `{ mode: "explicit", roots }` covers the given pages and databases and everything under them.
  Both accept `rescanIntervalMs` (default **6 h**, `0` disables).
* **Roots** in workspace mode: the space record's `pages`; the account's `space_view` (from
  `getSpaces`, matched by `space_id`) `private_pages`; `team_pages` of every teamspace that
  `getTeamsV2` with `teamTypes: ["Joined", "UnjoinedActive"]` returns with a readable record
  (closed teamspaces answer `role: "none"`); `getUserSharedPagesInSpace` `pages`.
* **Walk**: records are read in batches (§5), up to 4 batches at a time. Only pages and databases
  keep their full record in memory; other blocks keep `type`, `alive` and `content`. A readable, alive `page` or database block
  (`collection_view`, `collection_view_page`) becomes a node; other blocks (columns, toggles,
  synced blocks) are walked through for the pages nested in them. A database adds its data source
  (`collection_id`) as a node. Rows are not walked or watched one by one: their activities come
  through the data source. Missing entries, `role: "none"`, entries without a value and
  `alive: false` are skipped. Children are kept in document order.
* **Tree**: stored in the StateStore (§1.1) as nodes `{ id, table, type, parent, children }`;
  containers (`space`, `space_view`, `team`, `shared`) carry `checkedAt`.
* **Watching**: every page and database block is watched as a page and every data source as a
  data source (§8.3). Container keys: `teams_in_space_v2/<spaceId>`,
  `user_shared_pages_in_space/<spaceId>-<userId>`, `versions/<spaceId>:space`,
  `versions/<spaceViewId>:space_view`, `versions/<teamId>:team`.
* **Start**: with no stored tree, the first `start()` walks everything and watches it without
  emitting events. With a stored tree, `start()` watches it at once and then walks again in the
  background. Each walk reconciles the tree: new entities are watched, entities no longer reached
  are unwatched and removed.
* **New content** (each read 2 s after the signal, folding bursts):
  * `versions/<page>:block` of a watched page: its content is walked again; new child pages and
    databases (and their subtrees) are watched. No event: the page's activity reports them.
  * `versions/<team>:team`, `versions/<spaceViewId>:space_view`, `versions/<spaceId>:space`,
    `user_shared_pages_in_space/…`: the list is read again; new pages are walked and watched.
  * `teams_in_space_v2/<spaceId>`: `getTeamsV2` again; new readable teamspaces are added and
    their keys subscribed.
* **Events for container roots**: pages that appear at a container root have no activity to
  report them, so discovery emits `page.created` (or `database.created`) when the page was created
  at most 60 s before the container was last read (or after); older pages (moved there, or shared
  long after creation) are watched without an event. The event ID is built from the single key
  `discovery|<type>|<pageId>`; the parent comes from the page record (§8.2); `delivery` is
  `live` for signals and `backfill` for the periodic walk. Pages found by a walk under a watched
  page get no event.
* `health().watch` reports the mode, page, data source and container counts, the number of walks,
  the last walk time and the last error; `health().connections` the keys per connection.

## 10. Recovery

What changed while the SDK could not see signals (a lost connection, or no process running) is
read back and delivered with `delivery: "backfill"`, before any live event, and every recovery
ends with a `connection.gap` event.

* **Start.** A recovery begins when a connection that had been `READY` closes with any code other
  than 1000 (the SDK's own closes use 1000), and on every start with a stored page tree (§9).
  For a restart, `from` is the last stored `aliveAt` (written every **60 s** and on `stop()`).
* **What to read back.** After resubscribing with the stored message versions, the server sends
  one frame per key whose state changed meanwhile (§7). Entities whose keys produce non-initial
  frames during the recovery, plus entities whose activity window was open when it began, are
  collected. Frames with version `-1` and current-state frames are not changes.
* **When.** Collection ends **5 s** after the connection is `READY` again (for a restart, 5 s after
  the stored tree is subscribed). Each collected entity is then read as in §8.3 (cursor, paging,
  at most 8 in flight) with `delivery: "backfill"`; afterwards its window stays open for the usual
  re-reads.
* **Order.** Live events produced while a recovery runs are held and delivered after its
  `connection.gap`. Events found by discovery during a recovery (§9) are `backfill`.
* **`connection.gap`**: `{ kind: "reconnect" | "restart", from, to, recovered, failed, entities,
  events }`. `recovered` is `false` when any entity failed to read or its cursor was out of reach
  (§8.3 gap); `failed` lists those entity IDs. `health()` keeps the last one and reports
  `degraded` while a recovery runs or when the last gap was not recovered.
* **Lag.** While a recovery runs, `lagSeconds` counts from its `from`.
* **Limits.** Keys that never had state when first subscribed (frames with version `-1`) cannot
  report a change made while the process was down; the periodic walk (§9) and the next signal for
  the page cover them.

## 11. Guards and sandbox

### 11.1 Origin

* Every transaction the SDK submits registers, **before** it is sent, each record it touches
  (operation pointers, and the child IDs of `listAfter` / `listBefore` / `listRemove`) with the
  time and the kind of change: `lock:true|false` (`format.block_locked`), `alive:true|false`, or
  `other`. Every successful read-back registers the versions it confirmed.
* An activity edit by another account is `other_user`. An edit by the SDK's account is
  `this_client` when it is one of the SDK's writes, otherwise `self_other_client`:
  * when the edit's record carries a version (`block_data.after`, `block_value`, `comment_data`)
    and the SDK registered versions for that record: the version is one of them;
  * otherwise: the SDK wrote that record within **±30 s** of the edit's timestamp; for
    `page-locked` / `page-unlocked` / `page-deleted` / `page-restored` the write must be the
    matching kind (`lock:true`, `lock:false`, `alive:false`, `alive:true`), and each such write can
    be claimed by one edit only.
* The SDK's edits and the account's other edits never share an event: within one read, edits are
  grouped by event type, entity **and** whether they are the SDK's (§8.1).
* `this_client` events are not delivered unless the caller asks for them; they are still recorded
  as seen. Records found without an activity (§8.2 record diffs, §9 container pages) use the same
  rules with the record's version and last edit time.

### 11.2 Loop guard

* Event handlers run inside a handler context that follows their asynchronous work. Writes made in
  that context are counted per target page: the page a write method names (the parent for
  `pages.create`, the discussion for `comments.reply`), or the first operation's record for a
  direct Core transaction. At most **5 per 60 s** (configurable); the next write fails with
  `LOOP_DETECTED` before anything is sent, and `guard.loop_detected` `{ target, count, windowMs,
  eventId }` is emitted. Writes outside handlers are not limited.

### 11.3 Scoped views

* `scope(policy)` returns the read and write API (`me`, `users`, `search`, `pages`, `databases`,
  `comments`) without `core`, event subscription or lifecycle methods.
* `policy.read.roots` (pages and databases, each with everything under it) and
  `policy.read.teamspaces` limit what may be read or written. A page is in scope when walking up
  its `parent_table` / `parent_id` chain (through blocks and data sources) reaches a root or an
  allowed teamspace. With neither list, location is not limited. Search hits outside the scope
  are left out; `allowSearch: false` and `allowUsers: false` disable search and member lookups.
* Writes: `write.readOnly`, `write.allowedActions` (`pages.create`, `pages.updateProperties`,
  `pages.updateContent`, `comments.create`, `comments.reply`), and `approval(action, params)`
  consulted before every write. Creating in the private section is refused when roots are set.
* Every refusal fails with `SCOPE_POLICY_VIOLATION` before any write is sent and is logged.

### 11.4 Content for LLMs

* Delivered events and `pages.get()` results carry a non-enumerable `toLLMContext()`. It renders
  `<notion_event untrusted="true">` / `<notion_page untrusted="true">` with a `<meta>` section
  (IDs, type, times, authors, origin, parent; titles on one line) and a `<content>` section (the
  page's Markdown, or the event record's title or comment text).
* Every sequence in the content that could open or close one of the envelope's tags
  (`notion_event`, `notion_page`, `meta`, `content`, in any case and with spaces after `<` or
  `/`) is neutralized by replacing `<` with `&lt;`; other markup is kept.

## 12. Errors

Every error carries a `code`, a `message` and `retryable`; HTTP failures also carry `status` and
`rawError` (only `name`, `message`, `errorId`, `debugMessage`, `clientData.type` from the
server's body). Retryable codes have already been retried (§4) when they reach the caller.

| Code | Retryable | When |
| --- | :---: | --- |
| `RATE_LIMITED` | yes | 429 after the retries; `retryAfterMs` when the server said |
| `NETWORK_TIMEOUT` | yes | a request, a Message Store request or reconnect, timed out or failed at the network |
| `SERVER_ERROR` | yes | 5xx after the retries |
| `AUTH_DEAD` | no | the session is dead (§3); every later HTTP call fails with it without being sent |
| `NOT_FOUND` | no | the record does not exist or cannot be read (`role: "none"`, or missing while the session is valid); 404 |
| `PERMISSION_DENIED` | no | 403, or a role too low for a write |
| `WRITE_REJECTED` | no | a transaction answered with 400 `ValidationError` |
| `WRITE_NOT_APPLIED` | no | the write returned 200 but its read-back does not show it (§5) |
| `INVALID_ARGUMENT` | no | bad input: IDs, options, a search `limit` above 1,000, an unknown workspace, an explicit watch without roots |
| `INVALID_STATE` | no | the call does not fit the current state, e.g. a closed state store or a stopped Message Store |
| `SEARCH_LIMIT` | no | reserved; v0.1 reports the search limit as `INVALID_ARGUMENT` |
| `CANCELLED` | no | the caller aborted, or sign-in was closed |
| `BROWSER_NOT_FOUND`, `SIGN_IN_TIMEOUT` | no | interactive sign-in (§3) |
| `SCOPE_POLICY_VIOLATION` | no | a scoped view refused the call (§11.3) |
| `LOOP_DETECTED` | no | a handler wrote to one page too often (§11.2) |
| `SUBSCRIPTION_CAP_EXCEEDED` | no | more keys than the connections can hold, or a rejected batch with no connection left (§7) |
| `STATE_STORE_UNAVAILABLE` | no | the state store cannot be read or written (§1.1) |
| `NOTION_API_ERROR` | no | any other non-2xx answer, or a subscription batch rejected twice (§7) |

Events about the SDK itself: `auth.dead` (§3), `connection.gap` (§10), `guard.protocol_drift`
(§8.2), `guard.loop_detected` (§11.2).
