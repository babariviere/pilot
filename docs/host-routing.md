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
Local host, preserves qualified keys and refuses collisions. Remote UI consumers must
use qualified keys in their navigation/draft stores. Existing local-only screens retain
their legacy keys until the unified host-selection UI adopts the facade. Remote enrollment,
persistent offline summaries and visible disconnected presentation are not enabled by
this routing layer alone.

