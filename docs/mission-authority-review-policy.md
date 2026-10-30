# Proposed mission authority, review and delivery policy

**Docs-only proposal, not an approved decision or active enforcement.** The coordinator owns
planning and adoption. Except for the approved defaults identified below, these mechanics need
coordinator/user validation before implementation. This document adds no schema, evaluator,
transport, tool, scheduling, provider calls, active gates or merge behavior. It changes no UI,
Ask roles, live missions, migration, cleanup, release or restart behavior.

## Approved defaults and boundaries

- **D18, Balanced:** T1 routine work has targeted independent-agent review and automatic delivery
  after all gates; T2 substantive work has full independent-agent review and automatic delivery;
  T3 sensitive or uncertain work has specialist-agent plus human review. Mission/tier configuration
  can require an agent, the user, or both. An override must be explicitly authorized, not inferred
  from a model recommendation, worker claim or successful prior run.
- **D19:** force is **OFF**. Future named review-waiver choices remain unresolved. No current
  waiver, generic administrator bypass or permission to ignore checks/protections exists. Checks
  must pass and repository protections must be respected, even under any future waiver design.
- The coordinator owns the brief, decisions, assignment scope, criteria, classification and
  acceptance. Workers submit findings/evidence and propose changes, never lower their own gates.
  Effort, difficulty and risk/uncertainty are separate; effort or diff size never grants authority.
- New missions first; existing missions require adoption preview and explicit opt-in (D22).
  This proposal does not retroactively approve work, infer ownership or retire workers.
- UI implementation for this mission still requires Opus (D24). This task draws no screens or
  prototypes. The mission's D27 permission for scoped verified direct pushes is a present delivery
  instruction, not implementation or adoption of this future automatic-delivery policy.

Dependencies: task #2's [interview/approval proposal](mission-interview-approval.md), #3's non-code
record foundations, #4's classification/model advice, #17's [review records](mission-review-records.md)
and #18's [delivery evidence](delivery-evidence.md). Task #22's contribution/task-at-operation choice
is still undecided. Numbered tasks here are design context, not grants of authority.

## Authority matrix

These are proposed responsibilities within a currently approved mission envelope, not permissions
created by a role label. Existing supported role boundaries remain in [mission-roles.md](mission-roles.md).

| Actor or boundary | May do within delegated scope | Cannot substitute for |
| --- | --- | --- |
| User, through a future trusted explicit action | Approve envelope/adoption, amend authority, give required human review | Passing checks, independent-agent review when required, repository permission/protection |
| Coordinator | Plan/classify, select approved profiles/executors, assess evidence/findings, accept exact outcomes, request authorized delivery | User-required review, proven independence, source/check/integration observations, authority outside the envelope |
| Worker or explorer | Execute admitted work using existing capabilities; submit exact evidence, limitations, blockers and proposals | Planning/adoption, self-acceptance, self-reclassification to lower gates, integration permission |
| Review executor | Apply a pinned rubric to exact inputs; report findings, uncertainty and resolutions | Coordinator acceptance, user authorship, independence proof or integration authority |
| Future delivery executor | Perform the specifically authorized integration after current eligibility and permission checks | Choosing policy, waiving gates, broad write authority, declaring an uncertain operation successful |

| Effective tier, absent an authorized override | Required review | Delivery recommendation once every gate is satisfied |
| --- | --- | --- |
| T1, routine and bounded | Targeted independent-agent review of the intended change, criteria and affected paths | Automatic authorized delivery; no additional human gate by default |
| T2, substantive | Full independent-agent review of the retained contribution and relevant interactions | Automatic authorized delivery; no additional human gate by default |
| T3, sensitive or uncertain | Independent specialist-agent review plus explicit human review | Only after both reviews, coordinator acceptance and all other gates |

Automatic means no extra approval prompt beyond the effective policy, not no verification or no
coordinator acceptance. Human approval alone cannot erase a required agent review. A mission/tier
override is part of the approved policy, distinct from waiving a gate for one failing delivery.
Conflicting overrides block the affected action until resolved by the authorized planner/user.

The approved mission policy must name the delivery mode and destination: for example, protected PR
integration or an explicitly permitted normal fast-forward push. Automatic delivery does not select
one, grant repository access or authorize switching modes after failure. Bind PR eligibility to its
exact head/base and applicable repository checks/reviews/protections, not just its URL or open state.
There is no active GitHub/merge execution here; any future executor needs its own validated contract.

## Distinct stages, not one green status

1. **Submission:** a worker claims completion of an exact assignment and maps each criterion to
   retained evidence, including missing coverage and limitations. Submission is not acceptance.
2. **Reported observations:** test prose, reviewer findings, screenshots, model output and host
   observations carry their producer, scope and limits. Reference availability observes content
   identity, not the truth of the report. A recorder is not necessarily its author or executor.
3. **Accepted evidence and outcome:** the coordinator assesses each criterion against applicable
   evidence and records a reasoned judgement about the exact submission. Evidence acceptance is
   not an execution attestation. Outcome acceptance is a necessary gate, not a check, review,
   permission or merge grant. An approval in #18 is only that dormant judgement record today.
4. **Eligibility:** a future decision determines whether this exact delivery action is authorized
   now, given all required gates, provenance and currentness. Eligibility is temporary and
   action-specific. It is not task completion, an integration attempt or successful integration.
5. **Integration and completion:** observe the exact authorized action's durable result and actual
   destination content, including all PRs/contributions. For non-PR/non-code work, the approved
   destination/publication and acceptance must be explicit, not a fabricated commit or PR. Final
   coordinator completion approval remains separate; eligibility alone cannot retire a worker.
   Under the approved PR completion direction, all worker-created PRs must be verified merged;
   a link, closed status or one merged PR does not satisfy that condition. Retirement/cleanup
   design is task #8, not activated here.

## Proposed deterministic decision explanation

For the same complete input identities and policy revision, explain the same allowed/blocked
actions and reasons. This is a decision procedure for discussion, not a new record schema or
evaluator. Evaluate every applicable condition; do not hide additional blockers behind the first.
List reasons in the order below, then by task, contribution and requirement identity, not arrival
order, score, majority vote or whichever reviewer finished first.

1. **Authority and proposed approval envelope.** Identify mission/project, exact approved package,
   effective policy/tier/override revision, current actor, requested action and explicit exclusions.
   Separate permission to research, build, submit, review, accept and integrate. Use #2's proposed
   immutable brief/decision/content/authority package and amendment lineage, without claiming its
   trusted user action/transport is selected or implemented. Ordinary messages, silence, activity,
   role labels and a coordinator-authored brief are not that trusted approval. Missing/currentness
   conflicts block the affected action; a repository credential cannot supply mission authority.
2. **Assignment, contributions and exact inputs.** Enumerate all covered tasks and their complete
   assignment/owner/definition fences, classification, criteria and dependencies. Name the physical
   repository and full change identities, exact retained base/head commit/content/comparison scope,
   or exact non-code references; include all delivered layers/PRs and relevant context/preferences.
   Distinguish worker-creation provenance, operation-time declared context, semantic task purpose
   and later contribution acceptance. Task #22 has not chosen between explicit coordinator
   allocation of retained contributions and an additional historical-context requirement. That
   prerequisite is **unavailable**, not satisfied by this proposal, #17, a task link, a singleton
   assignment or a research label. No new allocation record or inferred backfill is specified.
3. **Currentness and coverage.** Compare retained identities with an authoritative observation of
   the current proposed delivery, target/comparison, task fences and policy/context. Require exact
   criterion and contribution coverage. Retained snapshots alone cannot observe today's source.
   Partial capture, unsaved/unsupported source, divergent identity, missing content or unknown
   inventory blocks affected eligibility. Do not silently fall back to HEAD/latest or a smaller diff.
4. **Review intent/profile and execution.** Show each required rubric/profile revision, scope,
   expertise, selected versus observed executor/model, reasoning/time configuration and limitations.
   Show execution separately from interpreted outcome and applicability. A completed Pass can be
   stale; a current record can be pending or failed. Low human-attention is not a correctness Pass.
5. **Checks.** Enumerate the approved configured checks and why each applies, exact tested source
   and integration target, configuration/environment and attributable execution result. Require
   passing results for the current delivery, including required integration/CI checks. Free-text
   reports and hash-shaped legacy completion strings are not trusted execution or landing proof.
   Repeated reports of the same run do not create independent evidence.
6. **Review provenance.** For required agent review, require attributable execution plus adequate
   expertise and verified independence for the exact contribution, not self-review or assumed
   independence from a different chat/model/title. For required human review, require a trusted
   explicit human-origin action on the exact scope/revision, not coordinator transcription or an
   agent-authored “user approved” claim. #17 supplies neither guarantee. The detailed independence
   standard and trusted human transport remain open; absent support blocks the gate.
7. **Findings and coordinator acceptance.** Show findings per dimension, unresolved disagreements,
   resolution evidence, authorized dismissals and missing criterion coverage. Require no unresolved
   applicable findings and a current coordinator acceptance of the exact submitted outcome. A
   worker's resolution assertion or reviewer Pass does not supply that judgement. A stale acceptance
   cannot be repaired by changing its label or replaying its old acknowledgement.
8. **Action-specific result.** State separately what may proceed and what remains blocked: e.g.,
   investigation/submission may remain allowed while acceptance/integration is blocked. Delivery
   eligibility requires all preceding applicable gates, an explicitly permitted delivery mode and
   real repository permission. Recheck immediately before action, including after asynchronous
   work. Record integration attempt/outcome separately. Exact-operation uncertainty blocks dependent
   actions even if all earlier gates were once satisfied.

For **every required input**, unknown, missing, pending, failed, failed-to-run, timed-out,
inconclusive, skipped, stale/outdated, conflicting, unavailable and unsupported are **not passing**.
An approved relevance rule may explicitly exclude an inapplicable check before evaluation, with a
reason. This is not converting a skipped configured check to Pass, nor letting a worker infer that
verification is unnecessary. An absent check configuration is a gap, not an empty green checklist.

An explanation should name the exact subject/action, applicable requirements, observed state and
provenance for each, all blockers and the next authorized remedy (refresh, fix, clarify, seek the
required reviewer/user, or implement an unavailable prerequisite). It must distinguish a negative
decision from insufficient evidence. No aggregate confidence value can override this conjunction.

## Intent-sensitive scrutiny and executor selection

Targeted review is not sampling arbitrary lines; it checks the intended net change, promised
criteria and plausible affected paths, with explicit exclusions. Full review covers all delivered
layers and relevant interactions; it is not a promise of exhaustive impact analysis. Specialist
review adds domain expertise, not a fixed number of reviewers. Findings concern introduced or
worsened behavior/debt relative to the exact comparison. Unchanged legacy problems remain a visible
audit baseline unless the assignment explicitly covers them. Static call paths can guide scrutiny,
but unresolved edges and syntactic limits are not runtime or complete-impact proof.

| Intent | Targeted evidence and scrutiny | Expertise/profile considerations |
| --- | --- | --- |
| Mechanical | Exact net diff, invariants claimed unchanged, generated/config/documentation validity, scoped checks | A bounded rubric may suffice; “mechanical” is not proof of behavioral equivalence |
| Correctness | Triggering paths, boundary cases, regression/reproduction evidence, error and state transitions | Appropriate language/domain competence; targeted or full depth follows effective tier |
| Architecture/maintainability | Coupling, ownership, illegal states, layering, duplication and concrete maintenance/failure cost | Maintainability/Slop guidance with legitimate adapters/shared rules as counterevidence; no size heuristics or automatic rewrite |
| Security | Trust boundaries, authorization, adversarial paths, exposure, data handling and documented limitations | Relevant specialist expertise; a correctness Pass does not imply security Pass |
| Research/non-PR | Exact report/source versions, claim-to-source support, alternatives, uncertainty and reproducibility | Domain/source criticism; research intent proves neither truth nor absence of code contributions |
| Visual/interaction | Actual native renderer captures plus input/focus/IME/accessibility/state/performance evidence as applicable | Visual/interaction expertise, not a screenshot-only approval; UI implementation here remains Opus-only |

Three independent concepts must stay separate:

- **Profile/rubric:** what to examine and how to interpret output. #17 has versioned purposes,
  rubrics, applicable intents, model configuration, reasoning effort, time limits and output meanings.
- **Executor:** who/what actually performed it and with which observed model/capability. Profile
  configuration is not observed execution. Allowed catalog candidates, attributed suitability and
  fresh provider availability are separate inputs; authentication or usage cache is not availability.
- **Authority:** whose approval and which gates permit which action. Neither a stronger model nor
  a configured profile grants this authority or establishes independence/human authorship.

The correctness, security, maintainability/Slop and human-attention seeds are optional, independent
profiles, not a mandatory four-reviewer run. Combine relevant scrutiny without dropping any required
dimension; separate specialist review when needed. No fixed model defaults are invented. Terra can
be assessed for well-defined medium-effort work, not universally assigned. Reviewer needs can exceed
builder needs. Preserve user model restrictions/preferences; unavailable or unsuitable execution
requires an authorized alternative or a blocker, never reduced scrutiny or silent substitution.

## Findings, confidence and learning

Keep **correctness**, **security**, **preference/maintainability** and **human attention** distinct.
Severity is evidence-backed consequence, not effort to fix. Attention Low/Medium/High indicates
where a person should look under a rubric, not a hidden quality score, tier or authorization. A
human-required gate stays required even when an attention profile says Low.

Resolve a finding by applicable evidence that its triggering path is fixed, including a valid fix
elsewhere on that path. Deleted lines, self-rated confidence, repeated green runs and reviewer
silence are insufficient. Alternatively, an explicitly authorized decision-maker may record a
reasoned dismissal with counterevidence and exact scope, distinguishing false positive, irrelevant
baseline or permitted tradeoff. Contested applicability remains unresolved until settled. A dismissal
cannot waive a check, remove required review, accept an out-of-envelope security risk or silently
weaken criteria. A broader tradeoff returns to the user if outside delegated authority. Do not
pretend #17's reported resolution assessments implement authoritative closure/dismissal.

Preserve original findings, citations, disagreements, resolutions/dismissals, reasons and their
authors/revisions. New results supersede applicability, not history. Relevant user/project
preferences guide scrutiny and explain unwanted patterns, but never replace the pinned rubric,
override approved constraints or grant authority. D20's scoped memory direction is not automatic
preference extraction or learning in #17.

Confidence can recommend more investigation, review or a future scoped policy change; it never
waives hard gates or silently reduces user-required review. Proposed calibration compares human
corrections, material misses, rework and false positives for comparable intents/scopes, alongside
counterexamples and limited coverage. Distinguish explicit user preferences from inferred candidates.
Any promotion remains a reasoned, explicit policy amendment, not an aggregate-score engine,
self-rating threshold, majority vote or automatic authority increase. Task #12 owns the fuller
preference/learning design.

## Multiple tasks, stacks and change over time

- Enumerate each task's criteria, assignment/classification and all contributions/PRs in the
  delivery. Do not choose a convenient task label to lower scrutiny. A contribution serving several
  tasks inherits the union of applicable checks/review/acceptance obligations and the strictest
  delivery restriction. T1 plus T3 therefore needs specialist-agent plus human review, not an
  average tier. Incompatible requirements require resolution, not arbitrary precedence.
- Retain both exact layer comparisons and the relevant net ancestor-stack comparison. Review each
  intended layer and cross-layer interactions; a top PR's green status does not cover every lower
  layer, unrelated task or final combined target. Shared evidence can cover multiple criteria only
  with explicit coverage and identical applicable inputs, never invented independence or task proof.
- Splits, squashes, rebases, transfers, ancestor/target changes and additional PRs require explicit
  reconciliation of identities and coverage. A stable jj change ID identifies a line of work, not
  unchanged reviewed bytes. Changing a base can change the reviewed effect even if a head is stable.
  All worker-created PRs/contributions must be reconciled before completion, not just the first one.
- Source/context ABA, pin unlink/relink, custodian leave/rejoin, assignment release/reclaim to the
  same owner, or classification edit/reversal cannot resurrect old eligibility. Compare complete
  assignment revision/content, actual owner **and** existing shared-definition revision; assignment
  revision plus equal owner misses ownership ABA. #17 also conservatively invalidates on mission-wide
  brief/decision/artifact/member activity. Do not claim finer selective freshness is implemented.
- New source, evidence, review/profile, criterion, dependency or policy revisions require reassessing
  affected gates and acceptance. History survives. Carry-forward of unaffected evidence would need
  an explicit validated applicability rule; absent that support, block and refresh rather than guess.
  Unknown risk/scope/classification cannot silently become T1; expansion needs coordinator rescoping.
- Under #2's proposed envelope, a delegated in-scope amendment records rationale and exact lineage.
  Expanded authority, weakened criteria, material outcome/constraint changes or uncertain boundaries
  require new explicit user approval. A lower-tier override is not an informal waiver. Narrowing or
  revocation blocks new affected actions; do not grandfather queued integration. Safe handling of
  already-running work and exact revocation race boundaries remain unresolved, not an atomic-stop
  guarantee. Preserve observed completed actions; revocation is not permission for destructive rollback.

## Permission failures and exact-operation recovery

A permission, authentication, branch-protection or unsupported-operation failure blocks the action.
Explain the actual failure without treating it as local-only policy, retrying with broader credentials,
force-pushing, choosing a new route to bypass protection or silently changing the delivery mode.
An authorized direct push and a protected PR merge are different operations. Neither a PR URL nor
a linked checks page establishes live status or successful integration.

For a lost acknowledgement, retain the exact operation identity, actor, action, payload, subject and
destination. Keep its result **Unknown** until authoritative exact-operation reconciliation, never
interpret timeout as failure-to-execute or success. Do not issue a new grant, judgement, merge or
push with a new identity to make the uncertainty disappear. Recover the original durable record/result
through supported lookup or exact idempotent retry only; do not replay arbitrary commands or assume
all external actions are idempotent. Changed payload/actor/action/task conflicts, not a new retry.

Current #17 review retries require current authorization before lookup, then recover the same record
before mutable source/CAS checks and await durability. #18 has its own documented historical retry
semantics, including recovery of a former coordinator's own committed judgement, not permission to
write a new one. Do not generalize one API's retry behavior into a universal approval transport.
A recovered old Pass/approval proves the old record, not current eligibility. Re-evaluate current
authority, source, checks, reviews and acceptance before any new action. Access denial during recovery
leaves uncertainty for an authorized resolver; it does not permit impersonation or bypass. Future
approval/integration exact-result reconciliation remains unimplemented. Generic GET status or a
matching destination alone need not identify which uncertain operation executed.

## Worked decisions

The eligible examples below assume future authoritative observers/admission and the still-unavailable
contribution contract have been implemented and adopted. **Today these examples cannot be made
eligible merely by recording #17 Pass or #18 approval.**

| Case | Inputs and explanation | Proposed result |
| --- | --- | --- |
| T1 mechanical docs correction | Current bounded assignment/contribution; targeted independent review covers exact diff/criteria; configured docs/link/whitespace checks pass; no findings; coordinator accepts | Automatic authorized delivery, not permission to skip review or run irrelevant app suites |
| T2 parser change | Current retained layers/net diff; full independent review of parsing/error paths; current regression and configured integration checks pass; criterion evidence accepted | Automatic delivery under effective policy, then observe integration separately |
| T3 authorization change | Sensitive boundary; specialist-agent evidence and explicit trusted human approval cover exact revision; current checks and coordinator acceptance pass | Delivery only with both reviews and all other gates; high confidence alone cannot authorize it |
| Stale source/checks | Retained comparison H1 has a current pinned-record Pass and a green run; proposed delivery is H2, or target/base changed | Block: live identity/comparison and affected check/review coverage are stale; retain H1 history and refresh |
| Independence unavailable | Completed Pass from another named chat; producer/model may be observed, but independence is unavailable | Block required independent review. A role/title/model difference is not proof; coordinator cannot manufacture it |
| Multiple tasks/stacked PRs | Routine task A and sensitive task B share two layers; only top PR checks passed and only A was reviewed | Strictest union requires specialist plus human, both tasks' criteria and all affected layer/integration checks; no partial green completion |
| Pending human review | T3 specialist review/checks pass; human request is pending, or an agent recorded “user agreed” | Block human gate. Low attention/confidence scores do not replace explicit trusted approval |
| Lost integration ACK | All gates passed at admission, integration request sent, response lost | Integration Unknown; reconcile that exact operation, do not retry as a new operation or mark task done; recheck gates before new actions |
| Owner/classification ABA | Owner A submits, task is released/reclaimed by A or classification raised then restored | Old evidence/acceptance remain historical; definition/assignment fences changed, so no revived eligibility |
| Non-PR research | Pinned report maps findings to criteria and coordinator approves; contribution coverage/code-free claim is unproved | #22 prerequisite and other missing verification remain unavailable; no fabricated hash or “no PR means done” shortcut |

## Existing reuse versus capability gaps

Inspection anchors are the current daemon implementations, not claims of active policy enforcement:

| Foundation to reuse | What it actually establishes | Still missing for this policy |
| --- | --- | --- |
| #2 proposal, protocol brief revisions/decisions and coordinator-owned planning | Exact planning content/CAS and existing role boundaries | Selected trusted approval transport, adopted envelope/currentness/amendment/admission/revocation mechanics |
| #3 non-code record/reference support | Explicit versioned non-code references, not invented code receipts | Active non-code acceptance/completion; legacy commit format/free text do not verify landing/checks |
| #4 `mission-classification.ts` / `mission-model-recommendation.ts` | Versioned classification, task fences and advisory allowed-model/suitability/availability diagnostics | Active tier authority/routing; classification/advice is not a grant, execution or availability guarantee |
| #13 [jj ownership](jj-ownership.md), #20 [retained snapshots](review-snapshots.md) | Worker-creation metadata and immutable bounded layer/stack bytes | Exact task-at-operation proof, current unsaved/live source and complete contribution reconciliation; #22 choice remains open |
| #18 `mission-delivery-evidence.ts`, Store/Service entry points | Durable exact submissions, criterion evidence indexes, coordinator judgement and record-freshness fences | Trusted execution/checks, active acceptance eligibility, contribution contract, live source and integration observations |
| #17 `mission-review-contract.ts`, seeds and Store/Service entry points | Versioned optional profiles/results, retained citations/context fences, execution/outcome distinction, optional host-observed agent producer | Reviewer execution, independence and human-authorship proof, live freshness, checks, acceptance/authority/eligibility or merge consumer |

`evaluateDelivery` currently returns checks, independent review, authority, task-at-operation,
live source, integration and eligibility as unavailable. `evaluateMissionReview` reports pinned-record
applicability separately and returns live freshness, checks, task-at-operation, integration,
independence, authority, acceptance and eligibility as unavailable. Store durability/idempotency and
Service actor/project checks are reusable boundaries, not hostile-shell/unauthenticated-REST isolation.
**A current pinned-record Pass is not live freshness, an independent review, a passing check,
coordinator acceptance or merge authority. Task #17 did not establish those capabilities.**

## Remaining decisions, not silently settled here

Approved Balanced, force OFF/checks mandatory, coordinator ownership and rollout defaults above
are not reopened. The following require later bounded decisions/contracts:

- #2's trusted explicit approval action/transport, package representation/currentness, amendment
  lineage, adoption previews and handling of in-flight revocation. No generic authorization framework
  or new transport is chosen here.
- #22's authoritative contribution-acceptance versus historical task-context choice, including
  multiple tasks, transfers and non-code work. This remains an unavailable prerequisite, not an
  allocation mechanism approved by this policy.
- Precise independence/expertise criteria and trusted executor/human provenance, check/source/target
  observers, active gate admission and exact integration/permission/result reconciliation.
- Detailed mission/tier override presentation and applicability, classification escalation/materiality
  rules, finding-dismissal delegation, conservative versus selective invalidation and permissible
  evidence reuse. These must not silently lower approved or user-required gates.
- Named future review-waiver eligibility, approver, scope, duration and audit/revocation rules.
  **No waiver is selected. Force stays OFF; checks and repository protections are never waived.**
- Intent-specific rubric adoption, model-suitability assessment and calibration of human corrections,
  misses and false positives; #12 preference lifecycle and any explicit authority-promotion proposals.
- Delivery modes and non-code destinations, completion/retirement safeguards and activation sequencing.
  No automatic merge, scheduling, GitHub mutation, migration or cleanup follows from this document.
