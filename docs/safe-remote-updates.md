# Updating a remote Pilot runtime

`LinuxSSHUpdate.start` is the app-callable update action. It is not initial setup and does not
change the selected host. Devbox UI consumes this API separately. No personal devbox, live provider,
release publication or production signing key is used by its fixtures.

## Trust and request ownership

Download a `LinuxRuntimePackage` through the existing authenticated stable-release access layer.
The signed Mac app pins its Ed25519 key. Exact manifest bytes/signature, platform/protocol, expected
app version/tag and archive size/hash must verify. Missing signing configuration or assets blocks
the action. There is no unsigned package, source build, global tool upgrade or key-from-release fallback.

Persist an update UUID with the pinned `HostRef` before calling `LinuxSSHUpdate.start`. The helper
rehashes before transfer, uses the existing strict OpenSSH policy, and sends only the authenticated
archive and public package metadata. No GitHub token, provider credentials or SSH diagnostics enter
the remote journal. It stages a complete, fsynced, content-addressed package under the private
runtime directory and verifies the manifest again before recording intent. Setup and activation use
the same flock; neither overwrites another installer or foreign service.

The existing daemon must advertise `capabilities.runtimeUpdates: 1`. An older runtime without the
startup/admission contract cannot be safely updated through this API. It returns a compatibility
blocker before changing the service, not a shortcut through the first-install helper.

Running and target versions must be orderable stable numeric releases. An older app cannot install
its older package over a newer devbox. Unknown/prerelease current versions block rather than guessing.
The exact already-installed package is a completed no-op, with no restart or updater installation.
A different package at the same version requires explicit repair, not an ordinary update. Saved-ID
retries and the independent owner's pre-commit recovery also repeat the version gate.

The accepted update belongs to a separate enabled `pilot-update.service`, outside pilotd's cgroup.
SSH logout, Mac sleep/quit and observer cancellation do not cancel it. Retry an ambiguous request
with the same UUID/package, or read its status after reconnecting. Never infer failure or create a
fresh transaction solely because a reply was lost.

Staging is **not** confirmed acceptance. GET status explicitly returns `requestConfirmed: false`
while phase is `staged`, with instructions to retry the same UUID. A crash after staging but before
owner enable/start may require that retry; staging alone does not promise independent continuation
or reboot recovery. Only after the owner is durably installed/enabled and started does the helper
persist `requested` and return `requestConfirmed: true`. Swift refuses an unconfirmed success reply.
If the owner exists but that final response/publication was lost, status remains conservative or
advances through the owner's own journal; reconciliation always keeps the original UUID.

## Waiting for work

The daemon's `runtimeResources` includes workspace and setup PTYs, parent/child jobs and actual
child-process checks, attachment bodies/finalization/cleanup, artifact/file downloads, mutations and
durable-operation handlers. Admissions freeze synchronously before asynchronous work starts. A
disconnected response remains counted until both its route work and response cleanup settle.
New work gets a temporary refusal, never a Local fallback or blind replay.

Tool drain joins committed results and child barriers, not entire conversations. Its proof is
correlated to the current workers. Unknown inspection, actual idle child kernels, retiring processes,
queued admissions and unsaved state all block restart. No updater kills a guessed process. An idle
child kernel may require explicit closure; a durable subagent record alone is not a live process.

When blockers remain, the journal says `waiting`, lists bounded resource references and releases
maintenance holds so agents/children can finish. A drain attempt yields after ten seconds rather
than freezing children indefinitely. The remote owner checks again while this requested update is
pending. Explicit stop/close remains available, and only actual process exit removes a process
blocker. The update never silently stops jobs or shells. Saved records do not resurrect OS processes.

## Journal and restart boundary

`~/.local/share/pilot/runtime-update/current.json` is private, atomically replaced and fsynced.
It retains the immutable request, signature evidence, old/new exact unit content, host/storage pins,
phase/revision, bounded blockers, OS boot ID, main PID/start ticks and systemd invocation identity.
Conclusive previous receipts remain addressable by UUID, bounded to 128 retained update-state files.
Capacity needs explicit reconciliation; safety receipts never expire automatically.

Phases are `staged` (unconfirmed), `requested`, `waiting`, `draining`, `ready`, `stopping`, `switching`, `validating`, and
`completed` or `cancelled`. Unreadable/foreign intent fails closed. Admission holds do not expire
with the unrelated 30-second Mac-app update lease. The daemon reads the journal before session
recovery, shared-grant recovery, notices/compaction and schedules. Startup-fenced sessions load
metadata only. Releasing maintenance then recovers the same saved session/input/grant IDs.

Before stopping, the owner repeats the blocker proof and matches PID/start/boot, invocation, exact
unit ownership and persistent identities. Stop authorization is durable before invoking systemd.
It waits for confirmed old-service exit before atomically replacing only the expected unit. A reboot
or replacement invocation invalidates readiness and requires a fresh drain. Foreign units, linked
paths and administrator overrides require explicit repair; the updater never removes overrides.

Restart/recovery reconciles each phase with the observed service and unit, including a lost stop,
publication or start reply. The target starts fenced, validates exact version/protocol, independent
execution, pinned daemon/storage identities and separate coordinator isolation, then completes the
journal and releases recovery. A failed health check retains ownership and retries reconciliation.
There is no automatic data restore, unproven downgrade, tool replay, grant release or task reassignment.

## App access

- `LinuxSSHUpdate.start(configuration:package:host:id:)`: explicit authenticated staging/request.
- `HostClients.runtimeUpdate(_:on:)`: current or retained UUID status, fenced to the host/connection.
- `HostClients.cancelRuntimeUpdate(_:on:)`: explicit cancellation **request**, not proof it happened.
- GET `/api/runtime-update[?id=UUID]`: bounded public status, no signature/paths/secrets.
- POST `/api/runtime-update/cancel` `{id}`: owner settles cancellation before committed restart.

The internal drain/commit endpoints are used by the remote systemd owner, not an app restart loop.
Disconnect remains availability loss, not an invented stopped/failed chat outcome.

## Verification

Focused tests inject crashes/lost replies after every durable phase and stop/publication/start,
exercise PID/start/boot mismatch, blockers, cancellation, startup recovery and legacy-lease separation.
A real loopback HTTP fixture proves a disconnected artifact request blocks until its pending work
settles. Existing kernel tests verify committed unsafe effects and child continuation are not replayed.

Linux package CI stages two complete extracted production runtimes over disposable SSH with a
fixture-only signing key. Real PTY and unfinished upload blockers retain the daemon PID. Killing the
independent updater exercises systemd reconciliation; explicitly closing/abandoning those resources
then permits activation. It checks the new version, unchanged persistent identities and completed
receipt after user-manager restart. Full Node, Swift, app bundling and package work run in CI only.
These checks are not evidence of signed publication, arbitrary OS-policy support, sustained GUI
performance or actual personal-devbox deployment.
