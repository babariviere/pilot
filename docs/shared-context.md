# Shared context and independent task execution

This is the daemon/client integration protocol, not the devbox enrollment or delegation UI.
It uses the existing loopback-only daemons and pinned SSH transports. No reverse connection,
public unauthenticated API, workspace synchronization or credential/configuration transfer is added.

## Authority, enrollment and local reads

An explicitly confirmed `SharedContextBinding` pins a logical project, binding ID/generation,
memory-home project, mission-home installation, execution-host project and mission allowlist.
Names, repository URLs and filesystem paths never establish enrollment. Each participating daemon
must persist the same enrollment. Unknown enrollment fields and invalid qualified references are
rejected. Scope/identity is immutable; revocation is monotonic. A new link does not adopt the old
link's quarantined proposals or allocations.

Memory and mission homes may differ. Memory authority may be the execution daemon, using its
enrolled canonical memory project rather than its workspace project's unrelated memory. Canonical
commits remain single-writer. A revision vector describes independent stores, not a distributed
transaction. Source changes use entity revisions and tombstones; activity IDs are not a changefeed.
Task definition/user-intent revisions are distinct from imported execution progress.

Memory checkpoints contain the complete authorized raw entry set with stable IDs, corrections,
checksums and qualified provenance. Historical local notes without recorded host provenance are
not assigned an invented origin. Checkpoint manifest/cursor export is durable and resumes in
bounded batches. Replica staging cannot execute a task. Activation verifies completeness and
digest; deltas must be contiguous. Replacement preserves proposals, conflicts and receipts.

Delegated mission/memory tools read these durable local stores, not a Mac RPC or the app's offline
summary cache. The target never creates a writable cloned mission. Pending memory contributions
are shared among authorized chats on the same binding, explicitly labelled and without fake
canonical indices. Correction indices resolve through a pinned read view to stable IDs and CAS.
Canonical and provisional changes produce durable, deduplicated context notices. Memory overlays
have their own durable revision, independent of canonical count. A missing mandatory replica blocks
admission/recovery; the ordinary best-effort memory-wake timeout is not a completeness guarantee.

## Native page reads

Native placement uses `POST /api/missions/:missionId/tasks/:taskId/delegations` with both
`expectedRevision` (the current task definition revision) and required `expectedPreviousEpoch`.
Read the latest task grant from the mission-home inventory across all bindings, including sealed
grants; send its execution epoch, or `0` only if no grant exists. Both fields are mandatory intent
fences, not timestamps. The store atomically compares the previous epoch and reserves exactly the
next one. Missing/invalid/stale epochs fail with 409, including a delayed old POST arriving after
a later execution has sealed without changing the task definition. There is no implicit-current
default for HTTP or programmatic callers. A failed or uncertain request requires refreshing the
home inventory, not blindly retrying it as a newly authorized execution.

The shared pages must use binding-scoped reads, not ordinary execution-project memory routes:

- `GET /api/shared-contexts/:bindingId/memory/wake?lines=96`,
  `memory/recall?regex=...&lines=96`, and `memory/zoom?lo=0&hi=1` return `SharedMemoryRead`.
- `GET /api/shared-contexts/:bindingId/memory/tree?depth=2` returns `SharedMemoryTreeRead`.
  Optional `lo`, `hi` select an existing aligned block; `reveal=1,2` reveals paths to at most
  64 existing indices. Trees permit depth 1–64 and at most 1024 nodes. Replica trees additionally
  cap node payload at 256 KiB, report `truncated`, and label groups as raw notes, not invented summaries.
- `GET /api/shared-contexts/:bindingId/missions/:missionId` returns `SharedMissionRead`.
  Its snapshot is committed canonical or durable replica state. Pending/conflict/rejected proposals
  are separate, never applied speculatively to the mission. More than 256 retained contributions
  requires reconciliation rather than silent omission.
- `GET /api/shared-contexts/:bindingId/missions/:missionId/versions?limit=128` returns
  `SharedMissionVersions`, with entity/tombstone revisions and distinct task `definitionRevision`.
  Follow `next` using `after` and the original `sequence`; a changed sequence fails with 409 and
  requires restarting the read. Generic entity revisions are for proposal CAS; task definition
  revisions are for placement CAS. Missing legacy definition revisions are unknown, not permission
  to infer them from timestamps, activity, grants or old proposals. New checkpoints/deltas capture
  task definition revisions with their values; the canonical-home route always reads the real counter.

Memory reads include unresolved binding-local contributions. On the memory home, received
conflict/rejection receipts are retained with their original proposals for the same binding;
offline proposals not yet delivered can only be shown by the execution daemon that holds them.

Every response is capped at 1 MiB. Requests derive project, mission scope and authority from an
active enrolled binding. Unknown selectors, duplicate parameters, arbitrary project/session/path
selectors and mutations are not accepted. Incomplete replicas, disabled memory sharing and revoked
bindings fail closed. Revocation is rechecked after asynchronous reads. Read responses use the same
secret-like export refusal as synchronization. `conflicts` continues returning `SharedMissionProposal[]`.

## Control status reads

`pilot status` and `GET /api/control-chat/dashboard` share a change-driven, read-only projection:
`sharedTasks` contains mission-home grants and remote-home committed/provisional task rows;
`replicaMissions` contains enrolled remote-home mission summaries (separate from local writable missions).
Rows carry the pinned mission-home identity and binding. Grants carry the execution host, execution
epoch, reserved/accepted/cancel-requested/sealed state and any eligible last imported working fact.
Cancel requested does not mean stopped; sealed means not running. Missing or old facts never imply failure.
Project filters use the local enrolled execution project for replicas. Mission IDs may match multiple
authorities; rows retain their qualified host/binding identities, never merge their state.

Replica summaries report completeness, sequence, last mission import time and age. Memory imports do
not refresh mission age. Legacy/missing timestamps have unknown (`null`) age. Incomplete replicas expose
no committed task rows. Provisional task proposals retain pending/conflict/rejected labels and never
overwrite committed status or receive invented task numbers. Revoked replicas are excluded; home grants
remain visible even after binding revocation or sealing. The cache retains at most 100 thin task rows per enrolled mission
scope, with pre-clipping totals. Dashboard row and 24,000-byte limits still apply. No worker, remote read,
new transport, connectivity lease or reassignment is involved.

## Performance evidence and remaining risk

The initial #555 CI fixture reported 127 operations, one complete reassembly, about 762 ms wall
time and a 129.37 ms maximum heartbeat gap (115 ticks). Its 2000-write comparison was about
634.8 ms unenrolled versus 735.1 ms enrolled. These are diagnostics, not proof of smooth daemon
or GUI behavior. CPU contention has not been established as the cause. The fixture's session-list
read is not a populated streaming-session or native interaction benchmark.

Follow-up avoids hashing the full manifest once per fragment and deserializing the entire active
outbox just to count entries or send one page. Exchange reads at most 17 indexed rows (16 plus
the `more` sentinel). CI now compares an idle/session-read reference with transfer CPU time,
event-loop utilization/delay percentiles, heartbeat gaps, filesystem block counters, involuntary
context switches and RSS. The canonical-write comparison also reports process CPU. The idle
reference is not a historical pre-change implementation. Large object serialization and final
replica-object parsing remain synchronous, bounded work needing further CI observation. No new
heavy performance measurement or native responsiveness check was run locally.

## Proposals and retained evidence

Remote notes, comments, task/brief edits and new-task proposals are provisional until authority
validation. New task proposals are not executable and receive canonical numbers only at home.
Concurrent edits, tombstones and changed permissions retain conflicts rather than choosing a
timestamp winner. Decision proposals do not activate binding policy offline; explicit home review
is required. Only user-authorized home operations can resolve conflicts or change existing decisions.
PR ownership transfers and sibling claims/dispatch are not replica permissions.

Accepted task scope remains the immutable grant, even if a proposed definition later commits.
Execution status proposals are separate from definition edits. A requested completion is not a
completion proof: home waits for authoritative settled execution facts and its PR requirement.
A turn ending, an idle snapshot, disappearing socket, pending child result or stopped viewer is
not proof that a task or allocation finished.

Target facts have stable IDs and contiguous execution sequences. Home transactionally records
dedupe, eligible projection, activity and coordinator-notice intent. Artifact facts retain qualified
execution ownership; they are not interpreted as local paths or local artifact IDs. Late facts after
cancel, delete, changed scope or revoke remain audit evidence without resurrecting retired tasks.

## Sole grants, cancellation and sealing

Mission home transactionally validates task/dependencies/current intent and persists one allocation,
epoch and immutable outgoing offer. Every local assignment/start path observes that allocation.
Obtaining an executable outgoing batch durably marks it possibly transmitted; losing a response
cannot withdraw ownership or create a fresh dispatch.

Target validates pinned authority, enrollment, complete context, locally available selected model,
and required pinned references. It persists ownership/start intent before session materialization,
using one stable session/opening-input ID through recovery. Repository, executable configuration,
provider access and trust are independently resolved on the target. Grant requests cannot carry
source cwd, attachment paths or executable configuration. Required artifacts must be installed and
digest-verified; task URLs must be explicitly classified online-only or materialized as required
authorized artifact content. Oversize/missing required content blocks, never silently truncates.

Cancellation is serialized with acceptance and leaves binding/home-lineage-qualified epoch
tombstones even when it precedes a delayed offer. Revocation requests fence admission before
asynchronous model selection can finish. Already unreachable execution cannot be instantly stopped
or erased. Revocation blocks future context/grants; prior receipts and factual evidence can still
reconcile. There is no connectivity lease, timeout reassignment, partition election or coordinator
relocation. The coordinator remains at mission home.

A target seal durably fences new inputs and automatic recovery/follow-ups, drains the kernel, and
checks admissions, jobs, actual OS children and workspace PTYs. Idle child kernels and failed/unknown
process inspection remain blockers. Durable child state alone is not a live-process blocker or a
process-resurrection promise. Home frees ownership only after the target's durable sealed/released
acknowledgment, including a never-accepted cancellation tombstone. A lost acknowledgment leaves
the source occupied. Ordinary Stop responses do not authorize reassignment.

## API and courier

Types: `packages/protocol/src/shared-context.ts` and `PilotCore/SharedContext.swift`.

| Endpoint | Contract |
| --- | --- |
| GET `/api/shared-contexts` | Bounded binding/freshness/allocation inventory. |
| POST `/api/shared-contexts` | Explicit enrollment or same-scope monotonic revocation. |
| POST `/api/shared-contexts/:id/exchange` | `{peer: OperationHost}`; up to 16 original immutable operations, with `more`. Export fences transmission. |
| POST `/api/shared-contexts/:id/ack` | `{operation,receipt}`; durably adopt a conclusive matching outcome. |
| GET `/api/shared-contexts/:id/conflicts` | Retained unresolved mission conflicts. |
| POST `/api/shared-contexts/:id/proposals/:proposalId/resolve` | Explicit home review with current expected revision. Original conflict is retained. |
| GET `/api/shared-contexts/:id/events/:delegationId?after=N` | Up to 128 factual events plus explicit next cursor. |
| POST `/api/missions/:id/tasks/:taskId/delegations` | Binding, expected definition revision, explicit model, instructions/reference classification. |
| POST `/api/delegations/:id/cancel` | Cancellation requested, not assumed stopped. |
| POST `/api/delegations/:id/seal` | Target-side quiescence proof; ambiguous IDs require binding qualification. |

Envelopes use existing POST `/api/operations` and `/api/operations/receipt`. Wire operation host IDs
are normalized to `daemon`; installation/lineage pins remain unchanged. Typed conflicts are handler
outcomes, not transport failures. The Mac courier checks receipts first, never invents operation IDs,
preserves pending/unknown ownership and does not replay arbitrary mutations or queue offline chat sends.
The destination journal owns pending-handler recovery. `shared-contexts.changed` invalidates the
courier after durable context changes and final receipt publication. Repeated exchange/fence reads
do not publish invalidations. Caught-up reconciliation becomes event-quiescent.

## Bounds and recovery limits

The operation journal retains its 64-KiB payload/4096-record bounds, four handlers and 64 requests.
Sharing permits 128 bindings, 64 queued calls, eight memory checkpoint pages prepared per exchange,
24-KiB/128-entry memory pages and a 1-MiB complete mission/reference/proposal object. Larger mandatory
objects explicitly backpressure admission. Fragment receipt accounting is scalar/indexed until one
bounded final reassembly, not a full prefix parse on each page. Staging is reclaimed only atomically
with its durable handled marker, never by a timer.

The domain retains at most 4096 outgoing envelopes (64 MiB), 32768 other safety records (64 MiB),
and 16384 mission changes. Enrolled-authority triggers alone record full entity changes; unrelated
local work does not populate that feed. Indexed active outbox reads do not parse historical envelopes.
The memory replica allows 256 retained proposal/receipt slots per binding and eight staged checkpoints.
Inventory over 1 MiB and conflict inventory over 128 fail explicitly rather than dropping safety data.
No safety-receipt TTL/automatic eviction is implemented. Capacity can require explicit operational
reconciliation; full storage is a blocker, not permission to lose an accepted allocation.
Factual events first enter the target's local journal; bounded export batches then reserve their
original outgoing envelopes. Courier/outbox pressure therefore does not discard local facts.
Failure to retain the local execution journal fences that session's future admissions and drains
its tools, without fabricating a completion or freeing home ownership. Repair/seal is explicit.

MissionStore's in-memory primary and disk changeset mirror share transactions. Destination sharing
triggers are disabled on the disk mirror to avoid applying their effects twice. Memory is a separate
worker-owned fsynced file log: prepared intent, stable idempotent append and finalized outcome recover
independently. Export/acknowledgment waits for durable completion. Restore/clone requires storage-lineage
repair; an uncertain rollback cannot automatically fail over.

Focused synthetic tests cover daemon/bridge/tool integration, file-vs-SQLite recovery, checkpoint and
overlay durability, lost acknowledgments, real loopback HTTP/WebSocket quiescence, CAS/tombstones,
revocation races, canonical memory on the execution host and live-child seal blockers. Full Swift,
packaging and large-manifest/streaming measurements are CI gates. They do not establish personal-devbox
deployment, publication/signing availability, sustained GUI performance or arbitrary external-tool
exactly-once effects. Secret-like exports are conservatively refused, not perfectly detected in prose.
