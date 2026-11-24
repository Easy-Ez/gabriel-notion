/**
 * Two-account integration tests for the five discovery paths measured in the research
 * (spec §9). They write to a test workspace and are skipped unless configured:
 *
 *   GABRIEL_NOTION_IT_RECEIVER_COOKIES  0600 JSON file { ua?, cookies: [{ name, value, domain }] }
 *                                       for the watching account (read, then deleted)
 *   GABRIEL_NOTION_IT_ACTOR_COOKIES     the same for the account that makes the changes
 *   GABRIEL_NOTION_IT_WORKSPACE         test workspace ID; both accounts are members
 *   GABRIEL_NOTION_IT_PARENT_PAGE       a page both accounts can edit
 *   GABRIEL_NOTION_IT_DATABASE          a database (block) both accounts can edit
 *
 * Also: a page the receiver cannot read produces no event even when its keys are subscribed
 * (Message Store signals are not filtered by permission).
 *
 * Run with `pnpm test:integration`. Only the actor writes; the receiver only reads. Created pages
 * and teamspaces are titled "IT discovery … (synthetic)" and stay in the test workspace.
 */
import { mkdtempSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NotionClient } from "../../src/client/client.js";
import type { NotionEvent } from "../../src/client/events/types.js";
import type { CookieInput } from "../../src/core/cookies.js";
import { FileStateStore } from "../../src/state/file.js";
import { EventPipeline } from "../../src/client/events/pipeline.js";
import { MemoryStateStore } from "../../src/state/store.js";
import { WatchState } from "../../src/state/watch-state.js";

const env = process.env;
const configured = Boolean(env.GABRIEL_NOTION_IT_RECEIVER_COOKIES && env.GABRIEL_NOTION_IT_ACTOR_COOKIES && env.GABRIEL_NOTION_IT_WORKSPACE);

function takeCookies(file: string): { ua?: string; cookies: CookieInput[] } {
  const parsed = JSON.parse(readFileSync(file, "utf8")) as { ua?: string; cookies: CookieInput[] };
  unlinkSync(file); // the session stays in this process only
  return parsed;
}

describe.skipIf(!configured)("discovery with two accounts (test workspace)", () => {
  const workspace = env.GABRIEL_NOTION_IT_WORKSPACE!;
  const stamp = new Date().toISOString().slice(0, 19);
  const events: NotionEvent[] = [];
  let receiver: NotionClient;
  let actor: NotionClient;
  let store: FileStateStore;
  let dir: string;
  let receiverId: string;

  const waitFor = async (pred: (e: NotionEvent) => boolean, ms = 60_000): Promise<NotionEvent> => {
    const t = Date.now();
    for (;;) {
      const e = events.find(pred);
      if (e) return e;
      if (Date.now() - t > ms) throw new Error("event did not arrive in time");
      await new Promise((r) => setTimeout(r, 250));
    }
  };
  const watching = async (id: string, ms = 30_000): Promise<void> => {
    const t = Date.now();
    while (!receiver.core.messageStore.has(`versions/${id}:block`)) {
      if (Date.now() - t > ms) throw new Error("not watched in time");
      await new Promise((r) => setTimeout(r, 250));
    }
  };

  beforeAll(async () => {
    const r = takeCookies(env.GABRIEL_NOTION_IT_RECEIVER_COOKIES!);
    const a = takeCookies(env.GABRIEL_NOTION_IT_ACTOR_COOKIES!);
    dir = mkdtempSync(path.join(os.tmpdir(), "gn-it-"));
    store = new FileStateStore({ file: path.join(dir, "state.json") });
    receiver = NotionClient.fromCookies({ cookies: r.cookies, ...(r.ua ? { userAgent: r.ua } : {}), workspace, stateStore: store, watch: { mode: "workspace" } });
    actor = NotionClient.fromCookies({ cookies: a.cookies, ...(a.ua ? { userAgent: a.ua } : {}), workspace });
    receiver.on("*", (e) => events.push(e));
    await receiver.start();
    receiverId = receiver.core.health().userId!;
  }, 300_000);

  afterAll(async () => {
    await receiver?.stop();
    await store?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("no event for a page the receiver cannot read, even with its keys subscribed", async () => {
    const page = await actor.pages.create({ parent: { private: true }, title: `IT discovery not shared ${stamp} (synthetic)` });
    const leaked: NotionEvent[] = [];
    const pipeline = new EventPipeline({ core: receiver.core, state: new WatchState(new MemoryStateStore(), workspace), workspaceId: workspace, selfUserId: receiverId, deliver: (e) => leaked.push(e) });
    pipeline.start();
    await pipeline.watch([{ id: page.id, kind: "page" }]);
    let signals = 0;
    const off = receiver.core.onSignal((key) => {
      if (key.includes(page.id)) signals++;
    });
    const lock = (v: boolean) => actor.core.submit([{ pointer: { table: "block", id: page.id, spaceId: workspace }, path: ["format"], command: "update", args: { block_locked: v } }]);
    await lock(true);
    await new Promise((r) => setTimeout(r, 10_000));
    await lock(false);
    await new Promise((r) => setTimeout(r, 10_000));
    off();
    await pipeline.stop();
    expect(signals).toBeGreaterThan(0); // the signals do arrive …
    expect(leaked).toEqual([]); // … but nothing is delivered
    expect(pipeline.isWatching(page.id)).toBe(false); // and the page is dropped
  }, 120_000);

  it("a page created under a watched page", async () => {
    const page = await actor.pages.create({ parent: { pageId: env.GABRIEL_NOTION_IT_PARENT_PAGE! }, title: `IT discovery child ${stamp} (synthetic)` });
    const e = await waitFor((x) => x.type === "page.created" && x.entity.id === page.id);
    expect(e.origin).toBe("other_user");
    await watching(page.id);
  }, 120_000);

  it("a row created in a watched database", async () => {
    const row = await actor.pages.create({ parent: { databaseId: env.GABRIEL_NOTION_IT_DATABASE! }, title: `IT discovery row ${stamp} (synthetic)` });
    await waitFor((x) => x.type === "page.created" && x.entity.id === row.id);
    await waitFor((x) => x.type === "data_source.content_updated" && (x.data as { updated_blocks: Array<{ id: string }> }).updated_blocks.some((b) => b.id === row.id));
  }, 120_000);

  it("a page newly shared with the receiver", async () => {
    const page = await actor.pages.create({ parent: { private: true }, title: `IT discovery shared ${stamp} (synthetic)` });
    await actor.core.submit([
      { pointer: { table: "block", id: page.id, spaceId: workspace }, path: ["permissions"], command: "setPermissionItem", args: { type: "user_permission", role: "editor", user_id: receiverId } },
    ]);
    const e = await waitFor((x) => x.type === "page.created" && x.entity.id === page.id);
    expect(e.data).toMatchObject({ parent: { type: "space" } });
    await watching(page.id);
  }, 120_000);

  let teamId: string;
  it("a new teamspace", async () => {
    const before = receiver.health().watch!.containers;
    const res = await actor.core.callApi<{ teamId: string }>("createTeam", { spaceId: workspace, name: `IT discovery team ${stamp} (synthetic)`, accessLevel: "open" });
    teamId = res.teamId;
    const t = Date.now();
    while (!receiver.core.messageStore.has(`versions/${teamId}:team`)) {
      if (Date.now() - t > 60_000) throw new Error("teamspace not discovered in time");
      await new Promise((r) => setTimeout(r, 250));
    }
    expect(receiver.health().watch!.containers).toBe(before + 1);
  }, 120_000);

  it("a page created at a teamspace root", async () => {
    const page = await actor.pages.create({ parent: { teamspaceId: teamId }, title: `IT discovery team page ${stamp} (synthetic)` });
    const e = await waitFor((x) => x.type === "page.created" && x.entity.id === page.id);
    expect(e.data).toEqual({ parent: { type: "team", id: teamId } });
    await watching(page.id);
  }, 120_000);
});
