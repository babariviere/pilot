# Exact Local task status

Open a mission's Tasks, select a task, then **Change status…**. Choosing a
status does not write. The confirmation shows the captured task ID, title and
current → chosen status; **Change status** is the explicit commit. Close/Escape
restores mounted task focus. Choices and operation results are retained for exact
tasks without a lifetime count limit in this window, not across process restart. There is no text
input or agent-start control in this form. Existing sibling-editor preedit
capture remains authoritative before pointer blur or navigation.

## Existing authority, not a new safe endpoint

Swift `MissionTaskStatusMenuItems` lists all seven `MissionTaskStatus` cases,
disables the selected `workStatus`, and writes through `updateMissionTask`.
The daemon's `server.ts::missionRoute` uses
`PATCH /api/missions/:missionId/tasks/:taskId` →
`MissionService.updateTask` → `MissionStore.updateTask`. Only `{status}` is
sent here, with canonical IDs, never task display numbers. All seven statuses
are accepted by `taskFields`; there is no transition matrix, active-mission
check, assigned-task veto or linked-PR veto in that write path. Done/archived
missions remain editable without reopening them. It does not claim, release,
assign, bind a PR, merge, create a chat or explicitly start one.

Status is not merely a label:

- An explicit status clears automatic Linear delegation metadata, opting out
  until a later assignment change. The assigned chat is retained.
- The user moving to a lower rank permanently sets `pr_sync_disabled`, even
  across restarts and future PR links. Ranks are todo=0, review=2,
  done/dropped=3, and progress/blocked/delegated=1.
- A changed status emits a task event, updates completion timestamps and
  reconciles phase completion/reopening and managed-ticket progress. This can
  change other tasks' projected phase-gated status. It does not move phases or
  dependencies explicitly.
- Blocked queues a coordinator notice; phase completion/reopening also queues
  notices. `MissionNotices.deliver` → `Sessions.sendNotice` can resume an
  existing coordinator's agent. Confirmation discloses this; it is not a
  claim of notification-free or side-effect-free mutation.
- Change publication refreshes mission PR observations/context. Concurrent
  PR/model/agent writers may change state again after the acknowledgment.

These effects are disclosed beside confirmation. There is no compare-and-swap
or no-wake option. A canonical Local hello/catalog check plus exact current
task preflight rejects known mismatches, but cannot guarantee race-free
current→chosen semantics or prevent a concurrent delegation/membership change.
Do not describe that read as atomic authority. No backend guard was invented.

## Delivery

The immutable operation includes pinned Local home, mission/task IDs, task
number/title/current status and chosen status. Transport rechecks Local hello,
canonical catalog provenance, and bounded mission detail before one PATCH.
Pre-request failures are Not sent. After PATCH admission any missing/error,
redirect, oversized, malformed or mismatched response is Unknown, including
HTTP400/409: `updateTask` can fail publishing after its transaction commits.
Only a valid HTTP200 exact task/status response acknowledges the operation;
phase projection is validated using `storedStatus` when present. This is an
operation acknowledgment, not a filesystem durability guarantee.

No automatic retry, GET settlement or replay is available after Pending,
Unknown or Acknowledged. Refreshing matching task status does not clear a lost
receipt. Late replies update only their immutable captured operation, even
after closing/navigating; they never reopen, refocus or retarget the form.
After an acknowledged change (or a pre-request Not sent result), an explicit
**Use refreshed task for a new change** begins a separate intent from the task
snapshot. It is never available for Pending or Unknown.
