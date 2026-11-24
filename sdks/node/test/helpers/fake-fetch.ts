import type { FetchLike } from "../../src/core/http.js";

export interface RecordedRequest {
  url: string;
  endpoint: string;
  headers: Record<string, string>;
  body: unknown;
}

export type Responder = (req: RecordedRequest) => Response | Promise<Response> | Error;

export function json(status: number, body: unknown, headers: Array<[string, string]> = []): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: [["content-type", "application/json"], ...headers],
  });
}

/**
 * A scripted fetch. Each endpoint has a queue of responders; the last one repeats.
 * A responder returning an Error makes fetch reject (a network failure).
 */
export function fakeFetch(script: Record<string, Responder[]>): { fetch: FetchLike; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const queues = new Map(Object.entries(script).map(([k, v]) => [k, [...v]]));
  const fetch: FetchLike = async (input, init) => {
    const url = new URL(String(input));
    const endpoint = url.pathname.split("/").pop() ?? "";
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    const req: RecordedRequest = { url: url.toString(), endpoint, headers, body: init?.body ? JSON.parse(String(init.body)) : undefined };
    requests.push(req);
    const queue = queues.get(endpoint);
    if (!queue || queue.length === 0) throw new Error(`unscripted endpoint ${endpoint}`);
    const responder = queue.length > 1 ? queue.shift()! : queue[0]!;
    const out = await responder(req);
    if (out instanceof Error) throw out;
    return out;
  };
  return { fetch, requests };
}

/** Synthetic credentials: never real values. */
export const SECRET_TOKEN = "v03%3AeyJTESTONLY.synthetic-session-value-0123456789abcdef";
export const USER_ID = "00000000-0000-4000-8000-000000000001";
export const SPACE_ID = "00000000-0000-4000-8000-0000000000aa";

export const baseCookies = [
  { name: "token_v2", value: SECRET_TOKEN, domain: ".app.notion.com" },
  { name: "notion_user_id", value: USER_ID, domain: ".app.notion.com" },
];

/** Synthetic workspace short ID (36-bit) and the space record response that carries it. */
export const SPACE_SHORT_ID = 12345678901;
export const spaceRecordResponse = () =>
  json(200, { recordMap: { space: { [SPACE_ID]: { spaceId: SPACE_ID, value: { value: { id: SPACE_ID, short_id_str: String(SPACE_SHORT_ID) }, role: "editor" } } } } });
