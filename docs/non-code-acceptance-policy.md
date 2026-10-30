# Non-code policy and explain-only evaluation

This is an **inert, host-only A foundation**, not an acceptance gate. It has no tool, HTTP,
IPC, UI, runner or provider caller. It never updates task status, completion, retirement or
lifecycle, submits reviews, grants authority or changes Ask. Existing journals and legacy
receipt/status behavior are unchanged.

`planningVersion: 1` is creation/schema admission only. It is not authenticated user opt-in,
brief approval or workflow authority. Legacy missions are refused; no adoption/backfill is added.

## Internal APIs

`MissionService` exposes:

- `saveNonCodeAcceptancePolicy(sessionId, taskRef, value)` appends immutable configuration.
- `lookupNonCodeAcceptancePolicy(sessionId, taskRef, value)` reconciles the **complete exact
  normalized write**, not just its operation ID. Returns the historical record or `undefined`.
- `evaluateNonCodeAcceptance(sessionId, taskRef)` explains current metadata and unavailable
  capabilities. It accepts no observations and always returns `eligible: false`.

The service derives actor/project/durable mission membership and requires the **current**
coordinator. `MissionStore` equivalents use trusted host callbacks, like the existing delivery
and allocation foundations. These callbacks are not request fields or arbitrary observation
ingestion. Store latest/history helpers are internal metadata reads, not independently admitted
public APIs. History takes an exact same-task record-ID cursor and a limit of 1–100; latest
queries never infer currentness from one history page.

Implementation: [contract/parser/explanation](../packages/daemon/src/mission-non-code-acceptance.ts),
[SQLite journal](../packages/daemon/src/missions.ts),
[service admission/readers](../packages/daemon/src/mission-service.ts).

## Exact configuration

All write keys are required, including nullable keys. Unknown keys are refused recursively.

```ts
{
  version: 1,
  operationId: ID,
  expectedPolicyId: ID | null,
  kind: "non-code",
  assignment: MissionAssignment, // full current normalized value, including classification
  ownerSessionId: ID,
  definitionRevision: PositiveSafeInteger, // sharedDefinitionRevision, not assignment revision
  expectedContextFence: {
    briefRevision, decisionEventId, artifactEventId, memberEventId, coordinatorEventId
  },
  destinations: NonCodeReference[],
  checks: { checkId: ID, configVersion: ID }[],
  reviews: ReviewRequirement[],
  authorityClaim: null | {
    source: "mission-decision", decisionId: ID,
    decisionEventId: NonnegativeSafeInteger, sha256: LowercaseSHA256
  }
}
```

`ID` is 1–128 ASCII letters, digits, `_` or `-`. Revisions are positive safe integers;
context event values are nonnegative safe integers. Assignment/classification reuse existing
strict bounds. Arrays are dense, ordered, and contain 1–20 entries. Duplicate destinations,
check IDs or review `(kind, profileId)` identities are refused. Normalization creates an owned
copy before any asynchronous read; complete normalized payloads, including array order, are bound
to operation identity. Encoded records are limited to 256 KiB.

`NonCodeReference` is exactly `{kind:"brief",revision}` or
`{kind:"artifact",artifactId,revision}`. No paths, URLs, snapshots, mutable latest references
or embedded source are accepted. Destination retained identities are resolved and saved as
existing `DeliveryObservation` metadata. This is **not** a publication/destination observation.

Classification must explicitly declare `deliveryKind: "research"`; missing/unknown, code and
native-UI classifications are refused. Research remains intent, not proof of code-free work.
The explicit outcome kind must be `non-code`; code/mixed/unknown kinds are refused.

`ReviewRequirement` is exactly one of:

```ts
{ kind: "independent-agent", profileId: ID, profileRevision: PositiveSafeInteger,
  scrutiny: "targeted" | "full" | "specialist",
  provenance: "host-proven-producer-and-independence" }
{ kind: "human", profileId: ID, profileRevision: PositiveSafeInteger,
  provenance: "trusted-human-origin" }
```

These describe **required evidence**, never trusted producer/independence/human facts. New writes
require current existing research-applicable profiles. Balanced minimums derive from
`classificationAdvice`: T1 targeted independent-agent, T2 full independent-agent, T3 specialist
independent-agent plus human. Stronger scrutiny is permitted, weaker minimums are refused. Unknown
safety dimensions retain T3 scrutiny. There is no override engine and force is always **OFF**.

Checks must be named with exact configuration versions. No executable registry/config resolver
exists here, so even well-formed names remain unavailable. Missing/empty checks are never a
successful applicability rule; new empty configurations are refused. Supplied green, approval,
actor, independence, human-authorship, force or arbitrary observation fields are refused.

## Authority remains unavailable

An authority claim references an existing mission decision's exact normalized digest and the
**conservative mission-wide decision-event fence**, not an individual authenticated approval event.
The surrounding record fixes mission/project/task/assignment/policy scope. A readable, matching
decision does not prove user authorship, approval of this package, delegated scope or current
acceptance authority. The [trusted approval source](mission-interview-approval.md) is not implemented.

The host stores its unavailable result separately from caller assertions. Explanation rechecks it:

- Null claim: `authority-not-configured`.
- Missing reference: `authority-reference-unavailable`.
- Digest/fence mismatch: `authority-reference-changed`.
- Matching ID/digest/fence: `trusted-approval-source-unavailable`, **still unavailable**.

No approval record, generalized authority adapter or grant is invented.

## Fences, durability and exact recovery

One append-only `task_non_code_acceptance_policies` table uses a sequence, mission/task foreign
keys, unique record ID and mission-local unique operation ID. Records retain request, recorder,
timestamp, resolved retained destination identities and unavailable authority description.

1. Current actor/project/durable membership/current-coordinator checks precede operation lookup.
2. An authorized **exact retry precedes mutable** owner/assignment/profile/pin/context/latest-CAS
   validation and source reads. Different actor/task/version/full normalized payload conflicts.
3. A new append requires an open owned task, exact assignment/classification/owner and
   `sharedDefinitionRevision`, latest-policy CAS, and the existing allocation context fence.
   Retained reads are sequential and bounded. Task pins, custodians, current brief and profile
   revisions must match. Owner/custodian membership/project checks apply to new writes and actual
   retained-content access, not historical policy metadata recovery.
4. The transaction repeats actor admission, exact retry, and every mutable record/context/profile/
   pin fence. Existing definition revisions catch owner A→B→A; existing member/coordinator/context
   event sequences catch ABA without adding epochs.
5. Writes, exact retries, present/absent lookups and explanations await `durable()` and recheck
   current actor admission before ACK. This acknowledges persistence, not evidence truth.

Thus a current coordinator can recover an exact old policy after owner/profile/pin changes without
reopening revoked source. A former coordinator cannot recover it. Historical recovery says nothing
about fresh applicability. Storage failure or lost ACK leaves effects **Unknown**, not successful
or absent. Reconcile the same complete operation before proceeding; do not invent a new operation
to replay uncertain effects. An absent lookup is only a read-point result, not a reservation against
an append already resolving asynchronously.

## Explain-only output and limits

The explanation names exact mission/project/task/actor/owner, assignment/classification/definition,
context, policy/submission/judgement/allocation and required profile/result IDs. It includes pinned
destination identities, missing requirements, stable capability/reason codes and remedies, while
omitting raw sources, rubric/check prose and secret-bearing resolver exceptions.

It captures the complete metadata tuple and host actor metadata before asynchronous reads and
compares them after reads **and durability**. If changed, output is outdated with explicit before/
after input IDs and actor metadata, not a silent mixture of epochs. Current retained metadata
applicability is separate from live-source freshness or verified requirement satisfaction.

All actual authority, check execution/config, review producer/independence/human-origin/finding
resolution, exhaustive code-free inventory/reconciliation, live freshness/source stability,
destination observer and executable completion capabilities remain unavailable. Missing submission,
criterion coverage, judgement, allocation, profiles and results are named separately. Reported
receipts, Pass, coordinator approval and selected-only allocation are inspectable inputs, never
passing gates. Even all of them together cannot yield `eligible: true` or any lifecycle effect.

These are host metadata fences, **not** a cross-store atomic snapshot, physical-I/O guarantee,
hostile-filesystem isolation or proof that no code/unmanaged work exists. See the
[prerequisite plan](non-code-acceptance-prerequisites.md): B still needs attributable check/review
execution and independently admitted authority/human provenance; C needs a validated exhaustive
domain, reconciliation, source stability and destination observations. D needs a separately
validated acceptance/completion seam, admitted transport and bypass audit. None is activated by A;
this is not completion of the non-code gate work. Legacy historical design adoption remains separate.

## Verification

[Focused parser/store/reopen tests](../packages/daemon/src/mission-non-code-acceptance.test.ts) cover
strict schemas/bounds, Balanced requirements, complete retry binding, historical recovery,
current actors, concurrency/CAS, ABA, unavailable authority, durability, lost ACK/reopen, delayed
append versus absent lookup, and input churn across reads/durability. Service tests additionally
exercise real retained artifact identity/pins, project/membership fences and the all-reported-inputs
negative control. Existing delivery/allocation/review/planning/classification/durability tests
remain regression checks. No real provider, active gate, runtime build or live migration is tested.
