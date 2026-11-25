# Changelog

## [Unreleased]

## [0.1.2] - 2026-11-25

- Documentation: the package README is now a complete API reference (every method, property value
  formats, events and their data, health, errors, configuration, CLI). No code changes since 0.1.1.

## [0.1.1] - 2026-11-24

- First release published from GitHub Actions with npm Trusted Publishing, with provenance. No
  code changes since 0.1.0.

## [0.1.0] - 2026-11-24

First release: read, write and watch Notion through the web session.

- Read and write API with Notion-flavored Markdown, verified by read-back.
- Change events named like the official webhooks, for a whole workspace or chosen subtrees,
  delivered in-process, with recovery after disconnects and restarts.
- Agent safety: origin marking, loop guard, scoped views, untrusted LLM envelopes.
- Sign-in helpers and the `gabriel-notion` CLI.

Details by slice:

- Package skeleton (S0).
- `NotionCore`: in-memory cookie jar with `Set-Cookie` handling, HTTP client with workspace and active-user headers, read/write retry classes, session state machine with `auth.dead`, account and workspace binding, credential-safe errors and health (S1).
- Records, transactions and IDs: batched record reads (≤1,000), `role: none` and missing records mapped to `NOT_FOUND` after a session check, atomic `submit`, read-back `verify` with `WRITE_NOT_APPLIED`, ID parsing from UUIDs and page URLs, web-compatible v8 block IDs (S2).
- Optional credential write-back: `credentialStore` saves a cookie snapshot when a session cookie rotates; `FileCredentialStore` (0600, atomic), `loadSessionCookies()` (env, then file), `parseCookieHeader()`.
- Markdown codec (S4): `renderPage` reproduces official `fetch` output byte for byte on the shared fixtures; `parseMarkdown` / `parseInline` read that format and plain Markdown; `specsToRecords` builds block records from parsed specs.
- `NotionClient` read API (S5): `me`, `users.list/search/get`, `search` (≤1,000, `truncated`), `pages.get` (Markdown or block tree, decoded row properties), `databases.get/query` (local cursor over a cached ID list), `comments.list`. The workspace binds lazily on the first call.
- Browser sign-in (S3): `signInWithBrowser()` opens a temporary-profile Chrome window and returns Notion cookies in-process (optional direct Google entry); `listWorkspaces()` verifies stored cookies. New error codes `BROWSER_NOT_FOUND`, `SIGN_IN_TIMEOUT`.
- `extractFromDebugChrome()` reads the Notion session from a Chrome started with `--remote-debugging-port`; `gabriel-notion` CLI with `auth login | extract | status | logout`, saving through `FileCredentialStore`.
- Write API (S6): `pages.create` (page, database row, teamspace root, private; Markdown body; title from a leading heading), `pages.updateProperties` (by property name), `pages.updateContent` (`replace_all`, `insert`, `update`), `comments.create` (page, block, inline selection) and `comments.reply`. Every write is read back and fails with `WRITE_NOT_APPLIED` when it did not take effect.
- `extractFromChrome()` / `listChromeSessions()` / `gabriel-notion auth read` and `auth profiles`: decrypt the Notion session from Chrome's on-disk cookie store on macOS (no browser launch, no re-login), scanning every profile with one Keychain read, auto-picking the signed-in one and listing choices when several are signed in. Verified end-to-end against real Chrome.
- StateStore (S8): `StateStore` interface with `MemoryStateStore` and `FileStateStore` (atomic snapshot via temp file + fsync + rename, 0600/0700, debounced writes, single-process lock, `STATE_STORE_UNAVAILABLE` on unusable storage, rejected writes not applied); `WatchState` stores the page tree, subscription versions, activity cursors and the last 10,000 event IDs per workspace, committing a cursor and its event IDs atomically.
- Message Store connection (S7): `MessageStore` pool over Engine.IO v4 + Primus on Node's built-in `WebSocket` (injectable `webSocketFactory`): answers both heartbeats, detects dead peers, `registerBatchSubscriptions` / `unregisterBatchSubscriptions` / `ackNotification`, at most 40,000 keys per connection in 5,000-key batches, a batch answered with `error` retried on a new connection, `SUBSCRIPTION_CAP_EXCEEDED` past `maxConnections`, full-jitter reconnect that resubscribes with the last message versions and reports `connection.ready` with the downtime, unknown frames reported once as `protocol.drift`. `NotionCore.subscribe` / `unsubscribe` / `onSignal` / `stopRealtime` / `messageStore`; the session cookie is sent while valid and dropped when `AUTH_DEAD` or with `anonymousRealtime`; `health().realtime` lists connections.
- Event pipeline (S9): `normalizeActivities` maps activity-log edits to webhook-named events (`page.*`, `database.created`, `data_source.*`, `comment.*`, `view.*`) with aggregation per entity and type, cancellation, access filtering and deterministic event IDs from edit keys; `diffRecord` covers comment edits and deletions, view edits and property renames. `EventPipeline` coalesces signals (1 s), re-reads every 90 s, closes windows after 10 quiet minutes, takes a baseline on first watch, pages back to the stored cursor, commits cursor and edit keys atomically, unwatches entities with `role: "none"`, and reports `guard.protocol_drift` once per kind. `NotionClient.on()`, `start()` (explicit roots for now), `stop()`, `health()`. Shared fixtures in `spec/fixtures/events`, JSON Schemas in `spec/schema`.
- Watch scope and discovery (S10): `watch: { mode: "workspace" | "explicit", roots?, rescanIntervalMs? }`. `Discovery` walks the page tree from the workspace root, private section, readable teamspaces and pages shared with the account (or from explicit roots), through non-page blocks, stores it in the StateStore and watches every page, database and data source; follows new content from `versions/<page>:block`, `versions/<team>:team`, `versions/<spaceView>:space_view`, `versions/<space>:space`, `user_shared_pages_in_space/…` and `teams_in_space_v2/…`; emits `page.created` for new pages at container roots; warm starts watch the stored tree first and re-walk in the background; a periodic walk (default 6 h) reconciles the tree. New entities get a lazy baseline (`since`) instead of an up-front activity read. `health().watch`. Two-account integration tests in `test/integration` (`pnpm test:integration`). The Message Store marks the current-state frame that answers a version -1 subscription as `initial`, which the pipeline and discovery do not treat as a change, and activity reads are capped at 8 in flight (found in a cold start of a large workspace: 86,874 keys, 3 connections, about 6 minutes).
- Disconnect and restart recovery (S11): a lost connection or a warm start begins a recovery; entities whose keys are replayed after resubscribing with stored versions (plus open windows) are read back with `delivery: "backfill"` after a 5 s catch-up window; live events are held until `connection.gap` (`{ kind, from, to, recovered, failed, entities, events }`) is emitted; `aliveAt` is stored every 60 s and on stop; `health().lagSeconds` counts from the start of a running recovery and status is `degraded` while recovering or after an unrecovered gap. Message Store frames with version -1 are flagged `initial` (no state is not a change).
- Agent safety guards (S12): origin `this_client` for the SDK's own writes (records registered before each transaction, versions confirmed by read-back, lock/trash edits matched by kind and claimed once), not delivered unless `guards.deliverThisClient`; the SDK's edits and the account's other edits are separate events. Loop guard: at most 5 writes per target page per 60 s from event handlers (`guards.loop`), else `LOOP_DETECTED` and `guard.loop_detected`. `client.scope(policy)` returns a `ScopedNotionClient` (no `core`) limited to page roots and teamspaces, with read-only, action allow-list, approval hook, and switches for search and users; refusals throw `SCOPE_POLICY_VIOLATION`. `toLLMContext()` on delivered events and `pages.get()` results renders an untrusted envelope whose tags the content cannot open or close. `client.getWorkspace()`.
