# Gabriel Notion

Read, write and watch Notion as yourself, through your Notion web sign-in. Search, pages as
Markdown, databases, comments and members, plus change events named like Notion's official
webhooks for everything you can read in a workspace, delivered in your own process: no
integration to install, no pages to share with a bot, no public webhook URL.

Part of the Gabriel family of SDKs (with [Slack](https://github.com/Easy-Ez/gabriel-slack) and
[Google Calendar](https://github.com/Easy-Ez/gabriel-calendar)).

> Personal, non-commercial project; not affiliated with or endorsed by Notion. It uses Notion's
> private web protocol, which may change, and acts with your identity: use it only on accounts and
> workspaces you are allowed to automate, following your organization's policies and Notion's
> terms. Your session cookie is equivalent to your password; never commit or print it.

```ts
import { NotionClient, loadSessionCookies } from "gabriel-notion";

const client = NotionClient.fromCookies({ cookies: (await loadSessionCookies())!, workspace: "My workspace" });
client.on("page.content_updated", (e) => console.log(e.entity.id, e.data.updated_blocks));
await client.start();
```

| Path | Contents |
| --- | --- |
| [`sdks/node`](sdks/node) | Node.js SDK (`gabriel-notion` on npm) — start with its [README](sdks/node/README.md) |
| [`spec`](spec) | Language-neutral behavior contract, event JSON Schemas and shared fixtures |
| [`docs/releasing.md`](docs/releasing.md) | How releases are cut and published |

## Development

Requires Node.js 22 or later and pnpm.

```bash
pnpm install
```

```bash
pnpm typecheck && pnpm test && pnpm build
```

```bash
pnpm leak:check
```

`pnpm --filter gabriel-notion test:integration` runs two-account tests that write to a test
workspace; they are skipped unless configured (see the header of
[`discovery.int.test.ts`](sdks/node/test/integration/discovery.int.test.ts)).

## License

[MIT](LICENSE)
