# Missions

The upcoming connected native path starts with **New → Plan a mission**. Pilot saves the complete
interview up front. Answer one question at a time, or choose **See all**; skipped questions still need
answers before the final submission. Back-navigation keeps drafts. After a read failure, **Read again**
keeps the earlier page visibly stale until a fresh read succeeds. If creation is not confirmed,
**Check creation** looks up its saved receipt, including after reopening. It never creates it again.

Approving and publishing a plan do not start implementation.
While Pilot plans, the planning page shows the agent's current step, such as "Reading
docs/missions.md", how long it has worked and when it last saved a step. After 5 minutes with no
new step, it says so. **Show planning chat** opens the agent's conversation and steps, read only.
Neither sends anything, stops the agent or tries again.
After publication, **Start work** asks you to confirm one ready task and its model. **Start task**
admits one background worker under existing project permissions and limits. The worker
follows the bundled upstream implement skill: test-first at the seams the plan agreed (tdd and
codebase-design), then a code review before it reports. Other tasks do not start
automatically. If the acknowledgement is lost, use **Check Start**, not another Start. Admission is not
progress or acceptance. Read the agent's report in the mission overview. This connected path is
qualified with an isolated daemon and faux workers, not enabled against your live profile. The current app
is unchanged.

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
slot (maximum two). Only chats that can change code take a slot, reviewers included. Ask chats
(explorers, task prototypes and thread chats) never wait for one. A worker finish wakes reconciliation without
waiting for every other worker.
A task chat that waits for you (its question, a reply, or your check of its result) gives its slot back.
Its files still count, so work on the same files still waits.
The coordinator checks fresh task scope, ownership and
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
agreement, not a required step or build task. When a research question is ready, Pilot starts a
read-only research chat for it (at most two at a time). Pilot saves the chat's findings word for word as
Knowledge linked to the mission, and the planner cites them. Research chats read `main`, change no files
and create no tasks. Its linked artifact, findings and open questions stay
with the mission. Findings are evidence, not your acceptance or permission to build. When a prototype
question is ready, Pilot starts one read-only prototype chat for it, with the model the planner chose. The
chat publishes one NSH mock with the variants, and Pilot links it to the mission. The planner then asks
you about it, and the round shows **The prototype**, which opens in the app's isolated preview (**Full window**
shows it over the whole page). A prototype chat has no time limit; its cost limit is shown, not enforced. See
[mission prototypes](technical/mission-prototypes.md).
After the plan is published, a builder whose task needs a UI prototype asks Pilot for one itself. Pilot makes
it in a read-only chat, links the mock to the task and sends it to the builder, which then asks you to choose.
You do not confirm the prototype first; you answer once, when you choose.
When a builder ends its turn with its task open, no new result and no question, Pilot reminds it once per
message you send: ask with its question tool, deliver, or go on. If it still stops that way, it may be asking you
something in prose. **Needs a look** on Today and the task's result page show its last message: **Reply** sends
your words once; **Continue** sends none. Chats of archived missions leave Needs you.
When Pilot's planning agent has stopped while the plan is still open, **Continue planning** under its
status asks it to pick up where it stopped. It answers, approves and starts nothing.
When it ended its turn with no question, it may be waiting for you: its planning page and Today's planning
row show its last message. **Reply** sends your words to it as a note; **Continue** sends none.
**Unstick**, under the same status, says whether planning moves, waits for you or is stuck, lists what
Pilot checked, and offers at most one fix. Reading it changes nothing; the fix applies only on **Apply**.
When there is no fix, report it with Feedback.
When planning is stuck, **Have an agent look** starts a read-only chat that reads the planning agent's chat,
Pilot's checks and the logs. It proposes one fix (continue, a note to the planning agent that you can edit, or
removing answers to an earlier wording) with the cause and what it read. Only **Apply** acts, and only while
the mission is as the agent saw it. For a bug in Pilot itself, **Report with Feedback** fills Feedback with the
agent's findings for you to check and send; from Feedback you can start a fix in Pilot's own project.
`~/Library/Logs/Pilot/pilotd.log` records each operation, planning step change and research or question
chat; `day.log` records closing, unsaved forms and window errors, including uncaught ones.
Under each question, **More context** shows the background Pilot wrote, and **Ask a question** asks a
separate read-only chat, which answers under the question from the mission's records. **Say it simpler**
and **Reword this** leave notes; add one on the whole round if you like, then **Send notes to Pilot**:
Pilot redoes the round with all of them at once. Your saved answers stay. Notes and questions answer
nothing for you, and they never start work. Unsent notes and questions come back after Pilot restarts.
With one question shown, keys toggle its help: **M** more context, **S** say it simpler, **A** ask a
question, **R** reword this.

These records form the mission's **map**, one shared overview for you and the planning agent:
what is open now, what waits, what is settled (never asked again), the Fog of war and the agreed
tasks. When a cited decision or Knowledge entry changes, the map says so until the agent updates it.
Viewing the map answers, approves and starts nothing.

Pilot Day draws the map as an expedition chart: settled questions are inked islands, open ones sit on
blank ground with a mark for their kind, fog of war is drawn as fog, and Pilot's route runs between
its planning rounds. The compass points at what needs you. Select a place for its field notes and
original sources. On the planning page the chart shows whole and stays still, so scrolling moves the
page. Trails show what waits for what. A question that waits for more than three others says how many
instead; select it to see its trails. A finished research chat's question says its findings wait for
Pilot until the planning agent records them. **Open chart** (⇧⌘M) shows it full window, where you drag,
scroll and zoom to look around; Esc closes the notes, then the full view. Changes that arrive while the
chart is open play once: an answer inks its ground, fog lifts, and a new planning round draws its leg.
Reduce Motion shows them without movement. Everything on the chart is also listed below it.

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
