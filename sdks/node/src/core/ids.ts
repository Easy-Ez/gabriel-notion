import { randomUUID, getRandomValues } from "node:crypto";
import { NotionError } from "../errors.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX32_RE = /^[0-9a-f]{32}$/i;
const HEX32_IN_TEXT = /([0-9a-f]{32})(?![0-9a-f])/gi;

function hyphenate(hex32: string): string {
  const h = hex32.toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * Normalizes an ID given as a hyphenated UUID, 32 hex characters, or a Notion page URL
 * (`app.notion.com/p/<title>-<id>`, `www.notion.so/<workspace>/<title>-<id>`, a peek URL with
 * `?p=<id>`) to the lower-case hyphenated form. Throws INVALID_ARGUMENT otherwise.
 */
export function normalizeId(input: string, field = "id"): string {
  if (typeof input !== "string" || input.trim() === "") throw new NotionError("INVALID_ARGUMENT", `${field} is required`);
  const raw = input.trim();
  if (UUID_RE.test(raw)) return raw.toLowerCase();
  if (HEX32_RE.test(raw)) return hyphenate(raw);
  let url: URL | undefined;
  try {
    url = new URL(raw);
  } catch {
    url = undefined;
  }
  if (url && /(^|\.)notion\.(so|com|site)$/i.test(url.hostname)) {
    const peek = url.searchParams.get("p");
    if (peek && HEX32_RE.test(peek)) return hyphenate(peek);
    const fromPath = [...url.pathname.matchAll(HEX32_IN_TEXT)].map((m) => m[1]!).pop();
    if (fromPath) return hyphenate(fromPath);
    const uuidInPath = url.pathname.split("/").find((seg) => UUID_RE.test(seg));
    if (uuidInPath) return uuidInPath.toLowerCase();
  }
  throw new NotionError("INVALID_ARGUMENT", `${field} must be a Notion ID or page URL`);
}

export function isNotionId(input: string): boolean {
  return UUID_RE.test(input);
}

const ID_EPOCH_MS = Date.UTC(2024, 0, 1);
const DAY_MS = 86_400_000;
const MAX_SHORT_ID = 2 ** 36;

/**
 * A block ID in the web client's UUID v8 layout, as the web client generates them:
 * - bytes 0–5: days since 2024-01-01 UTC in the high 12 bits, workspace short ID in the low 36
 * - byte 6: 0x80; byte 8: high bits 10; byte 10: high bits 11 (the `block` category)
 * - all other bits random
 */
export function newBlockId(spaceShortId: number, now: number = Date.now(), random: Uint8Array = getRandomValues(new Uint8Array(16))): string {
  if (!Number.isInteger(spaceShortId) || spaceShortId < 0 || spaceShortId >= MAX_SHORT_ID) {
    throw new NotionError("INVALID_ARGUMENT", "invalid workspace short ID");
  }
  const days = Math.floor((now - ID_EPOCH_MS) / DAY_MS);
  if (days < 0 || days >= 4096) throw new NotionError("INVALID_STATE", "clock is outside the block ID date range");
  const b = Uint8Array.from(random.subarray(0, 16));
  b[0] = (days >> 4) & 0xff;
  b[1] = ((days << 4) & 0xf0) | (Math.floor(spaceShortId / 2 ** 32) & 0x0f);
  for (let i = 0; i < 4; i++) b[2 + i] = Math.floor(spaceShortId / 2 ** (24 - 8 * i)) & 0xff;
  b[6] = 0x80;
  b[8] = 0x80 | (b[8]! & 0x3f);
  b[10] = 0xc0 | (b[10]! & 0x3f);
  const hex = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return hyphenate(hex);
}

/** Decodes the date and workspace short ID from a v8 block ID; undefined for other IDs. */
export function decodeBlockId(id: string): { createdDay: string; spaceShortId: number } | undefined {
  const hex = normalizeId(id).replace(/-/g, "");
  const b = Uint8Array.from(hex.match(/../g)!.map((x) => parseInt(x, 16)));
  if (b[6] !== 0x80 || (b[8]! & 0xc0) !== 0x80 || (b[10]! & 0xc0) !== 0xc0) return undefined;
  const days = (b[0]! << 4) | (b[1]! >> 4);
  const short = (b[1]! & 0x0f) * 2 ** 32 + ((b[2]! << 24) >>> 0) + (b[3]! << 16) + (b[4]! << 8) + b[5]!;
  return { createdDay: new Date(ID_EPOCH_MS + days * DAY_MS).toISOString().slice(0, 10), spaceShortId: short };
}

/** IDs for `discussion`, `comment`, `collection` and `collection_view`: random UUID v4 (block-style v8 IDs are rejected with 400). */
export function newRandomId(): string {
  return randomUUID();
}
