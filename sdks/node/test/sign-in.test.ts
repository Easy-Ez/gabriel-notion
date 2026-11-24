import { describe, expect, it } from "vitest";
import { listWorkspaces, notionSessionCookies, signInWithBrowserWith, type BrowserProcess, type CdpSocket, type SignInDeps } from "../src/core/sign-in.js";
import { SECRET_TOKEN, SPACE_ID, USER_ID, fakeFetch, json } from "./helpers/fake-fetch.js";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

interface Harness {
  deps: SignInDeps;
  spawned: string[][];
  killed: string[];
  removed: string[];
  closeWindow(): void;
}

/** A scripted browser: each poll returns the next cookie list (the last repeats). */
function harness(opts: { cookiePolls: unknown[][]; fetchScript?: Parameters<typeof fakeFetch>[0]; chromeExists?: boolean; windowCloses?: boolean }): Harness {
  const spawned: string[][] = [];
  const killed: string[] = [];
  const removed: string[] = [];
  let exitListeners: Array<() => void> = [];
  let windows = 1;
  let poll = 0;
  const proc: BrowserProcess = {
    kill: (signal) => {
      killed.push(signal ?? "SIGTERM");
      setTimeout(() => exitListeners.forEach((l) => l()), 0);
      return true;
    },
    on: (event: string, listener: (...a: never[]) => void) => {
      if (event === "exit") exitListeners.push(listener as () => void);
      return proc;
    },
  };
  const socket: CdpSocket = (() => {
    const listeners = new Set<(d: string) => void>();
    return {
      send: (data) => {
        const { id, method } = JSON.parse(data) as { id: number; method: string };
        let result: Record<string, unknown> = {};
        if (method === "Target.getTargets") result = { targetInfos: Array.from({ length: windows }, () => ({ type: "page" })) };
        if (method === "Storage.getCookies") {
          result = { cookies: opts.cookiePolls[Math.min(poll, opts.cookiePolls.length - 1)] };
          poll++;
          if (opts.windowCloses && poll >= 2) windows = 0;
        }
        setTimeout(() => listeners.forEach((l) => l(JSON.stringify({ id, result }))), 0);
      },
      close: () => {},
      onMessage: (l) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
      onOpen: (l) => setTimeout(l, 0),
      onClose: () => {},
      onError: () => {},
    };
  })();
  const { fetch } = fakeFetch(
    opts.fetchScript ?? {
      getSpaces: [() => json(200, { [USER_ID]: { space: { [SPACE_ID]: { value: { value: { name: "Test WS" } } } } } })],
    },
  );
  const deps: SignInDeps = {
    fetch,
    spawn: (cmd, args) => {
      spawned.push([cmd, ...args]);
      return proc;
    },
    createWebSocket: () => socket,
    fs: {
      exists: (f) => (opts.chromeExists ?? true) && f === CHROME,
      mkdtemp: (prefix) => `/tmp/${prefix}test`,
      readFile: (f) => (f.endsWith("DevToolsActivePort") ? "9222\n/devtools/browser/abc-123\n" : undefined),
      rm: (dir) => removed.push(dir),
    },
    pollIntervalMs: 1,
    rejectedGraceMs: 20,
    launchTimeoutMs: 500,
    exitWaitMs: 50,
  };
  return {
    deps,
    spawned,
    killed,
    removed,
    closeWindow: () => {
      windows = 0;
    },
  };
}

const notionCookies = [
  { name: "token_v2", value: SECRET_TOKEN, domain: ".app.notion.com", path: "/" },
  { name: "notion_user_id", value: USER_ID, domain: ".app.notion.com", path: "/" },
  { name: "SID", value: "google-session", domain: ".google.com", path: "/" },
];

describe("signInWithBrowser", () => {
  it("returns Notion cookies and workspaces once the session works, then cleans up", async () => {
    const h = harness({ cookiePolls: [[], notionCookies] });
    const statuses: string[] = [];
    const r = await signInWithBrowserWith(h.deps, { onStatus: (s) => statuses.push(s) });
    expect(r.userId).toBe(USER_ID);
    expect(r.workspaces).toEqual([{ id: SPACE_ID, name: "Test WS" }]);
    expect(r.cookies.map((c) => c.name).sort()).toEqual(["notion_user_id", "token_v2"]);
    expect(statuses).toEqual(["opening", "waiting", "verifying", "done"]);
    expect(h.spawned[0]).toContain("--app=https://app.notion.com/login");
    expect(h.spawned[0]!.some((a) => a.startsWith("--user-data-dir=/tmp/gabriel-notion-login-"))).toBe(true);
    expect(h.killed).toContain("SIGTERM");
    expect(h.removed).toEqual(["/tmp/gabriel-notion-login-test"]);
  });

  it("opens Google's consent screen directly when asked", async () => {
    const h = harness({ cookiePolls: [notionCookies] });
    await signInWithBrowserWith(h.deps, { provider: "google", email: "a+b@example.invalid" });
    expect(h.spawned[0]).toContain("--app=https://app.notion.com/googlepopupredirect?callbackType=redirect&redirectToAuth=true&email=a%2Bb%40example.invalid");
  });

  it("rejects with CANCELLED when the person closes the window", async () => {
    const h = harness({ cookiePolls: [[]], windowCloses: true });
    await expect(signInWithBrowserWith(h.deps)).rejects.toMatchObject({ code: "CANCELLED" });
    expect(h.removed).toHaveLength(1);
  });

  it("rejects with SIGN_IN_TIMEOUT when nobody signs in", async () => {
    const h = harness({ cookiePolls: [[]] });
    await expect(signInWithBrowserWith(h.deps, { timeoutMs: 30 })).rejects.toMatchObject({ code: "SIGN_IN_TIMEOUT" });
    expect(h.removed).toHaveLength(1);
  });

  it("rejects with AUTH_DEAD when Notion keeps rejecting the session past the grace period", async () => {
    const h = harness({ cookiePolls: [notionCookies], fetchScript: { getSpaces: [() => json(401, {})], authValidate: [() => json(401, {})] } });
    const err = await signInWithBrowserWith(h.deps, { timeoutMs: 2000 }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "AUTH_DEAD" });
    expect(JSON.stringify(err)).not.toContain(SECRET_TOKEN.slice(0, 20));
  });

  it("rejects with BROWSER_NOT_FOUND without Chrome, and validates browserPath", async () => {
    const h = harness({ cookiePolls: [[]], chromeExists: false });
    await expect(signInWithBrowserWith(h.deps)).rejects.toMatchObject({ code: "BROWSER_NOT_FOUND" });
    await expect(signInWithBrowserWith(h.deps, { browserPath: "relative/chrome" })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(h.spawned).toHaveLength(0);
  });
});

describe("notionSessionCookies", () => {
  it("keeps only Notion-domain cookies and requires token_v2", () => {
    expect(notionSessionCookies([{ name: "x", value: "1", domain: ".notion.com" }])).toBeUndefined();
    expect(notionSessionCookies(notionCookies)?.map((c) => c.domain)).toEqual([".app.notion.com", ".app.notion.com"]);
  });
});

describe("listWorkspaces", () => {
  it("lists workspaces for stored cookies and reports AUTH_DEAD for a dead session", async () => {
    const ok = fakeFetch({ getSpaces: [() => json(200, { [USER_ID]: { space: { [SPACE_ID]: { value: { name: "Test WS" } } } } })] });
    await expect(listWorkspaces({ cookies: notionCookies, fetch: ok.fetch })).resolves.toEqual({ userId: USER_ID, workspaces: [{ id: SPACE_ID, name: "Test WS" }] });
    const dead = fakeFetch({ getSpaces: [() => json(401, {})], authValidate: [() => json(401, {})] });
    await expect(listWorkspaces({ cookies: notionCookies, fetch: dead.fetch })).rejects.toMatchObject({ code: "AUTH_DEAD" });
  });
});
