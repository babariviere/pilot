# Explicit non-code acceptance prerequisites

**Planning only.** The coordinator validated A→B→C→D as a staged prerequisite plan, not blanket
API/code authorization or migration. #33's exact host-only A contract needs separate validation
before code; B/C provenance, authority, domain and stability remain prerequisites and #19 stays
blocked. D31 permits later allocation, never historical attribution; D36 preserves every gate.
No review writes, Ask changes, merge, archive, workspace deletion or restart is authorized here.

## Source baseline and the actual completion routes

Refreshed against landed `78a1200d04fcabe5d14dbde993864ea0f20cf20c`, including #30/#8/#12/#25/#26.
Symbol links identify implementation, not guarantees inferred from task titles or completion prose.

| Route / foundation | Actual contract | Not established |
| --- | --- | --- |
| [Kernel `complete`](../packages/kernel/src/mission-tools.ts), `MissionService.call` → [`MissionStore.completeTask`](../packages/daemon/src/missions.ts) | Legacy missions only; current task owner supplies exactly `{commit, checks, issues}`. Commit is 40 lowercase hex, not resolved. One immutable receipt; identical retry returns it. Writes done and inserts non-coordinator into `retired_members` | Landing, checks, review, inventory or acceptance. Retirement here prevents new assignments, not workspace deletion |
| `MissionService.updateTask` → `MissionStore.updateTask` / `assertTaskWriter` | v1 coordinator or trusted local user path can set done without a completion receipt. Legacy agent writes require a receipt; trusted local user writes do not | Status is not verified acceptance. This is a separate route, not #19 already implemented |
| [`server.ts`](../packages/daemon/src/server.ts), `PATCH /api/missions/:id/tasks/:taskId` | Calls `service.updateTask` with default user actor. Native [`task_status_transport.rs`](../apps/desktop/src/task_status_transport.rs) sends `{status}` after a read preflight | Preflight is explicitly not CAS; lost/error/malformed ACK is Unknown, never automatic replay. Loopback/user-path admission is not authenticated human authorship |
| `POST /api/missions/:id/lifecycle`, `MissionStore.lifecycle` | Passive mission-level complete requires at least one done task and no unfinished tasks (dropped excluded) inside a transaction | Task evidence, code-free work, review or acceptance; do not use this to close #10 |
| `MissionStore.reconcileTaskPullRequests` | Legacy only, not v1: known ownership PR links, none open/draft and at least one merged can set done; closed-unmerged links contribute nothing | Neither an exhaustive PR inventory nor proof every worker-created PR merged. Cached link states do not satisfy the proposed gates |
| #3 [`saveNonCodeDelivery`](mission-non-code-deliveries.md) | Host-only explicit `kind: non-code`, 1–20 exact brief/artifact refs, checks text, limitations; immutable per task, no status/lifecycle change | No active action/transport, assignment-bound acceptance or verified checks. Service can refuse retry after reference access changes |
| #18 [`submit/judge/evaluateDeliveryEvidence`](delivery-evidence.md) | v1 host-only append history, full assignment/owner/definition fences, criterion evidence indexes, exact retained identities, coordinator judgement | Coverage indexes are claims. Availability is not check success. Record currentness is not live-source freshness or completion eligibility |
| #13 [`SharedWorkspaceStore.ownership`](jj-ownership.md) | New v1 managed builders only; worker creation provenance and pinned operation discovery. Unsupported births/history intervals underclaim | Neither exhaustive work inventory nor exact original task purpose. Dirty files are not observed commits; no legacy enrollment |
| #17 [`recordReviewResult`](mission-review-records.md) | Exact profile/content/context, execution versus outcome, recorder versus optional observed agent producer | No runner, independence or human-authorship proof. Even current Pass is not a passing acceptance gate |
| #22 [`recordContributionAllocation`](contribution-allocation.md) | Coordinator-only exact selected submitted refs, latest-ID CAS and assignment/owner/definition/context fences. `scopeCoverage: selected-only` always | Exhaustiveness, code-free work, original purpose, live freshness, checks, integration or acceptance |
| #28 [`GET …/review`](mission-native-review.md) and native Review | Admitted bounded retained comparison reads. Exact revision remains pinned; related results have unavailable current authority unless structurally outdated | Browsing, opening source, or a readable manifest does not review/approve or prove all blobs readable |
| #30 [`WorkerReviewDelivery.checkpoint`](../packages/daemon/src/worker-review-delivery.ts) and [eligible-worker checkpoint](review-snapshots.md#eligible-worker-checkpoint) | Implemented creation-only v1 builder lifecycle observation → atomically queued exact committed non-checkout single-parent layers → existing retained capture → read-only Review. Current host membership/project/binding/custody is rechecked | Saved layers are not exhaustive inventory, check success, acceptance, landing, revision authorship or original task attribution. Legacy custody remains unavailable; reads never enroll or capture |

The [`jj-ownership.ts`](../packages/daemon/src/jj-ownership.ts) observer pins parent/head/operation;
[`jj-ownership-worker.ts`](../packages/daemon/src/jj-ownership-worker.ts) commits requests with
ownership/cursor advancement. The first exact request survives duplicate observations and lost ACK;
new revisions get separate requests. The bounded lifecycle drain retries pending/failed requests at
the next admitted checkpoint, never on Review GET. It creates no task delivery/acceptance record.

The mission IPC bridge awaits `store.whenDurable()` before exposing tool results; HTTP JSON
success is also durability-wrapped. Durability acknowledges persisted writes, not their truth.
The dedicated acceptance path must not inherit legacy `completeTask` retirement side effects.

## Minimum acceptance contract

Accept **one exact non-code outcome**, not a worker label or an allegedly empty checkout.
Use existing retained stores and append-only mission SQLite records. Do not create a general
observation inbox, receipt vault, scheduler or new framework. The following are separate facts:

1. **Explicit scope and authority.** A coordinator-owned assignment and approved, revisioned
   policy explicitly name non-code outcome, criteria, required checks/reviews, delivery destination
   and who may accept. Current actor/project/membership and authority must hold at admission.
   Missing hash, `research`, explorer/reviewer title, effort or empty links establish none of this.
2. **Exact submitted outcome.** #18 submission freezes assignment/owner/definition and maps every
   criterion to exact pinned brief/artifact/report references and limitations. Read and hash actual
   retained bytes, not just links/manifests. Uncovered criteria block. #3 remains an unaccepted
   reported submission; it is not silently upgraded or rewritten into accepted evidence.
3. **Reconciled contributions.** A host observation enumerates the complete *declared supported
   delivery domain*, with coverage boundaries and unresolved intervals. Reconcile every entry,
   including code, PRs, non-code artifacts and outstanding/uncertain operations. Enumerating only
   submitted refs, selected allocations, one history page, linked PRs or known owned IDs is not
   exhaustive. Unsupported creation, direct/unmanaged writes, divergent custody or missing history
   yield Unknown, not an empty successful inventory. No finite scan proves arbitrary external work
   never happened. Do not advertise such proof against unrestricted shells/REST.
4. **Exact allocation, not causal attribution.** Reuse #22 for later coordinator allocation of
   exact retained contributions against the criteria. Inventory reconciliation is a separate
   record relating all observed entries to selected scope, explicit other-task scope or unresolved
   work. Selected-only never becomes exhaustive by changing its label. Code in the outcome needs
   the code/mixed path and its gates, not the non-code path. Preserve creator/custody provenance;
   original task purpose remains Unknown even after later allocation.
5. **Verified gates.** Trusted named check execution must bind tested input digests, check/config
   version, environment, run identity and result. Required review must bind exact rubric/profile,
   input/context, observed producer and evidence of independence; required human review needs an
   explicit trusted human-origin action. Recorders, model selections and role/different-chat labels
   are not producers or independence. #17 output and #18 coordinator judgement are inputs, not
   execution attestations. No unresolved applicable findings. Balanced required reviews remain;
   a check can be excluded only by an approved applicability rule, never skipped-to-Pass.
6. **Currentness.** Re-resolve exact content and compare the inventory/source observation with the
   proposed delivery now. Recheck current assignment/owner/definition, policy, submission,
   judgement, allocation, context, review/profile and destination revisions. Current retained
   applicability, current live-source observation and current authority are distinct. Observe
   managed source only through supported host readers; historical snapshots cannot see dirty work.
7. **Destination and final acceptance.** Verify publication/linkage of these exact bytes at the
   authorized destination. For artifacts this means exact task pin/custodian/revision plus readable
   retained content/digest; for a brief it includes its current revision. A report saying published
   is not that observation. Code requires real destination commit/tree and required integration
   checks, all applicable PRs actually merged, or the explicitly authorized non-PR delivery mode.
   Final coordinator/user acceptance cites the exact evaluated bundle and reason, not a bare status.

An inventory is point-in-time and domain-bounded. Task acceptance does not certify that the worker
has no unrelated unfinished work, nor authorize its retirement. Known other work must remain visible;
unknown membership in the delivered scope blocks reconciliation. Worker-wide PR/job/assignment
reconciliation and stop/join/archive/delete are separate [#8 design](mission-worker-retirement.md)
work, never side effects of acceptance. Its landed proposal activates no retirement or cleanup.

## What the zero-code design deliverable #10 needs

No landed code hash exists for the accepted design. Neither a later implementation commit nor this
planning document's commit may be invented as its delivery. Existing acceptance of D18–D22 does
not need to be requested again. Preserve it as historical user acceptance with its actual provenance.

The eventual record needs: exact specification artifact revision 2, workflow artifact revision 4,
the particular retained brief revision and criteria they satisfied, their custodians and content
digests; inspectable criterion coverage; actual validation results/limitations (native diagram
validation versus unavailable HTML preview); the approved applicable check/review policy and its
required evidence; authoritative exact destination readback; a current authorized acceptance action
referencing that bundle. Artifact IDs and pins are already in the task, not inferred from titles.
An old brief is retainable history but is not current brief evidence under today's #18 resolver.
Do not restamp old evidence with today's assignment/context just to make it pass.

Crucially, #10 is in a **legacy mission**, without v1 assignment/enrollment or exhaustive contribution
observation. Absence of custody is not proof of no code. Its coordinator can also own unrelated work.
The present foundations therefore cannot certify automatic non-code completion for it. A future
explicit legacy compatibility/adoption contract must define a narrow historical-design acceptance
scope, preserve unavailable original attribution and reconcile relevant contributions without
guessing. Whether that contract allows human-attested bounded legacy scope instead of a host-proven
exhaustive inventory is a material policy choice, not an implementation shortcut. Until approved and
implemented, #10 stays formally blocked, with accepted design retained and no fabricated commit.
Do not change this mission's version, pins, status or custody to demonstrate the proposal.

## Dependency-ordered bounded implementation proposals

Names below are **proposed host-only APIs**, not endpoints or existing methods. Reuse #18/#17/#22
references/normalization and the existing SQLite durability model; do not change their historical
retry contracts. Each slice requires coordinator contract validation before code and leaves #19 off.

### A. Explicit policy and explain-only decision

The separately validated inert A foundation is documented in
[non-code policy APIs and recovery](non-code-acceptance-policy.md). It implements configuration and
always-false explanation only. Creation/schema admission is not authenticated opt-in or approved
authority. B/C/D below remain prerequisites, not activated by that foundation.

Add `MissionService.saveNonCodeAcceptancePolicy(sessionId, taskRef, request)` for the current
coordinator on a creation-admitted v1 mission. Request: `version:1`, `operationId`, `expectedPolicyId`,
full assignment, owner, `definitionRevision`, `expectedContextFence`, explicit `kind:non-code`,
destination refs, named required check IDs/config versions, required profile revisions/reviewer
provenance rules and exact authority reference. Store resolved approved authority separately from
coordinator assertions; no authority reference means unavailable. No worker can change requirements.

Add `evaluateNonCodeAcceptance(sessionId, taskRef)` returning exact input IDs, each requirement's
state/reason, missing capabilities and `eligible:false` while any required observer is absent.
It must not infer an empty check list or green non-code applicability. Reuse approved D18/D19
defaults described in #5, not its whole proposed merge/reviewer engine. Policy is coordinator-owned
configuration, not approved authority: a claimed authority reference remains unresolved unless an
admitted host source independently resolves its exact scope/version. A grants no authority.

Tests: strict schema, missing authority/config, code/unknown kind refusal, forged actor/gate fields,
cross-project and former coordinator, assignment/context ABA, exact retries/CAS and legacy refusal.

### B. Attributable checks and required reviews for retained design content

Implement only the named validators/reviewer execution approved in A, initially exact artifact/brief
validation and one configured independent-agent review path. Private host runner completion hooks
write typed results bound to an admitted run ID, pinned inputs, actual executor/config and output.
Do **not** expose `recordObservation(value)` or accept caller-supplied green/independent/human fields.
Reuse #17 output/history; retain execution/provenance evidence alongside it in mission storage,
without duplicating content. Human-required policy stays blocked until a separately admitted trusted
human action exists. This does not activate native Review writes or permit an override to avoid them.

Tests: wrong run/input/config, duplicate result and spoofed producer, self-review, missing independence,
timeout/partial/failed execution, superseded inputs/profile, unresolved findings, check exclusions,
actual runner failure, crash before/after result commit and disk reopen. No real provider accounts.

### C. Bounded reconciliation, freshness and destination observer

Add `observeNonCodeDelivery(sessionId, taskRef, {version:1, operationId, expectedObservationId,
policyId, submissionId, allocationId, expectedContextFence})`. This asks the host to **perform**
named reads; payloads cannot submit an inventory, source path, result, actor or filesystem grant.
Host derives mission/project/worker/domain, enumerates all pages, records exact source heads/cursors,
coverage gaps, outstanding operation IDs and destination readback, then validates criterion/allocation
coverage. Persist observation identity/digests and explicit scope, not copied blobs. Missing adapters
remain unavailable. Do not turn #30 saved committed layers into a complete inventory or dirty scan.

Start only with a domain the coordinator validates as fully observable, such as a newly admitted
constrained research workflow with host-recorded retained outputs and no repository-write channel.
A role label or Ask alone is not that proof. If present capabilities cannot close enumeration or
source stability, this slice reports Unknown; implementing a general shell interceptor is out of scope.
Legacy #10 and code/mixed work stay blocked rather than weakening this domain claim.

Tests: more than one page, omitted/unlinked PR or contribution, unsupported/borrowed creations,
dirty/unmanaged work, missing binding, unresolved operation, late append, all-blobs hash failure,
pin unlink/relink, owner/coordinator A→B→A, revocation during reads, source/destination change and
matching historical content with stale current authority. Partial inventory must never pass as zero.

### D. Final host-only completion seam, then separately admitted transport (#19)

Only after A–C are implemented and verified, propose
`acceptNonCodeDelivery(sessionId, taskRef, {version:1, operationId, expectedAcceptanceId,
policyId, submissionId, judgementId, allocationId, observationId, expectedContextFence, reason})`.
All supplied IDs name immutable records, not passing booleans. Current coordinator only initially;
explicit user acceptance requires a trusted user-origin adapter, not an agent-supplied actor string.
Re-evaluate before commit and compare full frozen fences in the transaction. Atomically append one
immutable accepted non-code completion and update task status, without calling legacy `completeTask`
or touching `retired_members`. Post-completion definition revision is part of the result; its own
status write must not make the exact committed acceptance look like an unrelated stale precondition.
Later scope/source changes remove current effect without erasing historical acceptance.

Transport is a separate substep: admit session identity from existing worker IPC and expose only the
typed submission/acceptance/lookup actions needed. Never add an unauthenticated loopback endpoint
that treats payload session/role as authority. Native human actions need their own proven admission;
#28 read access is insufficient. Capability detection and explicit new-mission opt-in precede use.
For opted-in scope, audit every done route (tool task/status, HTTP PATCH, PR synchronization and
mission lifecycle consumers): ordinary done cannot masquerade as accepted or trigger gated effects.
Preserve legacy manual status/receipt compatibility as **unverified**, not an alternate green gate.

Tests: store/service plus admitted IPC end-to-end, rejection through bypass routes, zero-code success
with no commit/PR, code/mixed/legacy refusal, concurrent acceptors, post-read source/authority changes,
status/acceptance atomicity, reopen/recovery, result projection and proof that no member retirement,
archive, workspace deletion, review submission, merge or Ask capability changes occur.

## Shared fence, durability and failure rules for the proposed APIs

- Before lookup/retry **and** after async reads, derive current session/project/durable membership
  and coordinator authority from host state. No former-coordinator recovery privilege is proposed.
  Record lookup authorization is separate from authorization to create a new acceptance.
- Each new request binds mission/task, recorder, action, version and complete normalized payload to
  its mission-local operation ID. Same ID with a changed field conflicts. Check exact authorized
  retry before mutable CAS/source checks; it returns history, never renewed eligibility. Each
  append CASes its expected latest ID. Recheck full assignment (including classification), owner,
  `sharedDefinitionRevision`, allocation's brief/decision/artifact/member/coordinator event fence,
  and referenced policy/submission/judgement/allocation/profile/result/observation identities.
- Keep bounds explicit: existing 20-reference/criterion limits, 100-record keyset history pages,
  256 KiB record cap; inventory enumeration pages without truncating eligibility. Exceeding a bound
  is unavailable/backpressure, not successful partial acceptance. Resolve sequentially/cancellably.
- Await `MissionStore.durable()` on writes, exact retries and present/absent lookups before success;
  recheck access before disclosure. Failures after possible commit remain Unknown. Lookup absence
  is read-time only: concurrent source resolution may append later. For observation work, persist
  its exact reservation first; reconcile that operation on recovery, never rerun arbitrary JS/shell.
  No acceptance operation kind is currently registered in the generic durable-operation journal;
  using `/api/operations` later needs a registered idempotent handler, not just a new payload label.
- Mission SQLite does not atomically lock artifact/session/repository stores. An observation is
  point-in-time. Final admission needs a supported revision token or write-stability boundary for
  each mutable source through commit; double reads alone cannot close an ancestor/ABA race.
  If the domain cannot supply that boundary, eligibility remains unavailable. Do not claim a
  global filesystem transaction or redesign authentication to hide the gap. The landed
  [descriptor traversal design](descriptor-anchored-source-traversal.md) is not an implemented
  stability/provenance boundary either.
- Missing, pending, skipped, failed, timed-out, inconclusive, stale, partial, corrupt, unauthorized,
  conflicting or unsupported **required** evidence is not passing. Denial reveals no retained bytes.
  Explanations name exact failed requirement/input and next supported remedy, not just “rejected”.
  Retain bounded diagnostic operation IDs, fence mismatch names and failure stages, not source/secrets.
- Test lost ACK before/after durable commit, duplicate concurrent retries, payload conflict, storage
  failure/reopen, former-actor denial, absent lookup racing a write and cancel/join of owned observer
  jobs. No timed sleep, ignored assertion or manufactured hash substitutes for observed outcomes.

## Choices to validate before activation

1. The exact approved policy/authority reference and minimum independent-review standard for design
   work. Balanced defaults are settled; executor independence and trusted human transport are not.
2. The smallest supported exhaustive domain and source-stability boundary for C. It must describe
   excluded channels honestly; never call managed-jj discovery universal contribution proof.
3. Whether a later explicit legacy historical-design path can use bounded human-attested scope, or
   must await host-observable inventory. This would be separate opt-in work, not adoption here.

Do not wait for these choices by building a generic evidence ingestion system. A can report gaps;
B and C can qualify narrow adapters; D remains disabled until the selected domain actually passes.
Cleanup, broad code integration, Review writes and legacy migration stay separate dependencies.
