# Internal jj attribution ledger

This is attribution metadata, not retained review content, review approval, delivery evidence or
completion acceptance. The creation-only [worker checkpoint](review-snapshots.md#eligible-worker-checkpoint)
atomically queues exact committed layers alongside observations, separately from acceptance.
No agent/HTTP write API is added. Native mission Review now consumes
bounded, admitted ledger reads; see [native Review](mission-native-review.md).

## Enrollment and identity

Only the creation of a **new managed shared workspace** for a builder in a `planningVersion: 1`
mission can enroll. The mission bridge supplies the session, mission and assigned open task IDs;
the workspace factory supplies the repository instance, workspace name and canonical path. Ask,
explorer, reviewer, coordinator, direct-checkout, Git-only and legacy work are not enrolled. Merely
reading, reopening or observing a workspace cannot enroll it. Existing missions are not adopted.

The key is repository instance + full 32-character jj change ID. Repository identity hashes the
canonical managed `.jj/repo` path and filesystem device/inode, not the remote URL or author. A
replacement, copied or relocated repository does not silently inherit attribution. The immutable
binding captures the original chat and task scope, not their later membership. Multiple task IDs
mean enrollment assignment scope only. Exact per-change `taskAttribution` remains Unknown, even for
one task: later claims/reassignments are not bound to jj operations by the current machinery.
There is no inferred transfer, including chat continuation or reassignment.

The factory records the exact initial change/commit and creation operation before worker admission.
That trusted creation fact is different from discovering a change in the current working copy.
New creation proofs also save `baselineCommitId`, the factory's resolved starting base. Existing
proofs are not upgraded or backfilled. Their missing baseline remains unknown. Creation-only v2
project/chat enrollment uses the same proof without claiming mission/task membership.

## Discovery and reconciliation

`SharedWorkspaceStore.ownership` exposes internal `binding`, keyset-paginated `list`, and exact-key
`get` reads. `observeOwnership` checks the managed binding and observes without enrollment. Sessions
request admitted observation on current-worker ready and when a quiescent turn finishes. Duplicate observations coalesce; at
most two run concurrently. Busy/failing observation is not a fresh result, and a later observation
can catch up from the durable cursor.

All observer jj commands use **both** `--ignore-working-copy` and `--at-op` (a pinned operation after
the initial head read). Ignore-working-copy alone can still merge concurrent operations. Observation
never snapshots files, imports refs, integrates operations or rewrites history. Dirty filesystem
edits are not new observed commits until some other authorized jj operation snapshots them.

Operation history is paged back to the durable cursor without an in-memory ownership window. Only
recognized jj 0.46 creation operations in the bound workspace can introduce claims: new, commit,
split, and the automatic new changes in single-commit abandon/squash. Full IDs added but not removed
in that operation's commit diff must also be its newly-created checkout target. This avoids claiming
borrowed abandoned ancestry resurrected by `jj new -r <old-commit>`. Non-checkout creations (for example
`new --no-edit` or splitting another change) underclaim until a stronger birth proof exists.
Rewriting an existing ID, editing borrowed work,
importing refs, or inheriting a branch never claims that ID. Unknown commands underclaim. This is a
daemon attribution boundary, not hostile-shell isolation or cryptographic proof against forged jj
metadata/configuration.

A known change keeps its creator across describe/rebase/commit rewrites. Split adds a distinct
identity; squash/abandon do not transfer or delete old identities. Absent changes remain in the
ledger, and divergent change IDs return **all** observed commit IDs, never an arbitrary winner.
Conflicting creation claims yield ownership `unknown/collision`, not first-writer-wins ownership.

The observer does not guess across merged operation histories or an unreachable cursor. It makes
no new claims for that interval, permanently records discovery coverage `unknown`, refreshes known
identities at the pinned head, and resumes provable discovery after that checkpoint. A malformed or
failed read leaves the cursor unchanged and current provenance Unknown until a successful retry.
`discovery: complete` means no history interval was skipped, not that unsupported creation commands
were attributed. Missing claims always return explicit `unknown/unproven`.

## Durability and read meaning

`<daemon-home>/jj-ownership.sqlite` lives outside workspaces. A worker thread owns SQLite, WAL and
`synchronous=FULL` commits, keeping disk sync off the daemon event loop. Enrollment is immutable and
idempotent; observations, creation claims and cursor advancement commit atomically with cursor CAS.
Strict record versions, full IDs and exact write fields reject unsupported/ambiguous input.
Malformed stored metadata fails closed rather than being normalized into ownership. Shutdown drains
observers and closes the store. Legacy observation does not even create the database.

`get` returns original creation provenance plus the **last point-in-time observation**: operation ID,
timestamp, commit IDs and parent IDs. `observed`, `divergent`, `absent` and `unknown` describe the view
at that operation. They are not a freshness guarantee, a claim about who authored a rewritten
revision, or proof of landing/checks/review. First-observed revision metadata is retained without
duplicating unchanged commits. Files, trees, patches and blobs are not retained, and jj GC may make
their content unavailable. Immutable review preservation is a separate facility.

## Inspecting change evolution and publication

`GET /api/sessions/:chat/review/:snapshot/evolution` (and the existing mission/worker Review route)
uses the retained comparison's exact owned change, current project access and durable binding.
It runs targeted `jj evolog` at one pinned operation, returning at most 20 commit/parent identities
plus `more`. Related squash predecessors are not adopted as owned changes. Missing/GC'd objects,
changed custody, repository replacement or concurrent operation changes refuse the read. It does
not snapshot, enroll, run the ownership observer or scan the repository's full history.
For absent squashed/abandoned changes it starts from at most two already saved revision identities,
or the creation commit when none were observed. `seed` states this limit; absence is not complete
post-creation history. The store limits these reads to two concurrent requests and joins them on close.
One `jj op log --limit 1` supplies the pinned repository operation and its parents only. It is
explicitly repository-wide evidence, not proof that this chat performed that operation. No shell
source, operation descriptions, author/host names, paths or credentials enter this projection.

Push and PR creation stages extend the existing `GitHubActionsDoc` and chat/mission audit feed,
not a second activity store. A durable `command-dispatch` attempt precedes execution. The result
record names that exact `attemptId` and records `confirmed` or `unknown`. A crash before the result
leaves the attempt unresolved. Reopening replays saved observations, never the push/PR mutation.
Native nested calls are observed at dispatch/result time, not inferred from codemode source.
Confirmation requires a simple authoritative successful command result; PR creation additionally
requires its one exact returned PR URL. Compound shell results, exceptions and missing replies do
not establish success. Failed pushes still count as attempts for the existing follow-up budget,
not as confirmed publication.

A simple `jj git push --bookmark <literal>` can attach a pre-dispatch local selection: repository,
operation, explicitly owned tip change/commit, original creation commit and optional baseline.
The supervised daemon resolves the bound workspace and checks custody. Other refspecs, implicit
heads, foreign/legacy changes and repository overrides stay unlinked/Unknown. This selection is
not proof of the remote revision: a bookmark can move after the read. Neither evolog nor op log
confirms a push, PR creation, checks, merge, deployment or user acceptance. Exact remote head/base,
canonical PR identity and checks continue to use the existing on-demand GitHub delivery reader
described in [delivery evidence](delivery-evidence.md#passive-code-observations). A later matching
remote record proves its observed state, not that an unresolved original mutation succeeded.

Day shows this as a folded **Agent work** section on a delivered result's page. A linked task in
a coordinator thread opens that page with it shown. Only Show reads, through the native
`day.delivery.work` method: it rechecks the exact result (target, delivery and owner chat), reads
evolution for at most three retained comparisons the result's submission names, and reads the owner
chat's saved audit through `GET /api/sessions/:chat/publication-audit?expectedProjectId=`. That
route needs the native capability and the chat's exact current project, and reads the saved
`GitHubActionsDoc` passively, without starting or subscribing to the chat. A task result keeps only
push and PR-creation records made in its mission, at most 20. The result is read again afterwards.
Day pairs dispatch and result records by `attemptId`; a missing result stays Unknown, and a local
selection is labelled as not proof of the remote revision. PR state and checks come from the
result's existing saved observations; the PR head revision is not read there. A refused section
shows as unavailable, never as empty.
