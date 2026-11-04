# Missions

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

In coordinator-owned planning, the coordinator maintains scope, assignments, and
acceptance criteria. Workers report progress, evidence, and blockers and propose
planning changes. Evidence alone is not acceptance or permission to expand scope.

Coordinators can answer ordinary member questions within the approved mission scope.
Replies are attributed to the coordinator. Database-access approvals remain yours.

Coordinators can record an already-authorized decision replacement with
`mission({action: "supersede", decisionId: "D7", replacementDecisionId: "D9"})`.
Both decisions must belong to this mission. The old text, history and task pins stay
traceable, but the old decision is no longer binding. Replacement text keeps its own
audience; pins are not redirected. This does not approve policy or change the user-only
decision edit/removal and proposal-approval rules. Exact retries are safe; relinking
and cycles are rejected. Existing decisions stay active until explicitly replaced.

## Finish or archive

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
