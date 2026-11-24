import { mkdtemp, chmod, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NotionCore } from "../src/core/core.js";
import type { CookieInput } from "../src/core/cookies.js";
import { FileCredentialStore, defaultSessionFile, loadSessionCookies, parseCookieHeader, type CredentialStore } from "../src/core/credentials.js";
import type { Logger } from "../src/util/logger.js";
import { SECRET_TOKEN, baseCookies, fakeFetch, json } from "./helpers/fake-fetch.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "gabriel-notion-test-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("FileCredentialStore", () => {
  it("writes a 0600 file in a 0700 directory and reads it back", async () => {
    const file = path.join(dir, "cfg", "session.json");
    const store = new FileCredentialStore(file);
    await store.save(baseCookies);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(path.dirname(file))).mode & 0o777).toBe(0o700);
    expect(await store.load()).toEqual(baseCookies);
  });

  it("returns undefined when there is no file, and clears it", async () => {
    const store = new FileCredentialStore(path.join(dir, "none.json"));
    expect(await store.load()).toBeUndefined();
    await store.save(baseCookies);
    expect(await store.clear()).toBe(true);
    expect(await store.clear()).toBe(false);
  });

  it("refuses a file other users can read", async () => {
    const file = path.join(dir, "open.json");
    await writeFile(file, JSON.stringify({ cookies: baseCookies }));
    await chmod(file, 0o644);
    await expect(new FileCredentialStore(file).load()).rejects.toMatchObject({ code: "INVALID_STATE" });
  });

  it("defaults to the config directory from the environment", () => {
    expect(defaultSessionFile({ GABRIEL_NOTION_CONFIG_DIR: "/x/y" })).toBe(path.resolve("/x/y/session.json"));
    expect(defaultSessionFile({ XDG_CONFIG_HOME: "/cfg" })).toBe(path.resolve("/cfg/gabriel-notion/session.json"));
  });
});

describe("loadSessionCookies", () => {
  it("prefers GABRIEL_NOTION_COOKIES over the stored file", async () => {
    const store = new FileCredentialStore(path.join(dir, "s.json"));
    await store.save([{ name: "token_v2", value: "from-file" }]);
    const env = { GABRIEL_NOTION_COOKIES: `token_v2=${SECRET_TOKEN}; notion_user_id=u1; file_token=ft` };
    const cookies = await loadSessionCookies({ env, store });
    expect(cookies?.find((c) => c.name === "token_v2")?.value).toBe(SECRET_TOKEN);
    expect(cookies?.find((c) => c.name === "file_token")).toMatchObject({ domain: ".notion.com", path: "/f" });
    expect((await loadSessionCookies({ env: {}, store }))?.[0]?.value).toBe("from-file");
  });

  it("rejects an environment value without token_v2", async () => {
    await expect(loadSessionCookies({ env: { GABRIEL_NOTION_COOKIES: "a=1" } })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });

  it("parses a copied Cookie header", () => {
    expect(parseCookieHeader("Cookie: token_v2=abc=; x=1")).toEqual([
      { name: "token_v2", value: "abc=", domain: ".app.notion.com" },
      { name: "x", value: "1", domain: ".app.notion.com" },
    ]);
  });
});

class MemoryStore implements CredentialStore {
  saves: CookieInput[][] = [];
  fail = false;
  async load() {
    return this.saves.at(-1);
  }
  async save(cookies: CookieInput[]) {
    if (this.fail) throw new Error("disk full");
    this.saves.push(cookies);
  }
}

describe("credential write-back", () => {
  function coreWith(setCookies: string[][], store: MemoryStore, logger?: Logger) {
    const { fetch } = fakeFetch({ search: setCookies.map((h) => () => json(200, {}, h.map((v) => ["set-cookie", v] as [string, string]))) });
    return new NotionCore({ cookies: baseCookies, fetch, credentialStore: store, credentialSaveDelayMs: 5, ...(logger ? { logger } : {}) });
  }

  it("saves a snapshot when token_v2 rotates, debouncing bursts", async () => {
    const store = new MemoryStore();
    const core = coreWith([["token_v2=rotated-1; Domain=app.notion.com; Path=/"], ["token_v2=rotated-2; Domain=app.notion.com; Path=/"]], store);
    await core.callApi("search", {});
    await core.callApi("search", {});
    await core.flushCredentials();
    expect(store.saves).toHaveLength(1);
    expect(store.saves[0]!.find((c) => c.name === "token_v2")?.value).toBe("rotated-2");
    expect(core.health().credentials?.lastSavedAt).toBeDefined();
  });

  it("ignores changes to non-session cookies and unchanged values", async () => {
    const store = new MemoryStore();
    const core = coreWith([["__cf_bm=abc; Domain=notion.com; Path=/"], [`token_v2=${SECRET_TOKEN}; Domain=app.notion.com; Path=/`]], store);
    await core.callApi("search", {});
    await core.callApi("search", {});
    await core.flushCredentials();
    expect(store.saves).toHaveLength(0);
  });

  it("saves when the session cookie is deleted", async () => {
    const store = new MemoryStore();
    const core = coreWith([["token_v2=; Domain=app.notion.com; Path=/; Max-Age=0"]], store);
    await core.callApi("search", {});
    await core.flushCredentials();
    expect(store.saves).toHaveLength(1);
    expect(store.saves[0]!.some((c) => c.name === "token_v2")).toBe(false);
  });

  it("reports a failed save in health without logging any value", async () => {
    const lines: string[] = [];
    const log = (o: Record<string, unknown>, m?: string) => lines.push(JSON.stringify(o) + (m ?? ""));
    const store = new MemoryStore();
    store.fail = true;
    const core = coreWith([["token_v2=rotated-secret-value; Domain=app.notion.com; Path=/"]], store, { debug: log, info: log, warn: log, error: log });
    await core.callApi("search", {});
    await core.flushCredentials();
    expect(core.health().credentials?.lastError).toBe("STATE_STORE_UNAVAILABLE");
    expect(lines.join("\n")).not.toContain("rotated-secret-value");
    expect(JSON.stringify(core.health())).not.toContain("rotated-secret-value");
  });

  it("writes through FileCredentialStore end to end", async () => {
    const file = path.join(dir, "e2e.json");
    const { fetch } = fakeFetch({ search: [() => json(200, {}, [["set-cookie", "token_v2=rotated-e2e; Domain=app.notion.com; Path=/"]])] });
    const core = new NotionCore({ cookies: baseCookies, fetch, credentialStore: new FileCredentialStore(file), credentialSaveDelayMs: 5 });
    await core.callApi("search", {});
    await core.flushCredentials();
    expect(await readFile(file, "utf8")).toContain("rotated-e2e");
    expect((await new FileCredentialStore(file).load())?.find((c) => c.name === "token_v2")?.value).toBe("rotated-e2e");
  });
});
