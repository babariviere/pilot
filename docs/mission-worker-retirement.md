# Proposed durable worker retirement contract

**Design only.** This is a proposed future contract, not an implemented lifecycle, gate,
authorization or permission to archive, delete, adopt a mission, or change live data. D10 sets the
terminal outcome, not a license to weaken preservation. Apply to new opted-in missions first;
existing missions require D22's adoption preview and explicit opt-in. Unknown custody is not adoption.
No retention delay is proposed: after the gates and safety checks hold, archive then start deletion
immediately. A safety block is not a timer.

## Starting point and prerequisites

* [jj ownership](jj-ownership.md) (#13) binds a proven creator to repository instance and full
  change ID, not task purpose, all changes, current content or delivery. Observation can underclaim,
  omit unsnapshotted filesystem edits and lose coverage. Unknown is not an empty inventory.
* [Native Review](mission-native-review.md) (#14) and [snapshots](review-snapshots.md) (#20) separate
  exact layer/stack comparisons from live workspaces. Committed captures are bounded; partial,
  unsupported and working-copy-unavailable are not complete coverage. The read slice exists; #30's
  eligible-worker checkpoint captures bounded committed layers for newly enrolled builders and
  exposes capture failures. It does not capture live edits, establish complete inventory or activate
  acceptance. Durable annotations, requests and submissions in #14 remain proposals.
* [Delivery evidence](delivery-evidence.md) (#18) records pinned submissions and coordinator
  judgements with assignment/owner/shared-definition fences. Freshness is not verified checks,
  review, current source, landing or completion. [Allocation](contribution-allocation.md) (#22)
  selects later assessment scope, not original task purpose. Required policy and #19 activation,
  authoritative integration and complete inventory remain prerequisites.
* `SessionManager.archive` preserves chat history but current archival/reclamation is not this
  contract. `SharedWorkspaceStore.remove` snapshots/rechecks non-ignored work and treats later ignored
  changes as disposable, so it does not satisfy this proposal's preservation gate as-is. The jobs
  registry is not proof that all descendants stopped. Current PR discovery in `pull-requests.ts`
  is a useful cache, not a complete worker-created PR ledger or authoritative merge proof. A closed
  PR is not necessarily merged. Do not wire these existing primitives together as if they prove gates.

## Subject and gate

The future host owns a durable retirement attempt keyed by mission, project, worker/chat, managed
workspace instance and generation, repository identity, and an operation ID. Freeze the exact
assignment set and revisions, actual owners, shared-definition revisions, relevant policy/brief
and context fences; exact owned-change inventory and revisions, pending reviews, PR identities,
evidence, integration and approval references. Capture generation/version fences for each source,
including later membership, assignment, review, workspace and PR-inventory changes. Do not use a
title, a branch, a worker statement, a cached projection, or a hash-shaped receipt as authority.

Completion requires all of the following, independently and currently verified:

1. Every assignment in the worker's scope is actually finished or explicitly and authoritatively
   resolved/reassigned, with no unfinished worker-owned or human-owned work, outstanding handoff,
   question, assignment or pending follow-up. Stuck, waiting for a human, takeover and pausing are
   not completion. Takeover retains the workspace and review data; it excludes concurrent worker
   edits and does not itself resolve the task. Coordinator handles disposition and seeks user help
   when outside authority, as in [handoff](mission-escalation-handoff.md).
2. Every contribution is inventoried and accounted for, including proven worker-created jj changes,
   unproven/borrowed changes and non-code outputs. Verify current exact revisions against the applicable
   criteria, required independent reviews, findings, checks and authority. Unknown, failed, stale,
   pending, skipped, incomplete or unavailable is not pass. Under D31, coordinator allocation
   selects exact retained contributions for later assessment; it neither satisfies independent
   gates nor proves their original task purpose. Retirement still requires all applicable gates.
3. All worker-created PRs are authoritatively known and **merged**, each with exact repository/PR
   identity and observed integration of the relevant revisions. Zero PRs is valid only when a
   complete trusted inventory establishes zero and equivalent accepted non-PR/direct delivery is
   verified. One or many require every PR, including prior branches, to be merged. A closed-unmerged,
   missing, inaccessible, stale, ambiguous or unverified PR blocks. A merged PR alone does not prove
   all its changes or subsequent edits landed. Discovery completeness and authoritative PR/landing
   observations need new primitives; current polling or absent links cannot prove zero.
4. The current coordinator expressly approves that the worker is finished, bound to the exact current
   inventory, assignment/evidence/review/integration and policy fences. Approval is neither a check
   result nor merge authority; prior task approval alone is not worker retirement approval.

Later work, owner/criteria changes, a new revision/review, reopened finding, changed integration or
an incomplete inventory invalidates affected approval and returns to evaluation. False/unknown gates
block, never silently treated as not applicable. The coordinator resolves exceptions and requests a
human decision where required; no worker or cleanup service self-waives preservation or checks.

## State machine and crash protocol

The names below are proposed durable states, not current API names. Each transition and exact
operation payload is durably recorded before its ACK. Journal the specific workspace identity,
attempt generation, input fences, preservation manifest and effect/receipt identities. Exact retries
return the original record; a reused operation ID with changed inputs conflicts. Unknown effects are
reconciled, never blindly repeated. Store the journal and preserved data outside the workspace.

| State | Admission and transition | Failure behavior |
| --- | --- | --- |
| `active` | Work or takeover continues. Evaluate only after explicit worker-finished request or coordinator initiation | Stuck/human-owned work stays here; no cleanup |
| `evaluating` | Resolve the full gate against trusted sources. Failed/unknown gives durable `blocked` reasons; success reserves a retirement generation with coordinator approval | Re-evaluate after changes, not on a stale notification |
| `reserved` | Atomically fence new work admission, assignments, sends, review changes and workspace writes for this generation; serialize concurrent retirement/restore/takeover. Drain already admitted writes and wait for acknowledgement/termination, not just signal or empty job list | If any writer/process cannot be proven quiescent, block. No lock eviction, forced kill, or unsafe deletion |
| `preserving` | Under the reservation, inspect filesystem and full contribution/review inventories, preserve and verify exact durable records and content, then revalidate all gates and identities. Commit the preservation manifest and ready-to-archive intent | Unreadable, unsafe, partial or ambiguous input blocks; preserve evidence and report actionable reason |
| `archiving` | Execute one idempotent archive intent. Record durable authoritative archived state and exact receipt; an ACK only proves what the archive contract explicitly guarantees | Lost ACK: inspect the same operation and exact archive generation; if indeterminate, block, never infer from HTTP success or merely retry a one-shot effect |
| `deleting` | Immediately after confirmed archive, recheck reservation, quiescence, workspace/repository identity and preservation. Record delete intent; delete only that managed workspace instance and its registration, not shared repo, other workspaces or durable stores. Prove deletion/registration outcome and commit receipt | Partial/failure/unknown remains archived with a visible cleanup exception. Do not claim deletion or resume work in a half-deleted workspace |
| `retired` | Only after durable archive and deletion receipts; history and evidence remain readable | Future work uses a fresh scoped chat/workspace linked to retained history, never silently revive the deleted instance |
| `blocked` | Persist phase, reason, exact known/unknown outcomes and next responsible action. Coordinator triages; user resolves authority, ownership or destructive ambiguity when needed | Before archive, retain chat/workspace; after archive, retain remaining workspace and preserved records. Retry only when proof is restored |

The fence is a required future host-wide admission/exclusion mechanism, not a claim that an in-memory
mutex or current Stop supplies it. It must cover host-mediated mutation, worker and child jobs,
workspace recovery and competing restore/takeover, and fence admission before draining in-flight work.
External editors or shell processes not governed by the fence, process inspection errors, or mutable
path/identity races make quiescence unprovable: block. No claim of hostile-shell isolation is made.
Ensure deletion cannot follow a replaced directory, symlink or changed workspace/repository binding.
If this cannot be enforced atomically enough, the implementation remains unavailable.

At restart, recover the journal and reservation before admitting new writes. Reconcile the exact
archive/deletion operation using durable authoritative receipts and workspace identity. If an
operation provably did not take effect, retry the same intent only under the same valid reservation;
if it did, advance once; if neither can be established, block and escalate. A path absent by itself
does not prove which workspace was removed, and a missing ACK does not prove failure. Before deletion,
if a fence has changed or a restoration wins, cancel the attempt, release the reservation safely and
re-evaluate. After deletion begins, reconcile its outcome before any restore or new admission. Keep
operation IDs and outcomes durable across crashes, duplicate events and concurrent retry attempts.

## Preservation and cleanup exclusions

Preserve and verify, outside the disposable workspace, the conversation including pending inputs and
tool/job outcomes, artifacts and exact versions, assignment/history/approval and provenance, delivery
evidence, PR and integration observations, and audit/cleanup journal. Keep access governed by current
mission/project custody rather than making preserved bytes public. Do not drop user drafts or pending
questions. Prove writes are durably committed and readable by identity, not just queued or ACKed.

For every owned or otherwise discovered change, reconcile current full identity and exact revisions,
including multiple changes, rewrites, split/squash/abandon and divergent revisions. Preserve every
required review comparison, its layer/stack, base/head, manifest, source/patch bytes and omission
status, plus exact annotations, drafts, submitted feedback, request history, authorship and anchors.
The #14 annotation design requires durable implementation and access after workspace deletion; the
current read-only slice is not that implementation. Pending or unresolved review, missing snapshot,
partial coverage needed for acceptance, quota/corruption, unknown custody or incomplete inventory
blocks retirement. Do not substitute live files, a different layer, a newer revision or an empty list.
Retained metadata alone does not preserve content. Keep historical task purpose Unknown where unproven.

Inspect both tracked edits and untracked or ignored content, including files omitted by jj and nested
repositories, without following paths outside the workspace. Unsaved, undelivered, unsafe, unreadable,
unsupported or ambiguously owned material blocks deletion until the coordinator arranges explicit,
authorized delivery or durable preservation and resolution. An ignore rule or build-output name alone
does not prove a file is disposable. User-owned or secret material must not be copied into a review
store by default. The responsible person chooses a safe disposition within authority; never silently
discard it. If complete inspection/preservation cannot be proven, retain the workspace. Changes
arriving during inspection invalidate it and require a new fenced evaluation.

## Contract scenarios for future implementation

These are executable-test obligations, not claims that tests or implementation already exist.
Use deterministic fake durable stores, jobs, PR observers and filesystem identities; inject crashes
at every journal/effect boundary and verify both state and retained bytes after reopen.

| Given | Expected invariant |
| --- | --- |
| Verified non-PR delivery and proven zero PRs | Approval, archive, immediate delete; no artificial PR |
| One merged PR, current checks and approval | Retire only after exact merge/integration proof |
| Three PRs, two merged and one open, closed-unmerged, inaccessible or unknown | Block; neither archive nor delete; coordinator resolves |
| PR lookup returns empty but discovery coverage is unknown | Block, not zero; failed/lost lookup never means merged |
| Assignment reassigned but unfinished, stuck or human takeover active | Keep workspace and reviews; no completion inferred |
| New assignment or changed owner A→B→A during drain | Fence invalidates approval; no delete based on old tenure |
| Active child, detached writer, failed census or pending operation | Drain/join with proof or block; empty registry and Stop ACK insufficient |
| Tracked dirty edit, untracked/ignored file, nested repo, unreadable path or path swap | Block until safe authorized disposition; never follow or delete replacement |
| Two changes, one unreviewed; stale review or unresolved annotation | Block; review of one never consumes the other |
| Retained snapshot partial/unavailable, corrupt, missing, or annotation only in workspace | Block; no fallback; after successful retirement exact snapshots and annotations survive reopen |
| Snapshot and assessment pass but source changed or checks unavailable | Block; historical evidence or coordinator judgement alone is not gate success |
| Lost ACK or crash before/after archive or delete side effect | Reopen and reconcile exact operation, preserve Unknown; never falsely report completion or delete twice |
| Archive succeeds; deletion fails, partially succeeds or identity changes | Archived cleanup exception persists; no false `retired`; coordinator handles safe recovery |
| Restore or new work races reservation/deletion | Serialize and fence; before deletion invalidate/re-evaluate, after intent reconcile before admission |
| Future follow-up after completed retirement | New scoped worker/workspace linked to historical records; no implicit resurrected ownership |

## Implementation dependencies and decisions

Before activation, implement complete conservative contribution and PR inventories, trusted merge and
landing observations, current gate policy and coordinator approval, durable annotations/review
requests, workspace-wide reservation/quiescence, retained-history and filesystem preservation, and
idempotent archive/deletion reconciliation. Define a practical authority and UI for exceptional
disposition without weakening any gate. Validate host and filesystem guarantees on supported
platforms. Any unsupported inventory, omitted material or ungoverned writer keeps cleanup blocked.
This proposal selects no concrete transport, storage schema, user consent for deletion, migration or
release. Tests above are the contract for later scoped implementation, not permission to activate it.
