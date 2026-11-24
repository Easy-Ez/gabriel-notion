import { NotionError } from "../errors.js";
import type { CookieInput } from "./cookies.js";
import type { FetchLike } from "./http.js";
import { listWorkspaces, notionSessionCookies } from "./sign-in.js";
import type { WorkspaceInfo } from "./account.js";

export interface ExtractOptions {
  /** DevTools port of a Chrome you started with `--remote-debugging-port`. Default 9222. */
  port?: number;
  /** Injected for tests: used for the DevTools discovery request and the session check. */
  fetch?: FetchLike;
  /** Injected for tests: opens the DevTools WebSocket. Default: Node's built-in WebSocket. */
  createWebSocket?: (url: string) => WebSocket;
}

export interface ExtractResult {
  /** Notion-domain cookies of that browser. Treat them like a password. */
  cookies: CookieInput[];
  userId: string;
  workspaces: WorkspaceInfo[];
}

function cdpCall(ws: WebSocket, id: number, method: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeEventListener("message", onMessage);
      reject(new NotionError("INVALID_STATE", `DevTools ${method} timed out`));
    }, 10_000);
    const onMessage = (e: MessageEvent) => {
      let msg: { id?: number; error?: unknown; result?: Record<string, unknown> };
      try {
        msg = JSON.parse(String(e.data)) as typeof msg;
      } catch {
        return;
      }
      if (msg.id !== id) return;
      clearTimeout(timer);
      ws.removeEventListener("message", onMessage);
      if (msg.error) reject(new NotionError("INVALID_STATE", `DevTools rejected ${method}`));
      else resolve(msg.result ?? {});
    };
    ws.addEventListener("message", onMessage);
    ws.send(JSON.stringify({ id, method }));
  });
}

/**
 * Reads the Notion session from a Chrome you started yourself with a remote debugging port,
 * through the DevTools `Storage.getCookies` call, and verifies it with `getSpaces`. This is a
 * door the person opens on purpose; Chrome does not expose the port by default. Chrome's
 * encrypted cookie files on disk are not read: that is fragile, OS-specific and the wrong trust
 * boundary. Start Chrome like this, sign in to Notion, then call this function:
 *
 *   "Google Chrome" --remote-debugging-port=9222 --user-data-dir=/tmp/notion-profile
 *
 * Only `127.0.0.1` is contacted. Cookie values are returned, never printed or logged.
 */
export async function extractFromDebugChrome(opts: ExtractOptions = {}): Promise<ExtractResult> {
  const port = opts.port ?? 9222;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new NotionError("INVALID_ARGUMENT", "debug port must be 1–65535");
  const doFetch = opts.fetch ?? ((input, init) => fetch(input, init));
  let wsUrl: string;
  try {
    const info = (await (await doFetch(`http://127.0.0.1:${port}/json/version`)).json()) as { webSocketDebuggerUrl?: string };
    if (typeof info.webSocketDebuggerUrl !== "string" || !/^ws:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(info.webSocketDebuggerUrl)) throw new Error("no local webSocketDebuggerUrl");
    wsUrl = info.webSocketDebuggerUrl;
  } catch {
    throw new NotionError(
      "INVALID_STATE",
      `no Chrome DevTools endpoint on 127.0.0.1:${port}. Start Chrome with --remote-debugging-port=${port} --user-data-dir=<dir>, sign in to Notion, then retry.`,
    );
  }
  const ws = (opts.createWebSocket ?? ((url: string) => new WebSocket(url)))(wsUrl);
  try {
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", () => reject(new NotionError("INVALID_STATE", "could not connect to Chrome DevTools")), { once: true });
    });
    const { cookies } = await cdpCall(ws, 1, "Storage.getCookies");
    const session = notionSessionCookies(cookies);
    if (!session) throw new NotionError("INVALID_STATE", "no signed-in Notion session found in that Chrome; sign in to Notion there first");
    const acct = await listWorkspaces({ cookies: session, ...(opts.fetch ? { fetch: opts.fetch } : {}) });
    return { cookies: session, userId: acct.userId, workspaces: acct.workspaces };
  } finally {
    ws.close();
  }
}
