# Workflow approval, review consent and human-review actions

**Design proposal for coordinator review, not an installed or adopted boundary.** Source
baseline: `f33f0101147a8ec57c847cb413d74029aef1b02e`. D27/D36 permit scoped verified
documentation publication, only after a separately serialized publication turn. D37/D38 do
not grant workflow authority, data-transmission/spend consent, real reviewer execution or
human-review authorship. This document does not supply any of them.

Read with the [production bridge](mission-production-review-bridge.md#approval-consent-and-human-origin-separate-trace),
[interview/package semantics](mission-interview-approval.md#proposed-approval-and-admission-mechanics)
and [unavailable A authority](non-code-acceptance-policy.md#authority-remains-unavailable).
The target/producer/accounting design is separate work. Nothing here installs transport,
protocol, SQL, UI, a provider caller, acceptance gates or permissions. Preserve Ask, Bash,
jobs, ordinary account behavior, Balanced floors, mandatory passing checks and force **OFF**.
No adoption/backfill, merge, cleanup, release or restart is implied.

## Decision in brief

Three future actions must remain independently attributable and independently effective:

| Action | Positive meaning | Never implies |
| --- | --- | --- |
| Exact workflow-package approval/delegation | The user approves these outcome/constraint/policy bytes and this bounded coordinator authority | Consent to transmit review data or spend; approval of future content; starting work by itself |
| One review-run consent | The user permits the named data transmission and total allowance under the named account/configuration and terms | Workflow approval, content judgement, paid fallback or another run |
| Human review disposition | A human explicitly submits these findings/disposition against this retained package and profile | Merge/completion authority, all other gates passing, or an agent becoming a human reviewer |

**Current conclusion: trusted sources for all three are unavailable.** Existing host-action
bearers and mission actors cannot distinguish a same-user agent request from genuine human
intent under the threat model below. Reuse data validation, identity checks, exact-operation
recovery and durability patterns, not their labels as proof of human origin. Recommend a
separately scoped qualification of a minimal new confirmation boundary before choosing an
implementation. If that distinction cannot be demonstrated on a platform, keep these sources
unavailable there. Landing this design must not make A eligible or unblock B/C/D by itself.

### Five different claims

1. **Actor authentication:** which admitted principal/channel performed the operation? A
   verified app process would be a software principal, not automatically a human principal.
2. **Human intent:** did a genuine user explicitly confirm this action, rather than a shell,
   extension, synthetic input, model interpretation, accidental default or replay?
3. **Displayed-payload freshness:** are the inspectable contents and action submitted exactly
   those displayed for confirmation, still current at the host's serialization point?
4. **Effective authority:** is the durable grant still applicable, unexpired, unrevoked and
   inside the current policy/scope? An authentic historical action need not be effective now.
5. **Content judgement:** what did the reviewer actually conclude about these requirements and
   bytes? Authentication, a fresh display and a grant do not prove judgement quality or coverage.

No single `human`, `approved`, `native` or `eligible` boolean may stand in for these claims.

## Source-backed trace and reuse limits

Line anchors refer to the baseline above; named symbols are the navigation anchors.

| Inspected path | Existing guarantee | Missing guarantee / reuse limit |
| --- | --- | --- |
| [`server.route`](../packages/daemon/src/server.ts#L608), [`isAllowedOrigin`](../packages/daemon/src/origin.ts#L1) | Reject requests carrying Origin; origin-less clients proceed to routing | Browser mitigation, not authentication. Bash/curl can omit Origin. Loopback is not a human-origin fence |
| [`missionRoute`, brief/decision/proposal routes](../packages/daemon/src/server.ts#L2666), [`MissionActor`/`USER`](../packages/daemon/src/missions.ts#L107) | REST omits session actor arguments; `{}` means user **or daemon** | Default attribution is not independently authenticated user intent. Existing proposal accept/reject cannot create these approvals |
| [`SessionManager`, `mission.call`](../packages/daemon/src/sessions.ts#L8384), [`MissionService.call`](../packages/daemon/src/mission-service.ts#L1289) | Tool IPC derives actor from the owning worker's `meta.id`, then checks mission membership/role | Good supported-path agent attribution, not a boundary against that agent using another ingress |
| [`assertPlanner`](../packages/daemon/src/missions.ts#L2458), [`writeBrief`](../packages/daemon/src/missions.ts#L2531), [`resolveProposal`](../packages/daemon/src/missions.ts#L5005) | Planner restrictions, immutable brief revisions and stale-write CAS; session actors cannot resolve proposals | No exact authority-package action or independently verified human origin. [`planningVersion:1` creation](../packages/daemon/src/missions.ts#L2291) is schema admission, not consent |
| [`messages` ingress](../packages/daemon/src/server.ts#L1809), [`inputOrigin`](../packages/kernel/src/input-origin.ts#L6) | Public request IDs reject internal namespaces. Internal `native:user:` presents extension-on-user-behalf input as user input | Neither ordinary public IDs, internal presentation prefixes, prose, nor caller flags prove a gesture or original unexpanded intent |
| [`GitHubSetupService.load/authenticate`](../packages/daemon/src/github-setup.ts#L87), [`model-scope` PUT](../packages/daemon/src/server.ts#L1385) | Random 32-byte bearer, replaced on service load, private-file write mode, exact token comparison; selected host routes require it | Bearer possession only. No per-action challenge, displayed digest, workflow scope or human presence. GitHub/setup/model-setting authority must not authorize these actions |
| [`LocalOptions.model_scope_capability`](../apps/desktop/src/model_scope_access.rs#L13), [`scoped_models.save`](../apps/desktop/src/scoped_models.rs#L168) | Explicit Save acquires bounded no-follow regular file, checks same UID/private mode and daemon/lineage, uses sensitive header; settings CAS/readback | Client hygiene, not same-UID isolation. GET equality is current state, not exact mutation attribution or an approval receipt |
| [`daemonIdentity`/`daemonLineage`](../packages/daemon/src/hello.ts#L13), [`LocalOptions.discover`](../apps/desktop/src/local_client.rs#L124) | Persisted installation/storage identities, local home/port selection | IDs alone are not a fresh authenticated process/channel incarnation or human identity |
| [`CriticalReviewApproval`](../packages/protocol/src/critical-review.ts#L96), [`ReviewAccounting.grant`](../packages/daemon/src/critical-review-accounting.ts#L437), [`approval`/`admit`](../packages/daemon/src/critical-review-accounting.ts#L115) | Host-only structured allowance primitive; run/target/evidence/host/project/expiry and allowance checks; accounting binds provider/model on calls | Caller is trusted by construction. No installed trusted consent writer. No package/profile/account/retention/human-action proof supplied by `action:"app_allowance"` |
| [`CriticalReviewDisposition`](../packages/protocol/src/critical-review.ts#L134), [`ReviewProducer`/`MissionReviewResult`](../packages/daemon/src/mission-review-contract.ts#L91) | Finding dispositions are records; mission producer is unavailable or observed-agent(session); independence/human authorship remain unavailable | Neither is a trusted human disposition for an exact retained package/profile. Never fabricate a chat ID or retrofit human authorship |
| [`nonCodePolicyAuthority` and exact lookup](../packages/daemon/src/missions.ts#L3717) | Even a matching decision digest/event yields unavailable authority; lookup reauthorizes before/after durability | Reuse conservative refusal and exact recovery ordering. A saved policy or coordinator decision cannot grant its own authority |

The Rust native client is the relevant app path. Swift is not the target for a future boundary.
The existing [scoped-model contract](../apps/desktop/docs/scoped-models.md#authority-and-truthful-outcomes)
is settings-specific, not a broader approval API.

## Attacker and trust model

The adversary is a mistaken, prompt-injected or deliberately misbehaving author/coordinator/
reviewer agent with its existing tools, including Bash/jobs where available. It may construct
arbitrary origin-less HTTP requests, flags and actor labels, replay captured requests, race
reads, and exploit any filesystem/process/automation capability its same-user environment
actually permits. Evidence, artifact source, decision text and rendered previews are untrusted
content, including instructions pretending to be confirmation controls.

The ordinary native loader retains extensions/tools ([`NativeAdapter.open`](../packages/kernel/src/native-adapter.ts#L492));
Ask has a different restricted factory. The coordinator's sandbox wrapper delegates shell policy
to the bundled sandbox ([`coordinatorSandbox`](../packages/kernel/src/coordinator-sandbox.ts#L11),
[`bundledResourceLoader`](../packages/kernel/src/bundled-extensions.ts#L27)). Those source paths
do not establish that this capability file, all same-user processes or automation are inaccessible
to every agent. No such sandbox guarantee is assumed, and no live secrets or permissions were probed.

- Mode 0600/0700 excludes other users under ordinary permissions, not the owning UID. A new
  filename, hidden path, in-process Rust field, environment secret, Unix-socket same-UID check or
  copied bearer is not evidence of agent exclusion. Do not claim the current app is uninspectable.
- A process signature, if later verified, could authenticate software provenance; it would not
  alone prove a human click. An in-memory nonce prevents some replay, not synthetic confirmation.
  Current macOS automation/accessibility permissions and Linux input/process restrictions are
  unqualified. Do not assume them safe or change them for this proposal.
- Trusted host resolver, action verifier, renderer/confirmation surface, persistence and eventual
  reviewer bootstrap are the proposed computing base. If a same-user process can rewrite those
  binaries, read signing material, alter the authority DB or automate their trusted controls, this
  design cannot claim protection without an independently demonstrated boundary. Private SQLite
  is not a tamper-evident trust root against same-user compromise.
- Even a future protected confirmation cannot prevent a human approving misleading content or
  guarantee semantic correctness. Show untrusted material as evidence, never executable approval
  UI, and keep content judgement separate from authenticated intent.

This is not permission to weaken Ask, remove Bash/jobs, restrict ordinary accounts, add broad
daemon authentication or create an OS sandbox. A stronger same-user integrity model is a separate
material decision. Unsupported assurance must be reported unavailable, not silently relabeled.

## Options and recommendation

| Option | Reuse versus addition | What it could honestly establish | Decision / residual risk |
| --- | --- | --- | --- |
| Reuse ordinary REST user path, coordinator decision or chat assent | No new boundary | Existing state/role/CAS semantics | Reject as trusted source. An agent can reach the same origin-less ingress; prose and role are insufficient |
| Extend existing GitHub/setup bearer to workflow actions | Small route change | Possession of the same broad host-action credential | Reject. Cross-purpose authority, same-user file access and no gesture/display binding. Never make existing GitHub access workflow consent |
| Add a purpose-specific bearer and app confirmation under existing process trust | Separate namespace plus immutable payload/CAS/lookup | Better scope/replay hygiene; procedural app-origin claim under additional assumptions | Not sufficient for required trusted-human origin under this threat model. Only consider a separately approved weaker-assurance product; never count it toward required human review |
| Minimal separately qualified confirmation verifier for only these three actions | Reuse resolvers/stores/recovery patterns; add purpose-bound challenge, authenticated confirmation and exact lookup | Potential genuine-action binding **only if** independently demonstrated against same-user reading/invocation/automation and payload substitution | Recommended investigation, not a selected implementation. OS-mediated protected confirmation or an already independently enrolled verifier are narrow candidates, not available guarantees. No new account/enrolment/permission change is selected |
| Keep all three unavailable | Reuse current fail-closed state | Honest refusal without policy changes | Recommended operating state until qualification. Leaves the dependent production bridge and human-required acceptance blocked |

Do not turn the fourth option into an invented secure channel. It needs a concrete supported
platform mechanism, explicit trusted-code/storage assumptions, payload-bound human confirmation
evidence and negative controls. A signed assertion from the same readable secret is not that
mechanism. If none is supportable within the approved scope, return that result and ask whether
to retain unavailability or separately scope stronger assurance. Do not redesign general auth.

## Candidate action contract, conditional on a qualified verifier

The following are requirements for later validation, **not a wire schema, new endpoint or
callable API**. No caller is allowed to mint the trusted evidence described here.

### Shared envelope and display CAS

- Host creates an immutable prepared action from authorized retained reads, not arbitrary caller
  source/HTML/paths. Bind version and action kind, operation ID, host/daemon/storage-lineage IDs,
  authenticated principal/verifier identity and qualification version. Keep the current authenticated
  connection/incarnation and one-use confirmation challenge separate from durable installation
  identity. A restart/replacement invalidates outstanding challenges; it does not invent a new action.
- Bind canonical project/mission/task IDs as applicable, coordinator ID plus incarnation fence,
  task owner ID, full normalized assignment and `sharedDefinitionRevision`, policy/approval IDs,
  submission/allocation IDs, exact destinations and full ordered context/package/profile digests.
  Mission-wide approval has no fictitious worker/task/run; run and task actions require those IDs.
- Include complete brief/policy/decision/reference contents or immutable resolvable pins, explicitly
  deferred unknowns, exclusions and missing content. Exact source/data bytes and ordered metadata
  are hashed with a versioned domain-separated encoding; do not hash display-decoded text instead.
  Reuse the inactive [retained-input contract](mission-production-review-bridge.md#inactive-retained-input-and-report-api-d38)
  where applicable, not its prepared-object identity as authorization.
- Prepare a readable host-owned confirmation summary with inspectable full payload, action meaning,
  recipient/spend or delegated powers and exclusions. Bind display generation/format version and
  complete payload digest to the challenge. No ellipsis, invisible field, remote reference or preview
  omission may silently remove consequential terms. A digest alone is not informed consent.
- Confirm only the captured immutable action. Never read the current selection/draft after the
  gesture, nor let a held click or async completion retarget another mission/run/profile. App-side
  generation matching is necessary but not sufficient: the verifier binds intent proof to the exact
  operation/kind/digest/challenge; the host verifies it and recomputes current pins/CAS at serialized
  commit. Proof for a stale prepared payload cannot be reused for its replacement.
- Require expected prior approval/consent/disposition ID (explicit null for first), authority and
  revocation generation, current ownership/context fences and current profile revision as applicable.
  Strict bounded owned JSON, unknown-key rejection, dense arrays, safe integers and duplicate-key/
  identity rejection must precede copying/hashing. Candidate reuse: existing retained-contract byte/
  reference bounds; exceeding them refuses, never truncates. Final action-specific limits need approval.
- Never accept request `actor`, `human`, `native`, `independent`, bearer identity or role as trusted
  fields. Derive principal and authority through the qualified verifier and host state. Purpose-separate
  all three action kinds so a consent proof cannot be used as a workflow or human-review proof.

### Per-action payload and effect

**Workflow-package approval/delegation.** Bind exact immutable brief revision/content, applicable
decision identities/content/event fence, complete effective versioned policy, outcome, non-goals,
constraints, acceptance criteria and explicit deferred unknowns. Pin tier review/check requirements,
force OFF, permitted actions/destinations, exclusions, escalation/materiality rules, coordinator and
delegation bounds. Distinguish approving the agreement from authorizing particular powers. Return a
durable approval record, not a worker start or acceptance. In-envelope amendments need an exact
new revision, parent approval, rationale and host-verifiable applicability rule; no model judgement
alone can decide that weakened criteria or expanded authority are in-envelope. Unresolved/material
changes require a fresh confirmation, as in the interview contract.

**Review-run data/spend consent.** Bind a host-prepared, not-yet-dispatched run ID and the exact
retained target/input/evidence/context/profile/runtime digests. Show selected data categories/content,
omissions/redactions, concrete provider/model/API destination, non-secret account/broker identity,
billing mode and verified rate/config version. Include total money/input/generated-token/time allowance
(thinking, repeated/cached input and follow-ups included), expiry, allowed sends and retry behavior,
provider data-use/retention terms and local retention choice/version. Missing terms, account binding
or enforceable total limits block this lane. Subscription consent is still transmission consent;
account sign-in, GitHub setup, subscription availability or workflow approval is not consent.

Candidate is one consent for one bounded run, not one new consent for every internal model turn and
not a reusable allowance for replacement runs. No automatic retry, model/account switch or paid
fallback follows. A new run after uncertainty needs fresh admission and consent. No dollar amount,
provider, budget mapping, retention period or delegated-spend policy is chosen here. The bridge's
candidate ceilings are ceilings, not a grant. Preserve ordinary same-account credential refresh;
bind effective account/config identity rather than secret token bytes, and require readmission if
that identity changes or cannot be verified.

**Human review disposition.** Bind exact retained content/input digest, references and revisions,
task/submission/allocation/context identity, complete review profile ID/revision/rubric and criterion
interpretation, current expected disposition/result and any exact findings/review run being addressed.
Capture the submitted findings, coverage gaps, limitations and explicit disposition as immutable
human-action payload. Findings' source citations must retain original-byte identity; rendering alone
does not establish a byte mapping. Opening, read marks, dismissal of attention, silence or an agent's
Pass cannot submit it. Draft/agent-suggested feedback stays labeled as such until the human explicitly
submits it; never infer original human authorship of generated text. Proof supports a human-submitted
disposition, not proof that every byte was read or that its reasoning is correct. Agent review remains
a separate requirement and can never satisfy a configured human-review requirement.

### Stale displays, owner/coordinator ABA and access

Use the existing [`allocationContextFence`](../packages/daemon/src/missions.ts#L3505): brief revision,
decision/artifact/member events **and coordinator event**. Owner binding requires
[`sharedDefinitionRevision`](../packages/daemon/src/missions.ts#L1182) as well as assignment revision
and current owner. The [definition trigger](../packages/daemon/src/missions.ts#L976) includes owner
changes; comparing assignment revision or matching IDs alone misses release/reclaim A→B→A.
Coordinator A→B→A invalidates via coordinator events; membership churn invalidates via member events.
[`continueSession`](../packages/daemon/src/missions.ts#L6039) changes coordinator/member identities
and emits member activity; [`detach`](../packages/daemon/src/missions.ts#L6183) can clear ownership
and coordinator through member activity. A coordinator-only event check is therefore insufficient.
Qualification must cover all mutation/continuation paths and durable reopen, not just ordinary PATCH.

Reject new effects when any captured fence changes, even if current bytes/IDs match again. Show a
fresh package/difference and request a new confirmation; never silently carry a grant forward. The
first candidate conservatively invalidates on these mission-wide fences. Selective unaffected-work
continuation needs an explicit applicability contract, not inference. Historical records stay history.

Reauthorize principal/project/mission membership and current source access before preparation,
after every async acquisition, inside final serialized admission and after durability before returning
content. Reuse [`resolveDeliveryEvidence`](../packages/daemon/src/mission-service.ts#L504) checks,
not caller-provided observations; keep task pins independent of mission-level pins. Recheck current
authority at assignment admission, review dispatch and every later send, and eventual acceptance.
Lost membership, moved project, unlinked/relinked pins, missing/erased content, changed profile/account,
revoked authority or uncertain reads cannot be repaired by `latest` or another chat's authority.

### Bounded delegation and revocation

Workflow delegation is to the exact current coordinator incarnation for named actions, mission,
destinations, risk/tier limits and amendment envelope, with explicit expiry/use bounds and durable
use accounting where limited. No particular limit values are selected here. No implicit
subdelegation, transfer to a successor, renewal, cross-project scope or self-promotion. Coordinator
continuation may preserve historical actor lineage but not silently transfer approval. Workflow
delegation excludes review spend unless separately explicitly granted by an approved consent policy;
human-review intent cannot be delegated to an agent. No delegation defaults are selected here.

Revocation/narrowing is a separate purpose-bound, durable action with its own operation and expected
grant/generation. Agents may request cancellation or voluntarily narrow behavior, never impersonate
the user's grant/revocation. Revocation must serialize against grant use, close new admissions/sends
immediately in memory while durability is pending, and fail closed on store failure. Durable generations
and terminal tombstones prevent grant→revoke→same-grant resurrection, including after restart or erasure.
Expiry/clock uncertainty also blocks new use; no renewable hold that extends consent invisibly.

Already transmitted data/spend cannot be undone. For active runs, close admission, abort and physically
join owned work, suppress late success and retain uncertain/worst-case accounting as in the bridge.
Local cancellation ACK is not vendor erasure or proof billing stopped. Broader in-flight workflow
stop/continuation semantics remain a decision, not a claim that revocation rolls back prior effects.

## Operation identity, durability and recovery

Candidate sequence: authorized preparation → immutable display/challenge → independently verified
confirmation → serialized CAS and immutable action record → durable barrier → ACK → separately
admitted use. Preparation/display has **no grant effect**. No effect may be exposed during the
in-memory interval before durability; use must consult durable effective state, not pending rows.

- Allocate one unpredictable operation ID per explicit action attempt before transmission; retain the
  exact normalized envelope locally. Bind operation uniqueness to host/lineage, principal, kind, scope
  and complete payload digest. Same ID/different bytes, actor, action or target is a conflict. IDs are
  reconciliation keys, never authentication. Challenge is one-use and expires independently.
- Commit action, expected-prior CAS, challenge consumption and authority/revocation generation in
  one transaction at their authoritative store. Repeated identical receipt retrieval never appends,
  refreshes expiry, resets spent budget, reconsumes a challenge or creates a new grant. New runtime
  dispatch is a separate operation, not a side effect of ACK serialization or lookup.
- After dispatch or ambiguous failure, retain **Unknown** until a read-only exact-operation lookup
  matches the whole captured action and returns a durable record. Do not resend a grant, manufacture
  a new operation ID or infer success from current state/GET equality. Exact lookup is required for
  this proposal; current model-scope readback and
  [lifecycle ACK](../apps/desktop/src/mission_lifecycle_transport.rs#L119) patterns do not supply it.
- Exact lookup must authenticate current access before querying and after its durable barrier. It may
  return authorized historical metadata before checking mutable owner/profile/currentness, but cannot
  reopen revoked blobs, grant current effect or require the original stale challenge to be reused.
  Return historical outcome and separately computed current applicability/revocation, never a reusable
  approval capability. An inaccessible receipt remains unavailable to that caller.
- A lookup `not found` is point-in-time absence, not proof the original request cannot still commit.
  Keep Unknown unless the host has durably serialized a terminal refusal/abandonment that fences the
  old operation and consumed/invalidated its challenge. Only then can a fresh displayed action start.
  Recovery must not replay user effects or reconstruct intent from messages/model output.
- On crash, retain durable action/consumption/revocation records; discard unconfirmed challenges and
  reauthorize before new use. Pending/unflushed rows, disk failures or missing proof do not become
  authority. Receipt loss must not reopen an operation ID; bounded retention needs durable tombstones
  or an equivalent no-reuse guarantee, not silent eviction that permits replay.

Prefer extending existing purpose-specific stores over a generic approval service or second receipt
file tree. [`MissionStore.durable`](../packages/daemon/src/missions.ts#L1356) and
[`acknowledgeWhenDurable`](../packages/daemon/src/server.ts#L166) show the mission barrier pattern.
[`CriticalReviewStore.put`](../packages/daemon/src/critical-review-store.ts#L57) and
[`CriticalReviewDisk`](../packages/daemon/src/critical-review-disk.ts#L66) provide immutable canonical
records, worker-owned SQLite and FULL synchronous transactions, not authenticated human intent.

Candidate storage ownership: mission package approvals/revocations and human dispositions in mission
storage; run-consent/accounting records in private critical-review storage; minimal immutable links
between them. This is a storage direction for review, not a new schema. The stores are not one
transaction. Authoritative action/receipt must be durable before an idempotent exact projection;
missing/conflicting projection blocks use. For consent, the accounting approval must derive from and
bind the exact durable consent, including revocation fencing. Crash recovery may reconcile that local
projection only, never dispatch a review, renew a grant or infer a missing human confirmation. A
concrete cross-store serialization/revocation contract must be qualified before any consumer exists.

## Audit and privacy requirements

Retain minimal action provenance: operation/action/principal/verifier version, payload/display digest,
scope and revision fences, actual host commit sequence/time, expected/actual prior record, grant bounds,
proof reference, revocation/applicability reason and recovery outcome. Separate authenticated facts,
user-submitted judgement, agent claims and host observation. Audit records must not promise tamper
resistance against same-user storage modification without a demonstrated integrity mechanism.

Keep tokens, capability headers, signing material, credential/config secrets, raw provider errors and
private local paths out of logs, telemetry, mission notices and agent context. Same-user-readable
digests/IDs still reveal correlations; do not broadcast them indiscriminately. Full inspectable payloads
belong in access-controlled local retained storage, not copied into every audit row or decision.
Never transmit data merely to prepare/show consent. Redaction changes require a new input digest;
never hide required omissions or promise provider deletion from local erasure.

Local retention, provider retention/data-use terms, proof/receipt lifetime, tombstone lifetime and
erasure-versus-audit obligations need explicit decisions. Erased evidence makes content effect
unavailable; a minimal revocation/no-reuse marker must not restore erased content. Do not introduce
automatic feedback learning, external audit export, a retention timer or hidden data collection here.

## Decision packet and required qualification

Coordinator review should separate these decisions rather than accept the document as a grant:

1. **Assurance:** retain unavailable, or authorize a bounded qualification of a concrete protected
   confirmation mechanism? Which same-user file/process/input threats must it withstand, and on
   which platforms? Weaker procedural app-origin evidence must remain explicitly insufficient for
   configured trusted-human requirements. Neither process identity nor bearer possession is enough.
2. **Workflow delegation:** exact permitted powers/destinations/expiry, materiality rules, successor
   handling and in-flight revocation behavior. Do not widen approved tier/check/force defaults.
3. **Run consent:** per-run versus separately bounded delegated consent, concrete data terms,
   total-budget mapping, retry policy, account/config binding and local/provider retention. No policy
   value is inferred from this chat, account setup or the bridge's candidate ceilings.
4. **Human disposition:** approved disposition vocabulary, coverage interpretation, supersession,
   finding resolution and whether any unchanged-content reuse is permissible. Required human review
   remains distinct from independent-agent review; diversity/specialist qualification is separate.
5. **Persistence:** authoritative store/linkage and atomic use/revocation fences, no-replay receipt
   retention and privacy/erasure behavior, including platform/restart/rollback support.

Future qualification, only after separate scoped approval:

| Required evidence | Negative controls / fail-closed result |
| --- | --- |
| Source-backed authenticated principal **and** genuine payload-bound human confirmation, on each supported platform | Same-user file read/copy, direct curl, agent jobs, synthetic/held input, automation, malicious preview, process substitution and replay cannot mint trusted action. If exclusion cannot be established, source remains unavailable |
| Complete inspectable display and commit CAS | Changed selected mission/profile/account/terms, hidden/truncated content, Unicode framing, source/data mismatch and late response cannot retarget intent; new display required |
| Current authority/access and incarnation handling | Owner release/reclaim, coordinator A→B→A, continuation, leave/rejoin, project move, pin unlink/relink, revoked/expired grant and changed profile refuse new effect |
| Durable exact reconciliation without regrant | Concurrent same/conflicting operation, lost ACK, every pre/post-commit crash, in-flight not-found, storage fault, cross-store projection failure, erasure and reopen never replay or resurrect authority |
| Consent/use lifecycle | Account refresh versus identity switch, total allowance exhaustion, revocation racing admission/send, cancellation/join and late output cannot bypass consent or reset usage; no live provider execution is authorized here |
| Human versus agent evidence | Spoofed flags/producer/role, model assent, read/dismiss, agent-authored Pass and old disposition never satisfy a required human gate; judgement quality remains a separate evaluation |

This proposal's verification is **source references, scoped Markdown, diff and final bytes only**.
No suites/builds, accounts/provider calls, real reviews, UI probes or permissions were used to qualify
a human boundary. No supported trusted-human mechanism is claimed. Submit for coordinator design
review, then wait for an explicit serialized D27 publication turn before commit/push. Any later
publication is checked ordinary fast-forward plus exact remote readback, one genuine landed
completion, not architectural adoption or runtime approval. No PR or GitHub mutation is required.
