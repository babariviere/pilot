# Status-only mission completion, Archive/Reopen

Mission Overview has a named **Mark done** action beside **Read decisions**, available only for an active
canonical Local mission whose current, complete task detail proves all remaining
tasks done. Dropped tasks are excluded, as in Swift; at least one done task is
required, so empty and all-dropped missions cannot complete. Confirmation states
the done and dropped counts. Task filters, collapsed phases and the short Overview
preview do not decide eligibility. Loading, failed/offline and incomplete reads
never enable it. Completion is explicit, never inferred from chat outcomes.

Overview offers contextual Archive or Reopen, followed by an explicit confirmation
for the canonical Local home, project and mission. The confirmation reads the
current title/status and describes the operation. It has no editable fields.
Existing root pre-blur/IME guards protect entry and navigation. Escape cancels;
Return or Command-Return confirms. Close restores mounted browser focus.

## Safety contract

`POST /api/missions/:id/lifecycle` is opt-in, distinct from legacy status PATCH.
The body contains only operationId, home (daemonId/lineageId), projectId,
expectedStatus and action (`complete`, `archive` or `reopen`). The server pins home, checks
project/status synchronously and commits only mission status/timestamps, a status
event and the durable passive-lifecycle marker. It does not reconcile tasks,
change membership/role/autopilot, archive/restore chats, remove scratch, send input
or stop work. An already-running turn is not interrupted. Legacy calls on missions
that never opted in retain their existing behavior.

Completion re-reads canonical identity and task eligibility before its single POST.
The server checks the active mission and current stored task statuses inside the
same immediate transaction as the status write, so a task reopened after preflight
blocks completion. Passive completion neither invokes tracker completion listeners
nor replays them on daemon startup. It does not complete tasks or release claims.

Passive lifecycle is durable: coordinator auto-archival and automatic coordinator
notices remain suppressed, including already-frozen/queued notices and restart.
Notice records are retained, not acknowledged or discarded. Mission-triggered
role callbacks cannot start pending work. Explicit chat sends/Stop still use the
normal admission path; unrelated previously running work can recover normally.
Inactive-chat maintenance does not treat passive mission archival as permission
to archive its member chats. There is no automatic re-enable or general automation
editor in this feature. Confirmation discloses the ongoing notice hold.

Old daemons without the `passiveMissionLifecycle` hello capability fail before
POST. No fallback to legacy PATCH is allowed.
Completion additionally requires `passiveMissionCompletion`; an older daemon may
still support Archive/Reopen without supporting Mark done.

## Delivery

Each user-confirmed attempt captures an immutable source, before-status, action
and operation ID. This ID correlates the response, not an idempotency/replay key.
Success requires the complete matching response and passive-lifecycle marker;
the server holds the response until mission storage is durable. Any interruption,
HTTP error (including post-COMMIT errors), redirect or malformed response after
POST begins is Unknown. GET is a snapshot, never a receipt. No blind retry.

Browser retains up to16 source-bound forms, including pending/Unknown outcomes,
through close/navigation. Hidden completion never reopens a form or steals focus.
This retention is window-lifetime memory, not a restart-safe client journal.
Only definite Not sent or acknowledged attempts can be reviewed afresh explicitly.
Unknown remains fenced. Changing Local connection never retargets a captured form.

## Scoped checks

State/transport units cover transitions, exact source/POST/ACK, unsupported
capability, stale preflight, errors, redirects and no replay. The native
`mission_lifecycle` target mounts production Browser and LocalViewer/Root against
an owned faux daemon: light/dark,680/1100 widths, cancel/keyboard, late hidden ACK,
retained Unknown, root marked-editor navigation and mounted focus. Backend
`mission-lifecycle.test.ts` and the passive-lifecycle cases in
`session-archives.test.ts` cover strict admission, retained notices, restart,
scratch/chat preservation, response durability and post-COMMIT errors. No real
mission/chat mutations, installation, service action or release is tested.
