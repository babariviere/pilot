# Retained review run linkage

**Linkage design with selected D54/D55 policy, not an adopted schema or execution authority.**
The detached D39/D40 foundations below do not install an executor. D54/D55 select native-action/
consent implementation, not a provider call, grant, migration, observer, review submission or gate.
The [production bridge](mission-production-review-bridge.md) and its D38 foundation remain the
baseline. Balanced minimums, force OFF, existing billing and ceilings remain unchanged. Normal
Bash, jobs, ask_user, credential helpers and account behavior are outside this proposal.

## Observed seams and missing facts

* [`CriticalReviewTarget`](../../packages/protocol/src/critical-review.ts#L23) identifies only a
  session snapshot or PR. [`validateReviewRecord`](../../packages/daemon/src/critical-review-disk.ts#L21)
  rejects other kinds. [`ReviewAccountingDisk.admit`](../../packages/daemon/src/critical-review-accounting.ts#L151)
  keys session by session ID and PR by repository/number, and couples session to the session
  effort. Neither can represent a retained non-code task. A made-up session or PR changes accounting
  semantics and falsely suggests provenance.
* [`CriticalReviewStore`](../../packages/daemon/src/critical-review-store.ts) delegates to a separate
  SQLite worker; [disk](../../packages/daemon/src/critical-review-disk.ts#L70) uses WAL and FULL
  synchronous transactions. Its records, calls and admissions are not a transaction with the mission
  store. [`CriticalReviewVault.capture`](../../packages/daemon/src/critical-review-vault.ts#L115)
  stages and syncs blobs, renames, syncs the directory, then stores the manifest; recovery removes
  incomplete stages. Its manifest digest covers entries/omissions, not all target or run pins.
  Vault `read` exposes decoded pages; the host-only `readExact` helper described below returns
  selected original sealed bytes. Neither acquires original live artifact revisions.
* [`ReviewProducer`](../../packages/daemon/src/mission-review-contract.ts#L91) permits unavailable or
  observed-agent with a session ID. [`MissionService.recordReviewResult`](../../packages/daemon/src/mission-service.ts#L735)
  uses an optional observer, unavailable when absent, and rechecks mission/project membership.
  [`MissionStore.recordReviewResult`](../../packages/daemon/src/missions.ts#L4274) authorizes before
  retry, resolves retained references, rechecks inside its transaction, inserts, then awaits durable;
  result independence and human authorship are unavailable. Its historical four-field review fence
  does not include coordinator events. The [allocation fence](../../packages/daemon/src/mission-contribution-allocation.ts#L14)
  adds that field, but neither fence alone is proof of authorship or an atomic cross-store lease.
* [`prepareRetainedReviewInput`](../../packages/daemon/src/retained-review-contract.ts) accepts supplied
  bytes, manifest, `sealed:true` and hashes. Its prepared object is private structural identity, not
  a host admission token, actual vault seal or observed execution. Parsing preserves findings,
  omissions and limitations even beside Pass. A historical Pass, recorder, custodian or role never
  establishes authorship, independence, semantic coverage or authority.
* [`finish` and `recover`](../../packages/daemon/src/critical-review-accounting.ts#L412) operate on
  ledger rows and release ledger admission, not physical executor ownership. The fake-only
  [`SyntheticReviewer`](../../packages/daemon/src/critical-review-runtime.ts#L79) suppresses aborted
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

D38's [`parseRetainedReviewReport`](../../packages/daemon/src/retained-review-contract.ts) separately
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

### Inactive host accounting implementation

`retained-review-runs.ts` is an uninstalled host seam. `retained-review-run-disk.ts` runs in the
existing critical-review SQLite worker (schema 4). It adds an explicit `retained-non-code` target,
not a synthetic chat or PR. Admission pins the structural target, actual sealed manifest, exact
prepared input descriptor, profile/context/runtime, channel generation and account configuration,
plus the exact current `WorkflowConfirmations.current(mission, true)` record. Production still has
no qualified consent configuration, resolver, provider adapter or installed executor.

The trusted host must provide current task/owner/assignment/allocation/profile/configuration and
ABA authorization checks, byte-preserving acquisition, and a resolved logical task lineage. Those
ports are requirements, not evidence that the production host can establish them. Unknown author
lineage remains unknown. No independent-review or approval claim is created by admission.

Budget rows use **host + mission + logical task**, without target, revision, consent or project in
the spending key. Replacement aliases must resolve to that same logical task. An existing task
cannot change its persisted mission/logical-task mapping; unresolved, cross-mission and cross-host
transfers refuse. The host seam checks the actual local host identity; an existing retained ledger
also refuses a different host namespace. A project transfer cannot reset the key. No generic
replacement/transfer resolver is installed.
Effort is an explicit host selection of the existing low/medium/high profiles, never inferred from
task classification. Their token/time/classifier/final-output bounds and all shared limits remain.
The additional lifetime money limits are $4/logical task and $20/mission, including uncertain
reservations, all revisions/rechecks and renewed consent. A new consent is never a new allowance.

The existing reserve-before-send ledger consumes each call claim once. Neither recovery nor a
lost ACK permits another send. Recovery closes unfinished retained runs and preserves uncertain
charges. Exact call/usage observations and terminal callbacks are appended with source erasure
provenance and the existing quota. Completion preserves original report bytes, exact termination
reason and usage knowledge at completion. Identical retries do nothing; conflicting callbacks
persist quarantine, never overwrite the accepted completion or refund its charge. Later exact
usage can settle a charge without changing completion. Recovery settles an already committed usage
observation if its subsequent settlement was interrupted. Erased observations are not reopened.
Raw/linkage copies use the existing 30-day raw retention bound (pins/active exceptions remain).

Physical capacity is separate: completion, ledger finish, revocation and recovery do **not** release
the retained executor slot. A host-observed join/drain/exit acknowledgement is required, including
after restart. Its opaque ID is an attribution record, not an implemented process supervisor.

Cross-store projection writes a versioned **completion reference** to `missions.sqlite`, with exact
target, consent operation, producer/binding/completion digests and a unique operation/run pair.
It waits for mission durability and rechecks current consent/access and critical-store availability
before returning. This is history linkage only, not `MissionReviewResult`, parsed Pass, independence,
human approval, checks or gate evidence. No report is coerced into the older review-result schema.
Future consumers must repeat current authorization; a historical reference is never current authority.

`retained-review-runs.test.ts` uses isolated fake host/provider observations, real vault/ledger and
real native-confirmation stores. It does not qualify real configuration, account terms, execution,
physical exit, transmission or spending. No provider send, installed consumer, HTTP/tool surface,
live approval, migration/adoption, attention or acceptance gate is enabled.

The [selected reviewer/consent policy](mission-authority-review-policy.md#2-what-initial-reviewer-consent-coverage-and-non-code-delivery-scope)
is D55: bounded mission-level consent, **$20 total per mission and $4 cumulative per task across
revisions/rechecks**, within all existing shared ceilings. Consent pins disclosed data scope,
provider/model/account, terms and total allowance; it expires at mission end/revocation. Expansion
or renewal needs fresh approval. No automatic account/model switch, paid fallback or silent refill
on replacement/transfer. D54 supplies practical exact native confirmation, not OS isolation or
verified human presence. Neither decision grants current transmission/spend or enables dispatch.

Each immutable target/run remains exact and distinct; budget consumption must aggregate across its
revisions/rechecks and consent renewals cannot silently reset spent/uncertain amounts. Concrete
mission/task ledger mapping, effort assignment and replacement/transfer reconciliation are #59
implementation/qualification gaps. Unsupported mapping blocks admission, not a request for another
policy menu or a fabricated session/PR. Same-model fresh independent evidence-only review is allowed;
unknown author lineage or unavailable producer observation remains a qualification gap.

The ledger currently enforces effort ceilings low $1, medium $4, high $10 and session $4, plus
tokens/duration, a shared $20/24h and token ceilings, two active runs, one active target, final
reserve and a bounded classifier. It requires matching structured approval, provider/model/billing,
current rate and usage gates. See [`REVIEW_PROFILES`, `admit` and `reserve`](../../packages/daemon/src/critical-review-accounting.ts#L15).
Subscription pricing is represented separately from API pricing, without a paid fallback. These
limits are ceilings, not an authorization to spend or a new consent. No mapping may bypass or reset
them by manufacturing new targets, calls, billing modes or profiles.

Required accounting linkage, not an installed target extension:

| Target | Accounting identity / scope | Unchanged constraint or gap |
| --- | --- | --- |
| session | Existing host/project/session | Existing session profile and ceilings remain unchanged |
| pull_request | Existing host/project/repository/number | Existing effort profiles/trusted floor remain unchanged |
| retained-non-code | Stable host/project/mission/task accounting across exact targets, revisions and rechecks; shared mission total | Enforce D55 $4 task/$20 mission totals plus all shared ceilings. Retained effort and concurrency implementation still need qualification; no default to session or new policy value |
| unknown / unsupported | Deny | No guessed mapping or fresh allowance |

D55 chooses cumulative scope and amounts, not a new per-run effort floor or concurrency exception.
Preserve existing bounds, call accounting and conservative uncertain charges. Reconcile task
replacement/project transfer before admitting use; unresolved linkage refuses, never silently
refills either total. A new target/run/consent ID is not a new spending entitlement.

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
   [`send`, `settle`, `recover`](../../packages/daemon/src/critical-review-accounting.ts#L337) implement
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
   [`settle`](../../packages/daemon/src/critical-review-accounting.ts#L369) compares settled usage and
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
[`eraseSource`](../../packages/daemon/src/critical-review-vault.ts#L344) tombstones before unlink, and
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

## Implementation consumers and qualification gaps

#49 captures original retained research/plan inputs at exact local brief/artifact revisions; the
vault cannot acquire missing historical bytes. #52 implements D54 actions and D55 consent/expiry/
revocation. #59 supplies stable cumulative task/mission accounting, exact consent/run linkage,
durable completion/projection and no-replay recovery. #64 installs fresh host-owned evidence-only
execution only under separately admitted authority; same-model is allowed, not diverse judgement
or OS isolation. #35/#36 qualify checks, coverage and current local destination; #19/#72 own later
acceptance. This is consumer scope, not another separate inactive-contract milestone.

Concrete account/terms binding, retained effort mapping, specialist competence, runtime/author
observation, lossless projection, cross-store durability/use-revocation ordering, confirmed executor
exit and cross-store retention/erasure remain unsupported or unqualified. Existing 30/90-day local
critical-review availability is not a provider erasure guarantee or new annotation policy.
The detached supplied-claim module below proves none of these. D55 closes consent/budget/domain/
same-model policy; it does not waive any missing observation or authorize installation, spending,
gate activation, adoption/backfill, cleanup or release/restart.

Source recheck: `cc51bb4af2ddc094618a9e8fb3514891705f76d9`,
`critical-review-accounting.ts:15-20,151-215,263-305`,
`critical-review.ts:23-36,96-109`, `retained-review-linkage-contract.ts:706-710` and
`mission-review-contract.ts:91-125`. Targets/approval remain session/PR/run-bound, dispatch stays
disabled and mission result independence/human authorship remain unavailable. Historical proposal
anchors below describe their own implementation slices, not current production qualification.

## Inactive linkage implementation status (D39)

[`retained-review-linkage-contract.ts`](../../packages/daemon/src/retained-review-linkage-contract.ts)
implements only six detached, deeply frozen **supplied claim** snapshots: target, run binding,
call observation, usage observation, completion and producer. It has no production importer,
executor, observer, storage, transport or accounting consumer. `retainedReviewDispatchStatus()`
always returns frozen `{enabled:false, reason:"retained-dispatch-disabled"}`. No retained effort
or budget key is implemented; existing session/PR accounting, accounts, Bash, jobs and ask_user are
unchanged. The conceptual storage/execution schema and protocol above remain proposals.

The exported parsers accept unknown public data and strictly snapshot each whole argument aggregate
before helpers or hashes. `RETAINED_REVIEW_LINKAGE_LIMITS` bounds that aggregate to 64 KiB JSON,
4096 visited nodes, depth 16, 256 own keys per object, 128 elements per dense ordinary array,
32 call observations, 32 usage observations and 20 claimed author lineages. IDs are 1–128 ASCII
letters/digits/underscore/hyphen; SHA256 strings are 64 lowercase hex characters. Reasons are
1–2000 UTF-16 units and sources/provider/model are 1–256, preserved exactly without trimming or
normalization. Raw-output length claims are 0–50 KiB. Integers are nonnegative safe integers
(definition/profile/assignment revisions start at one). Overflow refuses, never clips. Accessors,
toJSON functions, cycles, symbols, exotic objects, sparse arrays and noncanonical/out-of-range
array properties are rejected; reflection is not isolation against arbitrary Proxy traps.

`retainedReviewLinkageDigest(kind,value)` shape-validates one of the six snapshots and hashes
`["retained-review-linkage",1,kind,value]` with existing canonical `deliveryDigest`. It does not
validate unavailable parents. Contextual parsers additionally compare exact supplied parents:
target ID **and** digest, input/profile/context/runtime hashes, evidence/manifest identity,
run/binding, call-bound usage and known claimed billing. Completion resolves its nullable terminal
call and any nonempty unique captured usage IDs against supplied observations. Multiple distinct
observations of the same bound call may retain different provider/transport reasons, including
unknown then observed. This is neither latest-wins nor a claim that either source is authoritative.

`compareRetainedReviewTargetInput(target,binding,input)` compares every overlapping task, owner,
assignment, definition, allocation, submission, policy, manifest, profile and five-field context pin,
plus binding run/provider/model/evidence identity. It recomputes D38's exact public profile, context,
runtime and input digest domains from the supplied descriptor before comparing hash labels. This
is **public structural consistency only**, not D38 WeakMap/preparation membership, original-byte
validation, full descriptor/profile semantic validation, actual vault sealing or admission. A copied
or self-consistently fabricated structure can pass. Account `configSha256` is a separate claimed
domain: `deliveryDigest(["retained-review-linkage",1,"account-config",nonSecretAccountConfiguration])`.
The configuration is not acquired or verified here; this hash is never equated with D38's full
runtime `configSha256`. Unknown account/author lineage remains explicit, not inferred consent or
independence. The `host-retained-run` producer name denotes a supplied claim, not a host callback.

`compareRetainedReviewClaims(kind,left,right)` does shape-only pairwise comparisons:

- Exact whole canonical snapshots replay. Same target ID with changed pins conflicts; fresh target
  IDs are distinct, even for the same retained selection (D38 input includes run ID). No budget or
  authority follows a fresh target. Same run ID with changed binding conflicts.
- Reused call observation IDs with changed bytes conflict. A call ID rebound to another run/binding
  conflicts; distinct observations for the same bound call are distinct supplied facts.
- Usage with reused observation ID or receipt-source/receipt-identity pair and changed bytes conflicts,
  even across runs/calls. Only different observation and receipt identities with the same exact
  run/call/binding/rate/billing/input/generated/duration corroborate. Changed binding, rate, billing
  or usage for the same call conflicts. Other nonaliased call identities are distinct.
- Same run with a different completion ID conflicts, as does the same completion ID on another run.
  Producer comparisons also conflict on reused run or completion identity. Other identities are distinct.

These results are not a journal, durable idempotency, quarantine, settlement, charge/refund, callback,
or physical-quiescence proof. Completion captures usage knowledge immutably; supplying later call-bound
usage never rewrites that snapshot. Zero-length raw bytes, observed no-output with its exact reason,
and unknown raw output remain distinct. Host termination never synthesizes or overrides D38's separately
parsed model state/outcome/findings. No raw bytes are read or interpreted by this module.

Fixture tests cover these comparisons, every pin and mismatch, stale hash labels, strict data bounds,
detachment, exact reasons and later usage without terminal mutation. Existing D38 tests remain unchanged.
Equality or parser success establishes no host admission, observed execution, seal, provenance,
independence, current access, budget/consent, human origin, physical exit, projection or acceptance.
No production calls, persistence/migration, grant, gate, adoption/backfill, learning, cleanup or
release/restart follows. Production qualification and the named implementation gaps above remain blocked.

## Exact-byte vault read implementation status (D40)

`CriticalReviewVault.readExact(request, signal?)` is a host-only helper used by persisted brief acquisition below.
Its typed internal request pins one manifest ID/digest and 1–20 selected blob IDs/digests/lengths.
It snapshots the request before waiting, resolves the sealed manifest through the existing store,
checks pins, duplicate blob IDs and membership, then verifies every original file length and SHA256.
Selected blobs are capped at 1 MiB each and 8 MiB total before blob allocation. Request order is
preserved. Results contain detached stored manifest metadata and `{blobId, sha256, length, bytes}`
copies, including original BOM, CRLF, multibyte UTF-8 and zero-length bytes without text conversion.
The manifest digest still covers entries/omissions only, not its header or present authority.

The existing vault queue serializes the read interval against same-vault erasure. Handles close
before the final manifest/availability and cancellation checks. Cancellation suppresses the result
and releases the queue after in-flight I/O/close completes. Reads do not refresh retention. Erased,
tombstoned or expired manifests cannot be reopened through this helper. Returned copies are not a
continuing lease: later erasure cannot recall them, and later use needs its own authorization checks.
The final store recheck detects observed revocation or metadata changes, not an atomic barrier
against another owner changing state immediately afterward. Existing path checks, no-follow opens,
file stats and digest checks are not isolation from a hostile filesystem or mutable ancestors.

This small helper trusts typed host input and the existing local store. It adds no generic hostile
object parser or pre-hydration metadata guard: `store.get` still loads/JSON-parses the record under
the store's existing behavior (normal writes cap record JSON at 4 MiB). Direct database tampering
is outside that size guarantee. Caller-supplied pins or `sealed` claims cannot replace the lookup;
successful reads are neither admission nor delivery/acceptance evidence. Capture, retention,
deletion, text reads, accounting and transport are unchanged. Retained dispatch stays disabled,
force stays OFF, and production review/observation/acceptance remain blocked.

## Persisted brief acquisition

`MissionService.captureRetainedBrief(sessionId, taskRef, revision, host, signal?)` acquires one
explicit local persisted brief revision, seals host-selected bytes through `CriticalReviewVault.capture`,
then reopens with `readExact` and prepares the existing retained-review input. It returns either
`{state: "captured", input}` or `{state: "partial", manifest}`. Vault omissions (including secrets and
binary content) never become a prepared empty substitute. Quota, missing/stale revisions, revoked access,
changed bindings/configuration and cancellation reject. There is no endpoint or agent-tool action.

`MissionStore.briefExact` requires an exact positive revision. SQL bounds `length(CAST(markdown AS BLOB))`
before transferring the BLOB, with the existing input/vault 1 MiB per-blob limit. These are exact UTF-8
bytes **as persisted in immutable brief history**, including BOM, CRLF, multibyte and empty content.
Create/write still trim submissions. Discarded pre-trim bytes are unavailable, not reconstructed.
Decoded fields are used only for the existing reference-observation digest, never as captured bytes.
Artifact acquisition is unsupported: parsed/derived source/data fields are not original stored bytes.

The trusted host supplies the existing vault, host/daemon-lineage/run IDs, profile selection,
context-package digest, runtime build/config/model/prompt/tool pins and known secrets. It must observe
that configuration, not accept request digests as proof. The service derives mission/project/task,
assignment/definition, owner/coordinator, context fence, current policy/submission/allocation and exact
profile from live records. The current allocation must select only that brief. It reauthorizes current
coordinator/project and worker membership/project before and after durability and vault I/O. Existing
event fences catch coordinator/member and artifact unlink/relink churn, even when values return.

The host can retain `input.descriptor` and call
`reopenRetainedBrief(sessionId, taskRef, descriptor, host, signal?)` after vault restart. The descriptor
is bounded and structurally parsed, but grants no access. Reopen repeats current authorization and
binding checks, compares current raw bytes/reference identity, and checks the real sealed manifest and
selected blob through `readExact`. Old revisions remain in history but changed context is refused,
not reopened as current or replaced with latest. Erased/expired evidence is unavailable. Cancellation
suppresses returned input; a manifest sealed before cancellation or a post-I/O fence failure may remain
under ordinary vault retention. Neither capture nor reopen refreshes retention or initiates cleanup.

This is acquisition/preparation only. No synthetic session/PR target, generic store, review/provider
execution, spending, review-result write, approval, acceptance gate, migration or backfill is installed.
Context/config pins are still host-supplied observations, not qualified execution or authority.
