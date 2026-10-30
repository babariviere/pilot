# Proposed mission interview and approval contract

**Proposal, not an implemented gate or an adopted mission decision.** The coordinator owns the
plan and its final adoption; workers and explorers contribute evidence and proposals. This document
does not authorize implementation, admission, delivery, migration or changes to an existing mission.

## Agreed boundaries and defaults

Creation is interview-led, scaled to the work rather than a mandatory questionnaire. The coordinator
may authorize purpose-bound explorer research during the interview or later without per-launch user
approval; there is no research budget mechanism. Research is not approval to build or deliver.
Coordinator planning, persisted roles and explorer read-only boundaries are described in
[mission-roles.md](mission-roles.md). Ask role/mode removal is unresolved product discussion; it does
not change protections or authorize selectors. Reviewer metadata is not independent review.

The approved Balanced default is T1 targeted independent-agent review, T2 full independent-agent
review, and T3 specialist-agent plus human review. T1/T2 automatic delivery is conditional on all
gates. Mission and tier overrides are configurable; force is OFF pending separately agreed named
review waivers, and passing checks are mandatory. These future defaults do not grant current merge
authority. Rollout is new missions first; existing missions require preview and explicit opt-in.

## Interview and research

Start with the user's outcome and a concrete example. Ask only what is needed to make safe progress:

| Topic | Establish before approval or affected work | May defer |
| --- | --- | --- |
| Outcome and non-goals | Intended result, boundaries and who benefits | Presentation details that do not alter the outcome |
| Constraints and challenges | Known safety, access, compatibility and delivery limits; consequential unknowns | Implementation choices and researchable details within those limits |
| Acceptance | Observable success and how it will be checked, including unresolved verification gaps | Exact test techniques when equivalent approaches remain bounded |
| Authority | What the coordinator may decide, start and deliver, and where it must return to the user | Task decomposition and routing within the approved envelope |

The coordinator summarizes assumptions, unknowns, alternatives and relevant evidence in a draft.
An unknown may be explicitly deferred only if its consequences and a safe next step are bounded;
an unknown affecting outcome, risk or authority blocks the affected assignment or requires the user.
Trivial work can use a short conversational summary and explicit approval, without questions whose
answers are already clear. Explorer findings are evidence, not a decision or user assent. Explorers
use existing supported read-only capabilities, not a new shell or security boundary.

## Proposed approval and admission mechanics

1. **Research:** coordinator-authorized exploration may precede any approved brief. It grants only
   the existing explorer profile, not product writes, planning ownership or builder admission.
2. **Brief approval:** present a concise, inspectable approval package: mission/project identity,
   exact immutable brief revision and content, the applicable decision identities and content,
   explicit deferred unknowns, and a versioned effective authority/policy snapshot. The snapshot
   names permitted work and delivery actions, exclusions, escalation thresholds and each applicable
   tier's review/authority settings, including checks and force state. External references needed to
   understand the agreement must be pinned to exact versions or included; missing content is not
   implicitly approved. Preferences are separately scoped guidance, not mission decisions or grants.
3. **Explicit user action:** propose a trusted, durable user-origin approval of that exact package,
   with an operation identity and readable contents. The minimum is one explicit approval of a
   specific package containing the outcome, non-goals, material constraints, success criteria and
   bounded authority. A role/title, coordinator-written brief, ordinary message, silence, inferred
   assent, automated activity or an unverified author label is not that action. A user message may
   inform a draft but is not automatically converted into an approval. The trusted action and its
   transport are not yet implemented or selected.
4. **Assignment admission:** after approval, the coordinator decomposes work and admits a builder
   only when the current assignment intent, scope, criteria, dependencies and relevant decision pins
   fit the approved envelope. Admission is separate from approval and from delivery/review. Recheck
   the current approved package, authority and assignment at admission, including after asynchronous
   preparation. An approved brief does not itself start workers or bypass per-tier gates. Unavailable
   enforcement blocks the affected action rather than simulating approval.
5. **Amendments:** the coordinator may refine a plan within the explicitly delegated envelope,
   preserving its outcome, constraints, criteria and authority. Record the rationale and exact new
   revision and its relationship to the approved package; recheck affected assignments and gates.
   A material outcome, non-goal or constraint change, weakened acceptance, expanded authority, or an
   uncertain boundary requires a new explicit user approval before affected work proceeds. Narrowing
   or revoking authority takes effect for new actions; handling already-running work needs a separate
   safe-stop contract. No automatic authority promotion from outcomes or silence.

**Currentness and conflicts:** approval covers the exact package, not later content merely bearing
the same title or role. On a stale revision, conflicting decision, missing pinned content, or concurrent
authority change, do not silently carry approval forward: reread, show the difference, and either
document an in-envelope amendment or ask for fresh approval. Preserve historical approvals as history,
not current authority. If an approval acknowledgement is lost, its status is Unknown until the exact
operation is reconciled; do not replay a potentially new grant. Whether an unaffected assignment can
continue after a particular change is a future applicability decision, not a blanket guarantee.

Interview approval selects the mission's bounded authority and effective tier policy; it does not
specify reviewer selection, evidence validity, waiver mechanics or merge execution. Those belong to
the separate tiered review/merge design. Approval cannot waive checks or repository protections.

## Existing primitives and gaps

- `packages/protocol/src/index.ts` defines immutable brief revisions with stale-write CAS, mission
  decisions and proposals, creation-only `planningVersion: 1`, and persisted role metadata. Brief
  authorship and a decision record do not establish trusted explicit approval of this package.
- `packages/kernel/src/mission-tools.ts` and `docs/mission-roles.md` describe coordinator-owned
  planning, supported-path role admission and prebrief explorer research. They do not enforce the
  proposed brief-approval/build-admission gate; legacy behavior is unchanged. Roles are not hostile
  shell or unauthenticated loopback REST isolation.
- Existing assignment revisions and `sharedDefinitionRevision` fence assignment and ownership
  changes; both matter, including owner ABA. The dormant [review records](mission-review-records.md)
  retain a conservative context fence and exact inputs, but are not approval, live freshness or
  delivery eligibility. Reuse existing records and durability patterns where appropriate; no generic
  authorization framework or new schema is specified here.
- A trusted user-approval event bound to a complete current package, its lifecycle/applicability,
  safe amendment and admission enforcement, and explicit adoption remain gaps. Current records must
  not be represented as providing those guarantees.

## Examples and acceptance scenarios

1. **Normal:** user wants a small import fix. Coordinator summarizes outcome, non-goal, test and
   bounded authority in a short brief, selects Balanced, and requests explicit approval of the exact
   package. Only then may an in-scope builder be admitted; tier review and checks still apply.
2. **Uncertain:** compatibility with an older format is unknown. An explorer reads relevant code;
   its finding informs the draft. If support changes the promised outcome, ask the user; otherwise
   explicitly defer a bounded investigation and block the affected build until resolved.
3. **Delegated amendment:** approved criteria allow either of two equivalent parsing strategies.
   Coordinator chooses one based on research, records the new plan revision and rationale, and
   rechecks the assignment against unchanged authority. It cannot weaken the test criterion.
4. **Material change:** user initially approved local-only import; a worker proposes cloud sync.
   Coordinator does not admit that expansion under the old approval. It drafts the changed outcome,
   risks and authority and requests explicit user approval of the new package.
5. **Stale or ambiguous:** the user approves a displayed draft while a constraint or policy changes.
   The old package is not current; show the conflict and request approval of the current package.
   A chat message saying “looks good,” a role label or an automated notice alone is not a trusted
   approval. If exact acknowledgement is lost, reconcile rather than assume or replay.
6. **Legacy:** an existing mission remains unchanged until an adoption preview and explicit opt-in;
   neither its current brief nor previous worker activity is retroactive approval under this proposal.

## Unresolved product decisions

- Which trusted user action and transport create the durable approval, and how is lost-ack recovery
  exposed without treating ordinary messages as authorization?
- How are policy snapshots, decision/reference content and in-envelope amendment lineage represented
  and made current, including concurrent edits and selective versus conservative invalidation?
- What precise authority choices and materiality thresholds are presented, and what happens to
  already-running work when authority is narrowed or revoked?
- How do existing-mission adoption previews handle historical authority and pending work? How are
  tier overrides and named force-waiver rules selected in the separate review/merge design?
- Which unknowns and verification gaps can safely be deferred for each kind of work? Ask UI/role
  removal and its selectors remain separate, unresolved decisions.
