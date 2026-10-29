# Internal jj attribution ledger

This is attribution metadata, not retained review content, review approval, delivery evidence or
completion acceptance. No UI or agent/HTTP write API is added.

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

## Discovery and reconciliation

`SharedWorkspaceStore.ownership` exposes internal `binding`, keyset-paginated `list`, and exact-key
`get` reads. `observeOwnership` checks the managed binding and observes without enrollment. Sessions
request observation on worker ready and when a turn finishes. Duplicate observations coalesce; at
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
