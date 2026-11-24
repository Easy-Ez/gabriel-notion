import { NotionError, cancelledError } from "../errors.js";
import { anySignal, fullJitterDelay, sleep as defaultSleep } from "../util/async.js";
import type { Logger } from "../util/logger.js";
import { silentLogger } from "../util/logger.js";
import type { CookieJar } from "./cookies.js";
import { Session } from "./session.js";

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export const DEFAULT_API_BASE = "https://app.notion.com/api/v3/";
export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_RETRIES = 3;
/** A current desktop Chrome user agent; the research probes used the browser's own UA. */
export const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

/**
 * Retry classes:
 * - "auto": decided by the endpoint name (see isReadOnlyEndpoint)
 * - "safe": retry on 429, 5xx and network errors (the caller vouches the call is idempotent)
 * - "none": retry only on 429, which the server rejects before doing any work
 */
export type RetryMode = "auto" | "safe" | "none";

export interface CallOptions {
  /** Workspace for the `x-notion-space-id` header. `null` omits the header. Defaults to the bound workspace. */
  spaceId?: string | null;
  retry?: RetryMode;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Internal: do not run the 401 session check (used by the session validator itself). */
  skipAuthCheck?: boolean;
}

export interface HttpClientOptions {
  cookies: CookieJar;
  session?: Session;
  fetch?: FetchLike;
  /** Base URL of the web API. Only https Notion hosts (or localhost, for tests) are accepted. */
  apiBase?: string;
  userAgent?: string;
  /** Value for the `notion-client-version` header; omitted when unset. */
  clientVersion?: string;
  logger?: Logger;
  maxRetries?: number;
  timeoutMs?: number;
  /** Test hooks. */
  random?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
}

/**
 * Read-only endpoints may be retried on 5xx and network errors. Everything else is treated
 * as a write: replaying a transaction is not proven safe (it bumps record versions, and
 * replaying list operations was never tested), so writes are retried only on 429.
 */
export function isReadOnlyEndpoint(name: string): boolean {
  return /^(get|load|sync|search|query|list|find|check)/.test(name) || name === "authValidate";
}

const NOTION_HOST = /(^|\.)notion\.(com|so)$/i;

function assertTrustedBase(base: URL): void {
  const local = base.hostname === "localhost" || base.hostname === "127.0.0.1";
  if (local) return;
  if (base.protocol !== "https:" || !NOTION_HOST.test(base.hostname)) {
    throw new NotionError("INVALID_ARGUMENT", `refusing to send session credentials to ${base.host}`);
  }
}

/** Keeps only the informative, credential-free part of Notion's JSON error body. */
function summarizeErrorBody(body: unknown): unknown {
  if (!body || typeof body !== "object") return undefined;
  const b = body as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of ["name", "message", "errorId", "debugMessage"]) if (b[k] !== undefined) out[k] = b[k];
  const clientData = b.clientData as Record<string, unknown> | undefined;
  if (clientData && typeof clientData.type === "string") out.clientDataType = clientData.type;
  return Object.keys(out).length ? out : undefined;
}

/**
 * HTTP transport for `POST /api/v3/<endpoint>` (spec §4):
 * - cookies from the in-memory jar, `Set-Cookie` applied from every response;
 * - `x-notion-space-id` and `x-notion-active-user-header` on every request;
 * - full-jitter exponential backoff; `Retry-After` honored on 429;
 * - one session check per burst of 401s, the failed request replayed once.
 */
export class HttpClient {
  readonly session: Session;
  private readonly fetchImpl: FetchLike;
  private readonly apiBase: URL;
  private readonly userAgent: string;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;
  private readonly logger: Logger;
  private readonly random: () => number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private userId?: string;
  private spaceId?: string;

  constructor(private readonly opts: HttpClientOptions) {
    this.logger = opts.logger ?? silentLogger;
    this.session = opts.session ?? new Session(this.logger, opts.now);
    this.fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init));
    this.apiBase = new URL(opts.apiBase ?? DEFAULT_API_BASE);
    assertTrustedBase(this.apiBase);
    this.userAgent = opts.userAgent ?? DEFAULT_USER_AGENT;
    this.maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.random = opts.random ?? Math.random;
    this.sleep = opts.sleep ?? defaultSleep;
    this.userId = opts.cookies.peek("notion_user_id");
    this.session.setValidator(async () => {
      try {
        await this.call("authValidate", {}, { skipAuthCheck: true, retry: "safe", spaceId: null });
        return "valid";
      } catch (err) {
        if (err instanceof NotionError && err.status === 401) return "dead";
        throw err;
      }
    });
  }

  /** Sets the user sent as `x-notion-active-user-header`. */
  setActiveUser(userId: string): void {
    this.userId = userId;
  }

  /** Sets the default workspace for `x-notion-space-id`. */
  setWorkspace(spaceId: string): void {
    this.spaceId = spaceId;
  }

  activeUser(): string | undefined {
    return this.userId;
  }

  workspace(): string | undefined {
    return this.spaceId;
  }

  async call<T = unknown>(endpoint: string, body: unknown, opts: CallOptions = {}): Promise<T> {
    if (!/^[a-zA-Z][a-zA-Z0-9]{1,100}$/.test(endpoint)) {
      throw new NotionError("INVALID_ARGUMENT", "invalid endpoint name");
    }
    const retry = opts.retry ?? "auto";
    const safe = retry === "safe" || (retry === "auto" && isReadOnlyEndpoint(endpoint));
    const url = new URL(endpoint, this.apiBase);
    let attempt = 0;
    let authReplayed = false;

    for (;;) {
      if (opts.signal?.aborted) throw cancelledError(opts.signal.reason);
      if (!opts.skipAuthCheck) this.session.assertUsable();

      const timeoutSignal = AbortSignal.timeout(opts.timeoutMs ?? this.timeoutMs);
      let resp: Response;
      try {
        resp = await this.fetchImpl(url, {
          method: "POST",
          headers: this.headers(url, opts.spaceId),
          body: JSON.stringify(body ?? {}),
          signal: anySignal(timeoutSignal, opts.signal),
          redirect: "manual",
        });
      } catch (err) {
        if (opts.signal?.aborted) throw cancelledError(opts.signal.reason);
        const error = new NotionError("NETWORK_TIMEOUT", `${endpoint}: ${timeoutSignal.aborted ? "request timed out" : "network error"}`, { cause: err });
        if (safe && attempt < this.maxRetries) {
          this.logger.warn({ endpoint, attempt, reason: error.message }, "retrying after network error");
          await this.sleep(fullJitterDelay(attempt++, 500, 8_000, this.random), opts.signal);
          continue;
        }
        throw error;
      }

      this.opts.cookies.applySetCookie(url, resp.headers.getSetCookie?.() ?? []);

      if (resp.status === 401 && !opts.skipAuthCheck) {
        await resp.body?.cancel().catch(() => {});
        if (authReplayed) {
          throw new NotionError("NOTION_API_ERROR", `${endpoint}: HTTP 401 although the session check passed`, { status: 401 });
        }
        authReplayed = true;
        const state = await this.session.confirm("http_401");
        if (state === "AUTH_DEAD") this.session.assertUsable();
        continue;
      }

      if (resp.status === 429) {
        await resp.body?.cancel().catch(() => {});
        const header = Number(resp.headers.get("retry-after"));
        const retryAfterMs = Number.isFinite(header) && header > 0 ? header * 1000 : undefined;
        if (attempt < this.maxRetries) {
          const wait = retryAfterMs ?? fullJitterDelay(attempt, 1_000, 16_000, this.random);
          this.logger.warn({ endpoint, attempt, waitMs: wait }, "rate limited");
          attempt++;
          await this.sleep(wait, opts.signal);
          continue;
        }
        throw new NotionError("RATE_LIMITED", `${endpoint}: rate limited`, { status: 429, ...(retryAfterMs ? { retryAfterMs } : {}) });
      }

      if (resp.status >= 500) {
        const rawError = summarizeErrorBody(await resp.json().catch(() => undefined));
        if (safe && attempt < this.maxRetries) {
          this.logger.warn({ endpoint, attempt, status: resp.status }, "retrying after server error");
          await this.sleep(fullJitterDelay(attempt++, 500, 8_000, this.random), opts.signal);
          continue;
        }
        throw new NotionError("SERVER_ERROR", `${endpoint}: HTTP ${resp.status}`, { status: resp.status, rawError });
      }

      if (!resp.ok) {
        const rawError = summarizeErrorBody(await resp.json().catch(() => undefined));
        throw this.mapClientError(endpoint, resp.status, rawError, isReadOnlyEndpoint(endpoint));
      }

      const text = await resp.text();
      if (text === "") return undefined as T;
      try {
        return JSON.parse(text) as T;
      } catch (err) {
        throw new NotionError("SERVER_ERROR", `${endpoint}: HTTP ${resp.status} with a non-JSON body`, { status: resp.status, cause: err });
      }
    }
  }

  private headers(url: URL, spaceId: string | null | undefined): Record<string, string> {
    const h: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json",
      origin: `${this.apiBase.protocol}//${this.apiBase.host}`,
      "user-agent": this.userAgent,
    };
    const cookie = this.opts.cookies.headerFor(url);
    if (cookie) h.cookie = cookie;
    if (this.userId) h["x-notion-active-user-header"] = this.userId;
    const space = spaceId === null ? undefined : (spaceId ?? this.spaceId);
    if (space) h["x-notion-space-id"] = space;
    if (this.opts.clientVersion) h["notion-client-version"] = this.opts.clientVersion;
    return h;
  }

  private mapClientError(endpoint: string, status: number, rawError: unknown, readOnly: boolean): NotionError {
    const name = (rawError as { name?: string } | undefined)?.name;
    const opts = { status, ...(rawError === undefined ? {} : { rawError }) };
    if (status === 401) return new NotionError("NOTION_API_ERROR", `${endpoint}: HTTP 401`, opts);
    if (status === 403) return new NotionError("PERMISSION_DENIED", `${endpoint}: forbidden`, opts);
    if (status === 404) return new NotionError("NOT_FOUND", `${endpoint}: not found`, opts);
    if (status === 413) return new NotionError("INVALID_ARGUMENT", `${endpoint}: request too large`, opts);
    if (status === 400 && !readOnly && name === "ValidationError") {
      return new NotionError("WRITE_REJECTED", `${endpoint}: the server rejected the write`, opts);
    }
    return new NotionError("NOTION_API_ERROR", `${endpoint}: HTTP ${status}`, opts);
  }
}
