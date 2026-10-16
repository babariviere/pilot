# Remote lifecycle and offline metadata

`HostClients` keeps connection availability separate from the last authoritative session summary.
An unreachable host is **Disconnected**, not stopped, failed, idle, or eligible for reassignment.
`historyAvailability(_:cached:)` explicitly identifies uncached history that requires reconnection.
This is a state/API integration, not the devbox-selection/disconnected presentation UI.

## Enrollment, reconnect and cleanup

After explicit confirmation, persist `LinuxBootstrapConnection.host` with `enroll(_:configuration:)`,
then `adopt(_:configuration:)` its owned tunnel. Subsequent `reconnect(_:)` uses the saved SSH alias,
port, daemon ID and storage lineage. Changed identities fail closed, never silently re-pair.
`connect(host:configuration:)` also requires that enrolled pin/configuration. Bootstrap retains its
signed-package/service/coordinator gates; reconnect never installs, updates or starts a service.

Each connection consumes `tunnel.states()`. Losing the forward detaches subscriptions, invalidates
response fences and discards that endpoint client, preserving summaries. Each newly verified forward
creates a fresh client, including when the port changes. Host-qualified subscriptions/retained views
reattach only to that host. A daemon-only WebSocket reconnect rechecks hello against the pin before
opening control/transcript/terminal/subagent streams. An identity rejection requires explicit repair.
Only complete projects/sessions/missions snapshots replace a partition, never initial empty caches.

Ordinary quit returns AppKit's `terminateLater`, awaits `disconnectAll()` and the metadata flush,
then replies to termination. This closes/reaps only owned **local SSH forwards**, without any remote
stop, pause, shutdown or service command. It fences concurrent connection completions. Local daemon
power/sleep/update lifecycle remains owned by the existing Local-only controller. Abrupt app death
cannot guarantee awaited cleanup. No app connectivity timer changes execution ownership or relocates
a coordinator.

## Private offline index

Production startup reads `Application Support/Pilot/Hosts/hosts.json` without SSH or agent actions.
The private directory/file use 0700/0600, atomic replacement and file/directory fsync. Encoding,
decoding, whitelist projection and filesystem work run on a separate actor. Streaming saves coalesce
for 500 ms; revision fences prevent older saves replacing a later quit flush. Corrupt/unknown schemas
block writes rather than erasing pins or cached chats. Local work remains usable after a read failure.

The bounded index (32 hosts, 32 MiB, per-host list bounds) stores host pins/configuration, observation
time, chat identity/title/location/model, last-known execution/outcome/pause metadata, project metadata
and mission summaries. It omits diagnostic text, tool/job commands, subagent prompts, integration
configuration, mission goals/briefs, transcript events and credentials. Bounds cause backpressure,
not eviction of known chats. Drafts/attachments/selection remain with the existing qualified draft
store. Cached outcomes are not fed into notifications as new completions.

This summary index is **not** a target daemon's mandatory durable context replica, a grant journal,
or a source of authority for decisions/task dispatch. Accepted disconnected grants stay occupied;
neither an idle snapshot nor cancellation delivery acknowledgment is a sealed/released execution grant.
Shared-context/grant reconciliation belongs to the sharing protocol, never to this cache.

## Ambiguous operations and Stop

The operation outbox survives relaunch with immutable origin/destination/target/producer identities.
On availability, bounded **receipt lookups only** reconcile that host's pending inventory. Unknown
and pending are not failures. Reconnect never POSTs mutations, clears drafts, retires outbox records,
or falls back to Local. Only an explicit matching send/create retry can POST an unknown intent, after
receipt lookup, using the exact original operation. Pending/conclusive receipts are never resubmitted.
The composer must durably adopt results/drafts/attachments before calling `acknowledge`.

`requestStop(_:)` requires an available enrolled host. It persists `requested` before making one Stop
request, and records `acknowledged` only after a matching live response. A lost reply remains requested
across restart, even after an idle summary arrives. No automatic Stop replay or offline Stop queue
exists. The returned withdrawn draft belongs to the caller's draft owner, as with the existing Local
Stop API. The existing Stop endpoint has no durable result receipt, so a lost reply cannot reconstruct
withdrawn queued text or prove cancellation acknowledgment; the app must show that uncertainty rather
than infer success or safe reassignment. A later explicit user Stop is a new action, not reconnect replay.

## Verification

The ordinary macOS CI Swift test job discovers `OfflineHostsTests`, `RemoteLifecycleTests`,
`RemoteOperationRecoveryTests` and the 10k-session persistent aggregation test through the existing
SwiftPM test targets. Fixtures cover private whitelist storage, corrupt-file fencing, relaunch,
colliding IDs, pin changes, changed forward ports, stale subscriptions/responses, awaited cleanup,
local sleep separation, lost acceptance replies, pending/foreign receipts and ambiguous Stop.
Existing transport tests cover real owned-process reaping and the finite SSH retry budget.
These are synthetic fixtures, not a deployed devbox or complete UI validation. Native/full-suite and
large-session timing evidence run in CI, not local Swift builds/tests.
