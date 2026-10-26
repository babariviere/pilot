# Edit an exact Local task

Task details offer **Edit title and body…** in a focused popup dialog, not an
inline section. The retained native form has one
explicit Save (Command-Return). Plain Return edits; Close/Escape retains text.
Outside clicks do not dismiss it; Close/Escape respect active preedit. The
shared dialog owns modal focus, viewport bounds, scrolling and presentation.
Only title and body are sent. Status, ownership, model, dependencies, phase,
deletion and Start are not fields or outgoing operations.

## Audited existing contracts

- Swift's task row in `MissionTabs.swift` edits a title with `saveTitle()`,
  submitting `MissionTaskWrite(title:)` after nonblank trim. The description
  in `MissionTaskDescription.swift` is selectable and expandable, not a body
  editor. This slice adds explicit body editing without the row's implicit save.
- `server.ts::missionRoute` PATCH `/api/missions/:id/tasks/:taskId` returns
  **200 with a raw MissionTask**. It has id/number, but no missionId or receipt
  wrapper. Mission/home scope comes from the verified connection and exact route.
- `mission-service.ts::updateTask` resolves the task and validates preferences;
  `missions.ts::updateTask/taskFields/text` uses ECMAScript trim and checks raw
  JS lengths: title200, body8000 UTF-16 units, nonblank title, empty body allowed.
  Empty stored body is omitted. The form rejects oversized input atomically,
  retaining the previous value and explaining the undo reset.
- The store retains the existing status/owner/dependencies/phase when omitted.
  It updates timestamps, records rename activity, publishes member context,
  and runs existing phase/Linear reconciliation. Phase-reconciliation notices
  may notify the coordinator. The form discloses this, and sends no Start action.
  No new backend safety or no-wake guarantee is invented.
- There is no CAS, version predicate or idempotency key. Both text fields are
  written on Save; a concurrent editor can be overwritten even after preflight.
  Complete mutation responses wait for `MissionStore.durable()`, but errors
  can follow commit and response loss is not evidence of failure.

## Identity, retention and uncertainty

At most16 forms per window pin canonical Local home/mission/task/number plus
connection. Numeric task IDs are refused because the daemon interprets numeric
references as display-number aliases. Reads use bounded mission detail, not an
invented task GET or paging API. Canonical catalog/hello and exact task admission
precede the single PATCH. Maximum response2MiB and256 task rows; no partial
source clipping. Transport has no retries, redirects, remote fallback or cookies.

Each Save captures an immutable ID, target and normalized title/body. Only its
exact pending attempt accepts a result. Closing/navigation neither cancels nor
replays it; late ACK updates only that retained attempt, never focus or text.
Pending and Unknown cannot reset/replay. Every attempted write lacking a valid
complete200 ACK is Unknown, including400/409, disconnect, malformed or oversized
JSON and wrong identity/content. Later GET matches never settle it.
Not sent permits an explicit retry. After ACK, Edit again explicitly reads a
new snapshot. Drafts and receipts survive navigation, not app restart.

Shared native textarea/actions/notices retain input entities, Unicode/selection,
editor-internal pointer handling and preedit guards before sibling blur.
The mounted task pane and application root retain their navigation/IME guards;
close restores mounted task focus before unmount. No composer/backend writes.

## Focused verification

`python3 scripts/check-scoped.py --unit task_edit --test task_edit --lint`
selects state/normalization/transport tests and two offscreen production
Browser/form journeys (680 light,1100 dark), plus an actual LocalViewer root
IME/focus journey. Only owned faux HTTP is used. It covers retained drafts,
UTF-16 clipboard limits, real Save/Close keys, pre-blur sibling guards,
internal marked-editor pointer selection, navigation, delayed exact ACK,
Unknown fencing and exact outgoing two-field payloads.

Shared serial slot, CPU2/4GiB and private target/evidence are retained. No broad
suite, production daemon action, OS IME/accessibility qualification, motion or
Linux/Wayland acceptance is claimed.
