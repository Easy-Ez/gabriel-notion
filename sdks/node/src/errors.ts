/**
 * Unified error model. Every public API rejects with a `NotionError`.
 *
 * `retryable === true` marks a transient class. The SDK has already retried those
 * internally, so when one reaches application code the automatic retries are exhausted;
 * do not wrap SDK calls in another retry loop.
 *
 * Errors never carry credentials: no cookies, no request headers. `rawError` holds the
 * server's JSON error body (name, message, errorId), which contains no session data.
 */
export type NotionErrorCode =
  | "RATE_LIMITED"
  | "NETWORK_TIMEOUT"
  | "SERVER_ERROR"
  | "AUTH_DEAD"
  | "PERMISSION_DENIED"
  | "NOT_FOUND"
  | "WRITE_REJECTED"
  | "WRITE_NOT_APPLIED"
  | "SEARCH_LIMIT"
  | "INVALID_ARGUMENT"
  | "INVALID_STATE"
  | "SCOPE_POLICY_VIOLATION"
  | "LOOP_DETECTED"
  | "SUBSCRIPTION_CAP_EXCEEDED"
  | "STATE_STORE_UNAVAILABLE"
  | "CANCELLED"
  | "BROWSER_NOT_FOUND"
  | "SIGN_IN_TIMEOUT"
  | "NOTION_API_ERROR";

const RETRYABLE: ReadonlySet<NotionErrorCode> = new Set<NotionErrorCode>(["RATE_LIMITED", "NETWORK_TIMEOUT", "SERVER_ERROR"]);

export interface NotionErrorOptions {
  /** HTTP status of the failing response, when there was one. */
  status?: number;
  /** The server's JSON error body, e.g. `{ name: "ValidationError", message, errorId }`. */
  rawError?: unknown;
  /** Suggested cool-down when rate limited. */
  retryAfterMs?: number;
  cause?: unknown;
}

export class NotionError extends Error {
  readonly code: NotionErrorCode;
  readonly retryable: boolean;
  readonly status?: number;
  readonly rawError?: unknown;
  readonly retryAfterMs?: number;

  constructor(code: NotionErrorCode, message: string, opts: NotionErrorOptions = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = "NotionError";
    this.code = code;
    this.retryable = RETRYABLE.has(code);
    if (opts.status !== undefined) this.status = opts.status;
    if (opts.rawError !== undefined) this.rawError = opts.rawError;
    if (opts.retryAfterMs !== undefined) this.retryAfterMs = opts.retryAfterMs;
  }

  toJSON(): Record<string, unknown> {
    return { name: this.name, code: this.code, message: this.message, retryable: this.retryable, status: this.status, rawError: this.rawError };
  }
}

export function isNotionError(err: unknown, code?: NotionErrorCode): err is NotionError {
  return err instanceof NotionError && (code === undefined || err.code === code);
}

export function cancelledError(reason?: unknown): NotionError {
  return new NotionError("CANCELLED", "operation was cancelled", { cause: reason });
}
