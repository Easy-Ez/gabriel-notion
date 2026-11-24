#!/usr/bin/env node
// Scans every file git would track (tracked + untracked, minus .gitignore) for credentials,
// real-looking Notion IDs, personal paths, references to the private research repository and
// docs outside the curated public set. Run before every commit (`pnpm leak:check`).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const files = execFileSync("git", ["ls-files", "-co", "--exclude-standard"], { cwd: root, encoding: "utf8" })
  .split("\n")
  .filter((f) => f && !/(^|\/)(pnpm-lock\.yaml|package-lock\.json)$/.test(f) && !/\.(png|jpe?g|gif|ico|woff2?|tgz)$/i.test(f));

// Notion session tokens (token_v2 values start with v02/v03, raw or URL-encoded).
const TOKEN = /\bv0[23](?::|%3A)[A-Za-z0-9._~%-]{12,}/g;
const ALLOWED_TOKEN = /TESTONLY|\.\.\.\[REDACTED/;
const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const ALLOWED_EMAIL = /@(example\.(com|org|invalid)|anthropic\.com)$/;
const LOCAL_PATH = /\/(Users|home)\/(?!syn\/|you\/|me\/)[A-Za-z0-9._-]+\//g;
// UUIDs: placeholders are 00000000-0000-4000-8000-… (or a repeated digit); the shared fixtures
// carry remapped random IDs and SHA-derived event IDs, so they are exempt.
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const PLACEHOLDER_UUID = /^(0{8}-0{4}-4000-8000-[0-9a-f]{12}|([0-9a-f])\2{7}-\2{4}-[0-9a-f]{4}-[0-9a-f]{4}-\2{12})$/i;
const ALLOWED_UUIDS = new Set([
  "cb019182-2500-685e-42ad-640a98fe6bc0", // event ID test vector in spec/behavior.md
  "4212dfdc-1c35-805a-9a5a-da5a5a5a5a5a", // synthetic v8 block ID in the ID tests
]);
const UUID_EXEMPT = /^spec\/fixtures\//;

// Curated public docs: anything else under docs/ is rejected (research stays in the private repo).
const PUBLIC_DOCS = new Set(["docs/releasing.md"]);

// References to the private research and design material.
const INTERNAL_MARKERS = [
  [/\bresearch\/|\(research\b|notion-web-js|docs\/design\b|\binternal\//, "reference to the private repository"],
  [/实测|实网|调研|实验记录|双账号对照/, "research-process wording"],
  [/company[- ]workspace|公司工作区/i, "employer workspace reference"],
];

// Optional local-only list of internal words (git-ignored), one case-insensitive substring per line.
const denyFile = path.join(root, ".oss-denylist.txt");
const deny = existsSync(denyFile)
  ? readFileSync(denyFile, "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"))
  : [];

const SELF = new Set(["scripts/oss-leak-check.mjs", ".gitignore"]);
const findings = [];
for (const rel of files) {
  if (SELF.has(rel)) continue;
  if (rel.startsWith("docs/") && !PUBLIC_DOCS.has(rel)) findings.push(`${rel} not in PUBLIC_DOCS (internal notes belong in the private repo)`);
  let text;
  try {
    text = readFileSync(path.join(root, rel), "utf8");
  } catch {
    continue;
  }
  text.split("\n").forEach((line, i) => {
    const at = `${rel}:${i + 1}`;
    for (const m of line.matchAll(TOKEN)) if (!ALLOWED_TOKEN.test(line)) findings.push(`${at} token-like value ${m[0].slice(0, 6)}…`);
    for (const m of line.matchAll(EMAIL)) if (!ALLOWED_EMAIL.test(m[0])) findings.push(`${at} email ${m[0]}`);
    for (const m of line.matchAll(LOCAL_PATH)) findings.push(`${at} local path ${m[0]}`);
    if (!UUID_EXEMPT.test(rel)) {
      for (const m of line.matchAll(UUID)) if (!PLACEHOLDER_UUID.test(m[0]) && !ALLOWED_UUIDS.has(m[0].toLowerCase())) findings.push(`${at} non-placeholder ID ${m[0].slice(0, 8)}…`);
    }
    for (const [re, what] of INTERNAL_MARKERS) if (re.test(line)) findings.push(`${at} ${what}`);
    for (const word of deny) if (line.toLowerCase().includes(word.toLowerCase())) findings.push(`${at} internal identifier "${word.slice(0, 3)}…"`);
  });
}

if (findings.length) {
  console.error(`✗ ${findings.length} potential leak(s):\n${findings.map((f) => `  ${f}`).join("\n")}`);
  process.exit(1);
}
console.log(`✓ ${files.length} files scanned, no leaks found`);
