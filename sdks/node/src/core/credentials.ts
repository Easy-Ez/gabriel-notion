import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NotionError } from "../errors.js";
import type { CookieInput } from "./cookies.js";

/**
 * Where the caller keeps the session cookies between runs (spec §3).
 * `save` is called with a full snapshot whenever a session cookie changes, so a rotated
 * `token_v2` survives a restart. Implementations decide where the secret lives (keychain,
 * secret manager, file).
 */
export interface CredentialStore {
  load(): Promise<CookieInput[] | undefined>;
  save(cookies: CookieInput[]): Promise<void>;
}

interface StoredFile {
  cookies: CookieInput[];
  savedAt: string;
}

export function defaultConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.GABRIEL_NOTION_CONFIG_DIR) return path.resolve(env.GABRIEL_NOTION_CONFIG_DIR);
  const base = env.XDG_CONFIG_HOME ? path.resolve(env.XDG_CONFIG_HOME) : path.join(os.homedir(), ".config");
  return path.join(base, "gabriel-notion");
}

export function defaultSessionFile(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(defaultConfigDir(env), "session.json");
}

/**
 * Stores the cookies in a local JSON file: directory 0700, file 0600, written to a temporary
 * file and renamed into place so a crash never leaves half a file. Loading refuses a file that
 * other users can read. Meant for local development and single-user machines; prefer a keychain
 * or secret manager elsewhere.
 */
export class FileCredentialStore implements CredentialStore {
  readonly file: string;

  constructor(file: string = defaultSessionFile()) {
    this.file = path.resolve(file);
  }

  async load(): Promise<CookieInput[] | undefined> {
    let info;
    try {
      info = await stat(this.file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new NotionError("STATE_STORE_UNAVAILABLE", `cannot read ${this.file}`, { cause: err });
    }
    if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
      throw new NotionError(
        "INVALID_STATE",
        `${this.file} is accessible by other users (mode ${(info.mode & 0o777).toString(8)}); run: chmod 600 "${this.file}"`,
      );
    }
    let parsed: Partial<StoredFile>;
    try {
      parsed = JSON.parse(await readFile(this.file, "utf8")) as Partial<StoredFile>;
    } catch (err) {
      throw new NotionError("STATE_STORE_UNAVAILABLE", `${this.file} is not valid JSON`, { cause: err });
    }
    const cookies = Array.isArray(parsed.cookies) ? parsed.cookies.filter((c) => typeof c?.name === "string" && typeof c.value === "string") : [];
    return cookies.length > 0 ? cookies : undefined;
  }

  async save(cookies: CookieInput[]): Promise<void> {
    const dir = path.dirname(this.file);
    const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    try {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await chmod(dir, 0o700);
      const body: StoredFile = { cookies, savedAt: new Date().toISOString() };
      await writeFile(tmp, JSON.stringify(body), { mode: 0o600 });
      await chmod(tmp, 0o600);
      await rename(tmp, this.file);
    } catch (err) {
      await unlink(tmp).catch(() => {});
      throw new NotionError("STATE_STORE_UNAVAILABLE", `cannot write ${this.file}`, { cause: err });
    }
  }

  /** Deletes the file (sign-out). Resolves to false when there was nothing to delete. */
  async clear(): Promise<boolean> {
    try {
      await unlink(this.file);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw new NotionError("STATE_STORE_UNAVAILABLE", `cannot delete ${this.file}`, { cause: err });
    }
  }
}

/**
 * Parses a browser `Cookie` request header ("a=1; b=2") into cookies for `.app.notion.com`.
 * `file_token` is scoped to `/f` like the browser does.
 */
export function parseCookieHeader(header: string): CookieInput[] {
  const out: CookieInput[] = [];
  for (const part of header.replace(/^cookie:\s*/i, "").split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (!name) continue;
    out.push({ name, value, domain: ".app.notion.com", ...(name === "file_token" ? { domain: ".notion.com", path: "/f" } : {}) });
  }
  return out;
}

/**
 * Session cookies for `NotionCore` / `NotionClient`: `GABRIEL_NOTION_COOKIES` (a browser
 * `Cookie` header) from the environment first, then the given store (default: the
 * `FileCredentialStore` at its default path). Resolves to undefined when neither has one.
 */
export async function loadSessionCookies(
  opts: { env?: NodeJS.ProcessEnv; store?: CredentialStore } = {},
): Promise<CookieInput[] | undefined> {
  const env = opts.env ?? process.env;
  const fromEnv = env.GABRIEL_NOTION_COOKIES?.trim();
  if (fromEnv) {
    const cookies = parseCookieHeader(fromEnv);
    if (!cookies.some((c) => c.name === "token_v2")) {
      throw new NotionError("INVALID_ARGUMENT", "GABRIEL_NOTION_COOKIES must contain token_v2");
    }
    return cookies;
  }
  return (opts.store ?? new FileCredentialStore(defaultSessionFile(env))).load();
}
