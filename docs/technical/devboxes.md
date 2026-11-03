# Remote devboxes are retired

Pilot now runs chats and manages projects on this Mac. Remote setup, the execution-host picker,
project enrollment/delegation, MCP setup sharing, SSH reconnect, automatic remote updates and
cross-host couriers are no longer active app features. Scoped-model settings and Connections
only target Local. The local app/daemon separation is unchanged.

## Existing data

- Cached remote chat summaries and locally cached conversation history retain their original host
  identities and remain read-only. An uncached conversation cannot be fetched by this app.
- Private offline-host metadata, checkout associations, remote model-sync decisions, update journals,
  drafts, images, pending operation intents and daemon sharing tables are not deleted or migrated.
- A saved remote draft cannot be submitted to a devbox. **New Local chat** parks the original draft
  separately and opens a distinct Local draft. It never silently redirects the old request or files.
- Pending remote operations remain unknown. Retirement does not acknowledge delivery, replay requests,
  cancel remote work, seal an execution grant, infer completion or release ownership for reassignment.
- Already running remote agents and remote daemons are not stopped, uninstalled or updated. Their
  original data stays on their original machine. Manage those machines independently if necessary.

## Compatibility boundary

The native app's `ClientDirectory` owns one live Local connection and separate read-only legacy
snapshots. There is no remote endpoint registry. Model settings use one `LocalModelScope` scheduler;
old remote model decisions are inert persisted data, not synchronization participants.

SSH tunnels/bootstrap, remote update delivery, cross-host couriers, sharing/replication engines,
remote Control executors/contracts, native remote RPCs and their executable fixtures have been removed.
The daemon has no sharing, delegation, remote Control or runtime-update routes. A small read-only `RetiredDevboxes` adapter retains
legacy ownership records and rejects delegated admission, preventing old work from being recovered
or reinterpreted as ordinary Local work. Canonical Local missions and memory continue normally.

Old pending sharing/Control operations are excluded from startup recovery. An explicit attempt to
resubmit one is rejected before changing its receipt. Retired updater records are read only to
preserve safety fences; unresolved ownership is never automatically cleared. Control is retired
independently on main; no Control runtime or policy service is recreated here.

Host-qualified cache formats, provenance, offline readers and preservation tests are retained.
The Linux headless daemon and packaging remain development capabilities, not a supported macOS remote
execution workflow. Earlier transport/setup design documents describe historical behavior only.

`MissionReplica` is the Local mission store's off-event-loop SQLite disk writer, not cross-host
replication. It remains, as does the local memory append journal (historically named `shared.sqlite`).
Removing those would weaken Local durability rather than remove devbox support.

This retirement does not promise a remote-history export/import or data migration feature. No remote
machine is contacted during retirement, and no user data or credentials are erased.
