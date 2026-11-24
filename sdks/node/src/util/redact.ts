/**
 * Redaction helpers. Credentials must never appear in logs, errors, events or health
 * snapshots: only a short prefix and the length are kept, e.g. `v03%3Aey...[REDACTED, len=742]`.
 */
export function redactSecret(value: string | undefined, visiblePrefix = 6): string {
  if (!value) return "<empty>";
  return `${value.slice(0, Math.min(visiblePrefix, Math.floor(value.length / 4)))}...[REDACTED, len=${value.length}]`;
}

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  // Notion session and file cookies, in "name=value" form (Cookie / Set-Cookie headers, URLs).
  [/\b(token_v2|file_token|__Host-session_binding|notion_session)=[^;\s"'&]+/g, "$1=[REDACTED]"],
  // A token_v2 value on its own (encrypted JWE, "v0x%3A" or "v0x:" prefixed).
  [/\bv0\d(?:%3A|:)[A-Za-z0-9%._-]{20,}/g, "[REDACTED]"],
];

/** Scrubs anything that looks like a Notion session credential from free text. */
export function scrubSecrets(text: string): string {
  let out = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}
