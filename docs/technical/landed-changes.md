# Retained changes and landing observations

Backend contract only. No Day UI, live observation activation, scheduler, capture enrollment,
approval producer or release is installed by this change. Existing review/feedback/attention
writers keep their permissions and semantics.

## Passive reads

The existing scoped, local retained-review GETs accept:

- `/api/sessions/:sessionId/review?view=changes&after=0`
- `/api/missions/:missionId/review/:sessionId?view=changes&after=0`
- Either selected comparison path followed by `/:snapshotId/history`, with optional
  `landingAfter=0` and `reviewAfter=0` cursors.

`expectedProjectId` remains supported on session paths. All responses are `no-store`.
The version-1 protocol is in `packages/protocol/src/landed-changes.ts`.
These reads do not contact GitHub, wake workers, capture source, enroll old work or write attention.

Pages contain at most 20 retained comparisons. Their scope is **retained-comparisons-only**, not
all project work or all landed changes. `next: null` ends that enrolled slice, not a repository
inventory. Missing enrollment or unavailable/pending/failed capture is not an empty result.
Page qualification reads manifest metadata and custody fences, not every retained patch blob.
Unavailable selected source keeps a redacted slot; history fails closed when exact source cannot
be qualified. A complete, retained comparison with zero changes remains a valid empty comparison.

Each available row keeps the original comparison sequence, request ID, physical repository/change
identity, operation, base/head, layer, source kind and capture time, plus the exact feedback target.
`landing` is the latest saved observation attempt. Null means unobserved, not never landed.
`observedLanding` is the last positive historical observation, even after a later unknown/negative
attempt. Neither promises the commit is still contained in today's default branch.

History reopens the exact snapshot manifest and the original retained source/patch APIs, never live
files. It returns 20 landing observations and 50 human-review records per page with separate cursors.
Human records keep original IDs, operation IDs, author assurance, package digests, target selection,
disposition and annotation anchors. Attention keeps exact current request IDs, operation IDs,
revisions and states, including terminal requests. `complete: false` reports the 100-request bound.
The existing request-history endpoint supplies each request's full revision history.

Review is not approval. Historical `approve` records are not a current grant. Reopen always reports
`approval: not-evaluated` and `acceptance: not-evaluated`; it never prepares an approval, supersedes
feedback, resumes a snoozed request or revives withdrawn/retired/replaced requests. “Later” continues
to use the existing revision-checked attention snooze writer. Snooze is not acceptance or a gate waiver.

Reported completion hashes have a separate optional host projection. The HTTP reader currently
reports this source as unavailable: enrollment task IDs or a matching hash do not establish historical
task attribution. It never substitutes agent prose, cached PR state or chat completion for landing.

## Explicit host producer

`LandedChanges.observe(observationId, snapshotId)` is an internal, explicit host seam. There is no
landing mutation HTTP endpoint, agent tool or automatic observer. A future native adapter must supply
current host/project authority and a producer, for example a callback to
`SessionManager.observeRetainedLanding(sessionId, snapshot, ownedPrUrlOrNull, authorize)`.
Do not install this callback in a GET handler.

The session adapter derives upstream/cwd and PR ownership from trusted metadata, qualifies the exact
retained comparison and checks custody before and after the read. The GitHub adapter shares the
existing runner/rate budget without entering the PR scheduler. All commands are reads:

- Direct-delivery support observes containment of the exact committed head in the upstream's current
  default-branch revision. It reads the repository/default ref, compares exact OIDs, then re-reads the
  same ref/target. Churn is stale; denial/malformed/partial evidence is unknown; non-containment is not
  proof that the change never landed. This is not proof of who pushed or the push time.
- PR support reuses the fresh exact PR producer. Repository, head/base pair, merged commit and
  containment in the observed default target must match. Open/closed-unmerged PRs and cached merged
  labels cannot prove landing. Check availability and configured approval readiness stay independent.
- Working-copy comparisons cannot establish commit landing. Other hosts/providers and unqualified
  legacy contributions remain unavailable. No squash lineage or branch-name match is guessed.

Observations append to `change_landing_observations` in the existing `missions.sqlite` transaction,
replica and durability lane. Retained bytes stay in the snapshot store. Exact target digest, producer,
observed ref/target/revision, observation time and record sequence are kept. A negative/unknown result
does not delete earlier evidence. Reusing an observation ID returns its original record after a
durability barrier; using it for another target conflicts. A fresh observation needs a fresh ID.
Lost ACK recovery is lookup-only for that saved ID, not proof of new work or current landing.

Readers pin records before barriers and recheck custody/authority after asynchronous work. History
also rejects a changed attention revision rather than presenting an old snooze as current.
No landing observation edits task completion, acceptance, human feedback, approval or request state.

## Verification

Focused checks use synthetic GitHub responses and disposable jj/SQLite workspaces. They cover direct
and PR containment, stale/wrong identities, unavailable versus empty capture, persisted observations,
lost durability ACK recovery, independent feedback/approval/deferral, revision fences and retained
HTTP history after source loss. Native UI acceptance and live GitHub compatibility are not claimed.
