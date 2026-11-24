# AGENTS.md — guide for coding agents

Gabriel Notion reads, writes and watches Notion through a person's web session, with change events
named like Notion's official webhooks. This file tells coding agents (and humans) how the
repository is organized and which rules every change follows.

## Layout

```text
spec/            Language-neutral contract: behavior.md, event JSON Schemas, shared fixtures
sdks/node/       TypeScript reference SDK (npm: gabriel-notion) and the `gabriel-notion` CLI
docs/            Curated public docs: user guide (zh-CN), architecture, releasing
scripts/         Leak check
```

## Rules

1. **Spec first.** A behavior change updates `spec/behavior.md` (and `spec/schema/` or
   `spec/fixtures/` when events change) together with the implementation and its tests.
2. **Placeholders only.** Never commit cookies, tokens, emails, real page text, or real workspace,
   user or page IDs. Use `00000000-0000-4000-8000-…` IDs, `TESTONLY` in synthetic credential values,
   and `example.invalid` addresses. Fixtures keep only remapped IDs and replaced text.
3. **Credentials never leave memory unredacted.** Errors, logs, events and `health()` carry cookie
   names at most. Credentials are only sent to `https` / `wss` Notion hosts.
4. **Unit tests never touch the network.** Use the fake fetch and fake Message Store in
   `sdks/node/test/helpers`. Add a test with every change.
5. **Live checks are opt-in.** `pnpm test:integration` writes to a test workspace you name through
   environment variables; never run it against a workspace you may not change.
6. **Public docs are curated.** `docs/` only holds the files listed in `scripts/oss-leak-check.mjs`.
   Write for users and contributors; research notes and decision logs stay out of this repository.
7. **Keep safe defaults.** Own writes not delivered back, loop guard on, scoped views available,
   untrusted content wrapped for LLMs.

## Commands

```bash
pnpm install
```

```bash
pnpm typecheck && pnpm test && pnpm build
```

```bash
pnpm leak:check
```
