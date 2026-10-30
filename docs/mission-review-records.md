# Versioned review profiles and results (internal)

This is a **dormant host-only record/configuration foundation** in
`packages/daemon/src/mission-review-contract.ts`, `MissionStore` and
`MissionService`. It installs no write transport, tool, reviewer execution, model call,
scheduler, routing, active gate, acceptance, completion, merge or cleanup behavior.
The bounded native Review reader can display selected-comparison record summaries; see
[native Review](mission-native-review.md). It does not execute reviews or grant current-review authority.
It changes no Ask capabilities, roles, runtime configuration or live missions.

## Profiles

A schema-v1 profile has a stable mission-local ID and monotonically appended
revision, purpose, explicit rubric, applicable delivery intents (`code`,
`native-ui`, `research`), configured provider/model or an unavailable reason,
reasoning effort and time limit (each explicitly nullable/unconfigured), and
structured output interpretation. Interpretation is either named Pass/Fail
meanings or named Low/Medium/High **human-attention** meanings. These are not
quality scores, probability, effort, acceptance or delivery decisions.

`saveReviewProfile(sessionId, request)` requires the current coordinator, a
current same-project session and planningVersion 1, even on exact retries.
`expectedRevision` is CAS; older versions remain inspectable by exact revision.
The optional `reviewProfileDiagnostics` helper reuses the existing task-model
catalog and attributed model suitability/provider observations. Missing, expired,
disallowed or unsupported configuration stays unavailable. It makes no provider
calls, invents no model mapping and never switches a chat's model.

`optionalReviewSeeds()` returns four independent optional definitions:
correctness, security, maintainability/Slop and human attention. It does not save
them, mandate four reviewers, select models or learn preferences. The Slop rubric
preserves the user-authored patterns and legitimate counterexamples. Findings
require concrete cost/evidence, not file/line counts or blanket architectural
bans. No automatic rewriting is implied.

## Results and retained inputs

`recordReviewResult(sessionId, taskRef, request)` admits the current coordinator
or current task owner as **recorder**, not verified reviewer/author. It freezes:

- Exact profile ID/revision and complete assignment, including classification,
  task owner and the existing `sharedDefinitionRevision` fence.
- One exact retained comparison for code, or pinned brief/artifact references for
  non-code. Context and preference guidance use the same retained references, or
  an explicit unavailable preference reason. A guidance label is not proof of
  human authorship, accepted preference learning or an authoritative memory store.
- Resolved identities, content digests, custody and availability via the existing
  [delivery-evidence](delivery-evidence.md) and
  [snapshot](review-snapshots.md) readers. Content bytes stay in their existing
  stores, never a parallel receipt/content vault. Reads never substitute latest
  content or live workspace files.
- Retained context fence: brief revision and existing mission activity sequence
  IDs for decision, artifact-pin and membership changes. This conservatively
  invalidates on **any** such mission activity, not a claim of inferred relevance.
  Unlink/relink and source-custodian leave/rejoin ABA cannot resurrect a result.
  Requests explicitly name `expectedContextFence`; admission checks it before and
  after reads. Recording cannot silently stamp newer context onto older output.
- Producer observation separately from recorder. By default it is unavailable.
  An optional host-installed observer may attest the producing agent/session and
  actual provider/model plus observation identity. Selected chat/profile models
  are not observed output. Producer membership/project is rechecked; agent
  payloads cannot supply observations. No human-authorship or independence proof
  primitive exists here, so both remain unavailable. A role or different chat is
  not proof of independence. This is host admission, not shell/REST isolation.

Execution state is `pending`, `completed`, `failed-to-run`, `timed-out` or
`inconclusive`, with inspectable reasons. Only completed carries an interpreted
outcome. Partial findings may be retained after timeout/inconclusive execution;
they never turn that state into completed. Confidence is optional qualitative
self-assessment (`unavailable`, `low`, `medium`, `high`), not calibrated probability.

Findings identify the concrete trigger, failure/maintenance cost, severity,
counterevidence and whether debt is introduced, worsened or existing audit
baseline. Code citations are exact snapshot/side/path/hash/UTF-8-byte ranges in
retained text. Non-code findings cite the exact pinned brief/artifact with an
explanation, not fabricated code. A Pass cannot hide introduced/worsened findings.
Rubrics judge net base/head effects, not intermediate commits or unchanged legacy.

Resolution assessments name a retained prior finding in the same task/profile.
Resolved/remaining assessments require new applicable retained citations and a
reason explaining the triggering path. Fixing a boundary elsewhere on that path
is valid; line disappearance alone is not proof. Assessments remain reported
evidence, not verified behavioral proof or automatic finding closure. Original
findings and results are never overwritten.

## Applicability, durability and bounds

Results append using `expectedResultId` CAS per task/profile. Re-evaluation keeps
the historical output intact and reports pinned-record applicability separately:
`current`, `outdated` or `unavailable`, with reasons. Superseded profile/result,
changed assignment/owner/definition, changed context/pin custody or changed
retained identities invalidate applicability. Missing/partial source stays
unavailable. Current pinned-comparison applicability **is not live-workspace
freshness**. There is no live-source observer; `liveSourceFreshness` is always
unavailable. Historical snapshots cannot establish the current contribution.

The host checks current actor/project authorization **before retry lookup**, and
again after asynchronous reads. Exact review operation retries recover the same
record before consulting mutable source/CAS state, but never bypass current
authorization. Actor, task, action or payload changes conflict. Concurrent exact
retries deduplicate. New writes and retries await the existing mission SQLite
durability barrier, including recovery after a lost acknowledgement/reopen.

Records live in one append-only table in the existing mission database, capped at
256 KiB per record; bounded arrays cap references/findings/citations. Reads resolve
sequentially. History pages contain at most 100 records with explicit cursors;
indexed latest reads do not depend on history page size. No automatic retention
deletion is added. Existing legacy completion, delivery evidence, snapshot and
critical-review records/configuration remain unchanged and are never promoted.

All acceptance/authority/eligibility/independence outputs remain unavailable.
Even a current Pass is not passing checks, independent review, coordinator
acceptance, task-at-operation proof or integration. Future authority/review policy
and active contribution acceptance are separate prerequisites. The dormant
[allocation foundation](contribution-allocation.md) records later selected scope,
not original task purpose or active acceptance; these review records keep their
existing context and retry semantics.
No existing delivery gate consumes these records.
