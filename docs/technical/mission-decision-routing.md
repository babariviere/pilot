# Decision notice routing

## Audit and reused contracts

`MissionService.context` already selected prompt guidance using audience `all`,
audience `coordinator` for the coordinator, and `decisionIds` on open owned tasks.
Its live `decisionState` included every decision. `KernelSession.setMission` compared
all those rows, so unrelated changes reached every running kernel. Its random notice
IDs and last comparison lived only in memory. Direct edits, replacements and removals
also queued a separate coordinator wake through `MissionStore.event`.

The implementation keeps the existing `mission.context` IPC and `pilot.activity`
write path. A write adds attributed, model-visible context without creating a generation
or resuming work. No classifier, new worker, provider call, polling, or external send is
needed. Direct decision mutations no longer create a duplicate coordinator wake.
Explicit proposal outcomes keep their existing coordinator notification behavior.

Decision reads, mutation permissions, replacement/withdrawal approval, history, events
and task pins are unchanged. The live comparison is separate from the stable prompt.
As before, explicit retirement removes binding guidance from future prompt construction,
not from historical entries. A successor keeps its own audience and never inherits pins.

## Deterministic routing

The daemon supplies notice-only `decisionRoutes`, not new permissions:

| Current association | Destination |
| --- | --- |
| Audience `all` | Every current member, including members without tasks |
| An open owned task pins the decision | That task's current owner |
| Audience `coordinator` | Current coordinator (plus any explicit task owner pin) |
| Active reference with no open task assigned to a current member that pins it | Coordinator, marked uncertain and requiring routing |
| Reference associated only with another current owner | No worker notice outside that owner |

Reassignment, release, task closure, membership changes and pin changes recompute the
routes. New owners get current guidance in their startup context, or a live selection
notice if already open. A former owner does not receive later unrelated edits. Leaving,
moving missions, retiring the mission, or changing coordinator ownership clears pending
routing from the former scope. Newly selected guidance is context, not a work admission.

This is not semantic conflict detection. Shared safety/scope invariants must be explicitly
marked `all`; task-specific guidance needs pins. Missing associations remain uncertain,
not proof of irrelevance. The coordinator must resolve uncertainty before potentially
conflicting work continues. No text heuristic or model infers permission or scope.
Legacy context producers without routes keep their conservative notice behavior.

## Delivery and recovery

New mission-wide rules, changes to relevant guidance, replacement/withdrawal/removal,
new task selections, and edits to uncertain guidance bypass batching. Routine new
coordinator/reference guidance shares a fixed 30-second deadline from its first update.
Later additions cannot extend it. Sixteen update packets also force delivery. An urgent
update flushes the pending batch. Resolved unknown routing is removed before freezing.

`DecisionInboxDoc` saves the last live comparison and pending batch in the conversation's
Harness store. Before placement, it freezes the request ID, content and timestamp.
Lost placement ACKs retry those exact bytes through submission dedupe, including deferred
question writes. Normal close drains admitted writes and cancels the timer; reopening
restores deadlines, compares current guidance and reconciles offline changes. An offline
worker is never launched just to deliver a notice. Intermediate offline revisions remain
readable through decision/event history, rather than replayed as separate inputs.

On first use, current prompt guidance is the baseline, not a replay of all past changes.
A new/promoted coordinator still gets unassociated active guidance for routing. Pending
questions keep passive writes deferred until the question boundary permits them. Stop,
Pause, queue holds and current admission/permission checks are not released. Receipt
dedupe proves placement or deferral only, never that the worker applied the guidance.

## Verification

Focused tests cover routing, current owners/members, shared invariants, unassociated
guidance, grouped deadlines, the live kernel timer, urgent bypass, replacement and
withdrawal history, scope loss, SQLite reopen, lost placement ACKs and question deferral.
Existing kernel tests cover idle/busy frozen prompts and explicit question/Stop/Pause
boundaries. No live daemon, worker, provider, native UI or rollout was used.
