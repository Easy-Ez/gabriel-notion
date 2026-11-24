import { NotionError } from "../errors.js";
import type { HttpClient } from "./http.js";

export interface WorkspaceInfo {
  id: string;
  name: string;
}

export interface AccountInfo {
  userId: string;
  name?: string;
  email?: string;
  workspaces: WorkspaceInfo[];
}

/** Record maps wrap values as `{ value }` or, in newer responses, `{ value: { value } }`. */
export function unwrapRecord<T = Record<string, unknown>>(entry: unknown): T | undefined {
  if (!entry || typeof entry !== "object") return undefined;
  const v = (entry as { value?: unknown }).value;
  if (v && typeof v === "object" && "value" in (v as object) && typeof (v as { value?: unknown }).value === "object") {
    return (v as { value: T }).value;
  }
  return v as T | undefined;
}

type GetSpacesResponse = Record<
  string,
  {
    notion_user?: Record<string, unknown>;
    space?: Record<string, unknown>;
  }
>;

/**
 * Reads the signed-in account(s) and their workspaces with `getSpaces`. One session can hold several accounts; the active one is
 * `preferredUserId`, else the `notion_user_id` cookie, else the only account in the response.
 */
export async function fetchAccount(http: HttpClient, preferredUserId?: string): Promise<AccountInfo> {
  const resp = await http.call<GetSpacesResponse>("getSpaces", {}, { spaceId: null });
  const userIds = Object.keys(resp ?? {});
  const wanted = preferredUserId ?? http.activeUser();
  const userId = wanted && userIds.includes(wanted) ? wanted : userIds.length === 1 ? userIds[0] : undefined;
  if (!userId) {
    throw new NotionError(
      "INVALID_ARGUMENT",
      userIds.length === 0 ? "getSpaces returned no account for this session" : "the session holds several accounts; pass userId to choose one",
    );
  }
  const entry = resp[userId]!;
  const user = unwrapRecord<{ name?: string; email?: string }>(entry.notion_user?.[userId]);
  const workspaces: WorkspaceInfo[] = Object.entries(entry.space ?? {})
    .map(([id, rec]) => ({ id, name: unwrapRecord<{ name?: string }>(rec)?.name ?? "" }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const info: AccountInfo = { userId, workspaces };
  if (user?.name) info.name = user.name;
  if (user?.email) info.email = user.email;
  return info;
}

/** Resolves a workspace given by ID or by exact name. */
export function resolveWorkspace(account: AccountInfo, workspace: string): WorkspaceInfo {
  const byId = account.workspaces.find((w) => w.id === workspace.toLowerCase());
  if (byId) return byId;
  const byName = account.workspaces.filter((w) => w.name === workspace);
  if (byName.length === 1) return byName[0]!;
  throw new NotionError(
    "INVALID_ARGUMENT",
    byName.length > 1 ? `several workspaces are named "${workspace}"; pass the workspace ID` : `the account has no workspace "${workspace}"`,
  );
}
