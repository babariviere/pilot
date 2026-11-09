# Mission controls and agent reports

Status: v1 daemon/host contracts. No Day UI, live Pause, service restart or default-app change is implied.
The existing mission task store, dashboard projections, event cursors and SQLite replica are reused.

## Reads and reports

- `GET /api/projects/:projectId/day` returns `DayOverview` v1. Every existing dashboard section is complete,
  rather than its usual first five rows. IDs, ordering, counts and attention vocabulary are unchanged.
  `complete` describes these local projections, not all possible work or a complete evidence inventory.
- `GET /api/missions/:missionId/reports` returns the latest saved report for each reported task.
  Tasks without reports remain unreported, not “Not moving.”
- The supervised `mission` tool's `report` action derives the actor from its kernel IPC channel.
  `taskId` alone reads a source token and predecessor. A nested `report` submits the v1 payload with those
  exact values, a unique report ID, movement assessment, summary, next step and evidence strings.
  There is no HTTP endpoint accepting an agent-supplied actor.

Reports keep exact text and attribution. Their tokens bind project, mission, task, current owner, assignment,
definition revision, task-event cursor, coordinator, context and controls. Writes recheck after the durable
barrier and use predecessor CAS. Exact retries return the historical receipt, never create another report.
They do not update task status, acceptance or delivery evidence. Evidence strings are reported references,
not host-verified proof. Movement always has `agent_report` provenance. Activity alone is not progress.

Reads distinguish current, stale and unavailable. Source/owner/assignment changes make reports stale;
unavailable storage is not an empty inventory. Reports also become stale after 24 hours, a conservative
display expiry, not a guarantee that earlier assessments remain true. Unknown versions are not current.
The full read batches source fences, avoiding per-report task/phase/context queries. An isolated in-memory
400-member/400-report fixture measured 170.6 ms before batching, then 3.5–4.1 ms across five reads after.
This is daemon projection evidence, not a native UI or live streaming benchmark.

## Explicit mission control

`GET /api/missions/:id/controls` is passive. Native host actions POST a strict `MissionControlCommand` v1
to that path, using the existing Local app capability. Its exact home (`daemonId` and `lineageId`), project,
coordinator, expected control revision, action and operation ID are required. Resume also pins its Pause ID.
This boundary does not turn an agent, body actor or ordinary loopback caller into the user.

Pause saves a synchronous admission fence and a fixed member/owned-flow inventory before interruption.
It joins entered schedule dispatches, prevents new mission schedules/inputs/starts/actions, and checkpoints
current workers and their subagents with the existing [lifecycle close protocol](resumable-upgrades.md).
The final child inventory, independent jobs and OS-child census, close ACK and joined worker exit are
separate requirements. ACK alone is never `paused`. Owned flow reviewer chats are included without
inventing ordinary mission membership. Unrelated work keeps running.

Idle chats with no executor or pending work are held, not claimed by this Pause. A queued-input-only
checkpoint records `admissionOnly`, not a fabricated kernel census. Cold running work, uncertain input,
known cold children, interrupted shell effects, remaining jobs, failed inspection/exit, or a lost ACK keep
the aggregate Pausing/Unknown. Known local workers still checkpoint if another participant is uncertain.
Legacy remote execution has no pause adapter and is reported as an issue, never silently treated as drained.

Resume requires the exact acknowledged Pause and current membership/coordinator event fences (including
ABA), project and control revision. It only opens operation-owned checkpoints. A later Stop remains held;
other members may resume. Existing sleep, quota, input and update holds are not cleared. A released Resume
may wait behind another hold using its durable exact-operation authorization. Later Stop/Pause, moved
membership or unavailable controls veto that authorization. Changed input-control revisions still require
their own explicit recovery, not rebasing old execution authority.

Worker ready ACK is not model progress. No continuation message is synthesized. Resume admission with a
lost ready ACK stays Unknown. Operation and report receipt capacity is limited to 16,384 each; reaching it
refuses new records rather than evicting uncertain outcomes.

## Recovery and upgrade integration

`GET /api/missions/:id/controls/operations/:operationId` and exact POST retries are lookup-only.
An entered operation is displayed as Unknown after interruption. They never resend Pause/Resume effects.
Durable per-session checkpoints can be opened only by a valid explicit Resume, or its exact acknowledged
authorization still waiting behind another hold. Uncertain participant effects need inspection; there is
no automatic repair/replay endpoint.

`SessionMissionBridge.upgradeResumeFence` is installed before session recovery. Only control writes with
completed durable barriers are usable. It returns current canonical mission membership and pause/Stop
generations, or null for no membership. Missing/unavailable controls throw. Owned flow sessions inherit
their root's control fence. Upgrade checkpoints pin/recheck this fence, including after async isolation.
A mission Pause, Pause-then-Resume, Stop, changed membership or unavailable pinned controls vetoes old
upgrade resume. Mission Pause uses no global update lease and upgrade release cannot resume it.

Focused tests cover report staleness/attribution/CAS, full-list reads, admission and schedule-claim races,
Stop and owner ABA, ACK versus exit/census, independent holds, uncertain recovery and no unsafe replay.
All use isolated faux workers and temporary stores. Native controls and live acceptance remain separate.
