# Native Today intake

Today intake uses canonical tracked items, not the dashboard's five-row preview.
No source sync, sign-in, model call or external write runs during a read or Check.
The connected window's New section consumes these methods (apps/day/README.md).
The mock window keeps Today's read-only example rows.

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
The same projection also fills `snapshot.later`, `snapshot.discarded` and
`snapshot.claimed` (rows an entered Start owns); only `intake` counts unshown
rows. The screen takes each row's revision from `snapshot.sources`.
`operations` lists saved native intake operations for this exact root source,
including operations restored from the private command ledger after reopening.
Each names its `itemId`, `kind`, a triage's requested state (`asked`) and a
Start's `missionId`.

The screen reads again after opening, on Read again, after a write whose reply
held no fresh read, and when the root's cached Today preview of requests
changes. An invalidation alone does not read the service.

## Saved Linear browsing read

`day.linear.read {}` uses the same selected-project native owner and authenticated
read seam. Day's typed adapter is `apps/day/linearRead.ts`; its contract imports
only the canonical Node-free `tracking.ts` leaf. It returns `{snapshot, outcome:null}`
from `GET /api/projects/:projectId/saved-linear`, with no command ledger entry.
The HTTP route requires the native capability and refuses non-GET methods.

The intake query is not sufficient for browsing: it excludes linked/completed
issues and omits the saved cycle summary. The browsing read reuses the existing
tracked-items worker's list query, not a new store, source or live integration:

- `scope:saved-own-issues`, `version:1`, selected `projectId`, `contextDigest`.
- Active, non-dismissed saved Linear rows, including linked/completed issues.
  Exact `sessionId`/`missionId` and plural link history pass through unchanged.
  Matching titles, URLs or other metadata never infer or merge associations.
- `limit:100`, `total`, `complete`, numeric `more` count the eligible saved rows
  in one worker turn. There is no claim to list all team tickets or all cycles.
  This first page has no paging control; `more > 0` must stay visible to callers.
- `configurationCurrent` means a saved source checkpoint matches the current
  project's Linear settings. Missing/mismatched checkpoints hide rows and cycle
  data; their empty page is not evidence that the external source has no issues.
- `source` carries the canonical status, sanitized error, `lastPolledAt` and
  saved `linear` summary. `cycleStatus:current` is the cycle actually read by the
  last successful sync, with personal progress, not team progress. It is not
  proof that the cycle is still current now. Always show its saved timestamp and
  source trouble; `no_active_cycle` is a source result, not a fabricated cycle.
  A failed refresh keeps the prior successful saved data and timestamp.

Project configuration and source checkpoint are checked again after the worker
read; a race refuses the read, never retries it. The native boundary also checks
selected project identity/path before and after the read, source/row scope,
page counts and completeness. VM arguments cannot select a project or host.
Reads do not poll MCP, subscribe, authenticate a source, call a provider, start
work, write profiles/source settings or publish Linear issues. The default app's
deny-all capabilities are unchanged.

Checks: `saved-linear.test.ts` covers canonical wire types, HTTP permission,
exact links, same-title non-association, personal cycle, overflow, empty/missing/
replaced checkpoint, source errors and project/checkpoint races. Released NSH's
hidden `native/tests/linear.rs` exercises the real authenticated daemon through
the public host channel, including grant denial, offline/malformed replies and
deleted selected project. These checks do not qualify a new UI or live source.

## Explicit intents

All methods use the existing version/window envelope and exact-name host grant.
The host does not fence intake calls on its general read epoch: every dashboard
or session notice bumps it, including the notice an earlier intake write causes,
so the next quick action would be refused as stale. The host only requires that
it is open and the window's gate admits the call; the daemon's CAS on the pinned
revision and project configuration decides.

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
- `native/tests/intake_today.rs`: `Connected.tsx` headless on the same daemon:
  Later, Bring back, Discard and Undo each send once, a lost Start stays
  not confirmed across a native reopen and Check reads it once.
- `apps/day/Intake.test.tsx`: the New section's controls on a scripted source:
  stale writes, changed requests and projects, rapid presses and focus.

After a reopen, a Start whose request is already linked to its chat shows as "a
request": the read no longer holds the item, and the saved operation has no title.

These checks do not enable a live provider, integration, subscription or preview
window, and do not qualify native visual acceptance or live update/cutover.
