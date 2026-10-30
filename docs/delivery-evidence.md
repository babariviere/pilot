# Revision-bound delivery evidence (internal)

This is a dormant host-only foundation, not an acceptance engine or an agent tool.
It uses the existing mission SQLite durability barrier. Legacy code completion and
non-code records remain readable and unchanged. A hash-shaped commit and free-text
checks are worker reports, not observed landing, CI, independent review or authority.

## Contract

- A submission freezes the complete coordinator-owned v1 assignment (revision,
  intent, scope, ordered criteria), task owner, worker claims and limitations.
  Each criterion has an explicit list of evidence indexes, possibly empty.
  Required `definitionRevision` is the existing per-task
  `MissionStore.sharedDefinitionRevision(taskId)` fence. Admission rechecks it
  after reads; evaluation and new judgements compare it with the frozen value.
  Release/reclaim to the same owner cannot resurrect evidence from an old tenure.
- Evidence references are exact brief revisions, artifact IDs plus revisions, or
  retained comparison snapshot IDs from `review-snapshots.ts`. No live/latest
  fallback, arbitrary URL/path, score or caller-supplied verification result.
  Reference resolution observes identity/content availability only. A screenshot
  reference does not prove an interaction; a source snapshot does not prove tests.
- Each new submission names the previous submission. New evidence/source/review
  revisions require a new submission. Each coordinator judgement names its exact
  submission and previous judgement. Records append; nothing rewrites history.
- Only the task owner or the current coordinator can submit. Only the current
  coordinator can record judgement. Session identity is supplied by the trusted
  host, never an actor/role field in the payload. This is not shell/REST isolation.
- Operation IDs are mission-scoped. Exact retries by the same actor return the
  original record, including after a lost acknowledgement, without consulting
  mutable links/source. Different payload, task, action or actor is a conflict.
  All successful mutation acknowledgements await `MissionStore.durable()`.
- Freshness compares the full assignment and owner, latest submission/judgement,
  and retained evidence identities. Assignment, evidence or review changes never
  carry an earlier approval forward. Missing or unavailable source is not fresh.

Judgement records coordinator approval/rejection, not passing checks, independent
review, merge permission or integration. Required check/review/authority policies
are unavailable until implemented. Exact task-at-operation attribution for code
is unavailable. Current live-source verification is not inferred from task links,
enrollment scope, immutable historical source or caller-supplied current-task data.
No result from this foundation makes a task eligible for completion or merge.
`kind: research` is a claim about intent, not proof that the worker made no code
changes. Contribution/task proof remains unavailable for every kind.

## Host entry points and reads

`MissionService.submitDeliveryEvidence(sessionId, taskRef, request)` resolves
authorized retained references before `MissionStore` rechecks admission and pins.
The optional constructor snapshot reader is host code, never agent configuration.
Snapshot custody must match the frozen worker and mission; enrollment task IDs are
not exact task attribution. Source bytes remain in the existing artifact/snapshot
stores, not a duplicate receipt vault. Observations retain content fingerprints
and availability, not the source payload. Large artifact source hashing is async.

`judgeDeliveryEvidence` records a coordinator decision about an exact submission.
`evaluateDeliveryEvidence` re-resolves exact references, then reads current task
and latest submission/judgement again. Its `freshness` describes these records
only. A `current` judgement is not current live-source verification or eligibility.
Link/pin changes can invalidate reference availability but can never establish
that a source is the current contribution. No filesystem/HEAD scans are inferred.

`MissionStore.deliveryEvidence` returns at most 100 records, oldest first within
the page, defaulting to the newest page. Pass its first record ID as `before` to
read earlier history. `currentDeliveryEvidence` uses indexed latest-record reads,
not a truncated history page. Exact retry checks run before mutable source reads,
and still await durability. A former coordinator may recover their own previously
committed operation, but cannot record a new judgement.
Continuation preserves historical actors/owners, not current approval. Existing
progress projections intentionally do not increment the task-definition fence;
explicit definition/status/owner writes do. The assignment revision is checked
separately, including changes that do not increment that older definition fence.
These are freshness fences, not a new allocation model or task-at-operation proof.

## Proportional examples

| Intent | Worker claim and exact evidence | What remains unproved |
| --- | --- | --- |
| Code | Criterion 0 cites retained layer snapshot; criterion 1 cites pinned test-report artifact | Actual test execution, independent review, task-at-operation binding, landing/CI |
| Native UI | Criterion 0 cites pinned capture artifact; criterion 1 cites pinned interaction report | Real native renderer/input behavior, performance, independent review |
| Research, no PR | Each finding criterion cites pinned report/brief revision, with source limitations | Source truth/completeness, independent review, required policy gates |

Repeated green claims, duplicate captures or self-scores are not new independent
evidence. Balanced reviewer defaults and reviewer independence are unchanged.
Unsupported verification stays unavailable, never skipped-to-passing.

## Deliberately absent

No completion/status-done wiring, merge, cleanup, live adoption, UI or change to
`ask_user`. Future activation needs implemented check and authority policy,
intent-specific independent reviewer policy, contribution reconciliation and exact
later allocation (D31, not invented original task attribution), source freshness
observation and integration verification.
Transport exposure needs its own trusted session admission and project access
checks. These records alone do not satisfy those prerequisites.

[Dormant contribution allocation](contribution-allocation.md) separately records
later coordinator-selected assessment scope under exact submission/assignment and
context fences. This is the D31 alternative to requiring original task-at-operation
purpose proof for that later scope, not retroactive attribution or gate activation.
Historical task purpose stays Unknown; all other delivery gates remain required.

[Acceptance prerequisites](non-code-acceptance-prerequisites.md) separates these gaps from
the existing completion/status routes and proposes a bounded non-code path, without activation.
