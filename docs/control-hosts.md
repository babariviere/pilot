# One Control across hosts

Contract v1, not an enabled feature. The types in
[control.ts](../packages/protocol/src/control.ts) and
[ControlHosts.swift](../apps/macos/Sources/PilotCore/ControlHosts.swift) add no handlers,
transport, enrollment, migration, permission enforcement or UI behavior. Old daemons must not
receive these requests until support and enrollment are verified. This document is the interface
between Control handlers and the app courier/enrollment implementation.

## Authority and identity

Exactly one visible, authoritative Control lives on an explicitly selected home daemon, initially
the Mac. `ControlHostConfiguration.home` is its `OperationHost`, not the app's Local label.
The configuration also identifies this daemon and its role:

| Role | Meaning |
| --- | --- |
| `home` | Owns the active conversational Control, memory, authorizations, reservations and orchestration audit. Its host equals home. |
| `executor` | Accepts enrolled home operations and exports facts. No conversational Control. |
| `archived-control` | Executor with a preserved, read-only former Control. Archive identifies its chat and migration time. |

`controlSessionId` identifies the active Control only on home. An archived Control is identified
by `archive.sessionId`, never an active Control. Roles are persisted setup policy, not inferred
from connectivity. While executor policy is staged, `legacyControlSessionId` identifies its
still-visible former independent Control; only the final archive clears this field and fills archive.
Role labels do not authorize the app to hide that legacy Control. Never infer authority from a
sidebar row or a matching session ID. Until migration's gate is met, existing
independent Controls remain unchanged; this contract is not permission to hide them early.

Follow [host routing](host-routing.md): daemon installation and storage lineage identify authority,
not paths, repository names or endpoint aliases. Wire `OperationHost.hostId` is normalized to
`daemon`, as in [shared context](shared-context.md). The courier resolves it only through verified
endpoint pins. A different lineage needs explicit reenrollment, not cursor reuse.

`ControlHomeEnrollment` pins home and executor, a binding ID, generation and active/revoked state
on both daemons. Enrollment is explicit user-confirmed app setup, not an agent request.
Binding IDs use a separate Control namespace; they are not `SharedContextBinding` permissions.
Envelopes carry that ID/generation in `bindingId`/`bindingGeneration`. Reject wrong origin,
destination, lineage, missing/revoked enrollment and stale generations before admission.
A replacement enrollment never adopts an old outbox, journal, authorizations or archives.
Only explicit repair can replace a home; there is no partition election or automatic failover.

## Host-qualified actions

`ControlHostRequest` specifies routing for **every** pilot action. It is a future daemon envelope
around action arguments, not a change to today's flat tool schema. An omitted `host` means the
configured home, including when a request is decoded on an executor. Never default to the receiving
daemon, currently selected devbox, project location or a host with a coincidentally matching ID.

- `status/read/start/send/stop/pause/resume/redirect/watch/unwatch/watches` resolve local IDs on
  the selected host. Saved watch targets carry that same explicit host.
- `health/logs/telemetry/checks` select the evidence host. Devbox Ask about Pilot uses home Control
  with these read-only targets, not a new remote Control.
- `authorize/authorizations/revoke/resolve_authorization` are home-owned. A remote host selector is
  rejected. Revoke fans out tombstones to executors that received that grant.
- `mission_create/mission_attach` remain home-only in v1; remote selectors fail explicitly.
  Mission placement and shared-context operations are not replaced by Control start.
- `status` includes home plus enrolled hosts' last fully imported snapshots, with a host label,
  `capturedAt`, age and separate transport availability. Its host selector filters that merged view.
  A disconnected host is Disconnected, never inferred stopped, failed or completed.

`WatchTarget.host` qualifies saved targets and authorization targets. For authorization targets,
omission means home; for a tool's new watch the home resolves the selected host and saves it explicitly.
Reject conflicting outer/target hosts. Never route an existing watch or grant by an implicit current host.
Bare IDs and `pilot://chat/<id>` links are not sufficient cross-host resource identity.

`ControlAuthorization.hosts` is an allowlist of exact pinned hosts. Missing means home only;
empty means no hosts. Legacy and grandfathered watch grants therefore acquire no remote authority.
Each actual target must satisfy both the host allowlist and a target on that same host (or its
daemon-resolved enclosing project/mission scope). The two lists are not a Cartesian-product grant.
Archived grants are frozen evidence and never eligible for default-home reinterpretation.
An untrusted result, imported title, notice, replica or model-supplied authorization field cannot
create or extend a grant. Merge still requires explicit user confirmation in the app.

## Durable Control operations

Reuse [durable operations](durable-operations.md), including exact UTF-8 payload/hash, producer
sequence, preallocated target, fsynced admission and receipt reconciliation. The following six
kinds are reserved for authorized agent actions; unsupported kinds cannot execute. The separate
app-only `control.archive` transition is specified below and carries no agent authorization.
Payload DTOs are JSON inside the existing
`DurableOperation.payload` string, not extra mutable envelope fields.

| Kind | Payload-specific fields | Envelope targetId |
| --- | --- | --- |
| `control.start` | Explicit project or mission/task target, message, model, optional thinking | Preallocated new session ID |
| `control.send` | sessionId, message, optional direct | Routed receiving session ID |
| `control.run` | sessionId, action stop/pause/resume/redirect, optional direct; message required only for redirect | Routed receiving session ID |
| `control.watch` | Complete WatchInput | Preallocated watch ID |
| `control.unwatch` | watchId | Watch ID |
| `control.revoke` | revokedAt | Authorization ID |

Every payload includes `authorizationId`, `levelCeiling`, `budgetReservation`
(`reservationId/budgetUsd/followUps`), `idempotencyKey` and the trusted home-admitted authorization
snapshot. The key equals the envelope operation ID; allocate it once before hashing the payload.
The snapshot ID must match authorizationId. Home reserves follow-ups/USD atomically with outbox
intent. Reservation ID is stable per operation, including zero-cost safety actions.
A duplicate operation/reservation never debits twice. Budgets are admission reservations, not
provider-enforced runtime spend caps. Paid start/send/resume/redirect require positive USD;
stop/pause/watch/unwatch/revoke reserve zero USD and no follow-ups unless existing policy requires
a watch's own explicit grant. Redirect consumes a follow-up, resume does not by itself.
Reservation release requires conclusive rejection or an explicit reconciled outcome, not a timeout.

Home resolves mission-member routing before sealing the operation. Executor rechecks actual
target scope, direct/coordinator rules, model availability, level ceiling, expiry, enrollment and
locally known revocations at admission, including after asynchronous preparation.
The effective level is the lower of grant level and carried ceiling. Persist ControlPermission on
started chats and enforce per-input authority on sends/redirects; an unrestricted existing Build
chat cannot widen the permission. Start references target-local project/model IDs, never home cwd,
credentials, executable configuration or source attachment paths. Remote mission starts additionally
require the existing shared-context grant/epoch/complete replica; they cannot allocate a task by ID alone.

Stop/pause/resume/redirect retain the existing run-control semantics. An accepted stop receipt is
durable command admission, not proof all processes exited or permission to reassign a task.
Pause lets a live run finish but holds future inputs. Redirect is one idempotent Stop-plus-follow-up
intent, not two independently retryable mutations.

Revoke is a monotonic tombstone, not a new action authorized by the revoked grant. It and unwatch
may remove only their exact grant/watch under the enrolled home, even after that grant expires or
is revoked. They cannot spend or start a turn. Executor stores the tombstone before acknowledging;
a delayed action is rejected if its grant was tombstoned, regardless of courier order. Home stops
new dispatch immediately. An offline executor cannot know an unseen revocation: already accepted
work can continue, and a previously transmitted operation may be admitted before the tombstone
arrives. Revocation is not an instant remote kill; request stop separately. No connectivity lease.

`OperationReceipt.result` on acceptance of these six actions is `ControlOperationResult`, with the matching kind,
authorization and session/watch/removal/revocation outcome. Receipts retain the generic operation ID,
payload hash, destination and target fences. Accepted means admitted, not successful agent execution.
Only explicit rejection is terminal; pending/unknown retains original ownership and bytes.
A result is later journaled separately. This guarantees at-most-one allocation/admission with intact
journals, not exactly-once arbitrary tool effects.

## Courier-facing exchange

These are the reserved v1 loopback API surfaces for implementation, **not routes installed by this change**.
No daemon-to-daemon connection, reverse tunnel or new public listener is added. The app courier
already has verified connections to both daemons; it relays immutable data and never makes policy.

| Reserved route | Request / response and owner |
| --- | --- |
| GET `/api/control-hosts/:bindingId` on either peer | `ControlHostStateResponse`: persisted configuration/enrollment; home additionally supplies its trusted cutover evidence. Unknown binding is 404, never an implicit enrollment. |
| PUT `/api/control-hosts/:bindingId/enrollment` on either peer | Local-user `ControlHomeEnrollmentRequest` → durable `ControlHostStateResponse`. On executor this records the only accepted Control home. See enrollment rules below. |
| POST `/api/control-hosts/:bindingId/exchange` on home | `ControlOperationExchangeRequest {peer,cursor?}` → `ControlOperationExchangeResponse`, up to 16 original envelopes and `more`/`next`. Export durably fences possible transmission. |
| POST `/api/operations/receipt` on executor | Existing immutable operation receipt lookup, before attempting delivery. |
| POST `/api/operations` on executor | Existing operation envelope → matching pending/accepted/rejected receipt. |
| POST `/api/control-hosts/:bindingId/ack` on home | `ControlOperationAcknowledgment {operation,receipt}` → `ControlReceiptAdoptionResponse`; home durably adopts conclusive matching receipt before courier drops ownership. |
| GET `/api/control-hosts/:bindingId/events?after=N&limit=128` on executor | `ControlRemoteEventQuery` → `ControlRemoteEventPage`, ascending contiguous cursors for that enrollment. |
| POST `/api/control-hosts/:bindingId/events/import` on home | Original event page; atomically dedupe, stage eligible notice/audit and advance imported cursor. Returns `ControlRemoteEventAcknowledgment` only after durable commit. |
| POST `/api/control-hosts/:bindingId/events/ack` on executor | That acknowledgment → durably retained `ControlRemoteEventAcknowledgment` floor; validates binding/generation/source and exact through/eventId before retirement. |
| GET `/api/control-hosts/:bindingId/status?cursor=...` on executor | `ControlRemoteStatusQuery` → `ControlRemoteStatusPage`; omit cursor to capture, otherwise resume that capture. |
| POST `/api/control-hosts/:bindingId/status/import` on home | Original status page → `ControlRemoteStatusImportResponse` (`staged` with original next, or `published` on the last page); only then replace that host's cached snapshot. |
| POST `/api/control-hosts/:bindingId/archive` on home | Local-user app rollout `ControlArchiveRequest` → `ControlArchiveResponse`; creates the original durable `control.archive` envelope only after verified readiness. Delivery uses the same exchange/receipt/adoption flow. |

Enrollment UI persists the same `ControlHomeEnrollment` on both sides via explicit local-user setup.
Its confirmation, credentials and transport implementation belong to enrollment, not these operations.
Each route resolves its peer from active enrollment, not arbitrary supplied projects or endpoints.

An exchange cursor is opaque, scoped to enrollment/generation and a stable outbox ordering; it
allows scanning past a still-pending prefix rather than returning those same 16 operations forever.
`more` is true exactly when `next` is present. It is not a removal/acknowledgment cursor. After
reaching the end, wait for invalidation/reconnect, then scan again from the start, including old
pending items. New arrivals during a scan are handled by that next invalidated scan. A stale cursor
fails with 409 and restarts the scan without replacing any existing operation. No snapshot or
exactly-once execution claim follows from listing an outbox page.

Receipt adoption returns 200 only for a matching conclusive accepted/rejected receipt, after its
outcome, reservation accounting, audit and follow-through intent are durable at home. Replaying
that receipt returns the same adoption; pending/unknown cannot retire ownership. Event import/ack
also returns only after durable commit. Repeating an older exact event ack returns the current
retained floor, never regresses it; a different eventId for an acknowledged cursor is a conflict.
Status import replay returns the same snapshot/cursor state without publishing an older capture
over a newer one. Status is cache data, not permission to retire a factual event journal.

All selectors reject duplicate/unknown query fields and foreign enrollment identities. Invalid
payload/selectors are 400; missing state 404; identity, CAS, not-ready, cursor-gap or stale-capture
conflicts 409 with an explicit reconciliation/restart reason; capacity backpressure is 503.
Unsupported contract versions fail closed. None is an implicit successful mutation. Error prose
is bounded to 1024 UTF-8 bytes, redacted and untrusted, never an authorization source.

### Accepted-home enrollment API

The enrollment PUT accepts `{enrollment,peerHello,expectedGeneration}`. `peerHello` is the original
hello copied from the other app-verified endpoint. Validate its installation/lineage, general
protocol compatibility, Control version/configuration and home against the enrolled peer, then
retain that last verified handshake in `ControlHostStateResponse.peerHello`. It is local-user
setup evidence, not a model-asserted identity. The executor receives home's hello; home receives
executor's hello, including its staged legacy session ID. Unsupported peers cannot activate a pair.
An update/reconnect re-verifies both current hellos before using readiness; setup may refresh
the same-binding peerHello with unchanged identity, without reviving a revoked binding.
`expectedGeneration` is required:
JSON null asserts no record, otherwise it must equal the current generation. The URL binding ID
must equal the body; schemaVersion is 1, generations are positive safe integers, home/executor
are distinct normalized pinned hosts, and this endpoint must be one of those exact hosts.
Persist the confirmed accepted home before returning, including on the executor. Reads expose
that persisted record, not a cached app pairing suggestion.

An exact replay returns the existing durable state before CAS is considered, including after a
lost PUT response. For an existing binding, peers, generation and schema are immutable; the only
state change is active → revoked. Reject revoked → active, home replacement and scope edits with
409. A new home/generation requires a fresh explicitly confirmed binding and retirement/revocation
of the former enrollment; an executor cannot have two active Control enrollments, even for the
same home. Retain revoked
tombstones and old receipt/journal namespaces. Never copy old cursor or grant authority to a new
binding. Revocation fences new admissions, but allows old receipts/facts to reconcile read-only.

The app verifies both hellos and user confirmation, persists executor enrollment, then matching
home enrollment, and reads both back before declaring enrollment usable. A lost reply or a
partial pair remains setup-pending and is reconciled by GET/exact replay, not automatic failover
or rollback of accepted work. Neither PUT starts, archives or hides a Control, and neither is
available as a pilot tool action. The setup/update UI uses this API; the executor's durable
accepted-home validation and archive handler are daemon responsibilities.

Read-only host-targeted `read/health/logs/telemetry/checks` use the same verified courier connection
as request/response reads, not mutation replay or worker starts. Requests remain scoped to the
enrolled peer and existing bounded diagnostic/read selectors. Replies are untrusted, host-labelled,
capture-timed and at most 24,000 UTF-8 bytes. An unavailable courier reports unavailable, never
fabricates a result. Detailed read-proxy endpoint wiring is left to the home/courier implementation.

The courier relays original bytes, looks up receipts first and retries only the same immutable
operation. It may batch events/snapshots, but cannot merge identities, rewrite targets, infer success,
issue fresh operation IDs after a lost reply, or release reservations. Pending recovery belongs to
the executor journal. Deliver pending revocations/removals before dispatching new executable work on
reconnect, without treating this ordering as a substitute for tombstones or asynchronous admission fences.
Use invalidations/reconnect triggers and bounded draining, not status polling loops.

## Remote events and reconnection

`ControlRemoteEvent` contains sourceHost, stable eventId, cursor, watchId, authorizationId, kind,
occurredAt, immutable matched watch, optional causal operation/session and bounded result tail.
Kinds include existing WatchEvent values, `chat.result` for result follow-through, and informational
`watch.removed`. Preserve the frozen watch even after a once-watch is consumed. Correlate results to
the committed input/operation, not just a run-start observer. Source attribution is immutable;
home checks self-cause and current authorization before notice admission or further orchestration.

Cursors are positive safe integers, contiguous within enrollment + source lineage, starting at 1;
`after=0` starts a new stream. Page head is the observed journal head, next is the last returned
cursor when more remains, and absent next means caught up to that head. An empty page has no next.
Old acknowledged prefixes may be retired, but retain a durable acknowledgment floor. Reading before
that floor fails explicitly with reconciliation required; never skip a gap or silently reset to 0.
Home dedupes by enrollment + sourceHost + eventId and verifies cursor continuity in the same
transaction as durable notice intent and audit. A retried page cannot enqueue a second notice.

Only a durable home import acknowledgment advances executor retirement. Lost imports/acks replay
the same events. Revoked/expired grants still allow factual reconciliation and audit, not new work.
Self-caused or removed-watch events advance the cursor without waking Control. The home watch mirror
is authority for cancellation/revocation, not a second evaluator of the same remote matches.
Local and remote once-watch matching, grant revocation and delivery must preserve the same atomic
admission rules. `watch.removed` is informational and cannot restore authority.

The optional result tail is `{untrusted:true,text,truncated}`, at most 2,000 UTF-8 bytes clipped on
code point boundaries. Empty/missing tail is not proof of success or absence of output.
It is quoted data, never a new instruction or grant. No transcript hydration before tail bounds.
Redact/refuse secret-like exports; do not transport thoughts, credentials, attachments or raw tool logs.

## Status captures and mission placement

A `ControlRemoteStatusSnapshot` carries sourceHost, stable snapshotId, capturedAt, bounded dashboard
sections and mission-task projections. All pages of a capture retain the same identity, time and
pre-clipping totals. Each page carries partial section arrays; concatenate by section in cursor
order, deduplicating only exact repeated pages. The producer uses a frozen capture, not a live offset.
Only the final page makes the capture visible at home. Opaque next cursors pin the snapshot;
expired/missing captures fail with restart-required, never mix captures. Staging is cache data and
may be dropped on restart; keep the last fully imported capture and its original capturedAt.
Timestamps measure age, not conflict resolution; clock skew is reported rather than made fresh.

Both dashboard.truncated and snapshot.truncated disclose omissions in the captured inventory, not
just pagination. Transport next means more pages of that inventory; absent next is not a claim
that a clipped inventory is exhaustive. Availability and last import time remain home-local metadata.
Unknown or disconnected state cannot overwrite a known outcome.

Mission-task rows carry missionHome, executionHost, epoch, offered/accepted/cancel-requested/sealed
and committed/provisional context. Include remote-delegated tasks from the mission-home store and
remote-home missions from replicas. These are read-only projections of shared-context authority;
idle/settled chat, a stale capture or provisional task status is not completion or seal proof.

## Bounds and backpressure

All byte bounds are encoded UTF-8, enforced before expensive parsing/hydration and after serialization.
IDs/cursors are validated; numbers are finite safe integers where integral, generations/epochs
positive, timestamps epoch milliseconds, reservation USD finite and nonnegative.
Opaque cursors are at most 512 UTF-8 bytes and interpreted only by the issuing daemon.

- Keep existing operation limits: 64 KiB payload, 4096 journal records, four handlers, 64 requests.
  Outgoing Control operations share the domain's 4096-envelope/64-MiB retained budget; exchange at most
  16 envelopes and 2 MiB including envelope overhead.
- At most 128 enrollments, 32 grant hosts, 32 grant targets, 128-byte IDs (target IDs retain existing
  500-character validation), 4096-byte saved notes and 4000-character messages. Reject oversize
  executable payloads, never truncate instructions, targets or authorization evidence.
- Event pages at most 128 records and 1 MiB, each record at most 16 KiB including frozen watch and tail.
  Journal at most 32768 unacknowledged events/64 MiB per daemon across enrollments.
  A full safety journal backpressures new admissions; it never evicts unacknowledged facts.
  Retention failure fences affected future admissions and drains safely without inventing completion.
- Status pages at most 64 KiB, dashboard data per page at most its existing 24,000-byte bound,
  at most 100 mission-task rows per page. Freeze at most 10,000 total rows/4 MiB per capture,
  at most two captures per enrollment and 16 MiB of staging per daemon. Larger inventories explicitly
  set truncated and preserve original totals. Snapshot cache eviction never removes event evidence.
- No TTL on operation receipts, revocation tombstones, dedupe/retirement floors or unacknowledged
  events. Peer acknowledgment allows retirement only with persisted replay rejection floors.
  Safety-metadata capacity exhaustion requires explicit reconciliation, not automatic eviction.

## Archive migration and offline rules

### Negotiation and cutover readiness

The future implementation advertises both `DaemonHello.capabilities.controlHosts = 1` (the
Control contract version) and `DaemonHello.controlHost` (configuration, schemaVersion 1, home
identity and this daemon's role). This change only reserves optional wire fields; current hello
producers do not advertise support. Absent fields, unsupported versions, identity mismatches or
incompatible general hello protocols disable cross-host routing and cutover. Verify both daemons,
not just the Mac or a cached app version. Capability support alone never hides an old Control.

`ControlHostCutover` records readiness against the exact binding/generation and both host lineages:

1. Both verified hellos support contract v1, agree on home, and home advertises role home.
   The configured executor may stage its executor policy before its legacy Control is frozen;
   that staging alone does not suppress or archive the legacy row.
2. `homeReady` means the authoritative home Control, grant ledger, durable outbox and import stores
   are recovered and usable. `executorEnrolled` requires the same active confirmed enrollment on
   both sides and working registered Control handlers on the executor.
3. `actionReceiptOperationId` names a real remote authorized action with an accepted matching
   receipt durably adopted by home, not a successful socket write or health probe.
4. `watchEventId` names a real remote watch event imported durably after a courier disconnect and
   reconnect, with duplicate replay producing no second notice.
5. `taskSnapshotId` names a completely imported capture proving the required task visibility with
   mission/execution host and epoch. A partial capture or provisional completion is insufficient.

Only all five conditions permit state ready. GET `/api/control-hosts/:bindingId` on home reports
this home-verified evidence; there is no API to POST app/model-supplied readiness booleans.
Evidence is local trusted rollout state, never a
model-supplied permission, and is invalidated by changed enrollment, version or lineage. The app's
rollout trigger requests the final archive transition only after ready; that transition reconciles
the old Control and durably freezes every ingress, watches and grants before recording archived.
It is the last step, non-destructive and idempotent for the same enrollment and archive session.
Lost acknowledgments reconcile this same transition; they do not repeat mutations or reactivate
the old Control. Only verified archived state permits the app to show exactly one active Control
and move the old one to read-only history. If home is disconnected afterwards, retain its one
authoritative identity and the archives; do not undo cutover or promote the executor.

### Explicit archive operation

After the readiness GET reports ready, the app persists a single idempotency key and calls
POST `/api/control-hosts/:bindingId/archive` **on home** with `ControlArchiveRequest`:
`{expectedGeneration,sessionId,idempotencyKey}`. This is an administrative rollout request, not
a pilot action or grant-authorized delegation. Home checks both negotiated roles/versions, the
active matching enrollment/generation, the selected legacy session on the executor and its own
durable action/watch/task evidence. The app cannot supply that evidence or choose a different home.

Home reserves an immutable `DurableOperation` with kind `control.archive`, origin home,
destination executor, that enrollment's binding/generation, operationId equal to idempotencyKey
and targetId equal to the exact legacy sessionId. Its `ControlArchiveOperationPayload` is
`{idempotencyKey,sessionId,readiness}`; home seals its verified readiness snapshot, not app booleans.
It carries no authorization grant, budget reservation, model instruction or spending capability.
`ControlArchiveResponse` returns that same queued envelope. It is not an archive acknowledgment.

The app courier relays it through `/api/operations/receipt` then `/api/operations`, exactly like
the six agent-operation kinds. The executor validates the pinned home, generation, target/session
and home-issued ready evidence, fences new Control ingresses and reconciles any live/uncertain
Control mutation before durably freezing history/watches/grants. Until reconciliation succeeds
its receipt stays pending, the old Control stays visible, and no second archive intent is created.
Ordinary accepted execution is not stopped or reassigned by this transition.

Only after the complete freeze transaction succeeds does the executor publish accepted with
`ControlArchiveResult {kind:"control.archive",configuration,cutover}`. Configuration names role
archived-control and the original archive session/time; cutover names state archived and the same
enrollment/evidence. Replaying the same operation returns the same result and original archivedAt,
without reappending watch-removal audits or altering history. Conflicting targets or payloads
under the same key are rejected, and a crash recovers the original journaled transition.

Home receipt adoption durably records that archived result before returning its adoption response.
The app must observe that conclusive result (via adoption/readback), not infer it from a hidden row,
an empty watch page, a queued response or a transport timeout, before showing a single Control.
An already archived same-binding/session transition reconciles without deleting or reviving anything.
Retain the original keyed intent, receipt and replay floor; never substitute a fresh ID after an
unknown/pending result. The archive operation shares the existing payload, journal and retention
bounds; failure to retain evidence backpressures rollout rather than partially hiding Controls.

### Preserving legacy state

Accepted remote work continues while home sleeps or the app courier is absent. Events wait
durably on the executor. Home's authorized orchestration operations can remain pending in its
durable outbox, visibly pending versus acknowledged. This exception is for Control orchestration,
not an offline queue for ordinary composer sends. No second Control starts during disconnection.

Only after two-daemon end-to-end start, refusal, watches/reconnect, stop receipt, revoke and status
flows work may explicit migration set a non-home Control to archived-control. Preserve its chat,
transcript, memory, authorization records and audit on its original host/lineage. Block new turns,
scheduled wakes, queued notices, automatic recovery inputs and mutations through every ingress,
not just the sidebar. Stop its live watches with durable removal audits and freeze its grants.
Pending legacy watches stop with audit and deliver nothing new. Already-fired notices and the
old audit remain readable but cannot start another turn. Frozen grants are never merged, revived
or reinterpreted as home grants.
Do not silently merge history, memory, grants, reservations or audit into home. Already accepted
ordinary execution remains owned by that host. Migration must reconcile an active Control turn
before freezing, not erase an uncertain mutation. Archives remain navigable/readable and clearly
non-authoritative. Reenrollment/update does not reactivate them.

## Verification and review

This change supplies shared JSON round-trip fixtures for TypeScript and PilotCore, including the six
authorized operation kinds plus app-only archive, every run action, host defaults/explicit scope,
roles/hello negotiation, explicit-null enrollment CAS, courier queries/adoption, event cursors,
status capture/import pages and pending/accepted/rejected receipts. DTO decoding is not runtime
policy enforcement (apart from preserving the required explicit-null wire field).
Handler/courier work must test lost receipt/event acknowledgment, duplicate delivery, journal bounds,
revocation during preparation, foreign homes/lineages, snapshot restart and no wake after archive.

Review is required from both Control and Remote devbox coordinators before adopting this contract.
The contract intentionally does not claim personal-devbox deployment or transport verification.
