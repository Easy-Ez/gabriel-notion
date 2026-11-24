# Event fixtures

Each file replays activity-log reads through the mapping in [behavior §8](../../behavior.md#8-events).

| Field | Meaning |
| --- | --- |
| `workspaceId`, `selfUserId` | The workspace and the account the SDK acts as |
| `records` | Records the mapping may look up: `{ table, id, role, value }`; anything absent counts as `role: "none"` |
| `reads[]` | Successive reads of the same entity. Edit keys consumed by a read count as seen for later reads |
| `reads[].activities` | Activity records as `getActivityLog` returns them in `recordMap.activity` |
| `reads[].expected.events` | The events, in order, without `web.before` / `web.after` |
| `reads[].expected.noAccess` | Records whose events were dropped for lack of access |
| `reads[].expected.drift` | `guard.protocol_drift` kinds reported by the read |

The activities were recorded in a test workspace (one account editing, and two accounts editing
the same shared pages) in November 2026. Every ID is
remapped to `00000000-0000-4000-8000-…`, titles, comment text and names are replaced, and
permissions, formats and CRDT data are removed. Cases marked "Derived" edit a recorded activity
to cover a rule the recordings do not show (cancellation, no access, unknown types, a second read).
