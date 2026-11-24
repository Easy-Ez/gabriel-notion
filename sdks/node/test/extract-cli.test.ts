import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extractFromDebugChrome } from "../src/core/browser-extract.js";
import { FileCredentialStore } from "../src/core/credentials.js";
import { main, type CliIo } from "../src/cli/gabriel-notion.js";
import { SECRET_TOKEN, SPACE_ID, USER_ID, fakeFetch, json } from "./helpers/fake-fetch.js";

const browserCookies = [
  { name: "token_v2", value: SECRET_TOKEN, domain: ".app.notion.com", path: "/" },
  { name: "notion_user_id", value: USER_ID, domain: ".app.notion.com", path: "/" },
  { name: "other", value: "x", domain: ".example.com", path: "/" },
];

/** A fake DevTools WebSocket answering Storage.getCookies with `cookies`. */
function fakeSocket(cookies: unknown[]): WebSocket {
  const listeners: Record<string, Array<(e: unknown) => void>> = {};
  const ws = {
    addEventListener: (type: string, l: (e: unknown) => void) => {
      (listeners[type] ??= []).push(l);
      if (type === "open") setTimeout(() => l({}), 0);
    },
    removeEventListener: (type: string, l: (e: unknown) => void) => {
      listeners[type] = (listeners[type] ?? []).filter((x) => x !== l);
    },
    send: (data: string) => {
      const { id } = JSON.parse(data) as { id: number };
      setTimeout(() => (listeners.message ?? []).forEach((l) => l({ data: JSON.stringify({ id, result: { cookies } }) })), 0);
    },
    close: () => {},
  };
  return ws as unknown as WebSocket;
}

const spaces = () => json(200, { [USER_ID]: { space: { [SPACE_ID]: { value: { value: { name: "Test WS" } } } } } });

describe("extractFromDebugChrome", () => {
  it("reads Notion cookies over DevTools and verifies them", async () => {
    const { fetch } = fakeFetch({ version: [() => json(200, { webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/abc" })], getSpaces: [spaces] });
    const r = await extractFromDebugChrome({ fetch, createWebSocket: () => fakeSocket(browserCookies) });
    expect(r.userId).toBe(USER_ID);
    expect(r.workspaces).toEqual([{ id: SPACE_ID, name: "Test WS" }]);
    expect(r.cookies.map((c) => c.name)).toEqual(["token_v2", "notion_user_id"]);
  });

  it("explains how to start Chrome when no DevTools endpoint answers, and refuses non-local endpoints", async () => {
    const down = fakeFetch({ version: [() => new Error("ECONNREFUSED")] });
    await expect(extractFromDebugChrome({ port: 9333, fetch: down.fetch })).rejects.toMatchObject({ code: "INVALID_STATE", message: expect.stringContaining("--remote-debugging-port=9333") });
    const remote = fakeFetch({ version: [() => json(200, { webSocketDebuggerUrl: "ws://evil.example.com/devtools/browser/x" })] });
    await expect(extractFromDebugChrome({ fetch: remote.fetch })).rejects.toMatchObject({ code: "INVALID_STATE" });
    await expect(extractFromDebugChrome({ port: 70000 })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });

  it("reports a browser that is not signed in to Notion", async () => {
    const { fetch } = fakeFetch({ version: [() => json(200, { webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/abc" })] });
    await expect(extractFromDebugChrome({ fetch, createWebSocket: () => fakeSocket([]) })).rejects.toMatchObject({ code: "INVALID_STATE" });
  });
});

describe("gabriel-notion CLI", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "gabriel-notion-cli-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function io(over: Partial<CliIo> = {}) {
    const out: string[] = [];
    const err: string[] = [];
    const store = new FileCredentialStore(path.join(dir, "session.json"));
    const cookies = browserCookies.slice(0, 2);
    const base: CliIo = {
      out: (t) => out.push(t),
      err: (t) => err.push(t),
      store,
      signIn: async () => ({ cookies, userId: USER_ID, workspaces: [{ id: SPACE_ID, name: "Test WS" }] }),
      extract: async () => ({ cookies, userId: USER_ID, workspaces: [{ id: SPACE_ID, name: "Test WS" }] }),
      read: async () => ({ profile: "Default", cookies, userId: USER_ID, workspaces: [{ id: SPACE_ID, name: "Test WS" }] }),
      listSessions: async () => [{ profile: "Default", cookies, userId: USER_ID, workspaces: [{ id: SPACE_ID, name: "Test WS" }] }],
      list: async () => ({ userId: USER_ID, workspaces: [{ id: SPACE_ID, name: "Test WS" }] }),
      load: async (o) => (o?.store ? o.store.load() : undefined),
      ...over,
    };
    return { io: base, out, err, store };
  }

  it("login and extract save a 0600 session file and never print cookie values", async () => {
    for (const cmd of ["login", "extract", "read"]) {
      const h = io();
      expect(await main(["auth", cmd], h.io)).toBe(0);
      expect((await stat(h.store.file)).mode & 0o777).toBe(0o600);
      const printed = h.out.join("") + h.err.join("");
      expect(printed).toContain("Test WS");
      expect(printed).not.toContain(SECRET_TOKEN.slice(0, 20));
    }
  });

  it("status reports a missing session, then verifies a saved one", async () => {
    const h = io();
    expect(await main(["auth", "status"], h.io)).toBe(1);
    await h.store.save(browserCookies.slice(0, 2));
    expect(await main(["auth", "status"], h.io)).toBe(0);
    expect(h.out.join("")).toContain("Workspaces (1)");
  });

  it("logout needs --yes", async () => {
    const h = io();
    await h.store.save(browserCookies.slice(0, 2));
    expect(await main(["auth", "logout"], h.io)).toBe(1);
    expect(await main(["auth", "logout", "--yes"], h.io)).toBe(0);
    expect(await h.store.load()).toBeUndefined();
  });

  it("prints help for unknown commands", async () => {
    const h = io();
    expect(await main(["auth", "nope"], h.io)).toBe(1);
    expect(h.out.join("")).toContain("Usage:");
  });
});
