/**
 * gabriel-notion — Node.js reference implementation.
 *
 * The behavior contract every Gabriel Notion SDK implements is spec/behavior.md.
 */
export const SDK_NAME = "gabriel-notion";

export { NotionError, isNotionError, type NotionErrorCode, type NotionErrorOptions } from "./errors.js";
export { NotionCore, type NotionCoreOptions, type CoreHealth, type CredentialHealth } from "./core/core.js";
export type { CookieInput } from "./core/cookies.js";
export { FileCredentialStore, loadSessionCookies, parseCookieHeader, defaultSessionFile, type CredentialStore } from "./core/credentials.js";
export type { CallOptions, RetryMode, FetchLike } from "./core/http.js";
export type { AccountInfo, WorkspaceInfo } from "./core/account.js";
export { normalizeId, isNotionId, decodeBlockId } from "./core/ids.js";
export type { Operation, RecordEntry, RecordPointer, Role } from "./core/records.js";
export type { SessionState, SessionCheckTrigger, SessionHealth } from "./core/session.js";
export { consoleLogger, silentLogger, type Logger } from "./util/logger.js";
export * as markdown from "./markdown/index.js";
export { NotionClient, type NotionClientOptions } from "./client/client.js";
export { signInWithBrowser, listWorkspaces, type SignInOptions, type SignInResult, type SignInStatus } from "./core/sign-in.js";
export { extractFromDebugChrome, type ExtractOptions, type ExtractResult } from "./core/browser-extract.js";
export { extractFromChrome, extractFromChromeProfile, listChromeSessions, type ChromeProfileOptions, type ChromeProfileResult, type ChromeSession, type ExtractFromChromeOptions } from "./core/cookie-store.js";
export type * from "./client/types.js";
export { decodeProperties } from "./client/properties.js";
export type { BlockAnchor, ContentEdit, CreatePageOptions, CreateCommentOptions } from "./client/write-api.js";
export type { PropertyInput } from "./client/write.js";
export { MemoryStateStore, type StateStore, type StateWrite, type StateStoreHealth } from "./state/store.js";
export { FileStateStore, defaultStateFile, type FileStateStoreOptions } from "./state/file.js";
export { WatchState, SEEN_EVENT_LIMIT, type PageTreeNode, type ActivityCursor } from "./state/watch-state.js";
export {
  MessageStore,
  DEFAULT_MESSAGE_STORE_URL,
  DEFAULT_MAX_KEYS_PER_CONNECTION,
  type MessageStoreOptions,
  type MessageStoreEvents,
  type MessageStoreSignal,
  type MessageStoreHealth,
  type ConnectionHealth,
  type ConnectionState,
  type SubscribeEntry,
  type WebSocketFactory,
  type WebSocketLike,
} from "./core/msgstore.js";
export type { WatchOptions, ClientEvents, ClientHealth } from "./client/client.js";
export { EVENT_TYPES, type EventType, type EventData, type EventDataMap, type EventParent, type EventOrigin, type NotionEvent, type ProtocolDriftEvent, type UpdatedBlock, type UpdatedProperty } from "./client/events/types.js";
export { normalizeActivities, recordsToLoad, editKey, eventId, type Activity, type ActivityEdit, type NormalizeInput, type NormalizeResult } from "./client/events/normalize.js";
export { diffRecord, type RecordDiffTable } from "./client/events/record-diff.js";
export { EventPipeline, type ConnectionGapEvent, type PipelineOptions, type PipelineHealth, type WatchedEntity, type WatchKind } from "./client/events/pipeline.js";
export { Discovery, DEFAULT_RESCAN_INTERVAL_MS, type DiscoveryHealth, type DiscoveryOptions } from "./client/watch/discovery.js";
export type { DeliveredEvent, PageWithContext } from "./client/client.js";
export { ScopedNotionClient, type ScopePolicy, type ScopedWriteAction } from "./client/guard/scope.js";
export { eventToLLMContext, pageToLLMContext, neutralize as neutralizeForLLM } from "./client/guard/llm-context.js";
export type { LoopDetectedEvent } from "./client/guard/origin.js";
