# Retained review run linkage

**Proposal for design review, not an adopted schema or execution authority.** D27 and D36–D38
permit this design, not a provider call, grant, migration, observer, review submission or gate.
The [production bridge](mission-production-review-bridge.md) and its D38 foundation remain the
baseline. Balanced minimums, force OFF, existing billing and ceilings remain unchanged. Normal
Bash, jobs, ask_user, credential helpers and account behavior are outside this proposal.

## Observed seams and missing facts

* [`CriticalReviewTarget`](../packages/protocol/src/critical-review.ts#L23) identifies only a
  session snapshot or PR. [`validateReviewRecord`](../packages/daemon/src/critical-review-disk.ts#L21)
  rejects other kinds. [`ReviewAccountingDisk.admit`](../packages/daemon/src/critical-review-accounting.ts#L151)
  keys session by session ID and PR by repository/number, and couples session to the session
  effort. Neither can represent a retained non-code task. A made-up session or PR changes accounting
  semantics and falsely suggests provenance.
* [`CriticalReviewStore`](../packages/daemon/src/critical-review-store.ts) delegates to a separate
  SQLite worker; [disk](../packages/daemon/src/critical-review-disk.ts#L70) uses WAL and FULL
  synchronous transactions. Its records, calls and admissions are not a transaction with the mission
  store. [`CriticalReviewVault.capture`](../packages/daemon/src/critical-review-vault.ts#L115)
  stages and syncs blobs, renames, syncs the directory, then stores the manifest; recovery removes
  incomplete stages. Its manifest digest covers entries/omissions, not all target or run pins.
  Vault reads expose decoded pages, not a byte-preserving acquisition API.
* [`ReviewProducer`](../packages/daemon/src/mission-review-contract.ts#L91) permits unavailable or
  observed-agent with a session ID. [`MissionService.recordReviewResult`](../packages/daemon/src/mission-service.ts#L735)
  uses an optional observer, unavailable when absent, and rechecks mission/project membership.
  [`MissionStore.recordReviewResult`](../packages/daemon/src/missions.ts#L4274) authorizes before
  retry, resolves retained references, rechecks inside its transaction, inserts, then awaits durable;
  result independence and human authorship are unavailable. Its historical four-field review fence
  does not include coordinator events. The [allocation fence](../packages/daemon/src/mission-contribution-allocation.ts#L14)
  adds that field, but neither fence alone is proof of authorship or an atomic cross-store lease.
* [`prepareRetainedReviewInput`](../packages/daemon/src/retained-review-contract.ts) accepts supplied
  bytes, manifest, `sealed:true` and hashes. Its prepared object is private structural identity, not
  a host admission token, actual vault seal or observed execution. Parsing preserves findings,
  omissions and limitations even beside Pass. A historical Pass, recorder, custodian or role never
  establishes authorship, independence, semantic coverage or authority.
* [`finish` and `recover`](../packages/daemon/src/critical-review-accounting.ts#L412) operate on
  ledger rows and release ledger admission, not physical executor ownership. The fake-only
  [`SyntheticReviewer`](../packages/daemon/src/critical-review-runtime.ts#L79) suppresses aborted
  output, but an abortable wait is not proof that an underlying provider operation or worker exited.
  Neither seam supplies a host-owned drain/join/exit acknowledgement.

## Candidate identities and observed origins

The following is a conceptual schema, not a caller-writable API. Digests are domain-separated,
canonical and versioned; equality is exact and array order material. IDs are host-issued opaque IDs.

```ts
type RetainedTargetV1 = {
  kind: "retained-non-code"; hostId: Id; daemonLineageId: Id;
  projectId: Id; missionId: Id; taskId: Id;
  ownerSessionId: Id; coordinatorSessionId: Id;
  assignment: Assignment; sharedDefinitionRevision: number;
  submissionId: Id; allocationId: Id; allocationContextFence: AllocationFence;
  inputSha256: Sha256; manifestId: Id; manifestSha256: Sha256;
  profileId: Id; profileRevision: number; profileSha256: Sha256;
  contextSha256: Sha256; runtimeSha256: Sha256;
};
type HostRunBindingV1 = {
  runId: Id; targetId: Id; admissionId: Id; lineageId: Id;
  inputSha256: Sha256; profileSha256: Sha256; contextSha256: Sha256;
  runtimeSha256: Sha256; evidenceId: Id; contextId: Id;
  provider: string; model: string; accountBinding: OpaqueNonSecret;
  configObservationId: Id; channelGeneration: Id;
};
type HostProducerV1 = {
  kind: "host-retained-run"; runId: Id; admissionId: Id;
  completionId: Id; rawSha256: Sha256 | null; bindingSha256: Sha256;
};
type CallObservationV1 = {
  observationId: Id; runId: Id; callId: Id; bindingSha256: Sha256;
  // Exact host-observed transport/provider reason, or explicit unobserved.
  stop: { kind: "observed"; source: string; exactReason: string }
      | { kind: "unknown" };
};
type UsageObservationV1 = {
  observationId: Id; runId: Id; callId: Id; bindingSha256: Sha256;
  receiptSource: OpaqueNonSecret; receiptIdentity: OpaqueNonSecret;
  input: number; generated: number; durationMs: number;
};
type RunCompletionV1 = {
  completionId: Id; runId: Id; bindingSha256: Sha256;
  terminalCallId: Id | null; // null if no call yielded a terminal report
  hostTermination: { kind: "observed"; source: string; exactReason: string }
                 | { kind: "unknown" };
  raw: { kind: "bytes"; sha256: Sha256; bytesRef: OpaqueRef; length: number }
     | { kind: "no-output"; reason: string }
     | { kind: "unknown" };
  usageAtCompletion: { kind: "observed"; usageObservationIds: Id[] }
                   | { kind: "unknown" };
};
```

Each call has its own call ID and may have distinct transport and usage observations; a run has
one terminal completion ID, potentially after several calls. Preserve exact bounded host-observed
reason and source, including length, timeout, cancellation, unavailable and unfamiliar reasons,
without coercing them to a coarse success/failure category. `no-output` is an observed absence
with its reason; `unknown` means absence or output cannot be established. Zero-length bytes are
bytes, not either case. The raw report and its digest are nullable only through these explicit
variants. A no-output completion does not become an observed review result.

D38's [`parseRetainedReviewReport`](../packages/daemon/src/retained-review-contract.ts) separately
parses a **model-reported** `state` of `completed`, `failed`, `partial`, `length`, `timed-out`,
`cancelled` or `unavailable`. That claim exists only if raw bytes parse and must never replace,
be inferred from, or rewrite the host's transport/termination observation. Contradictions and
unparseable or absent output remain visible and unavailable for a successful projection; exact
interpretation policy remains unselected. A successful transport stop does not imply model Pass.

`lineageId` here denotes a host-issued reviewer execution lineage, distinct from daemon lineage
and from any author session. The admission must also record known author lineage with explicit
unknowns and the basis of observation, not infer it from custody. An unknown author set cannot
qualify a policy requiring proven independence. A fresh reviewer lineage and fixed context give
procedural separation only, not OS isolation, diverse judgment or proof of semantic coverage.

| Pins | Host facts required before admission, not caller assertions |
| --- | --- |
| Host, daemon lineage, project, mission, task | Current local host/daemon identity, canonical project/mission relationship, exact task resolution and current coordinator authorization. |
| Owner, coordinator, assignment and definition | Current membership and owner, full assignment and shared definition revision, plus monotonic ownership/assignment/coordinator generations or equivalent event fences; matching IDs after A→B→A is insufficient. Existing task/result schemas alone do not supply every proposed generation. |
| Submission, allocation and five-field fence | Exact retained submission and currently active allocation selecting exact references, plus brief/decision/artifact/member/coordinator events. Allocation identity and current state must catch withdraw/reallocate ABA even if bytes repeat. Later allocation is not original task attribution. |
| Input and manifest | Authorized exact retained reference/revision, kind, custodian, original bytes and reference observations; actual vault-seal/store lookup, selected blob IDs, source erasure state and original-byte hashes. No `latest`, display decoding or reopened deleted blob. D38's input hash binds supplied structure only. |
| Profile and context | Current profile revision and complete rubric, intended criteria, policy and relevant context package, including missing/conflicting material and fence. An opaque package hash is not an independently observed resolver or approval. |
| Runtime and lineage | Host observation of actual build/config, concrete provider/model, prompt/tool/output versions, retry/routing and non-secret account or credential-generation binding at send; private worker channel and new lineage. Existing runtime/bootstrap does not establish all of these facts. Never retain credentials or assume account binding from a model label. |
| Completion and producer | Host receives terminal report or establishes explicit absence on its private channel for this admitted run, preserving call-bound transport and usage observations separately before parsing. Provider-reported reasons are attributed as such; arbitrary callbacks, selected model and supplied hashes are not host observations. |

Runtime or access changes require fresh admission, not silently retargeting a run. This schema does
not assert that current sources can attest these facts. Current `CriticalReviewRun` has no binding,
raw completion, account observation or producer linkage; `MissionReviewResult` has no standalone
host-run variant and its output schema need not encode all D38 claims. Versioned additions and an
explicit lossless projection are needed; never coerce, truncate, drop findings or retrofit old rows.
Unsupported legacy readers must fail closed or receive an explicitly unavailable representation,
not misread a new kind as a session/PR or agent. Schema/version negotiation and migration are
separate work, not authorized here.

## Budget identity is separate from immutable target identity

The ledger currently enforces effort ceilings low $1, medium $4, high $10 and session $4, plus
tokens/duration, a shared $20/24h and token ceilings, two active runs, one active target, final
reserve and a bounded classifier. It requires matching structured approval, provider/model/billing,
current rate and usage gates. See [`REVIEW_PROFILES`, `admit` and `reserve`](../packages/daemon/src/critical-review-accounting.ts#L15).
Subscription pricing is represented separately from API pricing, without a paid fallback. These
limits are ceilings, not an authorization to spend or a new consent. No mapping may bypass or reset
them by manufacturing new targets, calls, billing modes or profiles.

Candidate **total** mapping, with an explicit exhaustive switch and unknown-kind rejection:

| Target | Option A, logical budget/concurrency key | Option B, coarser key | Effort |
| --- | --- | --- | --- |
| session | existing host/project/session | same | existing session profile only |
| pull_request | existing host/project/repository/number | same | existing low/medium/high, trusted floor |
| retained-non-code | host/project/mission/task, stable across allocation, revisions and rechecks | host/project/mission, serializing all its tasks | separately approved low/medium/high mapping or deny; never default to session |
| unknown / unsupported | deny | deny | deny |

Option A is a candidate for preventing per-revision concurrency evasion without coupling unrelated
tasks. Option B is simpler but serializes unrelated tasks. A target's full immutable pins still
identify its particular run; the key is not evidence identity. Neither option decides whether an
additional cumulative per-target allowance, approved effort floor, classifier, allocation scope or
mission-wide budget is appropriate. Existing per-run and rolling ceilings continue across rechecks;
only a separately trusted allowance and consent could admit any future send. Escalation rules and
billing cannot be relaxed. Explicitly resolve whether concurrency keys survive task replacement or
project transfer before implementation. No budget policy is selected here.

## Proposed ordered protocol and recovery

The **four linkage stages** are admission, dispatch accounting, raw run completion and mission
projection (1–4). The separately described later effect is outside this linkage. These are
requirements for a future implementation, not existing atomic guarantees. A stable host-issued
operation ID identifies each immutable transition. Exact repeats return the same result; the same
ID with a different canonical payload is a conflict. Completion and call usage are distinct IDs.
No user-controlled callback or generic external result endpoint may mint a host producer.

1. **Admission:** authorize the current coordinator and project, snapshot and verify all pins and
   ABA fences, resolve only selected authorized retained bytes, seal through the actual vault, and
   prepare the structural input from those exact bytes. Reauthorize and recheck all fences after
   async work and immediately before dispatch. Record a durable immutable host admission/binding
   tied to target, evidence, context and a private worker channel. If an observation cannot be
   established, admission is unavailable. This needs a new trusted adapter, not D38 alone.
2. **Dispatch accounting:** create a durable reservation for each unique call, then commit the
   single-use `send` claim before any provider I/O. Existing
   [`send`, `settle`, `recover`](../packages/daemon/src/critical-review-accounting.ts#L337) implement
   this ledger pattern, not the missing host binding. A lost dispatch ACK or crash after send is
   Unknown, never a replay; restart converts reserved/sent to uncertain. Unknown usage retains
   reservation conservatively. Exact trustworthy call-bound usage may settle later through the
   append-only observation process below; conflicts do not refund.
   A provider overrun raises the existing ledger fence. Do not equate a ledger sent bit with actual
   receipt, terminal output or a successful review.
3. **Raw run completion:** only the admitted private channel can submit the one run-terminal
   observation. Persist the immutable completion, exact host termination, terminal call ID or null,
   raw bytes/digest or explicit no-output/unknown, and usage knowledge *at that moment* on the
   critical-review side before interpretation or mission notification. Durably compare-and-insert
   one completion ID per run. An identical duplicate is a no-op; conflicting or second distinct
   terminal callback for that run is quarantined, never overwrites or produces a new review. A late
   output after cancellation/erasure must not restore content or create a projection. Existing
   ledger has no raw completion store or atomic completion transaction.

   Call transport observations and later usage receipts are separately identified, append-only
   call-bound facts, not terminal callbacks. A completion with `usageAtCompletion: unknown` remains
   byte-for-byte immutable when a trustworthy receipt arrives. Authenticate its provenance, bind it
   to the exact admitted run/call/rate/billing and append a unique receipt observation, then settle
   the ledger by call ID without rewriting completion or resending. Same receipt identity and exact
   canonical payload is idempotent; changed payload under that identity, wrong binding, or a second
   trusted receipt with different usage for an already settled call is a conflict requiring host
   reconciliation, not replacement or refund. A separately identified receipt with identical usage
   may be retained as corroboration, but must not settle twice. Unknown/untrusted receipts leave the
   conservative charge unchanged. Preserve receipt evidence and the ledger's overrun fence. Existing
   [`settle`](../packages/daemon/src/critical-review-accounting.ts#L369) compares settled usage and
   rejects conflicting values, but does not itself provide this append-only provenance journal.
   Completion, usage-observation append and settlement need an explicitly designed transaction or
   replay-safe ordering; recover missing steps by exact IDs, without provider I/O or duplicate charges.
4. **Mission projection:** independently reauthorize current coordinator before exact metadata
   lookup. Verify durable binding/completion and its digest, current task, owner, allocation,
   submission, profile, assignment and all generations/fences; do not reopen source blobs merely to
   discover whether a completion exists. Only if authorized and still current, obtain any required
   retained input via an authorized byte-preserving lease, parse exact raw bytes and preserve every
   finding, coverage gap and limitation. Write a versioned mission history record with an exact
   completion ID/digest and unique projection operation ID; in its transaction repeat current fences
   and enforce uniqueness, then await mission `durable()` before ACK. Release leases and reauthorize
   again after every asynchronous boundary and after durability before returning protected data.
   A stale or revoked run stays historical/unavailable, not a fresh result. A parsed Pass remains a
   model claim. If no valid lossless mapping exists, store no misleading mission projection.
**Outside linkage, later effect:** a separate future authority evaluates applicable, current evidence, coverage,
   findings, required checks and independently trusted approval/human origin. It must recheck its
own fences at effect time. Neither projection nor accounting nor completion is approval,
acceptance, a gate pass, a human action or permission to dispatch again.

Crash before reservation means no call; after reservation or send means uncertain and no resend.
Crash after raw durability but before mission append permits only exact lookup and reauthorization;
after append but before `durable()` or its ACK, query the exact projection operation, await mission
durability and reauthorize before returning. An absent lookup is point-in-time absence, not proof
that no concurrent writer will commit. A conflict, unavailable store or failed durability remains
Unknown. There is no distributed transaction: serialize per-run transitions and make immutable
IDs/unique insertion and durable acknowledgement explicit. A missing completion is never rebuilt
from a model claim or promoted historical Pass. Recovery must not call a provider.

### Executor capacity is not ledger capacity

The future host must retain a separate executor-slot ownership and generation fence, signal stop,
drain its owned work and channels, join the owned worker and establish confirmed exit before it
reuses that slot or starts replacement work for it. A timeout, lost owner, unjoined child, failed
drain or unprovable exit leaves capacity unavailable/Unknown, including across host restart; a new
generation cannot merely assert the old one is gone. The exact durable ownership and OS/process
verification mechanism is unimplemented and requires separate validation. Ledger `finish` or
`recover`, an inactive admission, settled/uncertain charges, an abort signal or suppressed output
cannot prove quiescence. Preserve worst-case uncertain charges independently of this slot fence;
late-output suppression prevents effects but does not free capacity or establish physical exit.

### Lookup, retention and revocation

Authorize canonical current coordinator/project/mission membership before lookup, and again after
each awaited read and `durable()`; deny or return a non-disclosing unavailable status on revocation.
Exact recovery of an existing projection may precede mutable freshness checks only after current
authorization, and must not reopen content. It returns historical identity, never present eligibility.
For a *new* projection, freshness and allocation checks are mandatory. The existing vault
[`eraseSource`](../packages/daemon/src/critical-review-vault.ts#L344) tombstones before unlink, and
serial read/delete leases plus a second manifest check prevent reads after acknowledged erasure.
Future raw reports, bindings, indexes, mission projections and all source IDs require a reviewed
cross-store erasure policy and race barrier: tombstone first, block recovery/projection, drain
readers, then erase content and derived copies. Whether minimal accounting metadata may remain is
an unresolved retention/legal policy, not a promise to erase ledger obligations. No hash or opaque
reference is permission to reopen revoked blobs. Existing vault erasure does not automatically
provide this cross-store guarantee.

## Negative controls for a later implementation

| Case | Required outcome |
| --- | --- |
| Absent observer/producer, forged session, copied prepared object or self-supplied seal | Unavailable/reject; no admitted host producer. |
| Owner or coordinator A→B→A, release/reclaim, allocation withdraw/reallocate, assignment/definition change | Generation/fence mismatch; old run cannot dispatch or create current projection. |
| Profile/context/runtime/account change, stale input, changed lineage or mismatched selected bytes | Reject admission or mark obsolete; no retarget, fallback or inference. |
| Same terminal callback repeated, or conflicting second callback | One immutable run completion; exact duplicate no-op, conflicting callback quarantined. |
| Unknown usage at completion, later trustworthy receipt, duplicate or conflicting receipt | Append call-bound observation; completion bytes unchanged. Settle once; exact duplicate no-op, conflicting value/binding quarantined without refund. |
| Multiple calls, null terminal call, empty raw bytes, no output, timeout/length/unavailable | Preserve call IDs and exact observed reason; distinguish bytes, no-output and unknown; never synthesize model state. |
| Host stop reason contradicts parsed D38 state, or raw report is malformed | Preserve both separately; no successful projection from contradiction or parse failure. |
| Ledger recovered/finished while worker ignores abort or exit is unconfirmed | Keep execution slot fenced; no replacement until owned work drained, joined and confirmed exited. Unknown charge and suppressed output remain separate. |
| Lost send/terminal/projection ACK or crash at each boundary | Exact metadata reconciliation only; Unknown when unproven; no provider resend or inferred effect. |
| Usage missing, partial terminal, malformed report, timeout or late result | Conservative uncertain charge as applicable; retain permitted raw observation; no implicit success or completed Pass. |
| Revoked membership, erased/expired source, unlink/relink, lookup race | Deny/recheck; no reopened blob or resurrected derived report. Historical lookup is not current eligibility. |
| Valid Pass with high findings, omitted criteria, unobserved authorship or unsupported diversity | Preserve claims and gaps; no semantic coverage, independence or authority promotion. |
| Legacy reader, schema unknown, unrelated project, fake synthetic run | Explicit unavailable/reject; no reinterpretation as a host production run. |

## Recommended next inactive slice and validation questions

After coordinator validation, a narrowly scoped **pure, uninstalled** target/binding and producer
contract could validate exhaustive discriminants, exact IDs/digests, duplicate/conflict behavior and
total budget-key mapping using fixtures only. It must have no store writes, migration, runtime import,
observer, transport, provider/account operation or gate effect. Keep the retained kind disabled
until its mapping is expressly chosen; existing session/PR behavior must remain unchanged. This is
a proposal for a separately authorized task, not an implementation instruction.

Coordinator/user validation is needed for budget-key option and effort/floor, whether accounting
needs cumulative target limits, version/compatibility and retention boundaries, authoritative ABA
generations, context/runtime/account observation, lossless mission projection, and separate trusted
approval/consent. Coverage, model/provider diversity and eventual authority remain policy choices.
Missing byte-preserving vault access, real host admission/producer, cross-store atomicity or safe
reconciliation, lifecycle erasure hooks and independently attested authorship are source-backed
blockers. They cannot be supplied by this document or fake-provider tests. No adoption/backfill,
production executor, live review, cleanup or release follows.
