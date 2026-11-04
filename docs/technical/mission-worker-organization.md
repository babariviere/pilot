# Coordinator worker organization

Implemented backend capability, separate from proposed [automatic retirement](mission-worker-retirement.md).
No native UI changes, historical backfill, bulk archival or live-chat migration.

## Supported path

The supervised `mission` tool exposes coordinator-only `archiveWorker` and `restoreWorker`,
both requiring `targetSessionId`. The daemon derives the actor, mission and project from
current membership and project records, never caller-supplied scope. Self, coordinator,
unrelated, moved-project and delegated remote targets are refused. Archived workers remain
in the existing `status` listing and targeted status path, with current project checks.

Before invoking archive, the coordinator must establish delivery or explicit resolution.
The host requires at least one associated assignment and every current or retained starting
assignment to be `done` or `dropped`. Idle, a done-looking reply or an outcome badge is not
completion. Unresolved comments authored by or addressed to the worker block organization,
as do pending questions. These actions never change task status or approve completion.
They do not prove code acceptance, PR integration or the proposed retirement gates.

`SessionManager.organizeMissionWorker` reuses the archive transition FIFO and update admission.
It refuses live work, tools, jobs, subprocesses, terminals, setup, automatic follow-ups,
scheduled inputs, model/workspace transitions, daemon outbox commands, durable queued/held
inputs and unresolved run/tool effects. A live worker must support child inspection and
report no outstanding admission. Cold reads never reopen it. Unknown/read failures block.
Already-reclaimed or reclaiming workspaces require the user's existing recovery path.

Membership/coordinator activity fences catch leave/rejoin and coordinator ABA. Assignment
and comment activity also invalidate an in-flight request. Current scope and work state
are checked after asynchronous inspection and inside the metadata writer immediately before
atomic rename. Host input/start and workspace cleanup use the existing lifecycle serialization.
This is host-mediated organization, not hostile-process isolation or a filesystem preservation
manifest. After the final admission check, later independently authorized changes are new work,
not proof that an earlier authorization was absent.

## Workspace preservation and durability

Ordinary archive has two cleanup consequences in `reclaimArchivedWorkspaces`: immediate
pruning of regenerable outputs, and shared-workspace reclamation after retention. Reusing
only `archivedAt` would therefore grant deletion indirectly.

Coordinator organization instead durably writes `coordinatorArchivePreservesWorkspace`
alongside archive state. The sweep skips marked workspaces; queued prune and automatic
reclaim recheck it inside their serialized transitions. Older lifecycle metadata saves cannot
erase it. The marker survives restore, later archival and daemon restart, so coordinator
restore cannot indirectly authorize cleanup on the next inactivity sweep. No existing chats
are backfilled. A separately authorized provider continuation carries the exclusion with
the transferred workspace, including continuation-journal recovery. Older runtimes do not
implement this exclusion.

This is an automatic-cleanup exclusion, not a claim that an archive flag alone preserves
data. Coordinator archive also skips scratch removal, cancellation and flow mutations.
Existing explicit user archive/restore and manual workspace reclamation remain available;
manual reclamation is a separate destructive user operation, not exposed by these actions.
There is no coordinator action to remove the exclusion or invoke retirement/deletion.

Metadata temporary-file flush, rename and directory sync complete before a successful ACK.
The result reports `{sessionId, archivedAt}`, with `null` for restored state. Repeated calls
keep the same archive timestamp and recheck authorization/durability. A pre-rename failure
leaves committed state unchanged. A post-rename sync failure reports an error, with the visible
archive state retained in memory and on disk; it is not falsely reported as uncommitted.
An explicit retry rechecks scope and syncs the same state, without work replay.
Scope/work is checked again after durability. If a later change won after the rename's
admission point, the error states the committed archive state rather than rolling back
over that independent change or falsely claiming nothing happened.

Restore changes only organization state and restoration time. It never recreates a workspace,
starts setup/model/flow/post-run work, sends a message, approves completion or replays a
pending effect. A follow-up is a separate authorized `send`/`start` after restoration.
History, artifact versions, task records and custody rules are unchanged.

## Qualification

Owned `mission-service.test.ts` fixtures cover delivered workers, explicit follow-up, passive
restore, repeated calls, scoped status, unfinished/busy/cross-mission/project refusal,
membership ABA, assignment/coordinator races, queued/held inputs and pending effects,
metadata FIFO races, failed persistence and post-rename durability uncertainty.
`session-workspaces-retention.integration.test.ts` exercises actual jj workspaces and stored
history/artifacts across pruning, retention and daemon restart, while retaining explicit
user reclamation. Kernel mission-tool fixtures check coordinator-only declarations/forwarding.
No qualification requires touching real chats or activating the retirement pipeline.
