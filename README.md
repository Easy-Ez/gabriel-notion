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

## Documentation

| Document | For |
| --- | --- |
| [使用指南（中文）](docs/zh-CN/guide.md) | Setup, reading and writing, events, AI safety, reliability, recipes, FAQ |
| [Node.js API reference](sdks/node/README.md) | Every method, option, type, event and error |
| [Architecture](docs/architecture.md) | How the SDK is built and why |
| [Behavior specification](spec/behavior.md) | The contract every language's SDK follows |
| [Releasing](docs/releasing.md) | Cutting a release |

| Path | Contents |
| --- | --- |
| [`sdks/node`](sdks/node) | Node.js SDK (`gabriel-notion` on npm) and the `gabriel-notion` CLI |
| [`spec`](spec) | Language-neutral behavior contract, event JSON Schemas and shared fixtures |
| [`docs`](docs/README.md) | Guide, architecture, releasing |

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
