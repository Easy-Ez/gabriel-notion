import { spawn as nodeSpawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { NotionError, cancelledError, isNotionError } from "../errors.js";
import { sleep } from "../util/async.js";
import type { CookieInput } from "./cookies.js";
import { NotionCore } from "./core.js";
import type { FetchLike } from "./http.js";
import type { WorkspaceInfo } from "./account.js";

/** Progress of {@link signInWithBrowser}. `verifying` and `waiting` may alternate during SSO redirects. */
export type SignInStatus = "opening" | "waiting" | "verifying" | "done";

export interface SignInOptions {
  /**
   * Optional email. With `provider: "google"` it becomes Google's account hint; otherwise it is
   * only used to choose the account when the session holds several.
   */
  email?: string;
  /**
   * `"google"` opens Google's consent screen directly instead of Notion's sign-in page
   * (the entry URL redirects to Google; the full flow is not verified yet).
   */
  provider?: "google";
  /** Limit for the whole sign-in. Default 300,000 ms. */
  timeoutMs?: number;
  /** Aborting closes the window and rejects with CANCELLED. */
  signal?: AbortSignal;
  /** Absolute path of a Chrome / Chromium executable. Default: the first one found in the usual locations. */
  browserPath?: string;
  /** Progress callback; the only output of the sign-in. Exceptions it throws are ignored. */
  onStatus?: (status: SignInStatus) => void;
}

export interface SignInResult {
  /** The session cookies for Notion hosts. Treat them like a password. */
  cookies: CookieInput[];
  userId: string;
  workspaces: WorkspaceInfo[];
}

/** Minimal child-process surface of the sign-in window. */
export interface BrowserProcess {
  kill(signal?: NodeJS.Signals): boolean;
  on(event: "exit", listener: () => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
}

/** Minimal DevTools socket surface. */
export interface CdpSocket {
  send(data: string): void;
  close(): void;
  onMessage(listener: (data: string) => void): () => void;
  onOpen(listener: () => void): void;
  onClose(listener: () => void): void;
  onError(listener: (err: unknown) => void): void;
}

/** Side effects of the sign-in, injectable for tests. */
export interface SignInDeps {
  fetch?: FetchLike;
  spawn(command: string, args: string[]): BrowserProcess;
  createWebSocket(url: string): CdpSocket;
  fs: {
    exists(file: string): boolean;
    mkdtemp(prefix: string): string;
    readFile(file: string): string | undefined;
    rm(dir: string): void;
  };
  pollIntervalMs: number;
  /** How long a session cookie may keep failing verification (SSO redirects) before it counts as rejected. */
  rejectedGraceMs: number;
  launchTimeoutMs: number;
  exitWaitMs: number;
}

const CHROME_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
];

export const SIGN_IN_URL = "https://app.notion.com/login";
/** The web client's entry point for signing in with Google directly. */
export const GOOGLE_SIGN_IN_URL = "https://app.notion.com/googlepopupredirect?callbackType=redirect&redirectToAuth=true";
const CDP_CALL_TIMEOUT_MS = 10_000;
const NOTION_COOKIE_DOMAIN = /(^|\.)notion\.(com|so)$/i;

/** Wraps Node's built-in WebSocket (Node ≥ 22) in the CdpSocket surface. */
function builtinSocket(url: string): CdpSocket {
  const ws = new WebSocket(url);
  return {
    send: (data) => ws.send(data),
    close: () => ws.close(),
    onMessage: (listener) => {
      const h = (e: MessageEvent) => listener(String(e.data));
      ws.addEventListener("message", h);
      return () => ws.removeEventListener("message", h);
    },
    onOpen: (listener) => ws.addEventListener("open", () => listener(), { once: true }),
    onClose: (listener) => ws.addEventListener("close", () => listener(), { once: true }),
    onError: (listener) => ws.addEventListener("error", (e) => listener(e)),
  };
}

function defaultDeps(): SignInDeps {
  return {
    spawn: (command, args) => nodeSpawn(command, args, { stdio: "ignore" }),
    createWebSocket: builtinSocket,
    fs: {
      exists: existsSync,
      mkdtemp: (prefix) => mkdtempSync(path.join(os.tmpdir(), prefix)),
      readFile: (file) => {
        try {
          return readFileSync(file, "utf8");
        } catch {
          return undefined;
        }
      },
      rm: (dir) => rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }),
    },
    pollIntervalMs: 1000,
    rejectedGraceMs: 30_000,
    launchTimeoutMs: 15_000,
    exitWaitMs: 3000,
  };
}

/**
 * Verifies stored cookies and lists the account's workspaces (no credentials are returned).
 * Rejects with AUTH_DEAD when the session is signed out or expired.
 */
export async function listWorkspaces(opts: { cookies: CookieInput[] | Record<string, string>; userId?: string; fetch?: FetchLike; signal?: AbortSignal }): Promise<{ userId: string; workspaces: WorkspaceInfo[] }> {
  if (opts.signal?.aborted) throw cancelledError(opts.signal.reason);
  const core = new NotionCore({ cookies: opts.cookies, ...(opts.userId ? { userId: opts.userId } : {}), ...(opts.fetch ? { fetch: opts.fetch } : {}), maxRetries: 1 });
  const acct = await core.account();
  return { userId: acct.userId, workspaces: acct.workspaces };
}

/**
 * Signs in to Notion in a dedicated Chrome window with a fresh temporary profile. The person
 * signs in themselves; once the session cookies work, the window closes and the cookies are
 * returned with the account's workspaces.
 *
 * Writes nothing besides the temporary profile, which is deleted whatever the outcome, and
 * prints nothing: progress is reported through `onStatus` only. The cookies never pass through
 * a child process's output. Errors never contain cookie values.
 *
 * Rejects with BROWSER_NOT_FOUND, SIGN_IN_TIMEOUT, CANCELLED (aborted or window closed) or
 * AUTH_DEAD (signed in, but Notion keeps rejecting the session).
 */
export function signInWithBrowser(opts: SignInOptions = {}): Promise<SignInResult> {
  return signInWithBrowserWith(defaultDeps(), opts);
}

function resolveBrowser(browserPath: string | undefined, exists: (file: string) => boolean): string {
  if (browserPath !== undefined) {
    if (typeof browserPath !== "string" || !path.isAbsolute(browserPath)) throw new NotionError("INVALID_ARGUMENT", "browserPath must be an absolute path");
    if (!exists(browserPath)) throw new NotionError("BROWSER_NOT_FOUND", "browserPath does not exist");
    return browserPath;
  }
  const found = CHROME_CANDIDATES.find((p) => exists(p));
  if (!found) throw new NotionError("BROWSER_NOT_FOUND", "Chrome or Chromium not found; pass browserPath");
  return found;
}

function signInUrl(opts: SignInOptions): string {
  if (opts.provider !== "google") return SIGN_IN_URL;
  return opts.email ? `${GOOGLE_SIGN_IN_URL}&email=${encodeURIComponent(opts.email)}` : GOOGLE_SIGN_IN_URL;
}

async function waitForDevTools(deps: SignInDeps, profile: string, signal: AbortSignal): Promise<string> {
  const deadline = Date.now() + deps.launchTimeoutMs;
  while (Date.now() < deadline) {
    const [port, wsPath] = (deps.fs.readFile(path.join(profile, "DevToolsActivePort")) ?? "").split("\n").map((l) => l.trim());
    if (port && /^\d{1,5}$/.test(port) && Number(port) <= 65535 && wsPath && /^\/devtools\/browser\/[\w-]+$/.test(wsPath)) {
      return `ws://127.0.0.1:${port}${wsPath}`;
    }
    await sleep(100, signal);
  }
  throw new NotionError("INVALID_STATE", "could not reach the sign-in browser window");
}

function cdpClient(socket: CdpSocket): (method: string) => Promise<Record<string, unknown>> {
  let seq = 0;
  return (method) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      const timer = setTimeout(() => {
        off();
        reject(new NotionError("INVALID_STATE", `the sign-in browser window did not answer ${method}`));
      }, CDP_CALL_TIMEOUT_MS);
      const off = socket.onMessage((raw) => {
        let msg: { id?: number; error?: unknown; result?: Record<string, unknown> };
        try {
          msg = JSON.parse(raw) as typeof msg;
        } catch {
          return;
        }
        if (msg.id !== id) return;
        clearTimeout(timer);
        off();
        if (msg.error) reject(new NotionError("INVALID_STATE", `the sign-in browser window rejected ${method}`));
        else resolve(msg.result ?? {});
      });
      socket.send(JSON.stringify({ id, method }));
    });
}

/** Notion cookies from a CDP cookie list, or undefined while there is no session cookie yet. */
export function notionSessionCookies(cookies: unknown): CookieInput[] | undefined {
  if (!Array.isArray(cookies)) return undefined;
  const list = (cookies as Array<{ name?: unknown; value?: unknown; domain?: unknown; path?: unknown }>)
    .filter((c) => typeof c.name === "string" && typeof c.value === "string" && typeof c.domain === "string" && NOTION_COOKIE_DOMAIN.test(c.domain.replace(/^\./, "")))
    .map((c) => ({ name: c.name as string, value: c.value as string, domain: c.domain as string, path: typeof c.path === "string" ? c.path : "/" }));
  return list.some((c) => c.name === "token_v2" && c.value !== "") ? list : undefined;
}

const windowClosed = () => new NotionError("CANCELLED", "the sign-in window was closed before signing in");
const sessionRejected = () => new NotionError("AUTH_DEAD", "signed in, but Notion rejected the session");

/** {@link signInWithBrowser} with injected dependencies. */
export async function signInWithBrowserWith(deps: SignInDeps, opts: SignInOptions = {}): Promise<SignInResult> {
  const timeoutMs = opts.timeoutMs ?? 300_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new NotionError("INVALID_ARGUMENT", "timeoutMs must be a positive number");
  if (opts.signal?.aborted) throw cancelledError(opts.signal.reason);
  const browser = resolveBrowser(opts.browserPath, deps.fs.exists);

  let lastStatus: SignInStatus | undefined;
  const report = (status: SignInStatus) => {
    if (status === lastStatus) return;
    lastStatus = status;
    try {
      opts.onStatus?.(status);
    } catch {
      /* a failing progress callback must not break the sign-in */
    }
  };

  const stop = new AbortController();
  let closing = false;
  const fail = (err: NotionError) => {
    if (!closing && !stop.signal.aborted) stop.abort(err);
  };
  const stopped = new Promise<never>((_, reject) => stop.signal.addEventListener("abort", () => reject(stop.signal.reason), { once: true }));
  stopped.catch(() => undefined);
  const guard = <T>(p: Promise<T>): Promise<T> => Promise.race([p, stopped]);

  let rejected: { token: string; since: number } | undefined;
  const onAbort = () => fail(cancelledError(opts.signal?.reason));
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(
    () => fail(rejected ? sessionRejected() : new NotionError("SIGN_IN_TIMEOUT", `sign-in did not complete within ${Math.round(timeoutMs / 1000)} s`)),
    timeoutMs,
  );

  let profile: string | undefined;
  let proc: BrowserProcess | undefined;
  let exited = false;
  let socket: CdpSocket | undefined;
  let result: SignInResult | undefined;
  try {
    report("opening");
    profile = deps.fs.mkdtemp("gabriel-notion-login-");
    proc = deps.spawn(browser, ["--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", `--app=${signInUrl(opts)}`]);
    proc.on("exit", () => {
      exited = true;
      fail(windowClosed());
    });
    proc.on("error", (err) => {
      exited = true;
      const code = (err as NodeJS.ErrnoException).code;
      fail(new NotionError(code === "ENOENT" || code === "EACCES" ? "BROWSER_NOT_FOUND" : "INVALID_STATE", "the browser could not be started", { cause: err }));
    });
    const wsUrl = await guard(waitForDevTools(deps, profile, stop.signal));
    socket = deps.createWebSocket(wsUrl);
    const s = socket;
    await guard(
      new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new NotionError("INVALID_STATE", "could not reach the sign-in browser window")), deps.launchTimeoutMs);
        s.onOpen(() => {
          clearTimeout(t);
          resolve();
        });
        s.onError((err) => reject(new NotionError("INVALID_STATE", "could not reach the sign-in browser window", { cause: err })));
      }),
    );
    s.onClose(() => fail(windowClosed()));
    const cdp = cdpClient(s);

    report("waiting");
    let sawWindow = false;
    for (;;) {
      // On macOS closing the last window leaves Chrome running, so watch the targets too.
      const { targetInfos } = await guard(cdp("Target.getTargets"));
      const windows = Array.isArray(targetInfos) ? targetInfos.filter((t: { type?: unknown }) => t.type === "page" || t.type === "app") : [];
      if (windows.length > 0) sawWindow = true;
      else if (sawWindow) throw windowClosed();

      const { cookies } = await guard(cdp("Storage.getCookies"));
      const session = notionSessionCookies(cookies);
      if (session) {
        report("verifying");
        const token = session.find((c) => c.name === "token_v2")!.value;
        try {
          const acct = await guard(
            listWorkspaces({ cookies: session, ...(deps.fetch ? { fetch: deps.fetch } : {}), signal: stop.signal }),
          );
          result = { cookies: session, userId: acct.userId, workspaces: acct.workspaces };
          break;
        } catch (err) {
          if (stop.signal.aborted) throw stop.signal.reason;
          if (isNotionError(err, "AUTH_DEAD")) {
            // Usually the sign-in is still redirecting through SSO; give it time before giving up.
            if (rejected?.token !== token) rejected = { token, since: Date.now() };
            else if (Date.now() - rejected.since >= deps.rejectedGraceMs) throw sessionRejected();
          } else if (!(isNotionError(err) && err.retryable)) {
            throw err;
          }
        }
        report("waiting");
      } else {
        rejected = undefined;
      }
      await sleep(deps.pollIntervalMs, stop.signal);
    }
  } catch (err) {
    if (stop.signal.aborted) throw stop.signal.reason;
    if (err instanceof NotionError) throw err;
    throw new NotionError("INVALID_STATE", "browser sign-in failed", { cause: err });
  } finally {
    closing = true;
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
    await closeWindow(deps, proc, () => exited, socket);
    if (profile) {
      try {
        deps.fs.rm(profile);
      } catch {
        /* best effort; the OS cleans its temp directory eventually */
      }
    }
  }
  report("done");
  return result!;
}

async function closeWindow(deps: SignInDeps, proc: BrowserProcess | undefined, exited: () => boolean, socket: CdpSocket | undefined): Promise<void> {
  try {
    socket?.close();
  } catch {
    /* already closed */
  }
  if (!proc || exited()) return;
  const gone = new Promise<void>((resolve) => proc.on("exit", () => resolve()));
  const wait = () => Promise.race([gone, sleep(deps.exitWaitMs).then(() => Promise.reject(new Error("timeout")))]);
  try {
    proc.kill("SIGTERM");
  } catch {
    /* already gone */
  }
  try {
    await wait();
  } catch {
    try {
      proc.kill("SIGKILL");
    } catch {
      /* already gone */
    }
    await wait().catch(() => undefined);
  }
}
