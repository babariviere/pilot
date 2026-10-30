# Production reviewer bridge and independence contract

**D37 design proposal only.** Source baseline: `d82df2b3cac4be1c9aa4e23e65d68377f273569f`.
This document does not select binding review policy, authorize provider/account execution, install
an observer, submit a review or activate acceptance. A is inert; B (#35), C (#36) and D (#19)
remain incomplete. Preserve Balanced minimums, force **OFF**, mandatory passing checks, current
custody/Ask boundaries and existing account/provider behavior. No waiver, historical attribution,
adoption/backfill, retirement, cleanup or restart follows from this proposal.

## Observed seams, not inferred capabilities

Line ranges below refer to the source baseline; symbols are the durable navigation anchors.

| Source | Observable behavior | Missing guarantee |
| --- | --- | --- |
| [`daemon.ts:240`](../packages/daemon/src/daemon.ts#L240), `new MissionService`; [`mission-service.ts:735–759`](../packages/daemon/src/mission-service.ts#L735), `recordReviewResult` | Production supplies no `reviewProducerObserver`; absent observer returns unavailable. An observed agent must still belong to this mission/project | No production producer observation or independence |
| [`mission-review-contract.ts:91–125`](../packages/daemon/src/mission-review-contract.ts#L91), `ReviewProducer`/`MissionReviewResult`; [`missions.ts:4274–4370`](../packages/daemon/src/missions.ts#L4274), `recordReviewResult` | Producer can only be unavailable or observed-agent with a **session ID**. Store resolves retained refs, fences assignment/profile/context, appends and awaits durability; independence/human authorship stay unavailable | A standalone run cannot be represented by inventing a chat ID. Installing an observer alone cannot establish independence |
| [`session.ts:581–679`](../packages/kernel/src/session.ts#L581), `KernelSession.open`; [`native-adapter.ts:334–404,412–598`](../packages/kernel/src/native-adapter.ts#L334), `NativeAdapter.open` | Native model proxy uses the owning registry; normal Build loads resources/tools, jobs and subagents. Ask has an explicit restricted factory. `Harness.open` at [`session.ts:761`](../packages/kernel/src/session.ts#L761) owns the durable loop | Ordinary Build/Ask/subagent sessions are not this review capability boundary or proof of independent context |
| [`critical-review-runtime.ts:79–173`](../packages/daemon/src/critical-review-runtime.ts#L79), `SyntheticReviewer` | Rejects providers unless `kind === "synthetic"`; bounded turns/context, reserve/send/settle, abort suppression | No real provider bridge, tokenizer enforcement, complete physical cancellation/join or production qualification |
| [`review-boundary.ts`](../packages/kernel/src/review-boundary.ts), `RestrictedReviewBoundary`; [`critical-review-runtime.ts:8–63`](../packages/daemon/src/critical-review-runtime.ts#L8), `sealedReviewPort` | Only fixed-manifest evidence list/read/literal-search. Host checks names/arguments on every call; 256 attempts, three retained I/O slots, 50 KiB results, 10s reads | No acquisition authorization, semantic coverage or trust in evidence prose |
| [`critical-review-accounting.ts`](../packages/daemon/src/critical-review-accounting.ts), `ReviewAccounting`; [`critical-review-store.ts`](../packages/daemon/src/critical-review-store.ts), `CriticalReviewStore` | Durable single-use send claims, numeric budgets, recovery to uncertain, bounded off-thread store. Grants/rates/gates are trusted host inputs | No authenticated grant writer, live rate verifier or installed real executor. Ledger facts do not prove output quality |
| [`critical-review.ts:23–35`](../packages/protocol/src/critical-review.ts#L23), `CriticalReviewTarget`; [`critical-review-accounting.ts:151–220`](../packages/daemon/src/critical-review-accounting.ts#L151), `admit` | Targets are session or PR only; accounting keys/constrains those target kinds | Retained non-code task target, budget mapping and mission-run linkage are absent, not reusable by relabeling a session |
| [`visual/index.ts:37–110`](../packages/artifacts/src/visual/index.ts#L37), `checkVisual`; [`shader.ts:151–165`](../packages/artifacts/src/shader.ts#L151), `assertShaderCompiles` | Visual runtime/WASM load **before** the initial worker timer. Worker termination is awaited; subsequent shader checks are separate stages. Shader publication helper permits unavailable checker | Limited validator candidate, not end-to-end 30s deadline, independent agent review, human visual inspection or acceptance-safe fail-closed wrapper |

The [non-code prerequisite plan](non-code-acceptance-prerequisites.md) separates execution,
inventory and acceptance. [A's policy contract](non-code-acceptance-policy.md) always explains
`eligible:false`. [Critical-review foundations](critical-review-foundation.md) are disabled;
their synthetic boundary tests are not production runtime evidence.

### SDK grounding

Inspected the installed Pi 1.4.0 documentation, matching the kernel/daemon package declarations:
`pi-coding-agent/README.md`, `docs/sdk.md`, its referenced `docs/models.md`, `docs/providers.md`,
`docs/configuration.md`, `docs/security.md`, and SDK examples `02-custom-model.ts`,
`09-api-keys-and-oauth.ts`, `12-full-control.ts`. Also inspected `pi-ai/README.md` and installed
`pi-coding-agent/dist/core/model-runtime.js`, especially `prepareRequest`/`streamSimple` (451–525).
These are package-relative installed paths, not APIs inferred from model knowledge.

SDK facts: `ModelRuntime.create` preserves native model/credential resolution; `streamSimple`
accepts explicit context/tools, `signal`, `maxTokens` and reasoning options and returns a stream
with `.result()`. Request auth is resolved at dispatch; virtual models may route to another model.
Final `AssistantMessage.stopReason` distinguishes stop/toolUse/length/error/aborted; receiving a
resolved result is not success. Tool execution is the caller's responsibility. SDK session defaults
discover resources, may retry, and `dispose()` is not a host-wide child/transport join guarantee.
No documented universal exact tokenizer, hard upstream cancellation or account-identity attestation
is assumed. Catalog limits/prices, optional `responseId` and provider-reported model IDs are not
independently verified facts about vendor internals.

## Options and bounded recommendation

| Option | Reuse | Cost / decision |
| --- | --- | --- |
| Ordinary reviewer chat/subagent through `KernelSession` | Harness storage, native registry/auth, usage and normal lifecycle | Smallest launch change but wrong boundary: resource discovery, tools, steering and author context can leak in. Reject as independence proof; do not remove Bash/jobs from normal sessions to make it fit |
| Dedicated SDK session + fresh Harness and explicit empty resource loader | SDK lifecycle and durable transcripts; full-control example demonstrates explicit resources | Possible, but a new restricted factory, registry, retries/continuation policy and per-dispatch accounting fences are still needed. More lifecycle surface than one bounded review requires; `tools:[]` alone is insufficient |
| **Separate restricted reviewer worker, explicit Pi model requests** | Sealed vault reads, `RestrictedReviewBoundary`, native `ModelRuntime`, critical-review accounting and existing mission history | Recommended design candidate: a small host-owned bounded loop, not a native chat. Needs explicit target/producer schema, trusted admission and real-provider qualification below. Architecture is not adopted by publication |

Proposed call path (none installed): current-coordinator admission in `MissionService` → exact
retained-input preparation → host review owner → restricted worker → `ModelRuntime.streamSimple`
→ terminal validated output → private host completion hook → #17 result/history plus run binding.
There is no general result-ingestion endpoint, new inbox, scheduler or duplicate receipt journal.
Keep `SyntheticReviewer` fake-only as a negative-control fixture; do not widen its provider union.

Reuse the **bootstrap pattern**, not a borrowed session, in [`ModelCatalog.getRuntime`](../packages/daemon/src/models.ts#L416):
[`installCredentialBrokerHooks`](../packages/kernel/src/credential-hooks.ts#L25) before runtime
creation, canonical broker/shared catalog, and the fixed bundled Anthropic transport installer
([`bundled-extensions.ts:84`](../packages/kernel/src/bundled-extensions.ts#L84)). No author
`extensionRunner`, personal/project resource loader, native commands, MCP, codemode, skills or
hooks enter the reviewer. The fixed transport installer is trusted executable bootstrap, not
reviewed input. Existing trusted credential commands/OAuth refresh remain host-side behavior;
do not disable them globally, copy credentials into evidence or introduce a second auth store.
An extension-only/virtual provider requiring arbitrary factories stays unsupported for this lane,
without changing its availability in ordinary chats. Qualify one existing concrete configuration
later; do not select a vendor, new account or paid fallback here.

The model sees only evidence capability definitions. Trusted SDK/provider/bootstrap code remains
in the computing base; a worker process is not an OS sandbox against that code or same-user host
compromise. Account refresh, credential helpers and provider network are not model-callable tools.
Host must own/terminate/join the worker and fence its narrow RPC; it must not inherit author IPC,
workspace handles or an author session affinity/cache identity. Stronger hostile-process isolation
would be a separate architecture decision, not a claim made by this design.

### Named absent prerequisites

1. A trusted, current workflow-approval source and separate data-transmission/spend consent source.
2. An approved independence/context contract, target/budget mapping and supported concrete runtime.
3. A retained non-code target variant with task/submission/input identity in the critical-review
   target, disk validation and accounting key. Existing session/PR keys cannot substitute for it.
4. A host-run producer variant/link in mission review history, not a fabricated `observed-agent`
   session; immutable admission/completion binding and its exact lookup. Existing records remain
   historical claims. No retrofit of old Pass or independence fields.
5. Trusted retained-content preparation into the vault, context/policy resolver, account/config
   fencing, actual token/output enforcement, transport cancellation/join and lifecycle erasure hooks.
6. Private completion projection and freshness consumers, real qualification, plus C/D separately.
   A human-required result also needs its own trusted action; agent execution cannot replace it.

## Proposed run and independence contract

All fields below are requirements for future host admission, not accepted caller assertions.

**Admission and pins.** Host allocates unguessable run/call identities and a private worker-channel
binding, deriving current host/daemon lineage, project, mission, task, coordinator, task owner and
known content authors. Bind full normalized assignment, `sharedDefinitionRevision`, policy ID,
submission/allocation IDs, destination refs, and brief/decision/artifact/member/**coordinator**
event fences. Recheck after async preparation and immediately before dispatch. Owner/coordinator
A→B→A must invalidate; matching current IDs alone are insufficient. Unknown authorship remains
Unknown and blocks an independence requirement that cannot be established.

Resolve **exact retained** artifact ID/revision/kind/custodian or brief revision via current
`MissionService` admission/readers. Reuse [`resolveDeliveryEvidence`](../packages/daemon/src/mission-service.ts#L504)
for access and retained identity, not as an executor. Hash the actual original UTF-8 source/data
bytes plus bounded canonical metadata; keep that execution digest distinct from #18's reference
digest. Never hash display-decoded/reformatted text or rendered HTML as a substitute. Seal explicit
selected blobs and omissions through `CriticalReviewVault`; fixed manifest/digests, no `latest`,
live-path fallback, hidden expansion, cross-project reads or acquisition of unrelated chat history.

Pin review profile ID/revision and complete rubric/interpretation, intent/scrutiny, criterion mapping,
approved authority/policy package, requirements versus separately labeled preferences, and relevant
decision contents. Record missing/conflicting context. Pin prompt/tool schema/output schema versions,
runtime/build digest, Pi/transport/validator versions, concrete provider/model/API/endpoint config,
effective thinking/sampling/cache/retry settings, tokenizer/bounds version, verified rate and billing
mode. Retain non-secret account identity or broker credential-generation binding, not tokens. The
current broker/runtime does not itself prove that binding through a send; this adapter is missing.
Normal same-account token refresh must remain supported; account/config changes require readmission,
not pinned secret tokens or a new credential store.
Do not log secret headers/config or treat an arbitrary header/model label as account attestation.

**Required independence.** Reviewer is a fresh host-admitted execution, not the author run, resumed
author conversation, author child or author-controlled completion writer. Host controls immutable
instructions, tool grant, context selection and output capture. No author steering, shared writable
context, author tools/memory, delegation, or author rewrite of raw findings. Author material is
untrusted evidence only. Avoid author rationales/prior judgements initially; if needed for a named
criterion, include explicitly labeled pinned evidence and disclose the resulting anchoring risk.
Host-observed separate execution and fenced context establish procedural separation, not absence
of correlated model errors. A reviewer may not approve its own authored contribution; multi-author
or previously collaborating runs must be checked against the author set. Unknown lineage is not
independent merely because a session/model/role name differs.

**Optional diversity.** Different model, provider or account can reduce correlated failure, but is
not the definition of independence and cannot rescue shared author context or writable outputs.
Whether T1/T2/T3 additionally require diversity, specialist qualifications or a particular context
scope needs an explicit policy decision. Balanced already requires targeted/full/specialist review
and T3 human review; this document neither weakens those floors nor silently adds diversity gates.

**Observed output.** Only the owning host completion hook can bind actual terminal bytes and their
digest to the run/call/admission and effective producer config. A narrated Pass, a submitted judgement
or provider response alone is not authority or proof that criteria were adequately reviewed. Strictly
parse bounded findings, criterion coverage, citations, execution status, limitations and exclusions;
validate citations against sealed byte ranges. Keep failed/partial/timed-out/cancelled/unavailable
separate from completed outcome. A length stop, malformed output or required omitted content cannot
Pass. Preserve findings and counterevidence; author assertions cannot resolve applicable findings.
Current #17 non-code citations name retained references, not byte ranges; the bridge needs an exact
sealed-citation mapping, never a counterfeit code snapshot or an assumption that #17 validates spans.
An exclusion needs an already approved applicability rule and exact reason, never skipped-to-Pass.
Host schema/citation validation cannot prove semantic completeness; qualifying the review profile
requires planted-defect/coverage evaluation, with residual risks stated, not self-confidence scores.

### Bounds, lifecycle and uncertainty

- Retain the existing accounting ceilings: PR low/medium/high $1/$4/$10, session $4, shared rolling
  24h $20/600k input/48k generated. A non-code target needs an explicitly approved **total** mapping,
  not automatic risk→effort or invented session billing. Propose no larger than medium ($4,120k
  input,12k generated,5m) initially, with lower grant allowed, one run/target and at most two/host.
  This candidate ceiling is not spend consent. No classifier is needed initially. Preserve 15%
  final-output allowance; follow-ups, thinking and repeated/cached input consume the same total.
- Candidate loop ceilings: 32 turns, 256 KiB serialized context, 16 KiB host instruction per turn,
  eight tool calls/turn and 50 KiB normalized response, with the existing evidence limits above.
  Enforce byte bounds incrementally, plus model-specific input count including tools/system/results
  and generated/thinking maxima **before each send**, within model context window and grant.
  Byte heuristics are not token proof. Missing qualified tokenizer/conservative upper bound or
  enforceable upstream maximum blocks the selected runtime. Never silently truncate required input,
  compact away evidence, retry, route models or increase allowances to obtain a Pass.
- Reuse `admit` → `reserve` → durable `send` → actual dispatch → `settle` → `finish`; recheck
  current approval, credentials/config, provider availability and usage/subscription gates before
  each send. Direct model calls bypass `NativeAdapter`'s subscription/offline proxy, so equivalent
  host gate integration is a missing prerequisite, not supplied by `ModelRuntime` alone. Preserve
  pauses and existing billing; no forced continuation or subscription→API fallback.
- Start a total deadline at admission/preparation, covering runtime/auth load, all requests, tools,
  parsing and validator stages. Bound stages by remaining total. On cancellation, expiry, revocation,
  store failure or account/context change: close capability admission, abort transport/worker,
  suppress late output, await actual owned work/reader settlement or termination and confirmed
  worker exit, then release execution slots. Prompt abort response is not physical join or proof
  the vendor stopped billing. `reviewAbortable` races the consumer only; synthetic close does not
  qualify this full join. Keep draining/uncertain work visible, not immediately reusable concurrency.
  The execution deadline is not a guaranteed response-time bound: termination/drain may outlast it.
  Existing accounting `recover` releases ledger concurrency; the host must separately establish
  local executor exit before admitting replacements, without claiming vendor-side cancellation.
- Persist the send claim before network dispatch. Lost claim ACK means Unknown: do not dispatch
  speculatively or replay. Crash after claim but before dispatch is still conservatively uncertain.
  Crash/send timeout/unknown usage retains worst-case charge; `recover` must run before admission,
  never replay calls. A fresh review needs a fresh admitted run and consent, not resumed hidden
  effects. Provider response IDs aid exact reconciliation only when actually supported.
- Use existing private critical-review storage for run/accounting and mission SQLite for the #17
  result/run link. They are not one transaction. Persist immutable validated completion first,
  then an idempotent mission projection referencing it, awaiting each store's durability. Recovery
  may reconcile that exact local completion without resending/reviewing; absent/uncertain completion
  cannot produce Pass. A projection failure leaves no effective review until exact reconciliation.
  Specify/test this linkage before code, rather than adding a generic journal or dual green writes.
- Reauthorize current actors before exact lookup and after durability; recovering historical metadata
  never reopens revoked blobs or grants current effect. Changed inputs/profile/context/authority,
  newer result, account binding or erased/expired source makes effect outdated/unavailable while
  preserving history. Revalidate at use: retained applicability, C's live freshness/destination and
  D's current acceptance authority are separate. No review result changes status or lifecycle.

### Limited validator beside, not instead of, review

Candidate `retained-visual-precheck` would execute exactly sealed source/data with frozen seed/clock,
runtime/WASM and checker versions/config, recording initial worker and each GLSL/Metal stage,
availability, cancellation/join and sampling limits. No write/preview/publication path is needed.
`checkVisual` samples views/interactions/draws; it does not establish requirements, usability,
human inspection or all states. A new acceptance wrapper must fail closed on missing checker,
partial stages and unsupported environment. `assertShaderCompiles` cannot be that wrapper.
Brief/other artifact validation requires separately named validators; no blanket validity from kind.
Validator-only implementation leaves B incomplete without authority and required independent review.

## Approval, consent and human origin: separate trace

| Current source path | Fact | Not a trusted approval |
| --- | --- | --- |
| [`server.ts:608`](../packages/daemon/src/server.ts#L608) → [`isAllowedOrigin`](../packages/daemon/src/origin.ts); mission brief/decision routes at [`2666–2736`](../packages/daemon/src/server.ts#L2666) | Origin-bearing browser requests denied; origin-less local clients can write brief/decisions and resolve proposals via default user actor | Loopback reachability/absent Origin/default actor is not authenticated human intent |
| [`MissionStore.writeBrief`](../packages/daemon/src/missions.ts#L2531), [`resolveProposal`](../packages/daemon/src/missions.ts#L5005) | Planner/CAS and user-path restrictions; immutable brief revision; proposal resolution refuses a session actor | Resolving a decision is not exact package approval, review consent or content judgement. `planningVersion:1` is schema admission only |
| [`server.ts:1809–1825`](../packages/daemon/src/server.ts#L1809), message send; [`input-origin.ts:6–25`](../packages/kernel/src/input-origin.ts#L6) | Public messages POST accepts only ordinary request IDs (1–128 letters, digits, underscores or dashes), rejecting internal automatic-producer namespaces. Internally, `native:user:` classifies extension-on-user-behalf presentation; it is not an accepted public prefix | Neither ordinary public request IDs nor internal presentation prefixes establish an authenticated human gesture, original unexpanded intent or approval; prose and caller `human` flags do not either |
| [`GitHubSetupService.load/authenticate`](../packages/daemon/src/github-setup.ts#L87); model-scope PUT at [`server.ts:1385–1402`](../packages/daemon/src/server.ts#L1385) | Private capability file, daemon identity metadata, random token and exact bearer comparison; existing app-action family protects selected host operations | No current mission approval/review action. Token possession alone proves neither a human gesture nor protection against a same-user reader; do not reuse GitHub authority as workflow consent |
| [`CriticalReviewApproval`](../packages/protocol/src/critical-review.ts#L96) → [`ReviewAccounting.grant`](../packages/daemon/src/critical-review-accounting.ts#L437) → `approval`/`admit` | Structured run/target/evidence/provider/model/billing/expiry/allowance checked; grant caller is trusted by construction | No installed trusted app approval/consent writer or verified human-origin adapter; a record or `action:"app_allowance"` cannot authenticate itself |
| [A authority resolution](non-code-acceptance-policy.md#authority-remains-unavailable) | Exact mission-decision digest/event match still reports trusted source unavailable | Coordinator decision reference, saved policy, Pass and judgement never become delegated authority |

Propose three distinct app-owned actions, **not new actions in this change**:

1. Approve the exact brief/policy package: inspectable mission/project/revisions, full contents and
   decision pins, authority/destination/exclusions, tier requirements, force OFF, checks and deferred
   unknowns. Record explicit user intent, current package digest and bounded delegation/revocation.
2. Consent to one review's data transmission and spend: run/evidence/context/provider/model/account,
   billing, retention, total allowance and expiry. Workflow authority does not imply this consent;
   consent to spend does not approve the outcome. Delegated consent, if wanted, needs its own policy.
3. Submit human review of an exact retained package/profile with findings/disposition and explicit
   intent. Opening, read marks, dismissal, silence or model-classified assent do not count. Required
   human review remains unavailable until this source is separately admitted and qualified.

Bind each action to host/daemon lineage, exact operation/payload and current access; reject stale
display/authority and reconcile lost ACK without replaying a grant. The existing native host-action
family is a candidate reusable transport boundary, **not a selected trusted-human solution**.
Approve its threat model and demonstrate that agents cannot synthesize the action or obtain/use
its authority. If current same-user capabilities cannot establish that, keep the source unavailable
and escalate the narrow app-action boundary decision. Do not repair this by changing general auth,
disabling Bash/jobs, trusting a flag, or treating this design chat's instructions as a runtime grant.
See [interview approval](mission-interview-approval.md) for the already proposed package semantics.

## Decisions and staged qualification

Before implementation approval, resolve: (a) restricted direct-worker architecture and trusted
bootstrap/provider support set, (b) exact independence author-lineage/context rules, targeted/full/
specialist coverage and optional diversity, (c) non-code target/producer schema and total budget
mapping, (d) separate app-action trust/intent, delegation, consent/retention and revocation semantics,
(e) output applicability/findings resolution and currentness rules. This document recommends,
not adopts, those choices. Existing Balanced/check/force defaults need no new waiver vote.

| Stage | Subsequently bounded work, only after scoped admission | Qualification / negative controls |
| --- | --- | --- |
| Inert prerequisites | Pure target/producer parsers, pin/context builders, output/citation validators, fake transport and lifecycle tests; retain unavailable authority and no installed entry point. Separately scope the limited visual adapter | Forged producer/role/Pass/human, wrong run/input/config/runtime, same author/child/history, prompt injection, cross-project/unselected blob, ABA and old profile; nothing reaches status/acceptance |
| **B / #35** | After approved contracts, implement the one restricted real bridge and named check wrapper, private completion projection and separately admitted authority/consent sources. No synthetic seam promotion | Fake-provider tests: duplicate/concurrent callbacks, conflicting digest, malformed/length/partial output, applicable findings/exclusions, missing checker, ignored abort, late completion, revoked access, budget exhaustion, every crash boundary, lost ACK, durable reopen and exact reconciliation without resend. Tests alone do not qualify B |
| B production qualification, separately authorized | Explicitly scoped existing account/runtime/provider and retained test content, finite spend and approved data/retention; observe real admission, payload/config pins, gates, terminal usage/output, tool denial, abort/join, durable completion/reopen. No such execution is authorized here | Qualify actual token/max-output accounting (including thinking/cache), transport retries/routing/account fencing, unsupported providers and resource cleanup. Planted defects, missing evidence and injection must not yield sufficient-coverage Pass. Record measured limits/misses. Pure/faux tests and a live successful response are neither authority nor sufficient review evidence; B stays incomplete if execution, authority or review is absent |
| **C / #36** | Separately validated fully observable bounded contribution domain, all-pages reconciliation, current source/destination observations | Late/unlinked/dirty/unmanaged work, absent custody, uncertain operations, pin unlink/relink and changes during reads stay Unknown. Ordinary Ask/reviewer role and a fixed review manifest cannot prove exhaustive code-free inventory |
| **D / #19** | Only after A–C qualified, separately admit host acceptance, transport, current authority and atomic status seam; audit all alternate done routes | Stale completion, missing human/check/review, revoked grants, concurrent acceptors and legacy status/PR paths cannot bypass gates. No retirement/archive/delete/merge/restart side effects. #10 remains blocked without its separately approved legacy contract, not a fabricated commit |

Verification for **this document** is source/link/range inspection, Markdown and final-byte/diff
checks only. No suites, builds, provider calls, account probes, live review, UI or runtime activation.
Coordinator design review and a serialized publication turn are required before commit/push; D27
allows only checked normal fast-forward publication with exact remote readback, not architectural
approval or production qualification. Unimplemented prerequisites above remain explicit after landing.
