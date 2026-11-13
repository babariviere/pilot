# Confirmed mission revisions

Backend contract. Pilot Day's Revisit screens run on mock data only (see [Native UI](#native-ui)).
Nothing here runs a model, changes a live mission, resets a chat, or enables a schedule.

## Reused records and limits

- `MissionStore.writeBrief` appends the canonical brief revision. It does not keep a second spec.
- `updateTask`, assignment CAS and definition revisions keep task identity, completed work,
  dependencies and owner fences. Revision edits support title, body, assignment, dependencies,
  decision pins and explicit drop, not reassignment, starts, model changes or completion.
- `supersedeDecision` and the shared withdrawal writer keep original bodies and historical pins.
  Revision retirements add reason, revision identity and the explicit human-source reference.
  Existing user edit/delete routes are unchanged. No historical cleanup or migration runs.
- Saved interviews already keep exact submitted answers and question digests in
  `mission_interviews`; `history` and `assertNewQuestions` preserve earlier rounds and reject
  repeated questions. Trusted grill-with-docs, Wayfinder, to-spec and to-tickets loaders remain
  unchanged. See [their review trail](skill-prompt-review.md).
- Creation interviews publish an agreement on submit. Canonical `interview-questions` accepts
  `kind: "revisit"`; rounds opened after native plan publication also use that kind. Later
  Revisit rounds stay Revisit rounds and reject repeated submitted questions. Save and submit
  keep exact answers, digests and history without writing the agreement. The submitted
  `agreementMarkdown` is an answer summary, not a publication; `briefRevision` identifies the
  unchanged agreement. Revisit answers cannot bind a workflow/build approval. Existing
  planning-only continuation can consume them under its unchanged independent gates.
  Native plan publication remains creation-only, not an amendment API. No legacy enrollment
  or automatic conversion of old interview records runs.
- The new table stores only reviewed deltas and exact confirmation receipts. Current planning
  still lives in the existing mission, brief, tasks and decisions, not in that table.

Check-ups compare current goal, agreement, active decisions and work (including completed work
to avoid duplicates). Reuse settled answers. Use a new saved interview only for genuine gaps.
Age can justify offering a check-up, never automatic questions, replanning or rewriting. There
is no age threshold, timer or schedule.

## API

Trusted local/user routes, under `/api/missions/:missionId/revisions`:

| Method and suffix | Result |
| --- | --- |
| GET | Current opaque `source`, latest confirmed summary and latest `pending` proposal (or null) with explicit source currentness |
| POST | Save `{operationId, source, summary, delta}` without applying anything |
| GET `/:id` | Exact saved proposal and any confirmation receipt |
| GET `/operations/:operationId` | Exact proposal/preview lookup (or null) after a lost reply, never a resend |
| POST `/:id/preview` | User requests a **new** full preview using `{operationId, source, digest}`; copies only the exact saved summary/delta and links `repreviewOf` |
| POST `/:id/confirm` | Confirm `{digest, humanSource}` for that exact saved proposal |

The coordinator tool exposes `revision-source`, `revision-propose` and `revision` (read by ID).
It has **no confirm action**. Caller-supplied user labels are not accepted through the agent
surface. The local HTTP boundary has the same trust model as existing user-only decision routes;
it is not a new sandbox against unrestricted local shells.

`MissionRevisionDelta` is in `packages/protocol/src/mission-revision.ts`. Only known fields are
accepted, at most 100 entries per collection and 64 KiB per proposal. Text is reviewed already
trimmed, not silently normalized during application. Decisions use replace/withdraw with a
reason, not edit/delete. Instruction and permission corrections are distinct **unapplied
proposals**, even in a confirmed package. Use the existing instruction/permission controls for
any separately approved change. Text or a revision receipt is never runtime authority.

Source binds mission/project/coordinator identity, membership/coordinator event generations,
brief/decision context, task definition revisions, phases, controls and current interview/plan.
It uses canonical task definition counters even on non-shared missions, not shared-replica
entity counters or timestamps alone. Concurrent changes, including ABA edits, require a new
review. Confirmation never substitutes new bytes. Exact operation retries are lookups; changed
bytes conflict. The durable SQLite writer must finish before acknowledgement or API reads.

## Safe application

Application is one SQLite transaction. A live membership or owned open assignment requires an
already **Paused**, durably held mission from the existing Mission Pause checkpoint protocol.
Running, Pausing or Unknown is refused, not treated as a safe boundary. Changing Pause or Stop
invalidates a proposal's source. This is a conservative backend gate, not an automatic pause
or checkpoint adapter.

### Reachable post-Pause preview

The coordinator can prepare and save an inert delta while already allowed to plan. The user
then invokes existing Mission Pause and waits for its durable Paused result. No coordinator
turn runs while held. The user can explicitly request `/:id/preview` using the saved proposal's
exact digest and the **new post-Pause source**. This creates a new immutable proposal with a
different ID/digest, without confirming anything or changing/renewing the old proposal.

The client must display a full comparison against the current mission, including any changes
since the old proposal, and require a fresh explicit confirmation of the **new** ID/digest.
This is not approval carried across a source mismatch, an automatic rebase, or proof the old
proposal still fits. If any referenced task has finished or decision has retired, normal
validation refuses instead of substituting content. Any subsequent edit/Stop/Pause stales the
new preview too. Exact operation retries return their original receipt; Unknown is lookup-only.
An already confirmed revision cannot seed a fresh preview. Confirmation keeps all holds.

Application does not cancel jobs, drop effects/drafts, clear user holds or Stop generations,
resume workers, retry Unknown starts or change queued policy authority. Task/assignment and
agreement/decision changes invalidate the existing report, allocation, approval and queued-start
source fences. Resume is a separate explicit lifecycle operation with its existing checks.
No worker status is inferred from its report. No completed/dropped task can be edited here.

## Current-only context and recovery

`MissionService.context` and `MissionStore.memberContext` remain the canonical assembler.
Coordinators receive the current brief, active decisions, up to 100 open task summaries (with
the full count), and the latest confirmed revision's short summary. They do not receive old
briefs/plans or retired decision bodies. Worker audience/pin routing is unchanged. Retired
comparison state carries hashes and links, not bodies. Coordinator system prompts refresh on
same-role changes; worker prompt caching keeps its existing selection and retirement behavior.

Default `mission decisions` reads active guidance missing from the prompt. `filter: "all"`
explicitly reads exact history; retired entries are labeled historical/nonbinding. Explicit old
brief reads and task-pinned retired decisions also carry that label. Replacement chains and
reasons remain available. Reads grant no authority and do not re-pin tasks.

`decisionNotice` omits retired/deleted bodies. `DecisionInbox.observe` runs on startup and live
changes, strips older pending batches, and quarantines exact frozen/queued/question-deferred
notices whose bodies became historical. It never rewrites an uncertain placement ID/bytes or
replays those bodies. Quarantine appends exact original records as historical entries with no
model contribution, not an ever-growing loaded context document. Unchanged current lost-ACK
notices still deduplicate with their original ID.
Question/Pause/Stop holds remain intact. No quarantine record is model context.

**Filtering cannot erase an already loaded transcript.** Earlier placed notices, tool results
and prior plans remain historical text. After a revision, re-read current agreement and tasks
before work. For a genuinely fresh context, use an explicitly requested existing checkpoint/
continuation flow after its safe boundary, carrying only current agreement, references to
history, kept drafts and uncertain effects. Do not reset automatically, recreate a lost tool
stack, replay effects, bypass opt-in compaction or claim that resume discarded old context.
This implementation does not initiate that lifecycle flow.

## Native UI

Day's planning page (`apps/day/RevisitDoc.tsx`) shows the agreement now, a Revisit interview
round (`RoundKind::Revisit`, the existing saved interview UI), and a full preview of one
revision: goal and agreement text, every open task (stays, changes or drops), finished tasks
kept, decision replacements and withdrawals with reasons, and unapplied instruction or
permission corrections. Confirmation is two presses and names the revision ID and digest shown.
Stale, unpaused and lost-answer cases refuse or stay Unknown; Check only reads.
`plan.rs` mirrors the delta above; the mock rules are in `plan_revisit.rs` and
`native/tests/revisit.rs`.

The connected host does not bind these routes yet and shows Revisit as unavailable. Connecting
the complete journey still needs:

- **Discovery binding.** GET `/revisions` now exposes the latest pending proposal after the
  last confirmation, including explicit currentness. Day still needs to bind that read.
- **User request.** No route lets the user ask the coordinator for a check-up.
- **Round binding.** Canonical inert Revisit rounds and the existing native interview mapper
  are ready; the connected check-up producer still needs to open them through the trusted
  planner. There is no legacy enrollment adapter.
- **Preview binding.** The post-Pause user re-preview route makes a confirmable proposal
  reachable without running a held coordinator. Day still needs to journal that new explicit
  intent, display the complete fresh comparison and bind its exact confirmation/lookup.

The remaining request seam is not a generic send: `SessionManager.canSendNotice` explicitly
excludes trusted planning sessions. A proposed extension would admit one explicitly requested
planning-only check-up through `admitPlanning` only for an active, unheld published coordinator,
with retained exact operation identity and lookup-only recovery. It would also expose inert
revision output on that trusted planner's tool surface. It must not release interview holds,
clear Stop/user holds, approve/start build work or use ordinary Build input as a fallback.
That admission extension is not implemented here; already-held coordinators remain unavailable.

A future host adapter must read `/revisions`, the pending proposal and `/api/missions/:id`
(for current text), recheck the exact source, confirm with a fixed `humanSource`, and settle
lost replies only through exact proposal/operation lookup.

## Verification

`mission-revisions.test.ts` covers inert proposals, exact confirmation, preserved completed
tasks, replacement/withdrawal provenance, concurrent edits, ownership ABA, Stop/Pause source
changes, safe-boundary refusal, assignment/report invalidation and durable reopen/receipt lookup.
`mission-service.test.ts` covers the HTTP boundary. Kernel decision/inbox/tool tests cover
current-only prompts, explicit history, live same-role coordinator refresh and queued/frozen/
question-deferred retirement, without real providers. Existing planning, reports, continuation,
pause and mission suites cover unchanged ownership and lifecycle gates.
Focused Revisit cases also cover post-Pause re-preview identities, stale discovery, subsequent
Stop/completed-task refusal, inert canonical/native submissions and exact history/receipt reopen.
`native/tests/plan_host.rs::revisit_round_uses_saved_interview_without_publishing_agreement`
exercises that existing bridge seam in an isolated daemon, not connected Revisit acceptance.

Local checkpoint evidence (2026-11-13): eight narrowly selected Node tests passed on
`41b59b2b`, plus scoped Biome/rustfmt checks. After reconciliation onto `81cd801e`, the single
named native bridge test could not compile: upstream `57820b54` updated Day's SHA-2/base64
requirements without updating its tracked Cargo lock. The supported MBX invocation with
`--locked` refused before compilation; no lock/cache bypass or dependency rollback ran.
That native regression and the new-head dependency updates remain unverified. Broader suites
stay in CI. This is independently safe backend groundwork, not complete connected Revisit.
