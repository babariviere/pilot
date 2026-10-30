# Proposed cost-aware coordinator wakes and stall recovery

**Docs-only proposal, not adopted scheduling or implemented guarantees.** The coordinator owns
planning and adoption. This document changes no runtime, schema, transport, tools, provider calls,
worker starts, `ask_user`, roles, UI, live mission, migration, cleanup, release or restart behavior.
Timing and caps below are recommendations for later validation, not service-level promises.

## Approved requirements and boundaries

- Avoid frequent no-op coordinator model turns, reliably notice finished work and prevent silent
  stalls. Cheap host observation is not a model turn. Observe state changes without asking a model
  whether anything changed; invoke it only when there is a current decision or bounded action.
- Coordinator planning/acceptance remains separate from worker reporting, host observation and
  execution. A completion wake asks for assessment, not automatic acceptance, merge or retirement.
- Reuse the [interview/approval proposal](mission-interview-approval.md) (#2) and
  [authority/review proposal](mission-authority-review-policy.md) (#5). Their detailed approval,
  applicability and enforcement mechanisms remain unadopted. Balanced tiers, force OFF and mandatory
  checks remain the approved design defaults, not grants supplied by a wake.
- The [escalation/Stop/custody proposal](mission-escalation-handoff.md) (#6) is an input, not adopted
  policy. Keep current `ask_user` until a dependable replacement is implemented and validated.
  Its suggested retry limit, request transport, response consumption, human custody and hand-back
  are not activated here. Unknown write quiescence still blocks unsafe concurrent human editing.
- Preserve explicit user questions, held input, Stop, usage-pause/Force work and safe drainage.
  Never impersonate a user, manufacture an answer, expand authority or automatically resume work
  explicitly stopped/paused. New missions first; existing missions require preview and explicit opt-in.

The smallest proposed addition is a durable explanation of **why the current coordinator needs to
act**, linked to existing facts, plus **what it is waiting for after a turn**. This is not a general
orchestrator, research-budget system, model polling loop or autonomous replacement-coordinator service.

## Current implementation and limits

These are source-inspection anchors, not evidence that the proposed lifecycle already exists.

| Existing foundation | Actual behavior | Limit or gap |
| --- | --- | --- |
| [Mission/member events and notice store](../packages/daemon/src/missions.ts): `event`, `recordMemberRun`, `recordMemberCompletion` | Events retain IDs, actor/task references and times. Completion high-water marks/signatures suppress repeated successful/stopped snapshots; distinct failures can be counted. Recovery baselines outcomes predating membership. Task changes and actionable comments can queue notices; informational/ACK comments and routine shared progress do not wake | A member's done outcome is not verified task delivery. Events do not universally contain immutable task/context revisions. A live `ask_user` need not end the run; completion recording also rejects sessions with running jobs. Do not assume all pending questions are completion events |
| Same store: `noticeDeadlines`, `prepareNotice`, `acknowledgeNotice` | Durable pending events/group summaries; latest summary per group; frozen payload/cutoff and `mission-notice:<lastEventId>` identity. Payload includes at most 100 groups plus overflow. ACK removes pending events through the cutoff, retaining later events | No reason-specific processing/disposition receipt. Overflow is a pointer, not proof every group was read. Old failures superseded by finish are summarized, not an independent unresolved-reason ledger |
| [Mission notices](../packages/daemon/src/mission-notices.ts) and [dispatcher](../packages/daemon/src/notice-dispatcher.ts) | One event-driven timer, serial delivery, durability wait before send, current-role/active/passive checks, idle-only coordinator admission. Member jobs/starting/working and remote occupancy influence batch timing. Routine debounce 30 seconds, oldest-event safety valve 30 minutes, rolling cap 20/hour | Another busy member can delay a settled completion until the safety valve. Latest urgent question/failure can be immediately due even with members busy; settled done is immediate when all are idle. The urgent branch bypasses the ordinary hourly-cap calculation. These are notice-placement rules, not model-cost or processing guarantees |
| [Session admission/outbox/recovery](../packages/daemon/src/sessions.ts): `canSendNotice`, `sendNotice`, `start`, `scheduleKernelRestart` | Save input before IPC; preserve exact pending identity; recheck authoritative notice eligibility after asynchronous persistence. Busy/failed/archived/paused/recovering sessions have admission constraints. Existing backoff and confirmed worker exit govern kernel recovery | Send/notice success is placement, not triage, action or progress. Recovery reopens durable work, not arbitrary tool code. No post-turn disposition or durable end-to-end reason-consumption contract exists |
| Same session projection and [kernel question tool](../packages/kernel/src/question-tool.ts) | Live awaited-question signal can show Needs you while the run remains active. Ended question outcomes and background jobs have distinct projections | Live awaited-question signal is presentation-only and cleared with the worker. Neither a busy label nor last message time establishes abandonment or durable user-wait identity |
| [Held-input journal](../packages/kernel/src/held-inputs-doc.ts), [admission/question boundaries](../packages/kernel/src/held-inputs.ts), [kernel session](../packages/kernel/src/session.ts) | Persist stopped/paused state, question hold, call-bound committed answers, held inputs and monotonic queue controls. Automatic inputs cannot answer a pending question. Stop parks automatic input, clears the live unanswered blocking gate and aborts the run; accepted reply context is restored after tool results | Interrupted questions can survive as next-turn questions, not a restored JS stack. This is not #6's coordinator request protocol. A retained question or automatic notice cannot release Stop or prove a new answer/approval |
| [Recovery stops](../packages/daemon/src/recovery-stops.ts) and [child cancellation journal](../packages/kernel/src/stop-recovery.ts) | Explicit recovery cancellation can journal child stops without model/credential startup. Stop is not dependent on resolving a coordinator question | Stop ACK/job cancellation is not workspace-wide descendant join or edit custody. Existing general shell/jobs isolation is unchanged |
| [Subscription policy](../packages/daemon/src/subscription-policy.ts), [native admission](../packages/kernel/src/native-adapter.ts), [limit recovery](../packages/kernel/src/subscription-limit.ts) | Pause at reported 99%; reset or fresh valid lower readings can release usage hold. Unknown/stale/error readings cannot thaw a known hold. Force work is provider-scoped. Tools already executing drain before the display becomes paused; model/tool admission respects the gate | A wake must not fetch provider usage to poll readiness, select another model, enable Force or replay native tools. A usage reset is not explicit post-Stop resume |
| [Tool stall observer](../packages/daemon/src/tool-stalls.ts) and [long-job observer](../packages/daemon/src/long-jobs.ts) | Cheap deadline-driven suspected-stall/long-job attention, not coordinator turns. Tool classifier distinguishes pause/user/child/background waits; stale liveness 60 seconds, delayed cancellation 30 seconds; category no-progress thresholds 5 to 60 minutes. Long jobs get live-only attention at one hour | Suspicion is not proof of deadlock, abandonment or safe termination. Snapshots are bounded/live, not durable mission disposition. Long-job attention explicitly does not create a coordinator notice |

[Notice tests](../packages/daemon/src/mission-notices.test.ts) cover frozen-ID restart recovery,
high-water marks, busy-member settlement, the 30-minute valve, cap boundaries and overflow.
They do **not** prove the future reason/disposition/watchdog contract. In particular, a generic
`mission get`, opening activity or a successful send is not proof that a coordinator processed it.

## Proposed minimal durable reason lifecycle

Reuse existing mission/task/request/event identities and store durability patterns. The following are
semantic obligations, not a selected schema/API or cross-store transaction. Keep authoritative facts
in their existing records; reasons reference them rather than duplicating full histories.

### Identity and currentness

One logical reason binds mission/project, kind, exact source event(s)/record and revision, original
actor session plus conversation/attempt when available, subject task ID(s), actual owner, assignment
revision/content and existing `sharedDefinitionRevision` (exposed as `definitionRevision` in evidence
contracts). Record the current coordinator destination and routing revision separately from the
origin. Include relevant request/submission/job/run IDs, dependency-edge/prerequisite revisions and
the context/policy/brief fence needed for the proposed action. Unknown attribution remains explicit;
a title, text match, timestamp or display task number cannot substitute for identity.

Host-generated reasons identify their host-observed transition; they do not relabel a worker or
user as its author. User input references the exact admitted user submission and actual origin,
not a new synthetic user message. Existing events that lack sufficient revision snapshots require
current-state reconciliation and an explicit limitation, never invented historical task-at-operation
proof. #22's separate contribution-attribution choice is not settled here.

Deduplicate by source transition plus subject/fence, not text or the latest activity cursor alone.
Link related completion/dependency/question reasons for one triage, but retain distinct scopes and
results. Status changes can advance the definition fence: capture after the correlated transition,
or atomically validate that transition, as #6 proposes. Never disable owner/definition checks to
avoid self-invalidation; owner A → B → A must not resurrect an old reason's authority.

### Stages that must remain separate

| Stage | Proposed durable meaning | Does not establish |
| --- | --- | --- |
| Recorded/open | Exact actionable transition and source references survive before requesting attention | Eligibility now, delivery or authority |
| Eligibility | Host observes a still-current reason, a useful coordinator decision, and admission/control availability. Deferred reasons retain the named hold and next trigger | A busy member preventing an unrelated decision; permission to override coordinator Stop or user wait |
| Placement | Exact batch manifest identifies reason IDs/revisions, destination, stable operation identity and durable recipient placement/result | Model read/consumption, response, successful action or progress |
| Consumption | Coordinator turn/attempt explicitly records each exact reason revision assessed, with handled, waiting, needs-user or rejected-stale rationale | Obedience, successful effects, user approval, task acceptance or reason resolution |
| Action | Record a bounded decision/attempt and its exact authoritative result, failure or Unknown outcome separately | Completion simply because a message was sent or an action was intended |
| Progress/resolution | Observed source transition or durable disposition settles this reason's requested decision, or names its next trigger. Terminal reasons are resolved, withdrawn or superseded with references | Task done, integration, retirement, process quiescence or deletion eligibility |

Consumption is a receipt, not a deletion. A consumed blocker awaiting the user remains unresolved,
but becomes ineligible for repeated turns until its named trigger changes. A handled completion may
resolve the triage reason while the task remains awaiting checks/review. A read/ACK, an unchanged
waiting disposition or the coordinator's own receipt mutation never creates a new wake reason.

Freeze a bounded batch manifest before placement; preserve later arrivals separately. A turn may
consume reasons added while it runs only by explicitly naming their exact current revisions. Never
clear all events through a cursor as proof of processing. Unread overflow remains pending, not
consumed. Record per-reason outcomes and the post-turn disposition together, or journal their
relationship with recoverable failure windows and await explicit durability before acknowledging.
The existing notice cutoff/ACK alone is insufficient; no atomic cross-store boundary is assumed.

### Eligibility and reconciliation by reason

| Reason | When a model turn is useful | Host reconciliation/deduplication |
| --- | --- | --- |
| Actionable completion/submission | Current work/evidence needs assessment, acceptance routing or a dependent-work decision | Bind exact submission/outcome and task fences. Do not wake for already accepted unchanged work, historical attach/recovery baseline or a duplicate completion ACK. Do not equate done prose with verified delivery |
| Question/blocker | New unresolved question, material evidence change or a requested decision within coordinator triage scope | Reference #6 request/revision when available, otherwise current supported record with its limits. Same unresolved question is one reason, not one per read, reminder or worker retry |
| Newly unblocked dependency | A named prerequisite-set transition makes an unfinished assignment potentially admissible and a planning/start decision is needed | Compare exact edges and current prerequisite states; only false → true readiness, not every done report. Dropped is not silently successful. Reopening a prerequisite invalidates readiness. Readiness never starts work itself |
| Failed/abandoned work | Explicit failure or confirmed absence of runnable work on unfinished responsibility has no legitimate named wait; coordinator can repair the plan, reassign or request help | Retain exact attempt/exit/failure IDs and current owner. Aggregate identical repeated failure without new evidence into the same episode. Silence, long duration, stale heartbeat or disconnected UI alone cannot prove abandonment |
| Explicit user input | Existing admitted user message/reply asks for a decision or continues work under its actual control semantics | Attach current pending reasons to the existing user turn without minting another turn/message. Receipt of input is not approval of #2's package or automatic release of every pause |

On each source change, before placement, consumption and action, recheck current membership,
coordinator, task/owner/assignment/definition/context and controls. A stale completion may be superseded
by new work; a stale question may still represent an unanswered problem under a new owner. Mark the
old revision historical/rejected-stale and either link a current successor or retain a reconciliation
blocker with its unknowns. Never delete an actionable problem just because its event is old, an actor
left, a summary changed or a delivery ACK exists. Conversely, do not carry an old answer/permission
into the successor. A source already authoritatively resolved needs no model turn; record why.

Event subscription plus bounded restart/source reconciliation must cover gaps between a source
commit and reason creation. Persist the observation checkpoint only with durable reason updates;
recover from source records as well as events. If the source cannot prove resolution/currentness,
retain waiting/Unknown and attention, not a guessed successful transition. This is a required future
failure-window contract, not an existing event-log completeness guarantee.

## Recommended placement, coalescing and cost bounds

**All values in this section are unadopted defaults.** Count automatic model-turn starts, including
continuations, not cheap checks, reads, tokens or dollars. Reuse the existing timer/store concepts;
do not add a second generic scheduling plane.
Here a start means one admitted coordinator run/wake, not every provider request within that run.
This bounds wake frequency, not a run's token cost or the duration of legitimate tool work.

| Control | Recommended default | Cost versus latency rationale |
| --- | --- | --- |
| Ordinary completion/readiness debounce | 15 seconds quiet, hard maximum 60 seconds from oldest eligible reason | Coalesce nearby finishes without waiting for the whole mission. Continuous arrivals cannot reset the oldest deadline |
| Blocking question/new failure | 2 seconds coalescing, maximum 5 seconds before placement is due | Small bursts combine; a worker needing a decision should not wait 30 minutes. No preemption of active tools or admission controls |
| Concurrent placement | At most one automatic batch/turn reservation per coordinator; while busy only update durable pending references | No competing coordinator turns or per-event steer messages. An active turn can read pending reasons at a safe boundary, otherwise the next idle turn receives them |
| Automatic start cap | Rolling 20 starts/hour per mission, including continuations; 16 ordinary slots and 4 reserved for blockers/failures/aged reasons | Reuses a familiar ceiling but explicitly includes urgency. Current urgent-notice bypass is not carried forward. The cap is a safety ceiling, not a target cadence or a research budget |
| Inter-start spacing | 30 seconds for ordinary automatic starts; urgent reasons may use the 5-second path, still within the hard cap | Prevent rapid self-induced completion/readiness chains; urgency does not mean unlimited calls |
| Fairness | Within priority, oldest eligible first; ordinary reason waiting 5 eligible minutes may use reserved capacity; reserve one reference slot for the oldest lower-priority reason in every mixed batch | New urgent traffic must not indefinitely hide useful completions. At exhausted hard cap, retain reasons and expose one capacity-wait attention item, not an exception loop |
| Payload | At most 50 compact reason references per batch, paged current details; overflow retains explicit pending IDs/count and oldest age | Bound prompt cost without resolving unseen work. Follow-up is bounded continuation, not one turn per overflow record |
| Continuation circuit breaker | At most one automatic continuation for the same unchanged reason-set/disposition episode, within the same cap | Allows an interrupted triage/finite remaining step, not repeated “continue” turns. Further unchanged work becomes attention until a material source transition or explicit user action |

Priority: existing explicit user input/Stop controls use their own admission path and are not throttled
by this automatic cap. Stop is control, never a model wake. For automatic work: questions/blockers and
failed/abandoned responsibility first, then actionable completion/dependency readiness, oldest within
class with the fairness rule above. Severity labels alone do not create authority or reserve capacity
for unrelated chatter. Host ordering must use stable reason IDs as a tie-breaker.

Aged reasons compete with urgent reasons using their original eligible timestamp, not promotion
time. The 16 ordinary starts are a maximum within the total 20; urgent starts may use remaining
capacity, never exceed 20. Reserve capacity durably before automatic admission; uncertain starts
retain their reservation until exact reconciliation. Release capacity only on a proven not-started
result, not an ACK timeout. Do not count a retry of the same exact placement as a new start or free
its old reservation to hide uncertainty. The actual reservation/start boundary needs validation.

The debounce maximum means **due for consideration**, not guaranteed processing time. Busy coordinator,
explicit user wait, Stop/pause, usage gate, unavailable transport or exhausted cap can defer it.
Track first-seen age and eligible-wait age separately; pauses do not erase the former. Cap state and
continuation allowance survive restart, so restart cannot buy another turn. Recompute rolling-window
release from retained starts, not a timer that wakes a model every few minutes.

Another busy member is **not a mission-wide veto**. Evaluate the completion's own settlement and
scope: if A is ready for useful assessment while B runs a long tool, wake the idle coordinator for A
after coalescing. If A's own writing job/follow-up is still active, treat its completion claim as
unsettled unless an explicit bounded assessment is useful now. Do not declare A finished from idle
presentation or erase B's work. No all-members-idle barrier or arbitrary 30-minute fallback is needed
for a current actionable reason under this recommendation.

Placement is idle-only by default. Arrivals during a coordinator turn are durable pending reasons,
not a request to interrupt, launch another turn or consume all pending input. At turn end, reconcile
what that turn explicitly assessed and its disposition; coalesce the rest into the next eligible
batch. If an already admitted explicit user turn can do the work, attach references there and cancel
only a demonstrably unplaced redundant reservation. Unknown placement cannot be treated as cancelled.

## Proposed durable post-turn disposition

Record one disposition for the exact coordinator conversation/attempt/turn with a monotonic revision,
the assessed reason revisions, remaining reason IDs, host-observed result references and current
control/context fence. Host facts override optimistic prose: an active tool remains active, an
unanswered `ask_user` stays pending, Unknown remains Unknown. An absent disposition after an exit is
an observation gap for the watchdog, never implicit done or permission to replay the turn.

| Disposition | Required detail | Permitted next trigger |
| --- | --- | --- |
| Continuing | Named finite remaining decision/action and reasons it serves; current authority and whether an existing live run/tool owns continuation | Existing run/tool completion, or one explicitly recorded automatic continuation when idle and admitted. “Keep working” alone is invalid |
| Waiting | Exact named external predicate/record IDs and observed revisions, such as request response, review/check result or dependency transition; why no useful action exists now | Predicate changes or a new unrelated actionable reason. An expected check time schedules host inspection only, not a model keepalive |
| Needs user | Exact pending question/request and missing human decision/action, affected scope and existing reply path | Actual explicit user reply/action or authorized withdrawal. Never expiry, model-generated answer, ordinary notice or Inbox read |
| Paused | Stop/input-pause/usage/sleep/update/connectivity/custody cause, control revision and permitted release source | Explicit current resume for explicit Stop/pause/custody; existing host gate release for transient holds only. Clear all other holds before admission |
| Done | No remaining coordinator action for this accepted scope; exact acceptance/outcome references and known unresolved exclusions | New admitted work or material change only. This is not automatic mission closure, worker archive or workspace deletion |

Waiting is not a global veto on unrelated action, but a pending **explicit user question** is a real
input gate. Recommend retaining new worker questions/completions until that user reply or authorized
withdrawal; show a single linked urgent-attention update if delay matters, without starting a parallel
model turn or rewriting the user's question. Supporting independent coordinator work during a live
user wait would need separate validated semantics; this proposal does not assume it.

For non-user external waits, name the responsible actor/source, observation coverage and next cheap
inspection deadline (recommend five minutes if no better expected time is known). A missed expected
trigger prompts one source reconciliation: still legitimately pending means waiting, a changed
actionable result becomes a reason, unavailable observation becomes a retained observation blocker
and latched attention. Never claim an unsupported check/review observer exists or schedule a model
turn just to ask whether the external work finished. User-answer waits have no automatic expiry;
live tool/job waits use the existing diagnostics instead of this five-minute inspection default.

Consumption/continuation must close the failure window: either a named source action succeeds,
the reason gets a durable wait/needs-user/pause/resolution, or a bounded continuing obligation
remains. A model saying it will act, a message send, new token output or a fresh read is not domain
progress. Genuine progress is a referenced decision/result or a changed authoritative predicate.
Progress can advance watchdog evidence without granting acceptance or resetting unchanged-reason
continuation allowance. Do not turn every progress update into a model wake.
Episode identity follows the unresolved obligation, not batch membership: splitting a batch, adding
an unrelated reason, changing coordinator prose or receiving a duplicate event cannot reset an old
reason's allowance. Only a material authoritative transition relevant to that obligation, or explicit
user continuation, can justify a fresh episode; it still consumes the same rolling automatic cap.

## Cheap host watchdog and unavailable-coordinator fallback

Use existing session/member/task/job/question/pause projections, reason receipts and disposition,
with one nearest-deadline host timer. Reconcile on relevant events, turn end, admission change and
startup/reconnect. UI disconnection alone is irrelevant if the daemon/coordinator is still running.
An unavailable daemon cannot observe or deliver anything; recovery must say how long observation
was absent, not claim an offline SLA.

Recommended bounds, also **unadopted**:

1. Inspect only affected/pending missions plus a bounded startup reconciliation. Process at most
   100 reason/source references per chunk and yield; keep a durable checkpoint/backlog and mark
   observation incomplete rather than scanning histories synchronously. A 60-second safety sweep
   may reconcile pending/dirty missions in such chunks, with at most one sweep in flight. No provider
   calls, new kernels, remote fanout, shell probes or model turns for observation. Unchanged named
   waits need no repeated timer; overdue states become latched attention, not one alert per sweep.
2. After a declared continuing obligation has had **60 eligible seconds** with no run, queued
   admission, tool/job/child or named wait, inspect exact placement/operation state once. Likewise
   inspect placed-but-unconsumed idle work after 60 eligible seconds. If a retained unplaced reason
   can use normal supported admission, schedule that same reason, not a new “are you there?” prompt.
   Do not duplicate an uncertain placement. At five eligible minutes unresolved, latch one
   attention item with the missing receipt/disposition and exact remaining action.
3. Reuse existing tool-stall categories and one-hour long-job attention rather than imposing a short
   mission timeout. Known live long tools, child/background work and explicit user waits are not
   abandonment. A suspected worker-tool stall can produce one reason for its healthy, available
   mission coordinator to decide a bounded remedy; a stuck coordinator cannot fix itself via a
   competing turn. With missing diagnostics, say liveness/progress unknown. Do not kill, retry tools
   or transfer custody.
4. Distinguish a true planning stall: unfinished responsibility, confirmed no active/admitted work,
   no named legitimate trigger/control hold, and missing/unfulfilled continuing obligation. First
   reconcile sources; then allow **one reason-bound recovery assessment** if the coordinator is
   healthy, idle and authorized, counted under the cap and continuation allowance. It must choose
   an action or a named disposition. If the same episode returns unchanged, latch attention, not
   a sequence of recovery turns. Elapsed time alone never proves work was abandoned.
5. If an eligible reason is delayed five minutes by busy admission/cap/transport, retain it and
   expose one diagnostic waiting item, not a human-required decision by default. Upgrade to an
   actionable user-help item only when intervention is actually needed. For a definitely missing,
   failed or archived coordinator, latch unavailable attention immediately; for unknown transport
   availability, use the five-minute bound after cheap reconciliation. These are observation
   targets while the host runs, not promised delivery or response times.

Attention is data, not a second wake loop. Deduplicate by mission/coordinator tenure, reason episode
and failure/control revision; update the existing item with material evidence. Reading/dismissing an
item does not settle its underlying reason, reset the circuit breaker or schedule another turn.
No periodic reminders, model keepalives, silent timeout approvals or automatic “needs user” questions
are generated. If attention delivery itself is unsupported, retain the blocker and report that gap.

Fallback preserves task ownership, evidence/partial work, pending questions/replies, held input,
unknown effects and reason/disposition history. Existing explicit recovery may be offered; an
authorized user/planner can choose recovery, replacement, pause or later handling. Do not auto-unarchive,
promote a worker, start another coordinator, change models, release human custody, mark tasks done or
clean workspaces. On an authorized coordinator replacement, revalidate the same unresolved reasons,
retain original actors and old consumption history, and bind new placement to the new tenure. An
old coordinator's receipt cannot consume work for the replacement or grant new authority.

## Stop, usage holds and uncertain operations

Stop remains reachable independently of question waits, queues, model credentials, usage holds and
watchdog admission. No answer/reason lock may be held while awaiting a model/user/transport. Store
new observations while stopped, but never let them release held input, restart work or reinterpret
Stop as done. An explicit pause/Stop dominates a transient hold release and stale continuation.
Preserve #6's distinction between stopping a run, retaining the question, cancelling a request and
verifying write quiescence. None substitutes for the others.

During a usage pause, keep reasons and named dispositions; let already executing tool/codemode work
drain safely under existing policy. No watchdog action can bypass the next-admission gate, toggle
Force, switch providers or abandon an active tool. A trusted existing reset/fresh-reading/explicit
Force event can make usage-held work eligible under existing semantics, but cannot release a separate
user Stop/pause or answer a question. Usage failure/unknown reset means waiting, not model polling.

Every proposed state/placement/consume/disposition/action operation needs stable exact identity,
payload, actor, destination, expected revision and committed result. Reuse validated exact-operation
lookup/idempotent retry patterns only where actually supported. Lost ACK remains **Unknown**, even
if a generic GET shows a plausible task status or matching text. Lookup absence is definitive only
with committed/pending coverage. Do not replay arbitrary JS, commands, one-shot `mission send` or
comments under a new ID. A failed exact lookup leaves uncertainty/attention, not permission to retry
the effect. Placement deduplication cannot promise exactly-once model execution or side effects.

On crash/restart, restore controls, pending questions/accepted replies, held queues, source/reason
checkpoints, exact-operation uncertainty, placements, consumption/dispositions and cap/continuation
state before admitting new automatic work. Reconcile with current source and existing kernel recovery;
do not restore a JS stack, rerun native tools or replay historical notices as instructions. Recovery
of a historical receipt proves that operation only, not fresh authority, current acceptance or safe
custody. Jobs/subprocess survival and child recovery retain their existing limits.

## Timelines and decision table

The times below assume the recommended defaults, healthy host and open admission. They illustrate
future acceptance scenarios, not tests run or guaranteed model latency.

| Timeline/case | Cheap host work | Useful model turn? | Durable state and deduplication |
| --- | --- | --- | --- |
| Single completion, t=0 | Record A's exact current submission/outcome; recheck own settlement and coordinator gates; due after 15 seconds quiet | Yes, if assessment/acceptance routing remains; no if already authoritatively handled | One reason and manifest entry for A's revision; ACK/read alone cannot resolve |
| Burst A t=0, B t=8s, C t=20s | Merge reference set; quiet deadline t=35s, never beyond oldest t=60s | One assessment turn, not three; overflow stays pending | Separate per-task/fence results under one batch identity; later arrivals survive cutoff |
| A completes, B still busy for 40 minutes | Inspect A independently; observe B's tool/job without a mission-wide idle barrier | Yes for settled A at normal deadline, even while B works | A reason placed once; B remains active and cannot be accepted/retired by implication |
| Worker question during coordinator turn | Persist exact request/revision; mark urgent due; no parallel turn or automatic steer | Existing turn may assess at safe boundary; otherwise next eligible idle turn | Consumption names exact request revision; unassessed arrivals retain their pending reason |
| Worker question during coordinator user wait | Retain worker reason and existing user-question identity; link delay/urgent attention if needed | No synthetic reply/parallel turn; actual user reply can carry both contexts | Needs-user/held-input state survives; no repeated wake per wait/read/attention ACK |
| Unchanged progress, repeated snapshot/ACK/read | Compare event/source identity and named predicate; update only warranted observations | No | Same reason/disposition/first-seen time, no renewed debounce, continuation allowance or attention episode |
| True planning stall after turn | At 60 eligible seconds reconcile missing live/admitted work, disposition and exact operations | One bounded recovery assessment only if healthy/idle/authorized; otherwise attention | Reason tied to exact unfinished obligation/episode; unchanged recovery latches, never repeats |
| Long tool or stale liveness | Reuse category diagnostics, known wait kind and live job/child state | No self-wake into busy coordinator; one available-coordinator triage only for an actionable suspected worker stall | Suspected/unknown, not abandoned; reference tool/run/diagnostic revision and latch once |
| Stale event after reassignment or source change | Reconcile owner/assignment/definition/context and authoritative current problem | Only if successor still needs a decision; none for already resolved source | Old revision historical; link successor/reconciliation blocker without applying old permission or losing unresolved work |
| Dependency A accepted/done, then reopened | Evaluate current prerequisite set/edges, not just A's notice | Yes once for newly ready B; no automatic start; withdraw readiness if A reopens before action | Bind B plus prerequisite revisions; supersede false readiness, never revive by text/owner ABA |
| Explicit input arrives while batch pending | Use existing admitted user submission; reconcile whether automatic reservation is certainly unplaced | Existing user turn is useful; no duplicate automatic turn | Preserve origin/submission ID and exact attached reasons; uncertain placement stays Unknown |
| Stop or explicit pause races with completion | Record source/reason, prioritize control fence and hold automatic input | No until explicit authorized continuation; Stop needs no model | Paused cause/revision dominates old continuation; late answer/ACK does not release hold |
| Usage reaches 99% during tool | Observe gate, drain executing nested calls, retain due reasons; wait for existing policy release | No admission while held; useful reason may run after release if no other hold | Same reason, paused cause and cap history survive; no provider polling/Force/model switch |
| Cap exhausted or sustained burst | Persist pending references, age/fairness and next capacity deadline; latch capacity-wait diagnostic if overdue | Only at next allowed slot; oldest eligible/aged reason included | Hard cap includes urgency/continuations; no dropping or new episode from timer/read/dismiss |
| Crash after placement or consume, before ACK | Restore controls/journals; reconcile exact operation and source; recompute deadlines, no blind resend | Only retained unprocessed current reason with supported admission; Unknown blocks duplication | Same reason/operation/manifest and cap history; no JS/command/one-shot-message replay |
| Restart during waiting or explicit Stop | Recover named predicate/question/reply/hold before automatic admission | No for unchanged wait; never automatically for explicit Stop | Waiting/paused remains; restart does not reset episode, authorize work or erase accepted replies |
| Failed, missing or archived coordinator | Confirm available facts; retain blocked work and one unavailable item; offer authorized recovery/replacement route | No automated fallback model/start or worker self-promotion | Reasons retain original actors/current subject fences; new authorized tenure gets revalidated placement, not old authority |

## Reuse, gaps and remaining choices

**Reuse:** mission events/membership/task revisions, durable store boundary and frozen notice identity,
session outbox/authoritative admission, held-input/question controls, subscription gates, existing
tool/job diagnostics and kernel recovery. Prefer event-driven updates and retained references over
new reports, full history scans or model heartbeats. Workers supply only problem/evidence/desired
action; host captures available identity and observation metadata.

**Required gaps before any claimed guarantee:** durable reason/source-reconciliation and revision
capture; exact placement/consumption/disposition/action boundaries and operation recovery; pending
user-wait/control projection usable at admission; durable cap/continuation/attention episodes;
restart coverage and fair bounded backlog handling. Existing notices alone implement none of this
end-to-end contract. No general scheduler, provider research, authority engine or UI is added here.

**Unresolved adoption choices for coordinator/user:**

- Select/adjust the proposed 15s/60s completion and 2s/5s blocker coalescing, hard 20/hour with reserved
  capacity, aging and single-continuation circuit breaker. Alternatives can favor lower cost
  (30s/120s completion coalescing) or latency (5s/30s), without changing identity/control rules.
  No empirical cost/latency measurements are claimed; validate burst/no-op/start counts and oldest
  eligible age in future synthetic tests before choosing defaults.
- Choose authoritative record ownership, exact-operation lookup coverage, atomic versus journaled
  cross-store boundaries, source checkpoint recovery and payload/backlog/retention limits. Do not
  silently evict unresolved reasons when a bound is reached; retain a recoverable reference/backlog
  and mark observation incomplete. Detailed storage and supported transport remain unselected.
- Validate conservative versus selective applicability, including status-transition ordering,
  task/context/owner ABA, coordinator replacement and explicit withdrawal. #2 approval/currentness,
  #5 live gate observers and #22 contribution attribution remain separate missing prerequisites.
- Decide attention routing/permissions and whether independent work during a pending explicit user
  question can ever be supported safely. Default recommendation here is hold, not change `ask_user`.
  No UI layout, role removal or direct worker-user escalation replacement is selected.
- Validate watchdog bounds and fallback against long tools, offline hosts, lost ACKs, safe drain,
  Stop races, repeated unchanged recovery, caps/starvation and failed/archived coordinators using
  the scenarios above. #6 custody/retry recommendations still require separate adoption; this
  document grants no takeover, process exclusion, automatic resume, cleanup or latency SLA.
