import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDecipheriv, pbkdf2Sync } from "node:crypto";
import { NotionError } from "../errors.js";
import type { CookieInput } from "./cookies.js";
import type { FetchLike } from "./http.js";
import { NotionCore } from "./core.js";
import type { AccountInfo, WorkspaceInfo } from "./account.js";

/**
 * Reads the Notion session straight from Chrome's cookie store on disk, so an already
 * signed-in Chrome needs no fresh login. This is the person's own session on their own
 * machine; only `notion.com` / `notion.so` cookies are kept, the rest are discarded.
 *
 * macOS only in v0.1. Chrome encrypts cookie values (`v10` prefix) with AES-128-CBC; the
 * passphrase is the "Chrome Safe Storage" item in the login Keychain, which the AES key is
 * derived from (PBKDF2-HMAC-SHA1, salt "saltysalt", 1003 iterations). Reading the Keychain
 * item triggers a one-time macOS permission prompt. App-bound (`v20`) cookies from newer
 * Chrome are not decryptable this way; fall back to signInWithBrowser().
 */

const KDF_SALT = "saltysalt";
const KDF_ITERATIONS = 1003;
const KDF_KEY_LENGTH = 16;
const AES_IV = Buffer.alloc(16, " ");
const NOTION_HOST = /(^|\.)notion\.(com|so)$/i;

export interface CookieRow {
  name: string;
  host: string;
  path: string;
  /** Raw `encrypted_value` bytes (as stored), or undefined. */
  encrypted?: Buffer;
  /** Plaintext `value`, used only by very old Chrome that did not encrypt. */
  plain?: string;
}

/** Side effects, injected for tests. */
export interface CookieStoreDeps {
  platform: NodeJS.Platform;
  homedir: string;
  exists(p: string): boolean;
  /** Copies the locked cookie DB somewhere readable and returns the path. */
  copyToTemp(src: string): string;
  cleanup(dir: string): void;
  /** The "Chrome Safe Storage" passphrase from the Keychain. */
  readSafeStoragePassword(): string;
  /** Reads the `cookies` rows of a DB for the given host suffix. */
  readCookieRows(dbPath: string): CookieRow[];
  /** Immediate subdirectory names of the Chrome user-data directory (profile candidates). */
  listProfileDirs(chromeDir: string): string[];
  /** Reads a small text file (e.g. Local State), or undefined when absent. */
  readTextFile(p: string): string | undefined;
  fetch?: FetchLike;
}

export interface ChromeProfileOptions {
  /** Chrome profile directory name, e.g. "Default" or "Profile 1". Default "Default". */
  profile?: string;
  /** Overrides the Chrome user-data directory. Default: the platform's standard location. */
  userDataDir?: string;
  fetch?: FetchLike;
}

export interface ChromeProfileResult {
  cookies: CookieInput[];
  userId: string;
  workspaces: WorkspaceInfo[];
}

/** A signed-in Notion session found in a Chrome profile. */
export interface ChromeSession {
  /** Profile directory name, e.g. "Default" or "Profile 14". */
  profile: string;
  /** The profile's display name from Local State, when available. */
  profileName?: string;
  userId: string;
  name?: string;
  email?: string;
  workspaces: WorkspaceInfo[];
  cookies: CookieInput[];
}

export interface ExtractFromChromeOptions {
  /** Pick a profile by directory name ("Profile 14") or display name. Omit to auto-pick. */
  profile?: string;
  userDataDir?: string;
  fetch?: FetchLike;
}

export function defaultChromeDir(deps: Pick<CookieStoreDeps, "platform" | "homedir">): string {
  switch (deps.platform) {
    case "darwin":
      return path.join(deps.homedir, "Library", "Application Support", "Google", "Chrome");
    default:
      throw new NotionError("INVALID_STATE", `reading Chrome cookies from disk is only implemented on macOS in v0.1; use signInWithBrowser() on ${deps.platform}`);
  }
}

/** First existing cookie DB for a profile (`Network/Cookies` in current Chrome, else `Cookies`). */
export function cookieDbPath(deps: Pick<CookieStoreDeps, "exists">, chromeDir: string, profile: string): string {
  const candidates = [path.join(chromeDir, profile, "Network", "Cookies"), path.join(chromeDir, profile, "Cookies")];
  const found = candidates.find((p) => deps.exists(p));
  if (!found) throw new NotionError("NOT_FOUND", `no cookie store for Chrome profile "${profile}" under ${chromeDir}`);
  return found;
}

/** Derives the AES key from the Keychain passphrase (Chromium's macOS scheme). */
export function deriveKey(password: string): Buffer {
  return pbkdf2Sync(password, KDF_SALT, KDF_ITERATIONS, KDF_KEY_LENGTH, "sha1");
}

function isPrintable(buf: Buffer): boolean {
  if (buf.length === 0) return false;
  for (const b of buf) if (b < 0x20 || b > 0x7e) return false;
  return true;
}

/**
 * Decrypts one Chrome cookie value. `v10` is AES-128-CBC with a fixed IV; the plaintext may
 * carry a 32-byte domain-hash prefix in recent Chrome, stripped when the remainder is printable
 * ASCII (Notion session values are URL-safe ASCII). `v20` (app-bound) is unsupported.
 */
export function decryptCookieValue(key: Buffer, encrypted: Buffer): string {
  const prefix = encrypted.subarray(0, 3).toString("latin1");
  if (prefix === "v20") throw new NotionError("INVALID_STATE", "this Chrome uses app-bound cookie encryption (v20); use signInWithBrowser() instead");
  if (prefix !== "v10") return encrypted.toString("utf8"); // legacy unencrypted value
  const decipher = createDecipheriv("aes-128-cbc", key, AES_IV);
  decipher.setAutoPadding(false);
  const padded = Buffer.concat([decipher.update(encrypted.subarray(3)), decipher.final()]);
  const pad = padded.length ? padded[padded.length - 1]! : 0;
  const plain = pad > 0 && pad <= 16 ? padded.subarray(0, padded.length - pad) : padded;
  if (isPrintable(plain)) return plain.toString("latin1");
  const stripped = plain.subarray(32);
  if (isPrintable(stripped)) return stripped.toString("latin1");
  throw new NotionError("INVALID_STATE", "could not decode a cookie value; the Chrome cookie format may have changed");
}

/** Maps decrypted Notion rows to cookies. Returns undefined when there is no `token_v2`. */
export function rowsToCookies(key: Buffer, rows: readonly CookieRow[]): CookieInput[] | undefined {
  const cookies: CookieInput[] = [];
  for (const row of rows) {
    if (!NOTION_HOST.test(row.host.replace(/^\./, ""))) continue;
    let value: string;
    try {
      value = row.encrypted && row.encrypted.length ? decryptCookieValue(key, row.encrypted) : row.plain ?? "";
    } catch (err) {
      if (err instanceof NotionError && err.message.includes("v20")) throw err;
      continue; // skip an undecodable non-session cookie
    }
    if (value === "") continue;
    cookies.push({ name: row.name, value, domain: row.host, path: row.path || "/" });
  }
  return cookies.some((c) => c.name === "token_v2") ? cookies : undefined;
}

function defaultDeps(): CookieStoreDeps {
  return {
    platform: process.platform,
    homedir: os.homedir(),
    exists: existsSync,
    copyToTemp: (src) => {
      const dir = mkdtempSync(path.join(os.tmpdir(), "gabriel-notion-cookies-"));
      const dest = path.join(dir, "Cookies");
      // Copy the DB and its WAL / SHM side files so a recent write is included.
      copyFileSync(src, dest);
      for (const ext of ["-wal", "-shm"]) if (existsSync(src + ext)) copyFileSync(src + ext, dest + ext);
      return dest;
    },
    cleanup: (file) => rmSync(path.dirname(file), { recursive: true, force: true }),
    readSafeStoragePassword: () => {
      try {
        return execFileSync("security", ["find-generic-password", "-wa", "Chrome", "-s", "Chrome Safe Storage"], { encoding: "utf8" }).trim();
      } catch {
        throw new NotionError("INVALID_STATE", "could not read the Chrome Safe Storage key from the Keychain (permission denied or not found)");
      }
    },
    readCookieRows: (dbPath) => {
      const sql = "SELECT quote(name), quote(host_key), quote(path), quote(encrypted_value), quote(value) FROM cookies WHERE host_key LIKE '%notion.so' OR host_key LIKE '%notion.com';";
      let out: string;
      try {
        out = execFileSync("sqlite3", ["-batch", "-noheader", "-separator", "|", dbPath, sql], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
      } catch (err) {
        throw new NotionError("INVALID_STATE", "could not read the Chrome cookie database (is the system sqlite3 available?)", { cause: err });
      }
      // Each field is a sqlite quote(): 'text' with '' escapes, or X'hex' for blobs, or NULL.
      const unquote = (f: string): { text?: string; blob?: Buffer } => {
        if (f === "NULL") return {};
        if (f.startsWith("X'")) return { blob: Buffer.from(f.slice(2, -1), "hex") };
        return { text: f.slice(1, -1).replace(/''/g, "'") };
      };
      const rows: CookieRow[] = [];
      for (const line of out.split("\n")) {
        if (!line) continue;
        const parts = line.split("|");
        if (parts.length < 5) continue;
        const name = unquote(parts[0]!).text ?? "";
        const host = unquote(parts[1]!).text ?? "";
        const p = unquote(parts[2]!).text ?? "/";
        const enc = unquote(parts[3]!);
        const val = unquote(parts[4]!);
        const row: CookieRow = { name, host, path: p };
        if (enc.blob) row.encrypted = enc.blob;
        if (val.text) row.plain = val.text;
        rows.push(row);
      }
      return rows;
    },
    listProfileDirs: (chromeDir) => {
      try {
        return readdirSync(chromeDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
      } catch {
        return [];
      }
    },
    readTextFile: (fp) => {
      try {
        return readFileSync(fp, "utf8");
      } catch {
        return undefined;
      }
    },
  };
}

/** Parses `Local State` to map each profile directory to its display name. */
export function parseProfileNames(localState: string | undefined): Record<string, string> {
  if (!localState) return {};
  try {
    const cache = (JSON.parse(localState) as { profile?: { info_cache?: Record<string, { name?: string }> } }).profile?.info_cache ?? {};
    const out: Record<string, string> = {};
    for (const [dir, info] of Object.entries(cache)) if (info?.name) out[dir] = info.name;
    return out;
  } catch {
    return {};
  }
}

/** Reads and decrypts a profile's Notion cookies (no network). Undefined when it has no session. */
function readProfileCookies(deps: CookieStoreDeps, chromeDir: string, profile: string, key: Buffer): CookieInput[] | undefined {
  let dbPath: string;
  try {
    dbPath = cookieDbPath(deps, chromeDir, profile);
  } catch {
    return undefined;
  }
  const copy = deps.copyToTemp(dbPath);
  try {
    return rowsToCookies(key, deps.readCookieRows(copy));
  } finally {
    try {
      deps.cleanup(copy);
    } catch {
      /* best effort */
    }
  }
}

async function verify(cookies: CookieInput[], fetchFn?: FetchLike): Promise<AccountInfo> {
  const core = new NotionCore({ cookies, ...(fetchFn ? { fetch: fetchFn } : {}), maxRetries: 1 });
  return core.account();
}

/**
 * Finds every Chrome profile with a signed-in, currently valid Notion session. The Keychain is
 * read once (the key is shared across profiles), so this prompts at most once; each profile with
 * a token is verified with one `getSpaces`. Profiles with expired or signed-out sessions are left
 * out. Pass `profile` to limit the scan to one.
 */
export async function listChromeSessionsWith(deps: CookieStoreDeps, opts: ExtractFromChromeOptions = {}): Promise<ChromeSession[]> {
  const chromeDir = opts.userDataDir ?? defaultChromeDir(deps);
  const names = parseProfileNames(deps.readTextFile(path.join(chromeDir, "Local State")));
  const nameToDir = new Map(Object.entries(names).map(([dir, name]) => [name, dir]));
  const dirs = opts.profile
    ? [names[opts.profile] ? opts.profile : nameToDir.get(opts.profile) ?? opts.profile]
    : deps.listProfileDirs(chromeDir);
  const key = deriveKey(deps.readSafeStoragePassword());
  const fetchFn = opts.fetch ?? deps.fetch;
  const sessions: ChromeSession[] = [];
  for (const dir of dirs) {
    const cookies = readProfileCookies(deps, chromeDir, dir, key);
    if (!cookies) continue;
    let acct: AccountInfo;
    try {
      acct = await verify(cookies, fetchFn);
    } catch {
      continue; // expired or signed-out
    }
    const session: ChromeSession = { profile: dir, userId: acct.userId, workspaces: acct.workspaces, cookies };
    if (names[dir]) session.profileName = names[dir];
    if (acct.name) session.name = acct.name;
    if (acct.email) session.email = acct.email;
    sessions.push(session);
  }
  return sessions;
}

export function listChromeSessions(opts: ExtractFromChromeOptions = {}): Promise<ChromeSession[]> {
  return listChromeSessionsWith(defaultDeps(), opts);
}

/** {@link extractFromChrome} with injected dependencies. */
export async function extractFromChromeWith(deps: CookieStoreDeps, opts: ExtractFromChromeOptions = {}): Promise<ChromeSession> {
  const sessions = await listChromeSessionsWith(deps, opts);
  if (sessions.length === 1) return sessions[0]!;
  if (sessions.length === 0) {
    throw new NotionError("INVALID_STATE", opts.profile ? `no valid Notion session in Chrome profile "${opts.profile}"; sign in to Notion in Chrome first` : "no valid Notion session in any Chrome profile; sign in to Notion in Chrome first");
  }
  const labels = sessions.map((x) => `"${x.profileName ?? x.profile}"${x.email ? ` (${x.email})` : ""}`).join(", ");
  throw new NotionError("INVALID_ARGUMENT", `several Chrome profiles are signed in to Notion: ${labels}. Pass profile to choose one.`, { rawError: sessions.map((x) => ({ profile: x.profile, profileName: x.profileName, userId: x.userId })) });
}

/**
 * Reads a Notion session from Chrome's on-disk cookie store (no browser launch, no login) and
 * verifies it. With no `profile`, auto-picks the only signed-in profile; if several are signed in,
 * throws INVALID_ARGUMENT listing them (use {@link listChromeSessions} to present a chooser). See
 * the module comment for the macOS-only scope and the one-time Keychain prompt.
 */
export function extractFromChrome(opts: ExtractFromChromeOptions = {}): Promise<ChromeSession> {
  return extractFromChromeWith(defaultDeps(), opts);
}

/** {@link extractFromChromeProfile} with injected dependencies (single named profile). */
export async function extractFromChromeProfileWith(deps: CookieStoreDeps, opts: ChromeProfileOptions = {}): Promise<ChromeProfileResult> {
  const s = await extractFromChromeWith(deps, { ...(opts.profile ? { profile: opts.profile } : { profile: "Default" }), ...(opts.userDataDir ? { userDataDir: opts.userDataDir } : {}), ...(opts.fetch ? { fetch: opts.fetch } : {}) });
  return { cookies: s.cookies, userId: s.userId, workspaces: s.workspaces };
}

/**
 * Reads the Notion session from one named Chrome profile (default "Default"). Prefer
 * {@link extractFromChrome}, which auto-picks the signed-in profile.
 */
export function extractFromChromeProfile(opts: ChromeProfileOptions = {}): Promise<ChromeProfileResult> {
  return extractFromChromeProfileWith(defaultDeps(), opts);
}
