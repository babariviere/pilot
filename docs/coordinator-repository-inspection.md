# Narrow coordinator repository inspection (design only)

## Decision and scope

Prefer a host-mediated **retained comparison view**, not commands in a member's
workspace or access to shared Git/jj stores. The first slice answers a small set
of repository questions from already retained, exact evidence. It needs no new
process execution. Broader history and live status are explicitly unavailable.

This is a proposal, not an implementation or new grant. It does not expose a tool,
start capture, enroll/backfill ownership, activate acceptance/review gates, change
bash/jobs, update a runtime, start an agent or clean up workspaces. Native source
guardrails and the [descriptor traversal design](descriptor-anchored-source-traversal.md)
remain separate. Neither design makes the coordinator process a hostile-reader
isolation boundary.

## Questions the first slice should answer

| Coordinator question | Proposed answer and exact boundary |
| --- | --- |
| What comparisons are retained for this current worker? | Scoped keyset list of retained comparisons with capture time, repository/change/operation IDs, exact base/head and layer/stack. This is **retained comparison history**, not all repository history or all worker activity. |
| Which revision and comparison am I inspecting? | One exact snapshot manifest and its proven worker provenance. Enrollment task scope is separate; original task purpose remains Unknown when unproven. |
| Which paths/modes changed? What is the patch? | Retained changes/rename inventory and raw patch for that existing exact pair. Rename detection is heuristic. A parent/layer is not silently substituted with stack/top-of-stack content. |
| What did this source path contain on either side? | Text retained at `(snapshotId, side, logical path, sha256)`, with strict membership in that exact side. No raw object lookup or live-file fallback. |
| Is evidence complete, partial or unavailable? | Manifest coverage and omissions. A complete snapshot is complete retained comparison evidence, not proof of passing checks, accepted work or merge. |
| Has a newer comparison been retained? | Another explicitly selected comparison from the same scoped list. Never silently advance an active selection. Capture time/order is not live source freshness. |
| What is the worker doing now? Is its workspace clean? | **Unsupported.** Stored ledger observations may identify previously observed revisions, but do not prove current dirty/index/untracked/conflict/process status. No `status` process is started to fill the gap. |
| Show every commit, bookmark, branch, jj operation, reflog, ancestor or sibling change | **Unsupported.** No graph closure or store-wide enumeration. A future bounded history projection would need its own explicit permitted revision set and data minimization. |
| Compare arbitrary revisions, show another object by hash, or prove landing | **Unsupported.** Reuse only an admitted retained pair. No merge-base/default-branch inference, reachability grant, fetch or remote/network check. |

The bounded view is intentionally less powerful than Git/jj. Missing retained
evidence is unavailable, not an invitation to run commands. A non-code task or
legacy unenrolled worker does not gain fabricated code custody to make this view
available. Asking a worker to prepare delivery evidence is a separate workflow,
not an automatic read-side capture or escalation to unrestricted execution.

## Existing architecture and reuse

| Source inspected | Concrete reuse and limit |
| --- | --- |
| [`shared-workspaces.ts`](../packages/daemon/src/shared-workspaces.ts), managed repositories and workspace bindings | Member `.git`/`.jj` metadata leads to a shared project store; filesystem readability or repository membership does not mean every sibling object is authorized. Do not expose these roots. |
| [`jj-ownership-contract.ts`](../packages/daemon/src/jj-ownership-contract.ts), `JjOwnershipBinding`, `JjOwnedChange` | Trusted repository/session/mission/workspace/start-operation binding and exact worker-created change provenance. An observed revision is not a live status or grant to its ancestors. |
| [`review-snapshot-contract.ts`](../packages/daemon/src/review-snapshot-contract.ts), `ReviewCaptureRequest`, manifest, source ref | Exact operation/base/head/layer-or-stack; inventory modes/OIDs/content hashes; strict safe logical paths and explicit partial/unavailable states. |
| [`review-snapshots.ts`](../packages/daemon/src/review-snapshots.ts), `list/get/read/diff` | Existing private SQLite worker, scoped discovery, bounded retained reads, hash checks and no live-object requirement after publication. Reads do not capture or create a missing store. |
| [`native-review.ts`](../packages/daemon/src/native-review.ts), `NativeReviewReader` | Binding-based discovery and source/patch checks, current owner revalidation, before/after read admission and no live fallback. Reuse logic, not app HTTP as agent authentication. |
| [`sessions.ts`](../packages/daemon/src/sessions.ts), `nativeReviewReader`, `coordinatorSources` and `source.scope` | Host-derived custody/current project and worker-bound IPC identity. Add a purpose-specific admitted projection rather than returning stores or forwarding request paths. |
| [`coordinator-source-tools.ts`](../packages/kernel/src/coordinator-source-tools.ts), [`coordinator-sandbox.ts`](../packages/kernel/src/coordinator-sandbox.ts) | Existing fresh-admission and first-party tool-owner checks at direct and nested boundaries; keep them. Repository inspection would be a separate fixed schema, not a special command exception. |

See [retained snapshots](review-snapshots.md), [native Review](mission-native-review.md)
and [jj ownership](jj-ownership.md). Existing app HTTP reads use loopback/origin
checks, not authenticated agent identity. Copying a mission/worker ID into a local
HTTP URL cannot authorize an agent. This design reuses the existing trusted
kernel IPC actor seam; it does not redesign daemon-wide authentication.

The existing [eligible-worker checkpoint](review-snapshots.md#eligible-worker-checkpoint)
independently saves exact committed layers for eligible newly enrolled builders.
`NativeReviewReader.list` can also return scoped pending/failed/ineligible capture
status. Those records explain saved-evidence availability, not live workspace
status, explicit worker submission or accepted delivery. Reads never start that
checkpoint, and this proposal does not extend its eligibility or capture policy.

The earlier controlled investigation found that macOS path denial did not prevent
a hardlink alias read, while Linux read-only host mounts did not scope ownership
of reads. Successful process-leader exit did not establish finite setsid/daemon
descendant lifetime. These are reasons to avoid adding a shell/store grant, not
evidence that this proposed data view isolates every alternate route.

## Proposed host admission and permitted set

1. Accept a fixed operation (list comparisons, inspect manifest, read retained
   patch, read retained text) and bounded logical selectors. No command, executable,
   revset, pathspec, environment, working directory, Git/jj path, fd or host path
   is accepted. Names and content are data, never command fragments.
2. Resolve actor from the current kernel IPC connection. Require that actor to be
   the current active coordinator of the requested mission and project. Resolve
   the target as a current same-mission/same-project member using durable host
   metadata, not caller assertions, task history, title or source_roots output.
   Await existing mission durability and recheck after async binding resolution.
3. Resolve the exact managed binding through host session metadata and the
   ownership ledger. A missing/ambiguous/colliding binding is unavailable. Existing
   retained reads need not stat the removed workspace or reopen a Git/jj store.
   Preserve existing current-custody checks even after source deletion.
4. For discovery, query only that binding's retained records. For one snapshot,
   verify snapshot ID, manifest hash, repository/change/worker binding, current
   proven ownership and stored request identities before releasing content.
   A valid-looking full hash, current membership, common ancestry, shared store
   location or possession of a snapshot ID is not sufficient permission.
5. The permitted revisions are **only the base and head of each specifically
   admitted retained comparison**. The permitted content is only the inventory
   and retained patch for that pair. The base need not have been created by the
   worker; its authorization is comparison context from an independently admitted
   capture, not a claim of worker ownership. Validate that admission policy when
   exposing its records. Nothing here authorizes a new capture.
6. No transitive grant follows commit parents, tree/blob hashes or jj operations.
   The retained source path must be on the specified side with the expected hash;
   do not add a raw-OID API even for objects that happen to exist in the same store.
   Identical bytes in another project/snapshot do not make its reference valid.
   Source content copied into an admitted tree is not authenticated provenance.
7. Scope and current ownership are rechecked at the same boundaries as existing
   `NativeReviewReader`. Membership leave/project move, coordinator continuation,
   binding replacement or custody collision blocks all new calls and pages.
   Finite admitted reads may drain without renewal, but do not weaken existing
   post-read refusal: if that check observes revocation, discard the response.
   Rejoining or A→B→A changes must not revive an old operation; a future transport
   needs an authoritative admission generation, not just equality of final IDs.

Current reader equality checks are useful but do not by themselves prove that an
unobserved membership ABA never occurred. Before exposing the agent transport,
validate the host's membership/custody generation fence (or add that bounded
prerequisite under separate implementation approval). Do not infer a generation
from timestamps, archived history or assignment number. No claim of atomic
hostile-process revocation is made.

## Transport shape, limits and errors

Proposed agent surface: one native fixed-operation repository-view tool with
worker ID and operation-specific snapshot/source selectors. Mission/project are
host-derived where possible, not selectable root grants. Every direct invocation
and nested codemode call reaches the same admitted host dispatcher. It must not
call the app's HTTP endpoint using caller-supplied identity. Do not add a command
runner disguised as `repository.inspect`.

Use existing limits as ceilings: list pages of 20 comparisons, 4,096 paths per
tree, 2 MiB retained source, 4 MiB retained patch, 8 MiB pre-hydration manifest
cap and eight pending store RPCs. Render at most 50 KiB text per tool response,
with explicit incomplete/continuation metadata; never silently truncate a diff
and call it complete. A bounded source excerpt retains the full source hash,
side, path and exact excerpt bounds. It is not a newly hashed whole file.

Propose a 10-second request budget including queueing, one active request per
coordinator and no unbounded automatic multi-page traversal. Keyset continuation
binds the query/worker/binding generation, not authority. Every page re-admits;
no live handle, child or lease is renewed by a cursor. Bounds need validation,
not timeout inflation to hide a stalled reader. Deadline/cancellation suppresses
late publication and joins owned work; slow storage may require asynchronous
drain rather than an immediate physical-I/O-stop claim. No stronger finite-I/O
guarantee is established for unhealthy/network storage.

Return typed unavailable/denied/changed/partial/limit/cancelled outcomes, not clean
status on errors. Separate missing enrollment, no retained comparisons, missing
bytes, invalid reference, stale scope and unsupported live status. Error payloads
must not reveal another subject's existence, host paths, object bytes or raw tool
stderr. Use existing opt-in diagnostics for request/operation, opaque subject ID,
admission/fence failure category, count/byte/time ceilings, retained read phase
and cancel/drain outcome, not source text or arbitrary names. Diagnostics are
actionable failure evidence, not authorization or safety attestations.

## Process execution is not necessary for this slice

All supported answers above come from retained records. The agent-facing view
does **not** invoke `captureReview`, `SourceReader.git`, `readCodeGit`,
`workspaces.run`, `subprocesses.run`, bash/jobs or child SDK execution. Existing
delivery capture policy is independently authorized work, not a fallback on miss.
General bash/jobs behavior and OS profiles are unchanged; do not claim the new
view prevents an already unrestricted process from reading by another route.

Why existing executors are not an isolation answer:

- [`review-snapshot-capture.ts`](../packages/daemon/src/review-snapshot-capture.ts)
  checks exact jj revisions at a pinned operation with `--ignore-working-copy`;
  [`critical-review-code-tree.ts`](../packages/daemon/src/critical-review-code-tree.ts)
  `readCodeGit` uses a fixed executable, sanitized environment and bounded output.
  These are useful host capture mechanisms, not an agent grant to shared objects.
  Local repository configuration/object alternates remain a separate trust issue;
  command spelling and a clean environment are not proof of object ownership.
- [`workspaces.ts`](../packages/daemon/src/workspaces.ts) `run` uses the
  [`subprocess-worker.ts`](../packages/daemon/src/subprocess-worker.ts) adapter.
  It owns a detached process group on Unix, times out/aborts/overflows through
  group signaling, and waits for `close` to drain stdio. A descendant that creates
  a new session and closes stdio can outlive the leader. Successful `close` is not
  a descendant census, and its normal success path is not group teardown proof.
- [`linux-coordinator.ts`](../packages/daemon/src/linux-coordinator.ts) existing
  namespace/readonly-mount checks primarily protect writes. macOS sandbox path
  policies do not establish alias-safe read ownership. Do not extend either
  adapter's claims based on readonly mounts or a command-name allowlist.

If future requirements truly need a live status/history process, that is a separate
design/approval gate. Its exact adapter delta must be reviewed before code:
the new admitted dispatcher must resolve trusted executable/cwd/revisions; a
purpose-specific runner must sanitize configuration, object alternates, environment,
stdin, inherited fds and helper lookup; all nested execution routes must inherit
the same source restrictions. `subprocess-worker.ts` would need an operation-owned,
non-escapable lifecycle owner and stop/join on **success as well as abort, timeout,
overflow, crash and disconnect**, with independent stdio and descendant completion
proof before releasing the operation. Escaped sessions/daemons must remain owned.
Process groups alone do not meet this requirement. No adequate existing cross-platform
mechanism has been established here; do not implement a generic runner or propose
a privileged executor to bridge that gap. Live execution remains unavailable until
a concrete supported mechanism and its inherited restrictions are qualified.

## Platform capabilities and non-goals

| Capability | macOS and Linux result |
| --- | --- |
| Host retained comparison view | Candidate on both using existing retained store and custody logic. Agent IPC admission/generation fencing and bounded presentation are not implemented by this document. |
| Alias/mount/inherited-fd resistance within this view | Logical keys only; no client-selected filesystem path/fd or exposed store. Retained DB is app-owned trusted storage. Corrupt/missing retained bytes fail hash/length validation, never live fallback. This is not immunity to same-UID tampering or mount administrators. |
| Arbitrary shared Git/jj access | Unsupported on both. Read-only store mounts still disclose unrelated objects. |
| Live status/history executor with finite escaped-descendant lifetime | Unqualified/unavailable on both. Existing platform sandbox success is not sufficient evidence. |
| Hostile-process, network, credential or daemon-wide auth isolation | Non-goal. Preserve existing policies; new local HTTP authentication or broad filesystem redesign is not part of this slice. |

Also excluded: repository writes, snapshot capture by reading, live working-copy
snapshotting, fetches/LFS/submodules, loading repository scripts/config as code,
global revision search, hidden object enumeration, merge/review/acceptance authority,
historical task attribution inference, cleanup, live adoption and migration.
The coordinator's own main-view source access remains the native source boundary;
absence of an admitted retained comparison does not turn that root into a Git grant.

## Concrete future tests and activation prerequisites

Tests use owned temporary SQLite/repository fixtures, fake admitted actors and
deterministic admission/read hooks. No live adversarial mutation is required.

| Fixture or route | Required assertion |
| --- | --- |
| Current same-mission/project worker, exact layer and stack | Correct list/manifest/patch/source; preserve selected pair and task-purpose Unknown |
| Other project, mission, unrelated session, forged actor or stale worker instance | No admission/content; no subject-existence or host-path leak |
| Two same-project sibling workers sharing stores, sibling object reachable from a permitted parent | Deny sibling comparison/raw hash even when Git reachability succeeds; base/head context never expands into ancestor history |
| Same bytes/OID across snapshots/projects; swapped side/path/hash | Only exact admitted side/path/hash reads; no content-addressed permission shortcut |
| `.git`/`.jj`, revsets/pathspecs/options, traversal, symlink/hardlink/bind aliases, `/proc/self/fd`, numeric/inherited fds | Reject selectors; no source/store open or fd adoption; no process spawned |
| Direct tool, nested codemode, sibling override, nested tool calls | Same host admission and first-party ownership; no alternate shell/job/HTTP dispatch. General bash/jobs regression remains unchanged |
| Empty/missing/legacy binding, collision, source deleted/pruned, retained DB reopened | Honest unavailable where unproven; valid retained reads survive source loss without touching objects |
| Revocation after discovery, queued/before/after read, between pages; coordinator continuation; membership A→B→A | No new admission/renewal; preserve stronger postcheck refusal; generation fence rejects old cursor/request |
| Oversize/malformed manifest, source/patch hash mismatch, binary/partial/conflicted evidence | Pre-hydration bounds and explicit incomplete/unavailable, never Pass/clean status |
| Abort/deadline/close with slow store, queue saturation, stale reply | Suppress late bytes, bounded queue, join owned work; no claim immediate physical-I/O cancellation |
| Supported request and every unsupported/error path with all spawn/capture adapters instrumented to fail | Zero process launches, captures, fetches, enrollment writes or new grants |
| Future executor qualification only: leader exits 0 while setsid/double-fork child closes stdio; abort/timeout/overflow/disconnect/crash | Must prove all descendants owned and joined on all paths. Current close/group implementation is insufficient; failed qualification keeps execution unavailable |

Before implementation: confirm the question set, validate retained-capture admission
and membership generation prerequisites, specify the worker-bound IPC/tool schema,
and reuse/extend scoped `native-review*.test.ts` and coordinator direct/nested
fixtures. Run focused retained-reader and tool boundary suites on both platforms;
measure bounded large retained inventories off the event loop. Do not start with
shell access, relax tests, infer missing custody or add capture-on-read to make
empty examples work. This docs change runs only document/source-reference checks,
not platform security or process-lifetime qualification.
