import { inspect } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { CookieJar } from "../src/core/cookies.js";
import { HttpClient, isReadOnlyEndpoint } from "../src/core/http.js";
import { NotionCore } from "../src/core/core.js";
import { NotionError } from "../src/errors.js";
import type { Logger } from "../src/util/logger.js";
import { SECRET_TOKEN, SPACE_ID, USER_ID, baseCookies, fakeFetch, json, spaceRecordResponse } from "./helpers/fake-fetch.js";

function client(script: Parameters<typeof fakeFetch>[0], extra: Partial<ConstructorParameters<typeof HttpClient>[0]> = {}) {
  const { fetch, requests } = fakeFetch(script);
  const sleeps: number[] = [];
  const http = new HttpClient({
    cookies: new CookieJar(baseCookies),
    fetch,
    random: () => 0.5,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...extra,
  });
  http.setWorkspace(SPACE_ID);
  return { http, requests, sleeps };
}

describe("headers", () => {
  it("sends the session cookie, active user and workspace on every request", async () => {
    const { http, requests } = client({ syncRecordValuesSpaceInitial: [() => json(200, { recordMap: {} })] });
    await http.call("syncRecordValuesSpaceInitial", { requests: [] });
    const h = requests[0]!.headers;
    expect(h.cookie).toContain(`token_v2=${SECRET_TOKEN}`);
    expect(h["x-notion-active-user-header"]).toBe(USER_ID);
    expect(h["x-notion-space-id"]).toBe(SPACE_ID);
    expect(h["content-type"]).toBe("application/json");
  });

  it("omits the workspace header when asked and uses a per-call workspace otherwise", async () => {
    const { http, requests } = client({ getSpaces: [() => json(200, {})], search: [() => json(200, {})] });
    await http.call("getSpaces", {}, { spaceId: null });
    await http.call("search", {}, { spaceId: "other-space" });
    expect(requests[0]!.headers["x-notion-space-id"]).toBeUndefined();
    expect(requests[1]!.headers["x-notion-space-id"]).toBe("other-space");
  });

  it("refuses to send credentials to a non-Notion or non-https host", () => {
    const jar = new CookieJar(baseCookies);
    expect(() => new HttpClient({ cookies: jar, apiBase: "https://evil.example.com/api/v3/" })).toThrow(NotionError);
    expect(() => new HttpClient({ cookies: jar, apiBase: "http://app.notion.com/api/v3/" })).toThrow(NotionError);
  });
});

describe("cookies", () => {
  it("applies Set-Cookie updates and deletions from responses", async () => {
    const { http, requests } = client({
      getSpaces: [
        () => json(200, {}, [["set-cookie", "token_v2=rotated-value; Domain=app.notion.com; Path=/; Secure; HttpOnly"]]),
        () => json(200, {}, [["set-cookie", "token_v2=; Domain=app.notion.com; Path=/; Max-Age=0"]]),
        () => json(200, {}),
      ],
    });
    await http.call("getSpaces", {});
    await http.call("getSpaces", {});
    expect(requests[1]!.headers.cookie).toContain("token_v2=rotated-value");
    await http.call("getSpaces", {});
    expect(requests[2]!.headers.cookie ?? "").not.toContain("token_v2=");
  });

  it("matches cookie paths, so file_token only goes to /f", () => {
    const jar = new CookieJar([...baseCookies, { name: "file_token", value: "ft", domain: ".notion.com", path: "/f" }]);
    expect(jar.headerFor(new URL("https://app.notion.com/api/v3/getSpaces"))).not.toContain("file_token");
    expect(jar.headerFor(new URL("https://file.notion.com/f/s3/abc"))).toContain("file_token=ft");
  });
});

describe("retries", () => {
  it("classifies endpoints", () => {
    expect(isReadOnlyEndpoint("syncRecordValuesSpaceInitial")).toBe(true);
    expect(isReadOnlyEndpoint("getActivityLog")).toBe(true);
    expect(isReadOnlyEndpoint("authValidate")).toBe(true);
    expect(isReadOnlyEndpoint("saveTransactionsFanout")).toBe(false);
    expect(isReadOnlyEndpoint("deleteContentRecords")).toBe(false);
  });

  it("retries a read on 5xx and network errors with backoff", async () => {
    const { http, requests, sleeps } = client({
      search: [() => json(503, {}), () => new Error("socket hang up"), () => json(200, { results: [] })],
    });
    await expect(http.call("search", {})).resolves.toEqual({ results: [] });
    expect(requests).toHaveLength(3);
    expect(sleeps).toHaveLength(2);
  });

  it("does not retry a write on 5xx or network errors", async () => {
    const { http, requests } = client({ saveTransactionsFanout: [() => json(502, {})] });
    await expect(http.call("saveTransactionsFanout", {})).rejects.toMatchObject({ code: "SERVER_ERROR", status: 502 });
    expect(requests).toHaveLength(1);

    const net = client({ saveTransactionsFanout: [() => new Error("reset")] });
    await expect(net.http.call("saveTransactionsFanout", {})).rejects.toMatchObject({ code: "NETWORK_TIMEOUT" });
    expect(net.requests).toHaveLength(1);
  });

  it("retries 429 for reads and writes, honoring Retry-After", async () => {
    const { http, requests, sleeps } = client({
      saveTransactionsFanout: [() => json(429, {}, [["retry-after", "2"]]), () => json(200, {})],
    });
    await http.call("saveTransactionsFanout", {});
    expect(requests).toHaveLength(2);
    expect(sleeps).toEqual([2000]);
  });

  it("gives up after maxRetries with a retryable error", async () => {
    const { http, requests } = client({ search: [() => json(503, {})] }, { maxRetries: 2 });
    const err = await http.call("search", {}).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "SERVER_ERROR", retryable: true });
    expect(requests).toHaveLength(3);
  });

  it("rejects with CANCELLED when the signal aborts", async () => {
    const { http } = client({ search: [() => json(200, {})] });
    const ac = new AbortController();
    ac.abort();
    await expect(http.call("search", {}, { signal: ac.signal })).rejects.toMatchObject({ code: "CANCELLED" });
  });
});

describe("error mapping", () => {
  it("maps a rejected write to WRITE_REJECTED with the server's error summary", async () => {
    const { http } = client({
      saveTransactionsFanout: [
        () =>
          json(400, {
            isNotionError: true,
            name: "ValidationError",
            message: "Invalid input.",
            errorId: "err-1",
            debugMessage: "Unsaved transactions: not allowed",
            clientData: { type: "unsaved_transactions", rollbackRecordMap: { big: true } },
          }),
      ],
    });
    const err = (await http.call("saveTransactionsFanout", {}).catch((e: unknown) => e)) as NotionError;
    expect(err.code).toBe("WRITE_REJECTED");
    expect(err.rawError).toEqual({
      name: "ValidationError",
      message: "Invalid input.",
      errorId: "err-1",
      debugMessage: "Unsaved transactions: not allowed",
      clientDataType: "unsaved_transactions",
    });
  });

  it("maps 403 and 404", async () => {
    const { http } = client({ getA: [() => json(403, {})], getB: [() => json(404, {})] });
    await expect(http.call("getA", {})).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    await expect(http.call("getB", {})).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("session state machine", () => {
  it("a 401 with a dead session enters AUTH_DEAD once, even for concurrent requests", async () => {
    const { http, requests } = client({ search: [() => json(401, {})], authValidate: [() => json(401, {})] });
    const dead = vi.fn();
    http.session.events.on("auth.dead", dead);
    const results = await Promise.allSettled([http.call("search", {}), http.call("search", {}), http.call("search", {})]);
    expect(results.every((r) => r.status === "rejected" && (r.reason as NotionError).code === "AUTH_DEAD")).toBe(true);
    expect(requests.filter((r) => r.endpoint === "authValidate")).toHaveLength(1);
    expect(dead).toHaveBeenCalledTimes(1);
    expect(http.session.current()).toBe("AUTH_DEAD");

    const before = requests.length;
    await expect(http.call("search", {})).rejects.toMatchObject({ code: "AUTH_DEAD" });
    expect(requests.length).toBe(before); // fails fast, no request sent
  });

  it("a 401 with a valid session replays the request once", async () => {
    const { http, requests } = client({ search: [() => json(401, {}), () => json(200, { ok: 1 })], authValidate: [() => json(200, {})] });
    await expect(http.call("search", {})).resolves.toEqual({ ok: 1 });
    expect(requests.map((r) => r.endpoint)).toEqual(["search", "authValidate", "search"]);
    expect(http.session.current()).toBe("VALID");
  });

  it("a transport failure during the check leaves the session state unchanged", async () => {
    const { http } = client({ search: [() => json(401, {})], authValidate: [() => json(503, {})] }, { maxRetries: 0 });
    await expect(http.call("search", {})).rejects.toMatchObject({ code: "SERVER_ERROR" });
    expect(http.session.current()).toBe("VALID");
  });

  it("can be re-checked explicitly, e.g. after a read returned 200 without its record", async () => {
    const { http } = client({ authValidate: [() => json(401, {})] });
    await expect(http.session.confirm("missing_record")).resolves.toBe("AUTH_DEAD");
    expect(http.session.health()).toMatchObject({ state: "AUTH_DEAD", lastCheckTrigger: "missing_record" });
  });
});

describe("credentials never leak", () => {
  it("errors, logs, health and inspection contain no cookie value", async () => {
    const lines: string[] = [];
    const logger: Logger = {
      debug: (o, m) => lines.push(JSON.stringify(o) + (m ?? "")),
      info: (o, m) => lines.push(JSON.stringify(o) + (m ?? "")),
      warn: (o, m) => lines.push(JSON.stringify(o) + (m ?? "")),
      error: (o, m) => lines.push(JSON.stringify(o) + (m ?? "")),
    };
    const { fetch } = fakeFetch({
      getSpaces: [() => json(200, { [USER_ID]: { notion_user: { [USER_ID]: { value: { value: { name: "Synthetic" } } } }, space: { [SPACE_ID]: { value: { value: { name: "Test WS" } } } } } })],
      syncRecordValuesSpaceInitial: [spaceRecordResponse],
      search: [() => json(503, {}), () => json(401, {})],
      authValidate: [() => json(401, {})],
    });
    const core = new NotionCore({ cookies: baseCookies, fetch, logger, maxRetries: 1 });
    await core.bindWorkspace("Test WS");
    const err = await core.callApi("search", {}).catch((e: unknown) => e);

    const surfaces = [
      JSON.stringify(err),
      String(err),
      inspect(err, { depth: 5 }),
      JSON.stringify(core.health()),
      JSON.stringify(core),
      inspect(core, { depth: 5 }),
      inspect(new CookieJar(baseCookies)),
      ...lines,
    ];
    for (const s of surfaces) expect(s).not.toContain(SECRET_TOKEN.slice(0, 20));
    expect(core.health()).toMatchObject({ session: { state: "AUTH_DEAD" }, userId: USER_ID, workspaceId: SPACE_ID });
  });
});

describe("account and workspace binding", () => {
  const spaces = {
    [USER_ID]: {
      notion_user: { [USER_ID]: { value: { value: { name: "Synthetic", email: "user@example.invalid" } } } },
      space: { [SPACE_ID]: { value: { value: { name: "Test WS" } } }, "00000000-0000-4000-8000-0000000000bb": { value: { name: "Other" } } },
    },
  };

  it("binds by name or ID and rejects unknown workspaces", async () => {
    const { fetch } = fakeFetch({ getSpaces: [() => json(200, spaces)], syncRecordValuesSpaceInitial: [spaceRecordResponse] });
    const core = new NotionCore({ cookies: baseCookies, fetch });
    await expect(core.bindWorkspace("Test WS")).resolves.toEqual({ id: SPACE_ID, name: "Test WS" });
    await expect(core.bindWorkspace(SPACE_ID.toUpperCase())).resolves.toMatchObject({ id: SPACE_ID });
    await expect(core.bindWorkspace("Nope")).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });

  it("requires userId when the session holds several accounts and no user cookie", async () => {
    const two = { ...spaces, "00000000-0000-4000-8000-000000000002": { space: {} } };
    const { fetch } = fakeFetch({ getSpaces: [() => json(200, two)] });
    const core = new NotionCore({ cookies: [{ name: "token_v2", value: SECRET_TOKEN }], fetch });
    await expect(core.account()).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });
});
