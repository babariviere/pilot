# Workflow approval, review consent and human-review actions

**Selected implementation contract, not an installed boundary.** D54 selects practical native
confirmation and bounded current-coordinator delegation. D55 selects bounded mission reviewer
consent; D56/D57 select global Review and exact human dispositions. This docs-only closure does
not issue approvals/consent, transmit data, spend, install execution or activate gates/attention.
No adoption/backfill, cleanup, release or restart follows. Publication needs actual-candidate source
review and a separate serialized D27 normal-FF turn, without PR/GitHub.

Use the [selected policy](mission-authority-review-policy.md#selected-policy-46-and-47),
[production bridge history](mission-production-review-bridge.md#approval-consent-and-human-origin-separate-trace),
[interview/package semantics](mission-interview-approval.md#proposed-approval-and-admission-mechanics)
and [unavailable A authority](non-code-acceptance-policy.md#authority-remains-unavailable).
Historical stronger-assurance proposals and handoff 23368 remain history, not current acceptance.

## Decision in brief

Three purpose-specific actions remain distinct:

1. Workflow-package approval/delegation binds exact immutable brief, decisions, policy and powers.
2. Reviewer data/spend consent binds the D55 mission envelope, exact data/provider/model/account/
   terms and $20 mission/$4 cumulative-task allowance inside existing shared ceilings.
3. Human disposition binds only the explicitly selected changes/revisions in global Review.

D54 selects explicit confirmation on a host-owned native surface, unavailable to ordinary agent
tools/REST. This is practical workflow assurance, **not verified human presence or OS isolation**;
hostile same-user processes and UI automation are outside the supported assurance. Production
purpose-specific admission, durable receipts and effective-use fences still need implementation/
qualification. Existing bearers, role labels, REST user attribution and model assent do not supply
them. Landing these docs neither makes A eligible nor qualifies production B/C/D.

### Five different claims

1. **Actor authentication:** which admitted principal/channel performed the operation? A
   verified app process would be a software principal, not automatically a human principal.
2. **User submission under D54:** was this exact action explicitly confirmed on the native surface,
   rather than submitted through ordinary agent tools/REST, model interpretation or replay? This is
   not verified physical human presence or protection against UI automation.
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
| [`server.route`](../../packages/daemon/src/server.ts#L608), [`isAllowedOrigin`](../../packages/daemon/src/origin.ts#L1) | Reject requests carrying Origin; origin-less clients proceed to routing | Browser mitigation, not authentication. Bash/curl can omit Origin. Loopback is not a human-origin fence |
| [`missionRoute`, brief/decision/proposal routes](../../packages/daemon/src/server.ts#L2666), [`MissionActor`/`USER`](../../packages/daemon/src/missions.ts#L107) | REST omits session actor arguments; `{}` means user **or daemon** | Default attribution is not independently authenticated user intent. Existing proposal accept/reject cannot create these approvals |
| [`SessionManager`, `mission.call`](../../packages/daemon/src/sessions.ts#L8384), [`MissionService.call`](../../packages/daemon/src/mission-service.ts#L1289) | Tool IPC derives actor from the owning worker's `meta.id`, then checks mission membership/role | Good supported-path agent attribution, not a boundary against that agent using another ingress |
| [`assertPlanner`](../../packages/daemon/src/missions.ts#L2458), [`writeBrief`](../../packages/daemon/src/missions.ts#L2531), [`resolveProposal`](../../packages/daemon/src/missions.ts#L5005) | Planner restrictions, immutable brief revisions and stale-write CAS; session actors cannot resolve proposals | No exact authority-package action or independently verified human origin. [`planningVersion:1` creation](../../packages/daemon/src/missions.ts#L2291) is schema admission, not consent |
| [`messages` ingress](../../packages/daemon/src/server.ts#L1809), [`inputOrigin`](../../packages/kernel/src/input-origin.ts#L6) | Public request IDs reject internal namespaces. Internal `native:user:` presents extension-on-user-behalf input as user input | Neither ordinary public IDs, internal presentation prefixes, prose, nor caller flags prove a gesture or original unexpanded intent |
| [`GitHubSetupService.load/authenticate`](../../packages/daemon/src/github-setup.ts#L87), [`model-scope` PUT](../../packages/daemon/src/server.ts#L1385) | Random 32-byte bearer, replaced on service load, private-file write mode, exact token comparison; selected host routes require it | Bearer possession only. No per-action challenge, displayed digest, workflow scope or human presence. GitHub/setup/model-setting authority must not authorize these actions |
| [`LocalOptions.model_scope_capability`](../../apps/desktop/src/model_scope_access.rs#L13), [`scoped_models.save`](../../apps/desktop/src/scoped_models.rs#L168) | Explicit Save acquires bounded no-follow regular file, checks same UID/private mode and daemon/lineage, uses sensitive header; settings CAS/readback | Client hygiene, not same-UID isolation. GET equality is current state, not exact mutation attribution or an approval receipt |
| [`daemonIdentity`/`daemonLineage`](../../packages/daemon/src/hello.ts#L13), [`LocalOptions.discover`](../../apps/desktop/src/local_client.rs#L124) | Persisted installation/storage identities, local home/port selection | IDs alone are not a fresh authenticated process/channel incarnation or human identity |
| [`CriticalReviewApproval`](../../packages/protocol/src/critical-review.ts#L96), [`ReviewAccounting.grant`](../../packages/daemon/src/critical-review-accounting.ts#L437), [`approval`/`admit`](../../packages/daemon/src/critical-review-accounting.ts#L115) | Host-only structured allowance primitive; run/target/evidence/host/project/expiry and allowance checks; accounting binds provider/model on calls | Caller is trusted by construction. No installed trusted consent writer. No package/profile/account/retention/human-action proof supplied by `action:"app_allowance"` |
| [`CriticalReviewDisposition`](../../packages/protocol/src/critical-review.ts#L134), [`ReviewProducer`/`MissionReviewResult`](../../packages/daemon/src/mission-review-contract.ts#L91) | Finding dispositions are records; mission producer is unavailable or observed-agent(session); independence/human authorship remain unavailable | Neither is a trusted human disposition for an exact retained package/profile. Never fabricate a chat ID or retrofit human authorship |
| [`nonCodePolicyAuthority` and exact lookup](../../packages/daemon/src/missions.ts#L3717) | Even a matching decision digest/event yields unavailable authority; lookup reauthorizes before/after durability | Reuse conservative refusal and exact recovery ordering. A saved policy or coordinator decision cannot grant its own authority |

The Rust native client is the relevant app path. Swift is not the target for a future boundary.
The existing [scoped-model contract](../../apps/desktop/docs/scoped-models.md#authority-and-truthful-outcomes)
is settings-specific, not a broader approval API.

## Attacker and trust model

D54 chooses a narrower practical workflow boundary than the earlier proposal. Ordinary agents,
extensions, model output and untrusted retained evidence must not invoke workflow approval,
reviewer consent or human dispositions through their tools/REST, spoof actor flags, replay an
approval for another purpose or retarget a held native confirmation. Preparation and rendering
never grant authority; the app captures exact immutable intent and the host checks it at commit/use.

Hostile same-user process inspection/tampering and UI automation are explicitly **unsupported**.
Private files, same-UID sockets, process identity, a bearer or an in-memory nonce do not establish
isolation against those threats. No verified physical human presence, tamper-proof local database,
OS isolation, proof every byte was read or judgement-quality guarantee is claimed. Do not expand
this task into general authentication, OS permissions/sandboxing, account restrictions or removal
of Bash/jobs/ask_user.

Trusted implementation components are the host resolver, native confirmation surface, purpose-
specific admission and persistence/use checks. Concrete platform support, restart/revocation races,
receipt durability and preventing ordinary agent ingress remain qualification obligations under
this selected model, not a renewed policy choice.

## Options and recommendation

This heading remains a historical link anchor. **D54 selected practical exact native confirmation**,
superseding the earlier recommendation to require a protected verifier against same-user automation.
The stronger option is not a prerequisite or promised guarantee of this implementation.

| Path | Selected treatment |
| --- | --- |
| Ordinary REST user attribution, chat assent, role or coordinator-authored decision | Not an approval/consent/disposition source |
| Existing GitHub/setup/model-scope bearer | Remains purpose-limited; never workflow authority |
| Purpose-specific exact native confirmation under D54's practical model | Selected implementation direction, still to qualify in #52 |
| OS-protected human presence / hostile-same-user exclusion | Not selected or claimed |
| Current runtime without the selected implementation | Dependent action remains unavailable, not silently approved |

## Candidate action contract, conditional on a qualified verifier

The following are implementation requirements under D54's practical assurance, **not a wire
schema, installed endpoint or callable API**. “Verifier” below means purpose-specific native-action
admission under that model, not a protected human-presence mechanism. Remaining record/storage
shapes are candidates, not newly selected architecture. No agent caller may mint action evidence.

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
  reference bounds; exceeding them refuses, never truncates. Final bounds are implementation details
  unless they materially change scope, behavior or risk.
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

**Review-run data/spend consent.** D55 selects bounded mission-level consent, not one new
confirmation per exact run. Native consent discloses future-data scope, selected content/omissions,
concrete provider/model/API destination, non-secret account/broker, billing, terms and total allowance:
**$20 per mission, $4 cumulative per task across revisions/rechecks**, within all existing shared
ceilings. Bind the exact consent version, scope/account/terms and enforceable totals; each run still
pins its retained target/input/evidence/context/profile/runtime and is admitted against that consent.
Thinking, repeated/cached input and follow-ups consume the same totals. Missing terms/account/
enforceable limits block sends. Account sign-in or workflow approval is not transmission consent.

Consent expires at mission end or revocation. Expansion/renewal needs fresh approval. No automatic
account/model switch or paid fallback; replacements/transfers cannot silently refill allowance.
Unknown usage remains conservatively charged, not a refund or permission to resend uncertain work.
Ordinary same-account credential refresh does not itself select a different account; changed or
unverifiable effective account/config identity requires fresh admission within valid consent, or
fresh confirmation if outside it. No provider/account, new token/time limit or provider-retention
guarantee is chosen here.

Initial non-code destinations are research/plans at exact local brief/artifact revisions, using fresh
host-owned independent evidence-only execution. Same-model review is allowed, not a diversity or
OS-isolation claim. Missing original historical bytes, unsupported kind, specialist competence,
account/terms, accounting mapping or observed independence remains a named blocker. Code/mixed and
external/side-effectful destinations do not silently enter this initial lane. Existing critical-review
raw/other availability limits (30/90 days after use, active/pinned exceptions) and explicit erasure
are local behavior to disclose, not new annotation retention or a promise of provider deletion.

**Human review disposition.** Bind exact retained content/input digest, references and revisions,
task/submission/allocation/context identity, complete review profile ID/revision/rubric and criterion
interpretation, current expected disposition/result and any exact findings/review run being addressed.
Capture the submitted findings, coverage gaps, limitations and explicit disposition as immutable
user-submitted action payload under D54. Findings' source citations retain original-byte identity;
rendering alone does not establish a byte mapping. Opening, read marks, dismissal or an agent's
Pass cannot submit it. Draft/agent-suggested feedback stays labeled as such until the human explicitly
submits it; never infer original human authorship of generated text. The native action supports a
user-submitted disposition under D54, not verified human presence, proof every byte was read or
judgement quality. Agent review remains separate and cannot satisfy required human review.
Task/submission/mission fields apply only where real bindings exist, never synthetic standalone scope.
D57 allows browsing/comments before prerequisites pass, but approval waits for required passing
checks and agent reviews. Disposition covers only explicitly selected exact changes/revisions in
D56's global Review, not a chat, unseen change or future revision. Comment keeps required approval
pending; Request changes blocks. User-only snooze/withdraw never waives a gate; humans resolve
their own threads. Coordinator retirement is limited to its own optional suggestions or requests
made obsolete by authoritative cancellation, never user-required approval. No approval carries forward.

### Stale displays, owner/coordinator ABA and access

Use the existing [`allocationContextFence`](../../packages/daemon/src/missions.ts#L3505): brief revision,
decision/artifact/member events **and coordinator event**. Owner binding requires
[`sharedDefinitionRevision`](../../packages/daemon/src/missions.ts#L1182) as well as assignment revision
and current owner. The [definition trigger](../../packages/daemon/src/missions.ts#L976) includes owner
changes; comparing assignment revision or matching IDs alone misses release/reclaim A→B→A.
Coordinator A→B→A invalidates via coordinator events; membership churn invalidates via member events.
[`continueSession`](../../packages/daemon/src/missions.ts#L6039) changes coordinator/member identities
and emits member activity; [`detach`](../../packages/daemon/src/missions.ts#L6183) can clear ownership
and coordinator through member activity. A coordinator-only event check is therefore insufficient.
Qualification must cover all mutation/continuation paths and durable reopen, not just ordinary PATCH.

Reject new effects when any captured fence changes, even if current bytes/IDs match again. Show a
fresh package/difference and request a new confirmation; never silently carry a grant forward. The
first candidate conservatively invalidates on these mission-wide fences. Selective unaffected-work
continuation needs an explicit applicability contract, not inference. Historical records stay history.

Reauthorize principal/project, mission membership where applicable, and source access before preparation,
after every async acquisition, inside final serialized admission and after durability before returning
content. Reuse [`resolveDeliveryEvidence`](../../packages/daemon/src/mission-service.ts#L504) checks,
not caller-provided observations; keep task pins independent of mission-level pins. Recheck current
authority at assignment admission, review dispatch and every later send, and eventual acceptance.
Lost membership, moved project, unlinked/relinked pins, missing/erased content, changed profile/account,
revoked authority or uncertain reads cannot be repaired by `latest` or another chat's authority.

### Bounded delegation and revocation

Workflow delegation is to the exact current coordinator incarnation for named actions, mission,
destinations, risk/tier limits and amendment envelope, with explicit expiry/use bounds and durable
use accounting where limited. D54 selects bounded delegation, not unbounded role authority. No implicit
subdelegation, transfer to a successor, renewal, cross-project scope or self-promotion. Coordinator
continuation may preserve historical actor lineage but not silently transfer approval. Workflow
delegation excludes review spend unless separately explicitly granted by an approved consent policy;
human-review intent cannot be delegated to an agent.

Direct decision withdrawal additionally requires user-controlled permission on that exact decision
revision and a current scoped coordinator delegation. Protected/unknown records, including legacy
records, stay user-only unless explicitly delegated; authorship is not authority. User-only constraints
remain protected. Editing the decision invalidates the permission; no inferred backfill. Preserve
text/history/pins/reason. #94's proposal/user-accept path remains the current implementation; direct
withdrawal needs its own admitted scope, not a shortcut through ordinary REST.

Revocation/narrowing is a separate purpose-bound, durable action with its own operation and expected
grant/generation. Agents may request cancellation or voluntarily narrow behavior, never impersonate
the user's grant/revocation. Revocation must serialize against grant use, close new admissions/sends
immediately in memory while durability is pending, and fail closed on store failure. Durable generations
and terminal tombstones prevent grant→revoke→same-grant resurrection, including after restart or erasure.
Expiry/clock uncertainty also blocks new use; no renewable hold that extends consent invisibly.

Already transmitted data/spend cannot be undone. For active runs, close admission, abort and physically
join owned work, suppress late success and retain uncertain/worst-case accounting as in the bridge.
Local cancellation ACK is not vendor erasure or proof billing stopped. Broader in-flight workflow
stop/continuation details require qualification, not a claim that revocation rolls back prior effects.

## Operation identity, durability and recovery

Candidate sequence: authorized preparation → immutable display/challenge → independently verified
confirmation → serialized CAS and immutable action record → durable barrier → ACK → separately
admitted use. Preparation/display has **no grant effect**. No positive grant, approval or use effect
may be exposed before durability; use must consult durable effective state, not pending rows.
Fail-closed revocation may block new admissions/sends immediately while durability is pending,
as described above; that restriction is not a positive grant or use effect.

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
  [lifecycle ACK](../../apps/desktop/src/mission_lifecycle_transport.rs#L119) patterns do not supply it.
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
file tree. [`MissionStore.durable`](../../packages/daemon/src/missions.ts#L1356) and
[`acknowledgeWhenDurable`](../../packages/daemon/src/server.ts#L166) show the mission barrier pattern.
[`CriticalReviewStore.put`](../../packages/daemon/src/critical-review-store.ts#L57) and
[`CriticalReviewDisk`](../../packages/daemon/src/critical-review-disk.ts#L66) provide immutable canonical
records, worker-owned SQLite and FULL synchronous transactions, not authenticated human intent.

Candidate storage ownership: mission package approvals/revocations in mission storage;
change-centered human dispositions/drafts in project-owned app storage, with optional mission links;
reviewer-consent/accounting records in private critical-review storage. Standalone Review never
requires a synthetic mission. #60 selects exact persistence without making mission membership the
owner of human feedback. Keep minimal immutable links between these records. This is a storage
direction for review, not a new schema. The stores are not one transaction.
Authoritative action/receipt must be durable before an idempotent exact projection;
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

D54–D57 are selected policy, recorded in the
[selected contract](mission-authority-review-policy.md#selected-policy-46-and-47), not still-open
assurance/consent/request choices. Concrete provider/account/terms, exact payload/storage shapes,
retained-task effort/accounting mapping, safe revocation/use ordering and platform implementation
remain consumer qualification, not permission to broaden policy.

| Consumer | Exact scope and remaining qualification |
| --- | --- |
| #52 | Purpose-specific package, consent and disposition admission; immutable native confirmation, durable exact receipts, bounded grant/use/revocation. Exclude ordinary agent tools/REST; do not claim hostile-same-user or UI-automation protection |
| #58/#61 | Exact package approval/admission/amendment; no Save/chat-assent authority; fresh confirmation for scope/risk/budget expansion |
| #49/#59/#64 | Original inputs, cumulative mission/task accounting and exact run/consent linkage, fresh host-owned evidence-only reviewer. No installed execution or spending follows |
| #60/#65 | Exact selected-change/revision dispositions and private drafts in global Review, human-owned threads, no inherited approval; practical assurance through #52 |
| #70/#88/#79 | One authoritative waiting/request source, global read surface, Inbox links to same targets without duplicate review state or capture-as-waiting inference |
| #35/#36/#19/#72 | Independently qualified checks/coverage/current destination and later acceptance; selected policy does not activate them |

Qualification must exercise stale/held confirmation, payload substitution, spoofed actor/purpose,
ordinary REST/tool attempts, coordinator/owner ABA, expiry/revocation, project move, exact-operation
conflict/lost ACK/restart, projection failure and uncertain accounting. Human and agent records
remain distinct; opened/read/dismissed items and agent Pass do not submit human approval. Hostile
same-user file/process access or UI automation is outside D54's assurance, not an unmet promise to
solve it here. Audit records also make no same-user tamper-resistance claim.

Source recheck: `cc51bb4af2ddc094618a9e8fb3514891705f76d9`.
`server.ts:1447-1620` admits retained GETs, not these actions;
`missions.ts:5217-5355` still requires user acceptance of withdrawal proposals;
`critical-review.ts:23-36,96-109` and `critical-review-accounting.ts:151-215` have session/PR
and run-bound allowances, not D55 mission/task consent. These named source gaps remain real even
though the policy choices are closed. Earlier line anchors above refer to their historical baseline
`f33f0101147a8ec57c847cb413d74029aef1b02e`, not unchanged current locations.

This documentation's verification is **source references, scoped Markdown, diff and final bytes only**.
No suites/builds, accounts/provider calls, real reviews, UI probes or permissions were used to qualify
a human boundary. No implemented native-action boundary is qualified. Submit the pinned candidate
for source review, then wait for an explicit serialized D27 publication turn before commit/push. Any later
publication is checked ordinary fast-forward plus exact remote readback, one genuine landed
completion, not architectural adoption or runtime approval. No PR or GitHub mutation is required.
