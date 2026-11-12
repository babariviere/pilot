# Decision notice routing

## What belongs in a decision

The glossary's [Decision, Approval and Human action](../../GLOSSARY.md#agreement-and-human-involvement)
remain distinct. The glossary agreement (D30/D31) defines a decision as a guiding choice;
D38 distinguishes a concrete choice about how to proceed from an interview that clarifies
intent. A submitted human answer can establish that choice. A suggested option, agent
report, proposal or discussion does not establish human agreement.

Record substantive agreed choices about **this mission's scope, behavior or tradeoffs**,
with the human answer/source reference and its limits in the existing decision text.
Do not turn every user utterance into a decision:

| Example | Existing destination |
| --- | --- |
| Agreed native NSH rather than WebViews | Decision: mission scope/architecture choice |
| Save all interview questions before showing the first | Decision when agreed: mission behavior |
| Ship offline reading first and defer editing | Decision when agreed: material delivery tradeoff |
| Explicitly allow checked task pushes, but not releases | Decision: new mission authority policy, with human source and limits; existing permission controls still apply |
| Continue approved daily-driver work alongside Expedition discussion (D67 correction) | Task update or `log` context: routine coordination, not a new choice or grant |
| Checks passed | Task/report: status, not user acceptance |
| I prefer concise replies | Existing preference/memory mechanism only when lasting and appropriate; not a mission decision or permission |
| Could we add editable coordinator instructions? | Discussion/proposal, not agreement or permission to implement storage/UI/injection |
| Approve this one upload | Existing specific approval flow, not a new general mission policy |

Keep useful routine directions in existing task/context records, without duplicate
bookkeeping. Cross-mission memory is not a place for transient status or a substitute
for explicit permission. A personal preference becomes a mission choice only if the
user actually agrees to material mission behavior, not merely because it was mentioned.
Do not discard explicit authority changes as routine coordination. Preserve their human
source, scope and exclusions, while still requiring applicable tool/runtime authorization.

This guidance does not modify old records, including D67. Historical cleanup needs
user-approved proposals with history preserved. Reuse `propose` and user resolution;
withdrawal keeps text, pins and history. `supersede` links an already-authorized
replacement, not permission to silently reclassify or retire past guidance.

## Canonical injection and permission seams

| Seam | Current source and boundary |
| --- | --- |
| Mission conversion | `draftMessage` in [mission-service.ts](../../packages/daemon/src/mission-service.ts) asks the new coordinator to draft scope, substantive choices and tasks from existing conversation. It does not start implementation. |
| Current prompt data | `MissionService.context` selects active `all` decisions, coordinator-audience decisions for the coordinator and decisions pinned to open owned tasks. It sends the complete decision state separately for live notices. `SessionManager.missionChanged` in [sessions.ts](../../packages/daemon/src/sessions.ts) publishes `mission.context` to an existing worker; [worker.ts](../../packages/kernel/src/worker.ts) calls `KernelSession.setMission`. |
| Trusted guidance | `withPilotPolicy` in [policy.ts](../../packages/kernel/src/policy.ts) assembles the Pilot section plus `missionPrompt` from current host context. [mission-tools.ts](../../packages/kernel/src/mission-tools.ts) supplies the detailed decision examples and existing action schemas. There is no text classifier. |
| Stable prompt and deltas | `KernelSession.setMission` in [session.ts](../../packages/kernel/src/session.ts) keeps selected decision prompt text stable for the same mission/role, except explicit retirement, and sends changes through `DecisionInboxDoc`. Startup/role changes take a fresh selection; live additions/edits use notices and explicit `decisions` reads. This is not a fresh full decision snapshot after every compaction. |
| Compaction | [Coordinator memory](coordinator-memory.md) is a derived historical summary. Current prompt/notices/tools remain separate. Summaries and recalled quotes do not create current consent, agreement or permission. No new instruction snapshot/compaction protocol is added here. |
| Mission writes | `MissionService.call` binds the actor to the calling session's membership and limits coordinator actions. `MissionStore.addDecision` uses `assertPlanner` and saves author/time/event attribution in [missions.ts](../../packages/daemon/src/missions.ts). Versioned planning restricts decision writes to coordinator/user; legacy planning retains its existing rules. Attribution records the writer, not proof of a human answer, so guidance asks for the source reference in text. |
| Historical changes | Store edit/remove and `resolveProposal` are user-only. Coordinator `proposeDecision`/`proposeWithdrawal` do not themselves accept changes; `supersedeDecision` keeps original text/history/pins and requires a current coordinator/user. These controls are unchanged. |
| Execution | `withPilotPolicy` calls `executionPermissionBlock` from [tool-policy.ts](../../packages/kernel/src/tool-policy.ts) before tools; `nativeToolPolicy` also checks actual nested native calls. These are backup policy gates, not arbitrary-shell isolation. Mission start admission rechecks current coordinator membership and mission holds via `assertStartActor`; other tool/runtime approval, Stop and admission controls remain authoritative. Writing a decision, task/context note or preference changes none of those permissions. |

Gaps: semantic classification and human-source completeness are guidance, not validated
by the decision schema/store. There is no separate editable coordinator-instructions
record, general preference database or permission ledger introduced by this work.
Conversation/task/log context is not a guaranteed independently refreshed instruction
snapshot. Fresh start/compaction snapshots plus deltas and an editable instruction UI
remain discussion, not implemented contracts. Audience/pin routing is not a complete
semantic applicability or security boundary. See the [prompt review index](skill-prompt-review.md)
for the other dynamic sources and its coverage limits.

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

Guidance-contract fixtures in `policy.test.ts`, `mission-tools.test.ts` and
`mission-service.test.ts` check substantive choices, the D67 coordination pattern,
status, preferences, unagreed proposals, specific approvals, provenance and unchanged
history/permission boundaries. They verify delivered instructions, not that a model
will always classify conversation correctly. No live provider classification was run.

Focused tests cover routing, current owners/members, shared invariants, unassociated
guidance, grouped deadlines, the live kernel timer, urgent bypass, replacement and
withdrawal history, scope loss, SQLite reopen, lost placement ACKs and question deferral.
Existing kernel tests cover idle/busy frozen prompts and explicit question/Stop/Pause
boundaries. No live daemon, worker, provider, native UI or rollout was used.
