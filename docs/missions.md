# Missions

The upcoming connected native path starts with **New → Plan a mission**. Pilot saves the complete
interview up front. Answer one question at a time, or choose **See all**; skipped questions still need
answers before the final submission. Back-navigation keeps drafts. After a read failure, **Read again**
keeps the earlier page visibly stale until a fresh read succeeds. If creation is not confirmed,
**Check creation** looks up its saved receipt, including after reopening. It never creates it again.

Approving and publishing a plan do not start implementation.
After publication, **Start work** asks you to confirm one ready task and its model. **Start task**
admits one background worker under existing project permissions and limits. Other tasks do not start
automatically. If the acknowledgement is lost, use **Check Start**, not another Start. Admission is not
progress or acceptance. Read the agent's report in the mission overview. This connected path is
qualified with an isolated daemon and faux workers, not enabled against your live profile. The installed
[development Preview](development-preview.md) remains demo-only. The current app is unchanged.

Direct chat creation, automatic continuation after human actions and budget increases are not supported
by this connected path. Unavailable controls do not grant permission or start work.

The connected overview shows each task's agent report, next step, evidence and
linked outputs without opening its chat. PR states and check health are saved
observations with their last-check times, not a promise they are current.
An agent-reported commit does not prove publication. A merged PR does not prove
a release, and none of these records replaces your explicit result check.

**Needs a look** on Today and in a mission shows unresolved host-reported
problems, their cause and a recommended next step. Saved or unfinished work
stays explicitly unverified when the record cannot prove it. Diagnostic chat
addresses remain available as selectable text. Reading a problem never retries
work or grants permission. Earlier/offline reads keep their warnings visible.

Use a mission when one goal needs several chats. Its **brief** describes the goal,
**decisions** record agreed choices, and **tasks** track ownership and progress.

1. Create a mission in the project and describe the outcome you want.
2. Break work into tasks, with dependencies or phases where useful.
3. Coordinate it yourself or use a coordinator chat.
4. Open task chats to inspect results, linked PRs, and artifacts.

The mission toolbar opens its Overview; the compass beside its title opens the coordinator.
Tasks can be grouped into ordered phases. Optional phase gating holds later work
until earlier phases finish, unless you explicitly override it.

## Work with a coordinator

The backend now supports reviewed mission revisions. Proposed changes do nothing until you
confirm the exact saved version. Completed work and earlier decisions stay in history.
Coordinator context uses the current agreement, active decisions and current work, not old
plans or retired decision bodies. History remains available on demand. This does not erase
earlier chat text or reset chats. See [the backend contract](technical/mission-revisions.md)
for its safety limits.

Pilot Day shows **Revisit mission** on an older mission's overview and planning page, on mock
data for now. It keeps three steps apart:

1. **Answer new questions.** Pilot asks only about gaps, in a saved interview round. Drafts save
   as you go. Submit once, after every question has an answer. Submitting completes that round
   only; nothing changes.
2. **Review the revision.** It shows what stays, changes and drops in the goal, agreement, open
   tasks and decisions. Finished tasks stay. Instruction and permission suggestions are listed
   apart and never applied by it.
3. **Confirm it.** One explicit confirmation of the exact revision shown. Pilot refuses it if the
   mission changed, or while chats still work and the mission is not paused. Confirming starts,
   resumes and permits nothing. A lost answer stays unconfirmed until you check; Pilot never
   sends it twice.

The connected app says Revisit is not connected yet.

In coordinator-owned planning, the coordinator maintains scope, assignments, and
acceptance criteria. Workers report progress, evidence, and blockers and propose
planning changes. Evidence alone is not acceptance or permission to expand scope.

Task owners can save versioned movement reports through the mission tool. These are
agent assessments, not verified progress or accepted delivery. Old reports can become
stale when their assignment, owner or context changes. Missing reports mean unknown.
The upcoming Day overview and separate Mission Pause/Resume controls are backend
contracts only; the current desktop app has not gained those controls yet.

Coordinators can answer ordinary member questions within the approved mission scope.
Replies are attributed to the coordinator. Database-access approvals remain yours.

When you authorize continued work, the coordinator can queue an exact next slice with
`start` and a stable `operationId`. It waits durably for dependencies and a free worker
slot, including reviewers (maximum two). A worker finish wakes reconciliation without
waiting for every other worker. The coordinator checks fresh task scope, ownership and
reports before closing work; a finished turn or published increment does not close a task.
`get` shows queued starts and waiting reasons. Stop, Pause, changed scope/authority and
user-pinned order still apply. Unknown starts use exact lookup, never another start.
Unrequested tasks are not execution grants. This does not enable Autopilot or grant spend.
Dispatch stays blocked unless the host has a qualified current dispatch/model/budget
policy source. This source is not yet bound in production. Queuing is not permission
to bypass that missing gate. See [the queue API](technical/mission-continuation.md).

Decision updates follow the current task's decision pins. Decisions marked for everyone
remain mission-wide rules. Unassociated guidance goes to the coordinator for routing,
not every worker. Routine additions are grouped for up to 30 seconds; changed guidance
and shared rules reach affected live chats immediately as passive context. Offline chats
reconcile when reopened. These notices do not start work, answer questions, or prove that
an agent applied the guidance. Full decisions and history remain available on demand.
See [decision routing](technical/mission-decision-routing.md) for the exact rules and limits.

Day's saved Wayfinder planning records distinguish **Needs research**, **Needs grilling** and
**Needs prototype**. A prototype is a small disposable experiment for a named uncertainty during
agreement, not a required step or build task. Its linked artifact, findings and open questions stay
with the mission. Findings are evidence, not your acceptance or permission to build. Interactive
prototype execution remains unavailable; see [native planning](technical/day-mission-planning.md).

These records form the mission's **map**, one shared overview for you and the planning agent:
what is open now, what waits, what is settled (never asked again), the Fog of war and the agreed
tasks. When a cited decision or Knowledge entry changes, the map says so until the agent updates it.
Viewing the map answers, approves and starts nothing.

Coordinators can record an already-authorized decision replacement with
`mission({action: "supersede", decisionId: "D7", replacementDecisionId: "D9"})`.
Both decisions must belong to this mission. The old text, history and task pins stay
traceable, but the old decision is no longer binding. Replacement text keeps its own
audience; pins are not redirected. This does not approve policy or change the user-only
decision edit/removal and proposal-approval rules. Exact retries are safe; relinking
and cycles are rejected. Existing decisions stay active until explicitly replaced.

For withdrawal without a successor, coordinators can propose
`mission({action: "propose", decisionId: "D7", withdraw: true, reason: "No longer needed", operationId: "unique-request-id"})`.
Only your acceptance withdraws the decision. Pending or rejected proposals leave guidance
active. Withdrawal preserves original text, history and task pins, records the reason,
and removes binding guidance from new and existing agent contexts. A withdrawn decision
cannot be replaced or used as a replacement; a replaced decision cannot be withdrawn.
Reuse the operation ID only for exact retries; conflicting requests/outcomes are rejected.
Do not automatically replay an unknown result.
User edits/removals reject pending withdrawal proposals while preserving their history.
Resolve an existing pending proposal before suggesting a different change.

This requires user confirmation, not autonomous coordinator withdrawal. Existing records
do not establish delegated withdrawal authority, including coordinator-authored records.
In the desktop app, open the proposal under **Read decisions** and choose **Withdraw D…**
or **Keep D…**. Withdrawn and replaced decisions move behind **Show retired**. Older
native readers reject the distinct `withdraw` kind rather than treating it as hard
Remove. Hard deletion and other user-only approvals are unchanged. No historical
withdrawals or delegation are inferred.

## Approve a coordinator-planned mission

For a mission created with coordinator planning, Overview's **More** menu has
**Approve plan…**, **Reviewer consent…** and their revocations. Each sheet shows the exact
brief revision, decisions, coordinator powers, limits and, for consent, the reviewer
disclosure, then confirms that package once. If the reply is lost, **Check** looks up the
saved confirmation and never sends it again. Approval starts no work. Reviewer consent
stays unavailable until Local has a reviewer configuration.

## Finish or archive

Coordinators can mark tasks done or dropped without an associated commit, preserving
their history. This records task closure, not PR review or merge approval.
Workers report scoped delivery facts with `report`, including a commit, checks and open issues.
Reports keep their assignment identity and notify the coordinator durably. They never change task
status or mean that you accepted the work. Only you or the coordinator can change canonical status.
The coordinator can use `complete` for a worker-owned task after checking its current scope,
ownership, dependencies and evidence. A merged PR is evidence, not automatic task closure.

**Mark done** is available when all remaining tasks are done, excluding dropped tasks,
and at least one task is done. It does not merge PRs or finish tasks for you.

Completing or archiving a mission archives its coordinator after current work finishes.
Archiving a coordinator also archives its mission. Other member chats and their
history remain intact. Archive and reopen are separate from deleting a workspace.

Coordinators can use `archiveWorker` and `restoreWorker` with `targetSessionId`
for finished workers in their current mission and project, without per-chat confirmation.
Assigned tasks must be done or explicitly dropped, with no outstanding work, queued input
or assistance. Idle alone is not finished. `status` includes archived workers.

Coordinator organization preserves history, artifacts and the workspace from automatic
cleanup. Restore does not send messages or restart work; a follow-up needs a separate,
authorized send or start. Your archive, restore and explicit workspace-cleanup controls
remain available. This does not enable automatic retirement or workspace deletion.

See [Linear](linear.md) for managed ticket contributions and [knowledge](knowledge.md)
for project documentation linked to a mission.
