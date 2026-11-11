# Native Today intake

Today intake uses canonical tracked items, not the dashboard's five-row preview.
No source sync, sign-in, model call or external write runs during a read or Check.
This is a native backend seam. The existing Today preview remains read-only until
its controls consume these methods.

## Read

`day.intake.read {}` returns `{snapshot, operations, outcome:null}`. The native
root's selected project and daemon lineage determine the request. TSX cannot
pass a project, path, host or credential.

The authenticated daemon read is `GET /api/projects/:projectId/intake`:

- `version:1`, `projectId`, `contextDigest` (the current project configuration).
- `sources`, ordered Slack then Linear. Each has `source`, `kind`, `label`,
  `status`, optional `error`, `limit:100`, `total`, `complete`, `items`.
- The total counts active, non-dismissed, open, unlinked items. Slack `waiting`,
  in-progress and done are not incoming work. Completed/canceled Linear items
  are excluded. Both latest links and link history exclude an item.
- Local triage is `triageState:new|later|discarded`, separate from Slack status.
  All three states remain readable for Bring back and Undo. An entered Start
  without a link remains visible with `startOperationId`; it is not startable.
- The worker reads counts and rows in one turn. More than 100 per source is
  explicitly incomplete. The native boundary refuses oversized bodies, never
  cuts them. Rows from a replaced team/channel configuration are not shown.

The native response also includes `snapshot.intake`, produced by the existing
Today projection, with only new, unclaimed rows. `Request.id` is the tracked
item ID. Its `more` text is conservative when a source page is incomplete.
`operations` lists saved native intake operations for this exact root source,
including operations restored from the private command ledger after reopening.

## Explicit intents

All methods use the existing version/window envelope and exact-name host grant.

```
day.intake.triage {itemId, revision, contextDigest, state}
day.intake.start  {itemId, revision, contextDigest, missionId?}
day.intake.check  {operationId}
```

Later sets `later`; Bring back sets `new`. Discard sets `discarded`; Undo sets
`new`. Source sync keeps this state. Every tracked-item update invalidates the
monotonic revision, even if its source timestamp does not change. ABA updates,
legacy PATCH and source updates cannot reuse an old native intent.

The native owner generates one operation ID and, for Start, one chat ID. It
saves the exact immutable envelope in the existing fsynced command ledger
before the only mutation POST. The daemon uses the existing OperationJournal
for `intake-triage` and `intake-start`; native capability authentication protects
both execution and receipt reads. Item/project/revision and project
configuration are pinned in the payload. Unknown fields are refused.

Start first resolves the project's model through existing task model scope and
price-cap policy. This is not a new Build spending cap. A worker-side CAS then
saves a permanent Start claim before chat admission. One project-pinned Build
is created through `spawnDurable`, optionally joining the explicitly chosen
same-project active mission under existing mission/lifecycle gates. A final
configuration guard also runs in the normal metadata creation path.

The existing confirmed-start link is recorded only after durable chat creation.
Its existing best-effort Slack eyes / Linear state side effects remain exactly
on that path. No other external write is added. A creation receipt proves
durable chat creation and a saved opening input, not agent progress, successful execution, delivery,
production release or user acceptance.

## Unknown and Check

Mutations return the operation ID and exact receipt when known. A dropped reply
stays Unknown locally. `day.intake.check` reads only the saved exact operation's
receipt using `/api/operations/receipt`. It does not call the mutation endpoint,
recreate a chat, update the source link or repeat Slack/Linear effects. Duplicate
mutation submissions and daemon restart recovery do not re-enter a pending
handler. A terminal receipt remains saved across reopen.

An exception after the durable Start claim can leave a pending operation and
an unlinked claimed item. A failed chat admission is not proof that nothing
happened. This slice deliberately offers no claim reset or automatic retry.
If no terminal receipt was saved, Check stays Unknown, including after restart.
An ordinary legacy start/link is also refused while this claim owns the item.
Triage has the same conservative cross-store crash window: a committed local
change without its outer receipt stays Unknown, never auto-replayed.

## Checks

- `native-intake.test.ts`: overflow, scope, independent triage, revision/ABA,
  exact Start, lost admission ACK, restart lookup and duplicate prevention.
- `native-intake-http.test.ts`: real authenticated HTTP, SQLite/journal and
  durable session metadata, with fake sources/model selection and no workers.
- `native/tests/intake.rs`: released NSH host channel, native ledger-before-send,
  real isolated daemon, all four triage actions, lost Start reply and cold Check.

These checks do not enable a live provider, integration, subscription or preview
window, and do not qualify native visual acceptance or live update/cutover.
