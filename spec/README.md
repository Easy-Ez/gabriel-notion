# Gabriel Notion Specification

Language-neutral contract that every Gabriel Notion SDK implements. The Node.js SDK in
[`sdks/node`](../sdks/node) is the reference implementation.

| Path | Contents |
| --- | --- |
| [`behavior.md`](behavior.md) | Normative behavior: session, HTTP, records and transactions, events, recovery, guards, errors |
| `schema/` | JSON Schema for every event type |
| `fixtures/markdown/` | Record ↔ Notion-flavored Markdown cases shared by all SDKs |
| `fixtures/events/` | Recorded (redacted) activity and frames with the events they must produce |

Fixtures contain synthetic samples and redacted evidence only — never real workspace content,
names or credentials.
