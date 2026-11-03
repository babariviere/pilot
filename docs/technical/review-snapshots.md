# Retained comparison snapshots (internal)

`packages/daemon/src/review-snapshots.ts` retains a host-only capture API.
The eligible-worker lifecycle checkpoint below starts bounded committed-layer captures.
HTTP, IPC and agent tools expose no capture write API; opening Review never captures.
The [native Review read slice](mission-native-review.md) exposes only admitted, bounded reads,
with current mission/project/worker custody, strict required manifests and exact retained references.
The host must authorize the exact comparison **before** calling `capture`. Ownership
is evidence about the creator, not authorization from an agent's payload. A future
transport needs its own authorization and read-access checks.

## Eligible-worker checkpoint

Only newly created, managed `planningVersion: 1` builder bindings are capture-enabled.
The creation transaction records activation; observing, reopening or re-registering an older
binding cannot activate it. Legacy missions, existing unenrolled workers, direct checkouts,
Ask/explorer/reviewer/coordinator work and continued custody are not adopted. Existing legacy
mission work remains unavailable without proven enrollment; no legacy custody bridge or backfill
is installed.

On current-worker ready or a quiescent turn end (no background work), the host checks current
durable mission membership/role, mission project, session metadata, the project source and
the exact managed workspace binding. It observes ownership without snapshotting files. At
that pinned observation operation, a proven owned change with one visible revision and one
non-root parent, other than the bound workspace's checkout, defines a **committed layer**.
Merge/divergent/absent/unproven subjects are not reduced to guessed comparisons. A closed
jj object is committed source; this checkpoint does not claim who authored its latest rewrite,
that it was explicitly submitted, that checks passed, or that it landed. Stacks are not inferred.

The normalized request pins physical repository, worker custody, change, operation, exact
parent/base and head, committed source and layer scope. Requests commit in the ownership
worker's FULL SQLite transaction with claims, observations and cursor advancement. The
request key deduplicates the same worker/base/head pair across later observations, retaining
the **first exact operation**. A newer revision creates a separate request, never rebinding one.
The outbox is capped at 10,000 records; quota failure rolls back the observation, not its evidence.

`WorkerReviewDelivery` coalesces lifecycle notifications (including another event during a
drain), admits at most eight queued workers and serializes captures. A pass tries at most four
requests, with least-attempted ordering so repeated failures cannot starve newer revisions.
Pending/failed requests survive crash and are retried at the next admitted worker checkpoint,
including ready after worker recovery, not on a Review GET or a polling timer. Current custody
is rechecked before each capture and after it. Revocation during a capture can leave retained
bytes, but they remain unreadable without current custody. Both current membership/binding and
change ownership are rechecked before settling the retained result. Shutdown joins the owned drain.

The retained store's exact retry/lookup resolves lost ACKs; only its durable result settles an
outbox row. A crash between these commits reuses the same request. Missing pinned objects fail
without substituting newer content. Pending, failed and capture-ineligible observations appear
in the scoped read projection; logs include worker/request/snapshot IDs and bounded failure
classes, never source or raw paths. Scoped status also identifies divergent, multi-parent, root,
absent, unknown-custody/discovery and conflicted cases, with explanations in native Details.
Existing saved comparisons remain independently readable.
No task purpose, task completion, allocation, review, acceptance or integration record is created.

## Capture contract

The host supplies an operation/request ID, physical repository ID, full target jj
change ID, pinned jj operation ID, exact base/head `{changeId, commitId}`, source
kind and one comparison scope:

- `layer`: the supplied base must be an actual direct parent of the supplied head.
- `stack`: the supplied base must be an ancestor of the supplied head.

There is no default branch, merge-base inference, revision abbreviation, live HEAD
fallback or caller-supplied host path. A jj line-of-work is not a selected text
line. Text selections and future annotation filters are separate from comparison
coverage and are deliberately absent from this first capture contract.

The durable ownership ledger resolves the source repository and supplies frozen
worker/change provenance. Both revision identities are checked at the explicit
read-only jj operation. Capturing never snapshots the jj working copy, imports,
changes refs, writes jj history or fetches network objects. It reads the managed
repository's local object store, not files through the worker's workspace.

`source: "committed"` means exactly committed content, even if the workspace has
unsaved changes. `source: "working-copy"` returns **unavailable**, with no source or
patch: coherent unsaved capture is not implemented. It never labels HEAD as the
unsaved content.

## Retention and reads

One private SQLite file outside all workspaces contains the immutable manifest,
before/after source bytes and raw comparison patch. It survives source rewrites,
Git/jj object pruning, workspace removal and daemon/store reopen. No reference back
to live objects is needed after publication.

The manifest records the full request, capture admission time, frozen ownership
ledger observation, Git tree identities, complete captured path inventories,
paths/rename inventory, modes, Git object IDs, byte lengths and SHA-256 identities.
The patch uses explicit pair identities, bounded rename detection, fixed diff
options, no external diff/textconv and no color. Rename detection is heuristic;
the exact original paths, modes and object identities remain authoritative.

`snapshotId = SHA256(serialized fixed-order manifest)`. The request is normalized
before identity comparison. The snapshot includes provenance, so equal source
bytes from distinct capture requests need not produce equal snapshot IDs. Blob
SHA-256 identities remain stable across such captures.

- `get(snapshotId)` returns the frozen manifest.
- `read(snapshotId, {snapshotId, side, path, sha256})` reads only an entry retained
  in that manifest. A reference for another snapshot is rejected, even when bytes
  happen to match. Paths are logical inventory keys, never host filesystem paths.
- `diff(snapshotId)` returns the retained patch or an explicit unavailable error.

Reads verify retained manifest/byte hashes and never fall back to live sources.
Binary bytes are retained and explicitly marked binary, not decoded as source
text. Symlinks are not followed; symlink/submodule content is unavailable. Deleted
and renamed paths remain represented by the two inventories and change records.

`complete` means the bounded comparison evidence was retained, **not** that a
review ran, a task is done or the coordinator accepted anything. Missing/oversize
content, inventory or patch limits produce `partial` with entry reasons and
manifest omissions. Entire mutable capture is `unavailable`. Never present a
partial snapshot as complete review coverage. Invalid identities, unsupported
unsafe paths and invalid comparison ancestry fail rather than guessing.
Conflicted jj comparisons are explicitly unsupported. This first slice supports
the ledger's managed colocated SHA-1 repositories, not virtual root commits or
other source backends.

The ledger may prove worker ownership while `taskAttribution` remains `unknown`.
Enrollment `taskIds` are assignment scope only. This API never creates exact task
bindings or acceptance records.

## Recovery, durability and bounds

Capture first commits the normalized exact request and provenance. A request ID
cannot be rebound to different identities, scope or source. Cancellation/crash
leaves `lookup(request).status === "interrupted"`; retry reuses the original
request/provenance and reads only those pinned objects. If they are no longer
available, retry fails, without substituting a newer revision. Failed requests
remain retryable, not falsely acknowledged successes.

The final manifest, retained bytes and request/result binding are committed in
one awaited SQLite transaction (`synchronous=FULL`, WAL). Only after COMMIT returns
does the worker send the durable result. Lost-ACK lookup/exact retry returns that
same snapshot, including after source removal; lookup does not recapture. SQLite
and hashing execute off the daemon event loop. Store close aborts and joins owned
capture work before closing storage.

One capture and at most eight pending RPCs per store; 60-second capture deadline;
10-second bounded, cancellable local child reads; 4,096 paths per tree; 400-byte
safe paths; 2 MiB per blob; 32 MiB unique source bytes; 4 MiB raw patch and 2 MiB
inventory outputs. No shells, LFS/submodule downloads, hooks or indexing service.
The retained database is capped at 512 MiB (plus bounded SQLite WAL overhead),
with at most 10,000 request records. Quota exhaustion fails without a successful
capture ACK; this API never deletes older evidence to make room.
Retention is explicit app-owned durable data, not an automatic cleanup policy.

The reader shares the existing hardened local Git reader used by code capture.
Ask/source-reader supplies the same pinned-object/no-live-fallback model, but its
text/tree reader does not retain raw patches, modes or durable capture operations.
The artifact store's immutable-publication principle is reused; snapshots need
an atomic multi-blob/request/result transaction rather than a display artifact.
