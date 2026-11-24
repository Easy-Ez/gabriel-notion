#!/usr/bin/env node
import { extractFromDebugChrome } from "../core/browser-extract.js";
import { extractFromChrome, listChromeSessions, type ChromeSession } from "../core/cookie-store.js";
import { FileCredentialStore, loadSessionCookies } from "../core/credentials.js";
import { listWorkspaces, signInWithBrowser } from "../core/sign-in.js";
import { NotionError } from "../errors.js";
import type { WorkspaceInfo } from "../core/account.js";

const HELP = `gabriel-notion — credential helper for gabriel-notion

Usage:
  gabriel-notion auth login [--google] [--email <address>]
      Open a dedicated Chrome window with a temporary profile; after you sign in, the session
      is verified and saved (0600). --google opens Google's consent screen directly.
  gabriel-notion auth read [--profile <name>]
      Read the session directly from your Chrome cookie store (no browser window, no re-login),
      verify it, and save it (0600). With no --profile, auto-picks the only signed-in profile
      and lists them if several are. macOS only; the first read prompts once for Keychain access.
  gabriel-notion auth profiles
      List the Chrome profiles that are signed in to Notion.
  gabriel-notion auth extract [--port <n>]
      Read the session from a Chrome you started with --remote-debugging-port (default 9222)
      and signed in to Notion, verify it, and save it (0600).
  gabriel-notion auth status
      Verify the session from GABRIEL_NOTION_COOKIES or the saved file and list workspaces.
  gabriel-notion auth logout --yes
      Delete the saved session file.

The session file is $GABRIEL_NOTION_CONFIG_DIR/session.json, or
$XDG_CONFIG_HOME/gabriel-notion/session.json (default ~/.config). Cookie values are never printed.
`;

export interface CliIo {
  out(text: string): void;
  err(text: string): void;
  store: FileCredentialStore;
  signIn: typeof signInWithBrowser;
  extract: typeof extractFromDebugChrome;
  read: typeof extractFromChrome;
  listSessions: typeof listChromeSessions;
  list: typeof listWorkspaces;
  load: typeof loadSessionCookies;
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function describe(io: CliIo, userId: string, workspaces: WorkspaceInfo[]): void {
  io.out(`Signed in as user ${userId}. Workspaces (${workspaces.length}):\n`);
  for (const w of workspaces) io.out(`  - ${w.name || "(unnamed)"}  ${w.id}\n`);
}

export async function main(argv: string[], io: CliIo): Promise<number> {
  const [group, command, ...rest] = argv;
  if (group !== "auth" || !command) {
    io.out(HELP);
    return group === undefined || group === "--help" || group === "help" ? 0 : 1;
  }
  switch (command) {
    case "login": {
      const email = flag(rest, "--email");
      const r = await io.signIn({
        ...(rest.includes("--google") ? { provider: "google" as const } : {}),
        ...(email ? { email } : {}),
        onStatus: (s) => {
          if (s === "opening") io.err("Opening a sign-in window; complete the Notion sign-in there. It closes automatically.\n");
        },
      });
      describe(io, r.userId, r.workspaces);
      await io.store.save(r.cookies);
      io.out(`Saved to ${io.store.file} (mode 0600).\n`);
      return 0;
    }
    case "read": {
      const profileArg = flag(rest, "--profile");
      if (!profileArg) {
        const sessions = await io.listSessions({});
        if (sessions.length === 0) {
          io.err("No Chrome profile is signed in to Notion. Sign in to Notion in Chrome, or run `gabriel-notion auth login`.\n");
          return 1;
        }
        if (sessions.length > 1) {
          io.err("Several Chrome profiles are signed in to Notion; choose one with --profile:\n");
          for (const x of sessions) io.err(`  --profile ${JSON.stringify(x.profileName ?? x.profile)}${x.email ? `  (${x.email})` : ""}\n`);
          return 1;
        }
        const s0 = sessions[0]!;
        describe(io, s0.userId, s0.workspaces);
        await io.store.save(s0.cookies);
        io.out(`Read Chrome profile ${JSON.stringify(s0.profileName ?? s0.profile)}. Saved to ${io.store.file} (mode 0600).\n`);
        return 0;
      }
      const r = await io.read({ profile: profileArg });
      describe(io, r.userId, r.workspaces);
      await io.store.save(r.cookies);
      io.out(`Saved to ${io.store.file} (mode 0600).\n`);
      return 0;
    }
    case "profiles": {
      const sessions = await io.listSessions({});
      if (sessions.length === 0) {
        io.out("No Chrome profile is signed in to Notion.\n");
        return 0;
      }
      for (const x of sessions as ChromeSession[]) io.out(`  ${JSON.stringify(x.profileName ?? x.profile)}  profile=${x.profile}  user=${x.userId}${x.email ? `  ${x.email}` : ""}  workspaces=${x.workspaces.length}\n`);
      return 0;
    }
    case "extract": {
      const portArg = flag(rest, "--port");
      const r = await io.extract({ port: portArg ? Number(portArg) : 9222 });
      describe(io, r.userId, r.workspaces);
      await io.store.save(r.cookies);
      io.out(`Saved to ${io.store.file} (mode 0600).\n`);
      return 0;
    }
    case "status": {
      const cookies = await io.load({ store: io.store });
      if (!cookies) {
        io.err(`No session: set GABRIEL_NOTION_COOKIES or run \`gabriel-notion auth login\` (${io.store.file}).\n`);
        return 1;
      }
      const r = await io.list({ cookies });
      describe(io, r.userId, r.workspaces);
      return 0;
    }
    case "logout": {
      if (!rest.includes("--yes")) {
        io.err(`This deletes ${io.store.file}. Re-run with --yes to confirm. It does not sign the session out on Notion's side.\n`);
        return 1;
      }
      io.out((await io.store.clear()) ? `Deleted ${io.store.file}.\n` : `Nothing to delete at ${io.store.file}.\n`);
      return 0;
    }
    default:
      io.out(HELP);
      return 1;
  }
}

const isEntry = process.argv[1] !== undefined && /gabriel-notion(\.js|\.ts)?$/.test(process.argv[1]);
if (isEntry) {
  const io: CliIo = {
    out: (t) => process.stdout.write(t),
    err: (t) => process.stderr.write(t),
    store: new FileCredentialStore(),
    signIn: signInWithBrowser,
    extract: extractFromDebugChrome,
    read: extractFromChrome,
    listSessions: listChromeSessions,
    list: listWorkspaces,
    load: loadSessionCookies,
  };
  main(process.argv.slice(2), io).then(
    (code) => process.exit(code),
    (err: unknown) => {
      const msg = err instanceof NotionError ? `${err.code}: ${err.message}` : "unexpected error";
      process.stderr.write(`error: ${msg}\n`);
      process.exit(1);
    },
  );
}
