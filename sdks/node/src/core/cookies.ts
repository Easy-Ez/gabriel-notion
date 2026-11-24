import { inspect } from "node:util";
import { NotionError } from "../errors.js";

/** A cookie as handed over by the caller (e.g. from `signInWithBrowser()` or a secret store). */
export interface CookieInput {
  name: string;
  value: string;
  /** Cookie domain, e.g. ".app.notion.com" or "app.notion.com". Defaults to "app.notion.com". */
  domain?: string;
  /** Cookie path. Defaults to "/". `file_token` uses "/f". */
  path?: string;
}

interface StoredCookie {
  name: string;
  value: string;
  /** Lower-case domain without a leading dot. */
  domain: string;
  /** true when the cookie must match the host exactly (no Domain attribute). */
  hostOnly: boolean;
  path: string;
  expiresAt?: number;
}

const DEFAULT_DOMAIN = "app.notion.com";

/**
 * Cookies that carry or bind the session. A value change in one of them is a credential change
 * worth persisting; analytics and bot-management cookies (e.g. `__cf_bm`) rotate often and are not.
 */
export const SESSION_COOKIE_NAMES: ReadonlySet<string> = new Set(["token_v2", "__Host-session_binding", "notion_user_id", "notion_users", "file_token"]);

function domainMatches(host: string, cookie: StoredCookie): boolean {
  if (cookie.hostOnly) return host === cookie.domain;
  return host === cookie.domain || host.endsWith(`.${cookie.domain}`);
}

function pathMatches(requestPath: string, cookiePath: string): boolean {
  if (requestPath === cookiePath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith("/") || requestPath[cookiePath.length] === "/";
}

/**
 * In-memory cookie container. It is the only place the session lives.
 *
 * Values leave it only as a `Cookie` header for a matching https Notion host, or through
 * `snapshot()` to a credential store the caller configured. `toJSON()` and `util.inspect` show
 * cookie names only, so an accidental log line or `JSON.stringify(client)` cannot leak the session.
 */
export class CookieJar {
  private cookies = new Map<string, StoredCookie>();
  private readonly sessionChangeListeners = new Set<(names: string[]) => void>();

  constructor(initial: readonly CookieInput[] | Record<string, string> = [], private readonly now: () => number = Date.now) {
    const list: readonly CookieInput[] = Array.isArray(initial)
      ? (initial as readonly CookieInput[])
      : Object.entries(initial as Record<string, string>).map(([name, value]): CookieInput => ({ name, value }));
    for (const c of list) {
      if (typeof c?.name !== "string" || typeof c.value !== "string" || c.name === "") {
        throw new NotionError("INVALID_ARGUMENT", "cookies must be { name, value } pairs");
      }
      const rawDomain = (c.domain ?? `.${DEFAULT_DOMAIN}`).toLowerCase();
      this.put({ name: c.name, value: c.value, domain: rawDomain.replace(/^\./, ""), hostOnly: !rawDomain.startsWith("."), path: c.path ?? "/" });
    }
  }

  /** Cookie names currently held (values are never exposed). */
  names(): string[] {
    this.purgeExpired();
    return [...new Set([...this.cookies.values()].map((c) => c.name))].sort();
  }

  has(name: string): boolean {
    this.purgeExpired();
    return [...this.cookies.values()].some((c) => c.name === name);
  }

  /** Value of a non-secret cookie such as `notion_user_id`. */
  peek(name: "notion_user_id" | "notion_users" | "device_id" | "notion_browser_id"): string | undefined {
    this.purgeExpired();
    return [...this.cookies.values()].find((c) => c.name === name)?.value;
  }

  /** The `Cookie` header value for a request URL, or undefined when nothing matches. */
  headerFor(url: URL): string | undefined {
    this.purgeExpired();
    const host = url.hostname.toLowerCase();
    const matching = [...this.cookies.values()]
      .filter((c) => domainMatches(host, c) && pathMatches(url.pathname || "/", c.path))
      .sort((a, b) => b.path.length - a.path.length);
    if (matching.length === 0) return undefined;
    return matching.map((c) => `${c.name}=${c.value}`).join("; ");
  }

  /** Calls `listener` with the changed names whenever a session cookie's value changes or it is removed. */
  onSessionCookieChange(listener: (names: string[]) => void): () => void {
    this.sessionChangeListeners.add(listener);
    return () => this.sessionChangeListeners.delete(listener);
  }

  /**
   * All live cookies with their values, for a caller-configured credential store only.
   * Never log or emit the result.
   */
  snapshot(): CookieInput[] {
    this.purgeExpired();
    return [...this.cookies.values()].map((c) => ({ name: c.name, value: c.value, domain: c.hostOnly ? c.domain : `.${c.domain}`, path: c.path }));
  }

  /** Applies the `Set-Cookie` headers of a response received from `url`. */
  applySetCookie(url: URL, setCookieHeaders: readonly string[]): void {
    const changed = new Set<string>();
    for (const header of setCookieHeaders) {
      const parts = header.split(";").map((p) => p.trim());
      const first = parts.shift() ?? "";
      const eq = first.indexOf("=");
      if (eq <= 0) continue;
      const name = first.slice(0, eq).trim();
      const value = first.slice(eq + 1).trim();
      let domain = url.hostname.toLowerCase();
      let hostOnly = true;
      let path = "/";
      let expiresAt: number | undefined;
      for (const attr of parts) {
        const [rawKey, ...rest] = attr.split("=");
        const key = (rawKey ?? "").trim().toLowerCase();
        const val = rest.join("=").trim();
        if (key === "domain" && val) {
          const d = val.toLowerCase().replace(/^\./, "");
          // Ignore a Domain attribute that does not cover the responding host (RFC 6265 §5.3).
          if (url.hostname.toLowerCase() === d || url.hostname.toLowerCase().endsWith(`.${d}`)) {
            domain = d;
            hostOnly = false;
          }
        } else if (key === "path" && val.startsWith("/")) {
          path = val;
        } else if (key === "max-age") {
          const seconds = Number(val);
          if (Number.isFinite(seconds)) expiresAt = this.now() + seconds * 1000;
        } else if (key === "expires" && expiresAt === undefined) {
          const t = Date.parse(val);
          if (Number.isFinite(t)) expiresAt = t;
        }
      }
      const cookie: StoredCookie = { name, value, domain, hostOnly, path };
      if (expiresAt !== undefined) cookie.expiresAt = expiresAt;
      const previous = this.cookies.get(this.key(cookie));
      if (expiresAt !== undefined && expiresAt <= this.now()) {
        if (previous && SESSION_COOKIE_NAMES.has(name)) changed.add(name);
        this.cookies.delete(this.key(cookie));
      } else {
        if (SESSION_COOKIE_NAMES.has(name) && previous?.value !== value) changed.add(name);
        this.put(cookie);
      }
    }
    if (changed.size > 0) {
      const names = [...changed].sort();
      for (const listener of [...this.sessionChangeListeners]) listener(names);
    }
  }

  toJSON(): { cookies: string[] } {
    return { cookies: this.names() };
  }

  [inspect.custom](): string {
    return `CookieJar { names: [${this.names().join(", ")}] }`;
  }

  private key(c: Pick<StoredCookie, "name" | "domain" | "path">): string {
    return `${c.name}\u0000${c.domain}\u0000${c.path}`;
  }

  private put(c: StoredCookie): void {
    this.cookies.set(this.key(c), c);
  }

  private purgeExpired(): void {
    const t = this.now();
    for (const [k, c] of this.cookies) if (c.expiresAt !== undefined && c.expiresAt <= t) this.cookies.delete(k);
  }
}
