# Proposed worker escalation and human handoff contract

**Docs-only proposal, not adopted mechanics or implemented enforcement.** The coordinator owns
planning and adoption. This document selects no new approval, gate, durable transport, takeover
implementation or scheduling. It changes no runtime, schema, tools, roles, `ask_user`, UI or live
mission. It authorizes no worker starts, model calls, migration, cleanup, release or restart.

## Direction and authority boundaries

D6's future direction is worker → coordinator → user when necessary, without direct worker-user
interruption. The coordinator answers within explicitly delegated authority and asks the user when
uncertain or outside it. D16 also requires a route for genuinely stuck work, including a human
finishing it. Neither direction removes tools now. **Keep existing `ask_user` until a dependable
replacement is implemented and validated.** Ordinary non-mission behavior is out of scope. Ask
role/mode/UI removal is separate unresolved discussion, not permission to remove capabilities or
weaken read-only protections.

Today, use the existing directed comment and execution-status/log paths for coordinator requests;
keep `ask_user` available when the current workflow needs it. Do not simulate the future protocol
by disabling that fallback or claiming an ordinary comment/send has the receipts defined below.

Use task #2's [proposed approval envelope](mission-interview-approval.md): mission/project identity,
immutable brief revision/content, applicable decision identities/content, deferred unknowns and
versioned effective authority/policy, with pinned references and amendment lineage. Refer to that
exact package, not a second grant mechanism. Its trusted explicit user action, transport, currentness
and amendment mechanics remain unselected/unimplemented. An absent approved envelope is a gap, not
permission to infer one from the current brief. This escalation proposal does not adopt #2's transport.

Task #5's [authority/review proposal](mission-authority-review-policy.md) keeps research, build,
submission, acceptance and integration distinct. Balanced defaults remain T1 targeted independent
review, T2 full independent review, T3 specialist plus human review; automatic delivery is conditional
on all gates. Force stays OFF, checks mandatory and repository protections intact. An escalation
answer cannot waive those requirements. Coordinator/user planning ownership remains unchanged:
workers report and propose, never rewrite scope, brief, decisions or their acceptance criteria.

Separate three requests, even when one conversation contains all three:

| Requested action | Meaning | Not implied |
| --- | --- | --- |
| Factual clarification | Answer an uncertainty using cited evidence, including limitations | Permission to change scope, start an action or treat a guess as fact |
| Scope/authority decision | Ask the authorized planner to choose a bounded alternative or seek explicit approval of an amendment | A factual answer, coordinator title, message label or repository credential granting authority |
| Human assistance | Identify an action an agent cannot safely or successfully finish | Approval, transfer of edit ownership, completed work or retirement eligibility |

A factual answer can be useful without being authoritative approval. A coordinator can say “the
format supports X” without authorizing a new feature using X. A human can fix a file without
approving its delivery. Unknown or conflicting authority blocks the affected action, not Stop.

## Actual primitives and proposed gaps

The following are inspection anchors in the current source, not an assertion that the proposed
end-to-end contract already exists.

| Current foundation | Actual behavior to reuse | Gap for this proposal |
| --- | --- | --- |
| [Role contract](mission-roles.md), [mission tools](../packages/kernel/src/mission-tools.ts) and [service](../packages/daemon/src/mission-service.ts) | Opted-in missions reserve planning for coordinator/user. Workers can report execution/log evidence and address actionable comments to the coordinator. Explorer tools remain read-only; reviewer is metadata only | No structured worker question/response/consumption or human edit-custody contract. Supported IPC roles are not hostile-shell or unauthenticated loopback REST isolation |
| [Mission store comments/notices](../packages/daemon/src/missions.ts) | Comments preserve an ID, text, actor session, optional recipient/brief anchor and resolution. Action/urgent comments can queue coordinator notices; informational/ACK comments do not wake. Each comment call creates a fresh ID | No caller-supplied exact escalation operation retry, task/owner answer fence or proof that resolving a comment means an answer was applied |
| [Mission notices](../packages/daemon/src/mission-notices.ts), [dispatcher](../packages/daemon/src/notice-dispatcher.ts) | Durable grouped events, frozen notice identity/payload, durability wait before send, idle-only coordinator delivery and acknowledgement. Busy coordinator delivery waits; existing member-activity/debounce/cap policy affects timing | Notice acknowledgement means notice placement, not coordinator triage, response or worker consumption. Existing batching is not a dependable blocking-question service or a selected latency promise |
| Coordinator `mission send`, [session delivery](../packages/daemon/src/sessions.ts), [input origins](../packages/kernel/src/input-origin.ts) | Coordinator-only supported send checks membership, reports delivered/queued/rejected, uses steer/followUp and host-minted coordinator origin/source. Current service mints a fresh random send identity per call | Delivered/queued is not answered, consumed, resumed or task-authorized. Repeating the tool call is another message, not an exact retry. No request-bound response record is supplied |
| [Question tool](../packages/kernel/src/question-tool.ts), [held inputs](../packages/kernel/src/held-inputs.ts) and [journal](../packages/kernel/src/held-inputs-doc.ts) | `ask_user` publishes a call-ID-idempotent transcript question and waits for a committed reply. Automatic/coordinator inputs are held, not accepted as the explicit user answer. Replies survive tool-boundary restoration; interrupted JS is not replayed | This is a user-question path, not a coordinator-question path. Historical question visibility is not an outstanding escalation record or scoped approval receipt |
| [Kernel session Stop/reopen](../packages/kernel/src/session.ts), daemon Stop and [recovery stops](../packages/daemon/src/recovery-stops.ts) | Serialized input/Stop handling, held automatic messages, persisted abort before recovery, and a credential/model-independent child-recovery cancellation path. An interrupted blocking question is retained as a next-turn question, not a restored JS stack | Stop clears the live unanswered blocking gate; retained transcript history is not this proposal's durable request state. Stop acknowledgement alone is not write quiescence or a takeover receipt |
| [Jobs monitor](../packages/kernel/src/jobs.ts), native adapter jobs/stopJob and [shell deadlines](../packages/kernel/src/shell-deadline.ts) | Live registry projection/refresh, explicit job cancellation, SDK shell process-group cleanup, no automatic failed-shell replay. Registry inspection failure preserves known live jobs | No workspace-wide write exclusion or proof all descendants joined. Empty running list is not proof of quiescence |
| Assignment and [review records](mission-review-records.md), [delivery evidence](delivery-evidence.md) | Assignment revisions, existing shared-definition fence, pinned context/content and durable exact-record patterns | Review/delivery receipts do not establish escalation delivery, trusted human approval, process exclusion, live freshness or completion eligibility |

The [existing job/recovery description](../README.md#missions) also distinguishes durable handles/logs
from live subprocesses: unfinished crash records become interrupted, never automatically rerun, and
subprocesses may remain alive. Inspection of the bundled jobs provider confirms that stop marks a
job cancelled and signals its process tree; ordinary job completion can settle after shell exit and
a bounded output drain even if descendants remain. Provider shutdown has a bounded wait, not a
universal descendant-join proof. Cancelling a jobs wait does not cancel its job. General bash/jobs
behavior and these isolation limits remain unchanged by this document.

## Proposed request payload and fences

These are semantic fields for a future contract, **not a protocol/schema addition**. The host should
capture available identities and retained references; the worker supplies the short problem,
attempts, alternatives and desired action. Explicit `unknown` with a reason is different from an
empty list or “not applicable.” A missing required fence blocks an answer's consequential use.

| Field group | Exact proposed contents |
| --- | --- |
| Identity | Version, immutable request ID, create operation ID, exact payload identity, creation time and optional supersedes-request ID. One logical blocker has one current request; materially changed questions create a linked successor |
| Actor/routing | Host-derived originating session and conversation/attempt, mission/project IDs, current coordinator session observed at creation. Recipient is the current coordinator, not an unvalidated session named in prose; retain original routing history |
| Subject | Stable task ID, display number for readability, actual owner session, complete assignment version/revision/content including classification and criteria, and existing task shared-definition revision (`definitionRevision` in evidence contracts) for every affected task |
| Context | Exact #2 envelope/reference and effective authority/policy revision or explicit unavailable reason; brief revision, applicable pinned decision/content/reference versions, dependencies and relevant preference references. Preferences never grant authority |
| Currentness | Capture a conservative context fence using the existing brief revision and decision/artifact/member event IDs as a starting pattern, plus the exact relevant retained source/report/workspace identities. This is proposed reuse, not an implemented escalation fence |
| Problem/impact | Kind: factual, scope/authority or human assistance; one precise question/blocker; expected versus observed result; affected criterion/action; what cannot proceed and what independent work can safely continue |
| Attempts/evidence | Distinct attempted remedies and outcomes, concise failure/reproduction details, retained logs/tool results/partial diffs/artifacts with exact versions and producer/observation limits; unresolved or lost-ACK operations identified separately |
| Alternatives | Bounded choices, consequences, risks and recommendation, or an explicit reason none is known. No fabricated “safe default” when the answer is unknown |
| Requested disposition | Answer a named question, choose a bounded alternative, seek an envelope amendment, provide human help, request takeover/completion, reassign or cancel. State the exact next action and the authority it would require |
| Retained work/control | Workspace identity/location and repository identity, full jj change ID and retained base/head/content or non-code revision, dirty/uncommitted patch/untracked-file references where relevant, known jobs/children/terminals and pending effects, current Stop/pause and quiescence observations |

Retain the evidence needed to understand/resume the blocker outside a disposable workspace before
offering handover. A path, mutable log or change ID alone is not retained content. Preserve partial
output, provenance and limitations, not just the last error line; omit secrets and unrelated history.
Large evidence belongs in bounded retained references with coverage/truncation noted. Ownership of
a jj change is not proof of its exact task-at-operation purpose; task #22's unresolved prerequisite
is not settled by these request links.

Validate fences at request admission, response creation and response consumption/resume. Compare
assignment revision/content **and** actual owner **and** existing shared-definition revision. Owner
A → B → A or release/reclaim by A must not revive an old answer. Context pin/member ABA also matters.
An answer to task A does not automatically answer task B. Relevant source changes can invalidate a
factual answer even when task ownership is unchanged.

Status changes can themselves advance the existing definition fence. A future implementation must
capture the fence after any blocking-status transition and reject intervening changes, or validate
an explicitly correlated transition atomically. It must not disable the fence to avoid
self-invalidation. Request-lifecycle revisions below are separate from assignment/definition
revisions; no atomic cross-store update is assumed available today. Conservative invalidation is the
recommended starting point; selective carry-forward needs a validated applicability rule. Historical
facts may inform a fresh request but historical permission never automatically transfers.

## Triage and response contract

1. **Report once and block the affected work.** Save the request before requesting attention.
   Continue only demonstrably independent, already admitted work. Do not proceed on the requested
   answer, start speculative writes or announce completion. A full blocker leaves the task blocked;
   a request's blocked portion and the task's overall status need not be identical.
2. **Coordinator triage.** Check current membership, task owner/assignment/definition/context,
   requested action, retained work and authority. Read the exact request, not merely its truncated
   notice. Group related evidence without merging distinct scopes or losing request identities.
3. **Answer or escalate.** Cite evidence for an in-authority factual answer; state uncertainty
   instead of guessing. Choose a bounded option only within delegated authority. If uncertain,
   investigate within existing authority or ask the user. For expansion, draft the exact change
   through coordinator-owned planning and #2's proposed amendment route; do not approve it by prose.
   Forbidden work remains forbidden unless an authorized change explicitly makes it permissible.
4. **Return a scoped response.** Proposed immutable response fields: response/operation ID, request
   ID and payload identity, expected request-state revision, exact subject/fences and recipient
   owner/conversation, host-derived responder, response kind (`fact`, `delegated-decision`,
   `needs-user`, `human-help`, `declined`, `cancelled` or `superseded`), answer/reason, cited evidence,
   alternatives resolved, precise allowed next action and limits. A delegated decision cites the
   exact delegation/envelope/amendment; a required user approval cites the exact trusted user action
   and package, or remains pending. Supersession links its replacement. Unknown fields stay unknown.
5. **Consume, then separately admit work.** The current owner receives the exact durable response,
   revalidates fences/authority and records consumed, rejected-stale or deferred with a reason.
   Consumption means receipt/assessment, not that a model obeyed or an effect succeeded. Resume
   requires a separate current admission, no Stop/pause/takeover fence and an explicit permitted
   next step. Record actual work/effects separately; do not promise exactly-once execution from
   exactly-once response consumption.

For user escalation, preserve the worker's question, attempts and alternatives and ask only the
missing decision. The coordinator can use today's `ask_user` for its user interaction, but a new
scope/authority grant still needs the trusted explicit package-bound action proposed in #2. Ordinary
user text, a relayed “user agreed,” or a recorder's role label is not automatically that receipt.
Preserve actual user authorship separately from the coordinator recording/transmitting it. A user
asking another question is not approval. Never POST a fabricated user message or disguise a
coordinator reply as user input to unlock a worker's pending `ask_user`.

## Durable state, delivery and recovery requirements

The future service needs an authoritative request record and per-operation results, not a new chat
message as its source of truth. The following lifecycle is proposed, not supplied by current sends:

| Dimension/state | Meaning and permitted transition |
| --- | --- |
| Request `open` | Durably recorded, affected work blocked, awaiting coordinator triage |
| `triaged` / `awaiting-user` / `awaiting-human` | Coordinator disposition recorded; still blocked on the named answer or action. Triage is not resolution |
| `response-ready` | Exact response is durable, not necessarily delivered or consumed; actionable permission is still subject to currentness/admission |
| `resolved` | Current owner consumed a sufficient response, or the exact human action was verified. This resolves the blocker only, not task completion |
| `cancelled` / `superseded` | Authorized withdrawal with reason, or obsolete request linked to a successor. Terminal for applying answers; history/evidence remain |
| Delivery `pending` / `placed` / `consumed` / `rejected-stale` / `deferred` | Separate receipts for durable recipient placement and request-specific consumption. A placed notice/message is not a consumed answer |
| Execution `blocked` / `stopped` / `resume-pending` / `running` / `human-owned` | Separate work control. A resolved answer can remain stopped; only explicit current admission may move to running |
| Operation outcome `Unknown` | Caller lacks the exact committed result. This can coexist with any actual server state; it is not a new permission or proof of failure |

Changes use expected lifecycle revision/CAS. Competing answers/cancel/supersede must not silently win
by arrival order at the model. Retain both observations; accept only the authorized current transition.
Resolving/opening/dismissing an Inbox item or comment is not a substitute for these transitions.

Proposed durability/identity obligations:

- Journal the exact create, triage/answer, cancellation/supersession, delivery, consumption and
  resume/control operations with distinct stable operation IDs. Bind each to actor, action,
  request/payload, expected revision, subject/fences and destination. Commit the state and pending
  delivery reference together, or use a recoverable journal with no acknowledged gap; await the
  store's explicit durable boundary before a successful receipt. No existing cross-store atomicity
  or transport is claimed. A receipt names that exact operation and committed result/revision.
- Retries are only supported exact-operation lookup or validated idempotent retry using identical
  identity and payload. Changed payload/actor/action/destination conflicts, not a retry. Duplicate
  receipts do not duplicate questions, responses, wakes or resumes. New evidence can append a
  separately identified update; a changed question/fence requires explicit supersession/revalidation.
- A timeout, disconnect or lost ACK stays **Unknown**. Reconcile the original exact operation before
  dependent action. A generic GET, matching text/status or latest owner is not proof which operation
  executed. An exact authoritative lookup may establish its result; absence is definitive only if
  that lookup guarantees committed/pending coverage. Access denial leaves resolution to an authorized
  actor, never impersonation. Recovering an old record does not make its authority current.
- No arbitrary JS/tool/script replay and no automatic replay of one-shot comments or `mission send`.
  Their existing fresh IDs do not supply this contract. Until exact-operation recovery exists,
  uncertainty is retained and escalated, not “fixed” by sending a new grant or rerunning the work.
- A notification carries request/response ID and revision, not authority. Queue it while the
  coordinator is busy; deduplicate by actionable request transition, coalesce related attention and
  preserve the full record. Reconnect/restart drains retained pending references, not model polling.
  The current coordinator must be rechecked at delivery/admission, without erasing the original actor.
  An unavailable/archived/failed coordinator leaves the request blocked and visible for an authorized
  replacement/user path; it does not transfer authority to a worker or auto-start another coordinator.
- Stop must remain reachable independently of this service and any answer/admission wait. Commit a
  Stop/control fence before further admissions; do not hold an admission lock while awaiting an
  answer, user or coordinator. Answers arriving after Stop can be stored, not auto-resume work or
  release held automatic messages. Stop cancels the active request wait/current turn, not the
  retained question; it is not by itself cancellation/join of every session-owned job. Explicit
  request cancellation is separate. A stale pre-Stop resume cannot undo a later Stop.
- Crash/reconnect restores unresolved questions, evidence, exact operation uncertainty, responses
  and stopped/human custody before new work admission. It does not reconstruct a lost JS stack.
  Reconcile pending operations and current task/context before a fresh explicit continuation. Rewind,
  attempt switch or reassignment cannot consume an old attempt's response automatically.

Request wakes must be actionable and bounded: notify on creation, materially changed evidence or
required disposition, and response-ready for its current owner, not on every read/ACK or elapsed
model turn. Busy queues must not drop requests; attention delivery cannot itself clear them. Task
#27 owns mission-wide completion/stall scheduling, timing, caps and unavailable-coordinator alerts.
This proposal neither chooses those parameters nor adds polling/model calls. Existing notice caps
and member-busy behavior require explicit compatibility validation before being reused for blockers.

## Human help and actionable Inbox handoff

Propose one data-backed Inbox request linked to the same escalation record, not a competing queue
or a screen design. The coordinator routes it only when human action is actually needed. It contains:

- The exact blocker, affected criterion and why coordinator/worker cannot finish, with attempted
  remedies, outcomes, evidence and bounded alternatives. Ask for the smallest useful intervention.
- The precise remaining action, expected observable result, access/prerequisites and risks. For
  example: “repair these two conflicting retained files, then return the resulting revision,” not
  “please take a look.” Secrets or credentials should not be pasted into the request.
- Mission/project/task/request identities and current assignment/owner/definition/context fences;
  retained source/base/head/dirty/untracked/non-code versions, workspace location and how it is
  preserved; all unresolved effects and known jobs/children/terminals. Missing preservation is a
  blocker to unsafe handover, not permission to delete the workspace.
- Current responsible worker, proposed human edit custodian, quiescence evidence/time/limitations,
  stopped/admission state, requested help versus takeover, and the exact hand-back/completion path.
  Existing tasks have a session owner, not this proposed human-custody field; no schema is added here.

Distinguish the actions explicitly:

| Action | Ownership and result |
| --- | --- |
| Help | Supply information or a bounded non-conflicting external action. Worker remains responsible and blocked on the result. Any overlapping source write needs the takeover/quiescence path, even if called “help” |
| Takeover | Explicitly accept temporary edit custody after verified quiescence. Worker stays paused, assignment remains unfinished, no implicit reassignment/approval/completion |
| Human completion | Human reports the exact remaining work finished and supplies resulting revision/evidence/limitations. Coordinator verifies criteria and applicable gates; the report alone does not mark done |
| Approval | Authorize an exact decision/review/package through its required trusted action. It neither edits files nor proves work complete or process quiescence |
| Hand-back | Human explicitly relinquishes edits and identifies the resulting state; coordinator revalidates/reassigns and separately admits the appropriate worker |

### Proposed custody sequence and safety limit

1. **Request takeover, not immediate concurrent editing.** Coordinator records the intended scope and
   human custodian. A pending takeover must fence new supported-path writes/admissions for the
   affected workspace and overlapping work, including late answers, job completions and recovery.
   Merely pausing input is insufficient to stop an active tool or session-owned background job.
2. **Quiesce and preserve.** Stop/cancel affected active runs, compaction, owned writing jobs and
   child work; await their cleanup/results through supported paths, including explicit job stops.
   Reconcile terminals, queued inputs, pending effects and recovery starts that can write the same
   assets. Signal owned process groups before relying on leader reaping; leader exit, registry
   `cancelled`, an empty running list, stable files or a Stop ACK alone do not prove descendants
   joined. Retain final partial work/logs and reconcile the workspace revision after draining.
3. **Verify before granting edit custody.** Record which supported writers were fenced/joined,
   observations and failures, retained revision and the exact workspace/task/control revision to
   which verification applies. New writer admission invalidates it. Current general bash/jobs,
   extensions, detached descendants, shared repositories and other sessions may escape that
   inventory. No atomic hostile-agent/process exclusion or workspace-wide asset containment is
   claimed. Unknown quiescence blocks unsafe concurrent editing; stop and request a safe manual
   resolution or separately approved isolation plan, not broader process killing or a “best effort”
   ready label. A bounded verification timeout leaves blocked/Unknown, never silently ready.
4. **Explicit human acceptance.** Only after verified safe handover, durably record accepted custody
   against the retained state. Worker write admissions and automatic restart remain blocked across
   Stop/crash/reconnect. This record is a proposed control requirement, not an existing lock that
   can constrain arbitrary shells. If actual safety cannot be established, no shared-workspace edit
   takeover is offered. Read-only inspection/information can still help without pretending custody.
5. **Explicit hand-back or submission.** Human stops overlapping writes, records exact resulting
   revision/patch and actions/evidence/limitations, then explicitly returns custody or submits a
   completion claim. Coordinator verifies resulting content, resolves conflicts, updates planning
   and fences if needed, and rechecks current authority. The same worker or a newly assigned worker
   receives a fresh scoped continuation; old answers/grants do not follow automatically. No timeout,
   closed Inbox item, disconnected human or restarted daemon implies hand-back. Uncertain hand-back
   ACK is reconciled as the same operation before either party resumes writes.

Partial work is preserved without destructive rollback. Human changes are not relabelled as agent
authorship. Cancellation/withdrawal during custody still requires safe ownership reconciliation;
it cannot release a worker while a human is editing. Stuck, blocked, stopped, human-owned or
uncertain work is **not finished and not eligible for retirement/workspace deletion**. Completion,
acceptance, integration and eventual retirement retain their separate gates; task #8 owns cleanup.

## Worked cases and validation scenarios

These are future acceptance scenarios, not tests run or guarantees established by this document.

| Case | Required proposed result |
| --- | --- |
| In-authority fact | Worker asks which existing encoding a parser consumes. Coordinator cites retained implementation/test evidence, limits the answer to that revision, returns no new feature permission. Current owner consumes; only the already authorized fix may resume |
| Coordinator uncertainty | Evidence conflicts about compatibility. Record uncertainty; investigate within authority or ask the user with the exact alternatives. Keep affected work blocked, never choose a guessed answer to clear the queue |
| Forbidden expansion | Local-only assignment encounters a cloud-sync alternative. Coordinator declines current expansion or proposes an explicit envelope amendment to the user. A message saying “use cloud” cannot authorize it under the old envelope or waive checks |
| Unavailable/busy coordinator | Persist one actionable request; queue attention until current coordinator is available. If failed/absent, retain blocked status for authorized replacement/user handling. No repeated model polling, silent timeout approval or worker self-promotion; #27 designs fallback timing |
| Reassignment/stale response | A asks, task moves to B or returns to A with a new definition revision. Late answer is historical/rejected-stale, not applied to either current owner. Coordinator creates/revalidates a fresh scoped request and response |
| Duplicate/lost delivery | Duplicate exact operation returns its original receipt; duplicate notice does not rerun work. Lost create/answer/consume/resume ACK stays Unknown until exact reconciliation. Existing one-shot send/comment is not retried as a new message; a generic GET showing blocked/resolved is insufficient |
| Stop during wait/answer | Stop reaches the kernel without waiting for triage. Question/evidence remain, automatic inputs stay held. A late response can become ready but cannot revive a stopped run; explicit current continuation and consumption are separate |
| Crash/reconnect | Crash after answer commit but before delivery/consume ACK restores exact pending operations and request state before admission. Recover results without replaying JS or commands; retained job records do not prove subprocess death |
| Bounded repeated failure | Same remedy fails twice without new evidence, or the assignment's explicit retry bound is reached. Recommend stop that remedy and update the same blocker once with attempts/remaining action. Coordinator may choose a genuinely different bounded remedy, reassign or seek human help; no endless repair loop or new question per identical failure |
| Human help without takeover | User supplies a missing factual requirement through the coordinator. Preserve actual provenance, check whether it needs a package amendment and revalidate; no edit custody transfer or task completion is inferred |
| Takeover with unknown writers | A cancelled job's shell exited but a descendant may still write. Mark quiescence Unknown and preserve workspace; block concurrent human editing. Do not label it safe because the leader is gone or the job list is empty |
| Takeover and hand-back | Supported writers are demonstrably quiescent and partial work retained. Human explicitly accepts custody, finishes the named repair and returns its exact revision. Coordinator checks content/fences and explicitly admits continuation; human completion claims still need applicable acceptance/check/review gates |

## Recommended defaults, options and unresolved choices

**Recommended, not newly approved:** one short request per logical blocker; host-filled fences and
retained evidence references; affected-work blocking rather than blanket mission suspension;
conservative stale-answer rejection; no guessed answers, automatic timeout approval or automatic
post-Stop resume; one actionable deduplicated wake per material transition; explicit human custody
and hand-back with unknown quiescence blocking edits. A suggested circuit breaker is two identical
failed remedies without new evidence, with an explicit assignment retry bound taking precedence.
It limits repetition, not safe new investigation, and is not a model-call budget or implemented rule.

**Options requiring selection:** allow independent in-scope work while a question waits versus pause
the whole worker when dependencies are unclear; conservative mission-wide versus validated selective
context invalidation; temporary human custody versus coordinator reassignment to a fresh worker;
group several related questions into one user interaction while retaining separate request/results.
None may weaken task/owner fences, Stop, read-only roles, required gates or actual edit safety.

**Unresolved product/engineering decisions:**

- The authoritative record owner/store, exact-operation lookup/retry/receipt and durable placement,
  consumption and admission boundaries. Reuse existing patterns where suitable, but do not assume
  comments, send, generic GET or notice ACKs implement them. Resolve cross-store failure windows.
- #2's trusted user action, envelope representation/currentness, amendments/revocation and explicit
  adoption. #5's active authority/review gates, provenance and integration remain separate gaps.
- Response authority/current-coordinator changes, task-status/fence transition ordering, conflict
  resolution and any selective evidence/answer reuse. Which in-flight finite actions may drain
  after cancellation/revocation needs explicit semantics, not a promise of atomic live revocation.
- Safe human edit custody/admission and verifiable writer inventory/join across jobs, children,
  terminals, other sessions and crash survivors. Ordinary shell/process isolation is not redesigned
  here; unavailable safety must block unsafe shared-workspace takeover rather than be hidden.
- Bounded retry policy and request attention priority/cap interaction; #27 owns cost-aware mission
  wakes/stalls and unavailable-coordinator fallback timing. No latency/SLA or scheduling is selected.
- Inbox disposition/withdrawal permissions, evidence retention/privacy limits and completion routing;
  future desktop UI is separate. Ask role/UI removal remains unrelated and unresolved.

Before replacing worker `ask_user`, implement and validate durable request/response/consumption,
exact-operation Unknown recovery, current-owner/context/authority fencing, coordinator/user fallback,
Stop/admission races and crash/reconnect cases above. Validate custody separately before offering
human edits. New missions first; existing missions require preview and explicit opt-in. Writing or
accepting this proposal alone activates none of these mechanisms.
