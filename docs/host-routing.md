# Host routing

`HostRef` identifies a configured endpoint, pinned daemon installation and storage lineage.
`HostResourceRef` qualifies navigation, draft and cache keys. Never derive host identity from
a repository path, display name or matching daemon-local ID.

`AppModel.hosts` is the unified facade. Each registered `PilotClient` owns one endpoint,
its REST calls, subscriptions, caches and sockets. Use `HostClients.perform(ref, kind:)`
for endpoint APIs and keep the returned qualified ref when navigating. Never overwrite
the Local client's URL. Disconnected partitions retain last-known agent outcomes;
availability is separate. Replaced endpoints and late socket/HTTP responses are fenced.

Remote enrollment requires an explicitly confirmed `HostRef`. The SSH tunnel validates
compatibility and the pinned daemon/lineage only after its owned forward is acknowledged.
The daemon persists `storage-lineage` independently of `daemon-id`. Restore/clone tooling
must rotate the lineage before reenrollment; copying a live data home is not supported.

`ProjectBinding` keeps execution repository, canonical memory home, canonical mission
home and binding generation distinct. Socket reconnects do not advance a binding or
transfer execution ownership. Actual shared-context replication is a separate protocol.

`HostKeyMigration.local` migrates legacy bare keys using only an explicitly identified
Local host, preserves qualified keys and refuses collisions. AppModel migrates legacy chat
drafts after identifying Local, persists that identity for offline relaunch, and bridges local
composer calls to qualified keys. Remote composers/navigation use explicit resource refs.
Subscriptions reattach to replacement endpoint clients after verified tunnel reconnects.
The [lifecycle layer](remote-lifecycle.md) adds explicit enrollment, private persistent offline
summaries, receipt-only reconnect recovery and awaited forward cleanup. Visible devbox setup and
disconnected presentation remain separate UI work.
