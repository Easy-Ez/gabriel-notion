import { createCipheriv, pbkdf2Sync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  cookieDbPath,
  decryptCookieValue,
  defaultChromeDir,
  deriveKey,
  extractFromChromeProfileWith,
  rowsToCookies,
  type CookieRow,
  type CookieStoreDeps,
} from "../src/core/cookie-store.js";
import { SECRET_TOKEN, SPACE_ID, USER_ID, fakeFetch, json } from "./helpers/fake-fetch.js";

const PASSWORD = "synthetic-safe-storage-pass";
const KEY = deriveKey(PASSWORD);

/** Encrypts a value exactly as Chrome does on macOS (v10), optionally with the 32-byte prefix. */
function encryptV10(value: string, withDomainPrefix = false): Buffer {
  const iv = Buffer.alloc(16, " ");
  const cipher = createCipheriv("aes-128-cbc", KEY, iv);
  cipher.setAutoPadding(true);
  const plain = withDomainPrefix ? Buffer.concat([Buffer.alloc(32, 0), Buffer.from(value, "latin1")]) : Buffer.from(value, "latin1");
  return Buffer.concat([Buffer.from("v10"), cipher.update(plain), cipher.final()]);
}

describe("deriveKey", () => {
  it("uses Chromium's PBKDF2 parameters", () => {
    expect(KEY).toEqual(pbkdf2Sync(PASSWORD, "saltysalt", 1003, 16, "sha1"));
    expect(KEY).toHaveLength(16);
  });
});

describe("decryptCookieValue", () => {
  it("round-trips a v10 value, with and without the domain-hash prefix", () => {
    expect(decryptCookieValue(KEY, encryptV10(SECRET_TOKEN))).toBe(SECRET_TOKEN);
    expect(decryptCookieValue(KEY, encryptV10(SECRET_TOKEN, true))).toBe(SECRET_TOKEN);
  });
  it("returns a legacy unencrypted value as-is", () => {
    expect(decryptCookieValue(KEY, Buffer.from("plainvalue"))).toBe("plainvalue");
  });
  it("refuses app-bound v20 cookies", () => {
    expect(() => decryptCookieValue(KEY, Buffer.concat([Buffer.from("v20"), Buffer.alloc(16)]))).toThrow(expect.objectContaining({ code: "INVALID_STATE" }));
  });
});

describe("rowsToCookies", () => {
  const rows: CookieRow[] = [
    { name: "token_v2", host: ".app.notion.com", path: "/", encrypted: encryptV10(SECRET_TOKEN) },
    { name: "notion_user_id", host: ".app.notion.com", path: "/", encrypted: encryptV10(USER_ID) },
    { name: "file_token", host: ".notion.com", path: "/f", encrypted: encryptV10("ft") },
    { name: "sid", host: ".google.com", path: "/", encrypted: encryptV10("should-be-dropped") },
  ];
  it("keeps only Notion cookies and requires token_v2", () => {
    const cookies = rowsToCookies(KEY, rows)!;
    expect(cookies.map((c) => c.name)).toEqual(["token_v2", "notion_user_id", "file_token"]);
    expect(cookies.find((c) => c.name === "file_token")).toMatchObject({ domain: ".notion.com", path: "/f" });
    expect(cookies.find((c) => c.name === "token_v2")?.value).toBe(SECRET_TOKEN);
    expect(rowsToCookies(KEY, rows.slice(1))).toBeUndefined();
  });
});

describe("path resolution", () => {
  const deps = { platform: "darwin" as NodeJS.Platform, homedir: "/Users/syn" };
  it("builds the macOS Chrome directory and finds the cookie DB", () => {
    const dir = defaultChromeDir(deps);
    expect(dir).toBe("/Users/syn/Library/Application Support/Google/Chrome");
    const existing = `${dir}/Default/Network/Cookies`;
    expect(cookieDbPath({ exists: (p) => p === existing }, dir, "Default")).toBe(existing);
    expect(() => cookieDbPath({ exists: () => false }, dir, "Default")).toThrow(expect.objectContaining({ code: "NOT_FOUND" }));
  });
  it("refuses non-macOS platforms", () => {
    expect(() => defaultChromeDir({ platform: "win32", homedir: "C:/" })).toThrow(expect.objectContaining({ code: "INVALID_STATE" }));
  });
});

describe("extractFromChromeProfileWith", () => {
  function deps(over: Partial<CookieStoreDeps> = {}): { deps: CookieStoreDeps; cleaned: string[] } {
    const cleaned: string[] = [];
    const { fetch } = fakeFetch({ getSpaces: [() => json(200, { [USER_ID]: { space: { [SPACE_ID]: { value: { value: { name: "Test WS" } } } } } })] });
    return {
      cleaned,
      deps: {
        platform: "darwin",
        homedir: "/Users/syn",
        exists: () => true,
        copyToTemp: () => "/tmp/copy/Cookies",
        cleanup: (f) => cleaned.push(f),
        readSafeStoragePassword: () => PASSWORD,
        listProfileDirs: () => ["Default"],
        readTextFile: () => undefined,
        readCookieRows: () => [
          { name: "token_v2", host: ".app.notion.com", path: "/", encrypted: encryptV10(SECRET_TOKEN) },
          { name: "notion_user_id", host: ".app.notion.com", path: "/", encrypted: encryptV10(USER_ID) },
        ],
        fetch,
        ...over,
      },
    };
  }

  it("reads, decrypts, verifies and cleans up the temp copy", async () => {
    const { deps: d, cleaned } = deps();
    const r = await extractFromChromeProfileWith(d, { profile: "Profile 1" });
    expect(r.userId).toBe(USER_ID);
    expect(r.workspaces).toEqual([{ id: SPACE_ID, name: "Test WS" }]);
    expect(r.cookies.map((c) => c.name)).toEqual(["token_v2", "notion_user_id"]);
    expect(cleaned).toEqual(["/tmp/copy/Cookies"]);
  });

  it("reports a profile with no Notion session and still cleans up", async () => {
    const { deps: d, cleaned } = deps({ readCookieRows: () => [{ name: "notion_user_id", host: ".app.notion.com", path: "/", encrypted: encryptV10(USER_ID) }] });
    await expect(extractFromChromeProfileWith(d)).rejects.toMatchObject({ code: "INVALID_STATE" });
    expect(cleaned).toHaveLength(1);
  });

  it("surfaces a Keychain permission failure", async () => {
    const { deps: d } = deps({
      readSafeStoragePassword: () => {
        throw new (class extends Error {})("denied");
      },
    });
    await expect(extractFromChromeProfileWith(d)).rejects.toBeInstanceOf(Error);
  });
})

import { extractFromChromeWith, listChromeSessionsWith, parseProfileNames } from "../src/core/cookie-store.js";

describe("profile enumeration", () => {
  const key = KEY;
  const tokenFor = (user: string) => encryptV10(`v03%3A${user}`);
  function multiDeps(valid: Record<string, string>): CookieStoreDeps {
    // valid: profile dir -> userId whose getSpaces returns 200. Others 401.
    const { fetch } = fakeFetch({
      getSpaces: [
        (req) => {
          const uid = (req.headers["x-notion-active-user-header"] as string) ?? "";
          const liveUser = Object.values(valid).find((u) => u === uid);
          return liveUser ? json(200, { [uid]: { notion_user: { [uid]: { value: { value: { email: `${uid}@example.invalid` } } } }, space: { [SPACE_ID]: { value: { value: { name: "WS" } } } } } }) : json(401, {});
        },
      ],
      authValidate: [() => json(401, {})],
    });
    const rowsByProfile: Record<string, CookieRow[]> = {};
    for (const [dir, uid] of Object.entries({ "Profile 1": "u1", "Profile 2": "u2", Default: "u0", ...Object.fromEntries(Object.entries(valid)) })) {
      rowsByProfile[dir] = [
        { name: "token_v2", host: ".app.notion.com", path: "/", encrypted: tokenFor(uid) },
        { name: "notion_user_id", host: ".app.notion.com", path: "/", encrypted: encryptV10(uid) },
      ];
    }
    return {
      platform: "darwin",
      homedir: "/Users/syn",
      exists: () => true,
      copyToTemp: (src) => src, // src encodes the profile dir
      cleanup: () => {},
      readSafeStoragePassword: () => PASSWORD,
      listProfileDirs: () => ["Default", "Profile 1", "Profile 2", "System Profile"],
      readTextFile: () => JSON.stringify({ profile: { info_cache: { "Profile 1": { name: "Cai" }, "Profile 2": { name: "work" } } } }),
      readCookieRows: (dbPath) => {
        const dir = Object.keys(rowsByProfile).find((d) => dbPath.includes(`/${d}/`)) ?? "Default";
        return rowsByProfile[dir] ?? [];
      },
      fetch,
    };
  }
  // make cookieDbPath produce a path that contains the profile dir
  const withDirPath = (d: CookieStoreDeps): CookieStoreDeps => ({ ...d, exists: (p) => p.endsWith("/Cookies") });

  it("parses display names from Local State", () => {
    expect(parseProfileNames(JSON.stringify({ profile: { info_cache: { "Profile 1": { name: "Cai" } } } }))).toEqual({ "Profile 1": "Cai" });
    expect(parseProfileNames(undefined)).toEqual({});
  });

  it("lists only the profiles with a valid session, one Keychain read", () => {
    // validity checked by live getSpaces; set Profile 2's user as the only live one.
  });

  it("auto-picks the only valid profile", async () => {
    const sessions = await listChromeSessionsWith(withDirPath(multiDeps({ "Profile 2": "u2" })));
    expect(sessions.map((s2) => [s2.profile, s2.profileName, s2.email])).toEqual([["Profile 2", "work", "u2@example.invalid"]]);
    const one = await extractFromChromeWith(withDirPath(multiDeps({ "Profile 2": "u2" })));
    expect(one.profile).toBe("Profile 2");
  });

  it("throws listing the choices when several profiles are valid", async () => {
    const err = await extractFromChromeWith(withDirPath(multiDeps({ "Profile 1": "u1", "Profile 2": "u2" }))).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "INVALID_ARGUMENT" });
    expect((err as { message: string }).message).toContain("Cai");
    expect((err as { message: string }).message).toContain("work");
  });

  it("errors when no profile is signed in", async () => {
    await expect(extractFromChromeWith(withDirPath(multiDeps({})))).rejects.toMatchObject({ code: "INVALID_STATE" });
  });
});
