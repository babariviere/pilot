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
| POST `/api/control-hosts/:bindingId/exchange` on home | `ControlOperationExchangeRequest {peer,cursor?,lane?}` → `ControlOperationExchangeResponse`, up to 16 original envelopes and lane/`more`/`next`. Export durably fences possible transmission. |
| POST `/api/operations/receipt` on executor | Existing immutable operation receipt lookup, before attempting delivery. |
| POST `/api/operations` on executor | Existing operation envelope → matching pending/accepted/rejected receipt. |
| POST `/api/control-hosts/:bindingId/ack` on home | `ControlOperationAcknowledgment {operation,receipt}` → `ControlReceiptAdoptionResponse`; home durably adopts conclusive matching receipt before courier drops ownership. |
| GET `/api/control-hosts/:bindingId/events?after=N&limit=128` on executor | `ControlRemoteEventQuery` → `ControlRemoteEventPage`, ascending contiguous cursors for that enrollment. |
| POST `/api/control-hosts/:bindingId/events/import` on home | Original event page; atomically dedupe, stage eligible notice/audit and advance imported cursor. Returns `ControlRemoteEventAcknowledgment` only after durable commit. |
| POST `/api/control-hosts/:bindingId/events/ack` on executor | That acknowledgment → durably retained `ControlRemoteEventAcknowledgment` floor; validates binding/generation/source and exact through/eventId before retirement. |
| GET `/api/control-hosts/:bindingId/status?cursor=...` on executor | `ControlRemoteStatusQuery` → `ControlRemoteStatusPage`; omit cursor to capture, otherwise resume that capture. |
| POST `/api/control-hosts/:bindingId/status/import` on home | `ControlRemoteStatusImportRequest {page,expectedPublishedRevision}` → `ControlRemoteStatusImportResponse` (`staged` with original next, or `published` on the last page, plus publishedRevision); only then replace that host's cached snapshot. |
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

All selectors reject duplicate/unknown query fields and foreign enrollment identities.
Control-host route errors use ControlHostErrorResponse (code, bounded error, optional syncState).
The generic operations endpoints keep OperationReceipt/unknown semantics, not this error DTO.
Invalid payload/selectors are 400; missing state 404; identity, CAS, not-ready, cursor-gap or stale-capture
conflicts 409 with an explicit reconciliation/restart reason; capacity backpressure is 503.
Unsupported contract versions fail closed. None is an implicit successful mutation. Error prose
is bounded to 1024 UTF-8 bytes, redacted and untrusted, never an authorization source.

### Accepted-home enrollment API

The enrollment PUT accepts `{enrollment,peerHello,expectedGeneration,expectedRoleEpoch,approvalRequestId}`.
It requires the authenticated structured approval described below. `peerHello` is the original
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
expired/missing captures fail with restart-required, never mix captures. Staging pages and their
cursor persist together. If the producer capture has expired, discard only that incomplete cache
stage and capture anew; keep the last fully imported capture and its original capturedAt.
Timestamps measure age, not conflict resolution; clock skew is reported rather than made fresh.

Both dashboard.truncated and snapshot.truncated disclose omissions in the captured inventory, not
just pagination. Transport next means more pages of that inventory; absent next is not a claim
that a clipped inventory is exhaustive. Availability and last import time remain home-local metadata.
Unknown or disconnected state cannot overwrite a known outcome.

Mission-task rows use the single ControlDashboardSharedTask projection defined below, including
optional existing grant references and explicit committed/provisional provenance. Include
remote-delegated tasks from the mission-home store and remote-home missions from replicas.
Idle/settled chat, stale capture or provisional task status is not completion or seal proof.

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
   Explicitly approved executor policy fences legacy execution before load/recovery; it does not
   hide or archive the legacy row before end-to-end cutover. See the startup barrier below.
2. `homeReady` means the authoritative home Control, grant ledger, durable outbox and import stores
   are recovered and usable. `executorEnrolled` requires the same active confirmed enrollment on
   both sides and working registered Control handlers on the executor.
3. `actionReceiptOperationId` names a real remote authorized action with an accepted matching
   receipt durably adopted by home, not a successful socket write or health probe.
4. `watchEventId` names a real remote watch event imported durably after a courier disconnect and
   reconnect, with duplicate replay producing no second notice.
5. `taskSnapshotId` names a completely imported capture proving the required task visibility with
   mission/execution host and epoch. A partial capture or provisional completion is insufficient.

Only all five conditions plus the machine-readable route/build/archive checks below permit state ready.
GET `/api/control-hosts/:bindingId` on home reports
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
`{expectedGeneration,expectedRoleEpoch,sessionId,idempotencyKey,approvalRequestId}`. This is an administrative rollout request, not
a pilot action or grant-authorized delegation. Home checks both negotiated roles/versions, the
active matching enrollment/generation, the selected legacy session on the executor and its own
durable action/watch/task evidence. The app cannot supply that evidence or choose a different home.

Home reserves an immutable `DurableOperation` with kind `control.archive`, origin home,
destination executor, that enrollment's binding/generation, operationId equal to idempotencyKey
and targetId equal to the exact legacy sessionId. Its `ControlArchiveOperationPayload` is
`{roleFence,idempotencyKey,sessionId,readiness}`; home seals its verified readiness snapshot, not app booleans.
It carries no authorization grant, budget reservation, model instruction or spending capability.
`ControlArchiveResponse` returns that same queued envelope. It is not an archive acknowledgment.

The app courier relays it through `/api/operations/receipt` then `/api/operations`, exactly like
the six agent-operation kinds. The executor validates the pinned home, generation, target/session
and home-issued ready evidence, fences new Control ingresses and reconciles any live/uncertain
Control mutation before durably freezing history/watches/grants. Until reconciliation succeeds
its receipt stays pending, the old Control stays visible, and no second archive intent is created.
Ordinary accepted execution is not stopped or reassigned by this transition.

Only after the complete freeze transaction succeeds does the executor publish accepted with
`ControlArchiveResult {kind:"control.archive",configuration,cutover,roleAcknowledgment}`. Configuration names role
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

## Audit contract: durable ownership, approval, UI and lifecycle

This section is normative v1, not a claim that these routes, keys or stores already exist.
The app adapter consumes these DTOs; it must not create parallel protocol, router, watch-dedupe
or task models. Existing paths above remain reserved. The additions below close the integration
audit; they supersede any earlier description of an unauthenticated "local-user" write.

### Invalidation and exact recovery state

The reserved socket invalidation is `ControlHostInvalidation`:
`{type:"control-hosts.changed",bindingId,generation,changes:[...]}`, on the existing `/api/ws`.
Changes are outbox, receipts, events, status, enrollment, readiness or archive. Emit only after
durable changes, coalesce to at most once/second/binding, and send at most the seven distinct flags.
An event flag means a journal page is available, not that the socket payload is the event.
No cursor or result is trusted from a socket. Existing `dashboard.changed` remains the home
merged-view invalidation. Reconnect re-verifies hello/pins/role epochs and drains bounded HTTP reads.

Add GET `/api/control-hosts/:bindingId/sync-state` on either peer → `ControlHostSyncState`.
It reports the owner host, durable importedThrough/lastEventId, acknowledgedThrough/head, snapshot
stage/publication cursor, and reconciliationRequired. An executor's importedThrough is zero (it
is the source); its acknowledgment floor is authoritative there. Home's importedThrough and exact
lastEventId are authoritative for its imports. It is an inspection response, never permission to
set a cursor. The app stores only an advisory outbox scan position and its own UI intent keys.

Required durable ownership, implemented through bounded off-event-loop workers:

| State | Owner/store | Commit before returning |
| --- | --- | --- |
| Home grant reservations, outgoing Control intents, adopted receipts, event import cursor/dedupe, notice intent and audit | Home `$PILOT_HOME/memory/control-chat/chat.sqlite`, new host-scoped tables in the existing Control-memory owner | One domain transaction for each reservation+intent or event+cursor+notice/audit commit. Generic filesystem operation-journal reservation is a separate prepared/materialized step with stable IDs; never claim a cross-store atomic commit. |
| Home snapshot staging cursor and pages, last published snapshot and local importedAt | Same home Control-memory database, separate cache tables | Persist stage/page/cursor together; final page atomically publishes the entire capture. |
| Accepted home, enrollment tombstones, roleEpoch, native approval records and replay floors | Each daemon `$PILOT_HOME/control-hosts/state.sqlite`, exclusive daemon owner | Enrollment/approval consumption or role change and its replay evidence commit together. |
| Executor remote-watch authority, once consumption, frozen matches, contiguous events and ack floor | Same executor Control-hosts state database, separate tables | Once consumption and event append are one transaction; retirement floor commits before deleting a prefix. These are not the frozen legacy watch store. |
| Immutable envelopes, handler admission and receipts | Existing durable-operation journal | Original journal reservation/receipt rules still apply, with domain idempotency for recovery. |

Receipts/outbox adoption cannot rely on an app preference or a metadata JSON write as a durability
barrier. Prepared cross-store transitions recover by ID/hash; home acknowledges only after its
domain receipt, accounting and audit/notice state are durable. Executor role fences are held across
asynchronous preparation and rechecked before domain commit. Restore/clone rotates storage lineage;
the app never silently copies a cursor to another installation.

Reconciliation cases:

- Lost import response: re-read home sync-state or replay the same page; its exact event IDs return
  the original durable acknowledgment without a second notice. Lost executor ack response: resend
  that acknowledgment; its persisted floor makes retirement idempotent.
- Home import cursor ahead of executor ack floor: resend home's stored through/eventId acknowledgment.
  An executor floor ahead of home's committed import cursor indicates restoration/data loss, not
  ordinary reconnect. Mark reconciliationRequired and stop orchestration/cutover. Do not jump forward.
- A missing/noncontiguous event, same cursor with different ID/content, or unknown lineage returns
  409 reconciliation-required. V1 has no event-content checkpoint that authorizes skipping facts.
  The ack floor is only a replay-rejection checkpoint. Explicit repair must retain audit and restore
  missing evidence or reenroll under a new lineage; a status snapshot cannot replace it.
- Restart retains import/dedupe/floors and fully published snapshots. A snapshot stage resumes only
  if both the durable stage and producer's pinned capture still exist. Expired capture returns 409
  snapshot-restart-required: discard only the incomplete cache stage, capture anew, retain the last
  published snapshot and its original time. Never reset the event stream with a snapshot.
- Outbox scan cursors are not authority and may restart at the beginning after restart/invalidation.
  No scan read, exact ack replay or caught-up sync-state read emits a change, avoiding courier loops.

### Native approval, enrollment and unpair

A structured request ID prevents message confusion but **does not authenticate a native caller**.
Loopback, SSH connectivity, an HTTP Origin/header, possession of a request ID or a JSON
`userApproved:true` field is insufficient. Neither an agent message nor a watch, tool/MCP call,
imported result or copied approval text may grant enrollment, unpair or archive authority.

V1 requires a native-app Ed25519 signing key, private material retained under the stable signed
app's Keychain access policy and unavailable to agent workers, never an agent-readable file,
environment or daemon-supplied key. Keychain access must not allow arbitrary same-user executables.
Setup installs only its public-key/key-ID pin on both daemons through
the independently user-confirmed native bootstrap/management channel and verified SSH identity.
There is no public API that accepts a new approval key alongside an enrollment request. A key
suggested by the request itself is never trusted. Until that authenticated channel/key provisioning
exists, these writes fail closed, not as ordinary loopback mutations. This contract adds no key
installation or transport implementation. A future equivalent authenticated native channel requires
an explicit contract review, not a silent authentication downgrade.
Daemon key pins and approval/role stores must also be outside agent-writable namespaces. A mode-0600
file is not isolation from arbitrary unsandboxed code running as the same OS user; an implementation
that cannot protect this native/daemon boundary must report pairing unavailable rather than claim
authenticated user approval. Native key possession never bypasses the preview/gesture checks.

Reserved native approval API on the daemon whose state will change:

| Route | Type / rule |
| --- | --- |
| POST `/api/control-hosts/:bindingId/approval-requests` | `ControlHostApprovalInput` → daemon-issued `ControlHostApprovalRequest`. An unapproved request changes no enrollment, role or execution. |
| GET `/api/control-hosts/:bindingId/approval-requests/:requestId` | Same request/status, scoped to that daemon and binding. |
| POST `/api/control-hosts/:bindingId/approval-requests/:requestId/decision` | `ControlHostApprovalDecision` → same request/status after durable native-signature verification. |
| POST `/api/control-hosts/:bindingId/unpair` | Approved `ControlUnpairRequest` → `ControlUnpairResponse`; durably revokes locally and increments local roleEpoch. |
| POST `/api/control-hosts/:bindingId/unpair/ack` on home | Original verified executor `ControlUnpairResponse` → home response with peerAcknowledged true after durable reconciliation. |

The app first serializes the intended enrollment/unpair/archive request **without**
approvalRequestId into exact UTF-8 intentPayload bytes. The issuing daemon parses strict known
fields and stores those original bytes and SHA-256 intentHash, native app key ID, pinned home and
executor, binding/generation, its requestingHost, expectedRoleEpoch, a random 256-bit request ID
and expiry (at most five minutes). Its signingPayload is exact UTF-8 JSON containing those issued
fields (not mutable state/signingPayload itself). No cross-language canonical reserialization is
required: the native app decodes and verifies all issued fields and the original intent hash,
displays the exact target pins and consequences, then signs the original returned bytes prefixed
by UTF-8 `approve\n` or `deny\n`. Decision.allow must match the signed prefix. Signature is base64
Ed25519; daemon verifies it only against its previously installed app-key pin.

Native UI responds only to its own outstanding request and actual user gesture, never an agent
"yes" or an unsolicited event. Changed digest, pin, role epoch, binding/generation, key, expiry
or decision fails with 403/409. Unknown keys cannot enroll. Missing authenticated approval is 403;
expired requests are 409 and require a new preview/decision. A repeated identical signed decision
returns its stored result. A mutation consumes its matching approved request with the same domain
commit, before any effect; exact retries reconcile that original consumed intent, never authorize a
different request. Denied/expired/consumed records cannot authorize new mutations. Cap pending
requests at 64 per daemon, intent at 64 KiB and signing payload at 4 KiB; exhausted retained approval
replay evidence backpressures writes, never expires a consumed mutation's safety floor.

`expectedRoleEpoch` is required on enrollment/unpair/archive requests. `ControlHostConfiguration.roleEpoch`
starts at one and monotonically advances on explicit role changes, unpair/revocation and archive.
Restart/reconnect/update never resets it. Every executable envelope's payload carries
`ControlRoleFence {home,executor}`; its epochs and generation must match current trusted policy.
Archive increments the executor epoch atomically with freeze; receipt adoption records the new epoch
at home. A replayed already-conclusive operation is looked up by original receipt before current-role
admission checks, so an epoch change does not erase its acknowledgment. New operations use the new
fence; old unadmitted envelopes cannot acquire authority under it. Event cursor namespaces remain
binding+generation+source lineage, so old factual evidence can still reconcile after archive/unpair.

Pairing approves and persists each exact peer intent independently, reads both back, then permits
dispatch. Unpair immediately fences new local dispatch/admission, retains revocation tombstones,
freezes relevant watch authority and keeps archives/audit/receipts readable. It neither stops accepted
ordinary work nor restores the legacy Control. If the other daemon is unreachable, peerAcknowledged
stays false and UI says revocation pending there. Retain the signed native consent and exact unpair
intent durably; on reconnect the native management path obtains/answers the peer request only for
that same already-user-approved pinned intent, or asks again if scope changed. The courier must not
turn a model result into such consent. Peer unpair uses its own current epoch/approval request and
the original scoped intent key; home records its verified response through unpair/ack. Losing an ack
replays that same response. No second active home is created while peer revocation is uncertain.

Daemon reinstall/data restore changes lineage and invalidates enrollment, epochs and cursor authority;
explicit repair is required. An SSH host-key change fails before daemon hello and requires explicit
native re-verification, not a new host inferred from names. App reinstall/key loss requires explicit
native management rekey; agents cannot replace the pinned key. Key rotation invalidates pending
approvals, preserves consumed decisions/receipts/tombstones and does not revive grants or archives.
Incompatible peers can be inspected/read-only but cannot become ready or execute cross-host work.
An already enrolled peer may always be monotonically unpaired using its authenticated native
management API, even if ordinary Control versions are incompatible; otherwise record local revoke
and show peer pending. No implicit downgrade or failover.

### Machine-readable rollout proof and archived reads

`ControlHostCutover` now includes roleFence, compatibleRoutes, archiveReady and optional
`ControlAcceptanceProof`. GET state on home reports preparing unless all are satisfied:

- Both installed builds have trusted packaged test evidence for suite
  `control-hosts-two-daemon-v1` (the two-daemon acceptance test), recorded as homeBuildId and
  executorBuildId, with a verified daemonProofId. Activation additionally requires verified
  realCourier evidence for `control-hosts-real-courier-v1`, including appBuildId and proofId.
  Both suites cover the assembled actions, watches and task visibility before activation.
  The daemon suite covers admission/refusal, stop receipt, revocation, disconnect/replay
  watch delivery, qualified task visibility and non-destructive archive/readback. A build without
  daemon-suite evidence must not advertise Control v1 route support; route support is not
  activation, and missing real-courier proof keeps readiness preparing. This is a release/build gate,
  not an app-supplied `testsPassed` flag, and this contract does not claim the future suite has passed.
- compatibleRoutes means both verified hellos/epochs and registered versioned enrollment, approval,
  exchange/receipt, events/import/ack, status/import, sync-state, lifecycle and archive-read routes
  satisfy the contract. Missing handlers or unsupported route versions keep preparing.
- Actual runtime actionReceiptOperationId, reconnect watchEventId and fully imported taskSnapshotId
  are verified against home durable stores for this exact enrollment and role fence.
- archiveReady means the executor's legacy session/source stores are identified, all archive read
  routes are available and active/uncertain legacy Control mutations can be reconciled by the
  archive handler. It is not proof that freeze has already happened.

The app shows separate legacy Controls while preparing/ready or while archive is pending/unknown.
Only adopted accepted control.archive plus matching archived role/epoch and usable history-read
routes allows one active row. Already archived executors without legacy content use their explicit
executor role only after the same capability/enrollment/route/test gate, not by hiding an unknown row.
Any build, pin, generation or epoch change invalidates stale ready evidence. A post-cutover disconnect
retains the one authoritative home row as disconnected and keeps archived history navigation.

Read-only archive API, all on the original executor, never the current home singleton:

| GET path below `/api/control-hosts/:bindingId/archives/:sessionId` | Response |
| --- | --- |
| base path | `ControlArchiveInfo`: original SharedSessionRef, archivedAt, roleEpoch, readOnly true |
| `/history?before&limit` | `ControlArchiveRead<ControlArchiveHistoryPage>`, full retained transcript from newest page backward (entries oldest-first within a page); next is oldest returned entry ID, absent at end |
| `/memory/view` | `ControlArchiveRead<ControlMemoryViewResponse>` |
| `/memory/nodes/:id/:n?offset` | `ControlArchiveRead<ControlMemoryNodeResponse>` |
| `/memory/messages?before&limit&q` | `ControlArchiveRead<ControlMemoryMessagesResponse>` |
| `/memory/stats` | `ControlArchiveRead<ControlMemoryStats>` |
| `/audit?before&limit` | `ControlArchiveRead<ControlAuditResponse>` |
| `/authorizations?after&limit` | `ControlArchiveRead<ControlAuthorizationsResponse>` |
| `/watches?after&limit` | `ControlArchiveRead<ControlArchivedWatchesResponse>`; preserved watch records and their stopped/fired disposition, ID order, default 40 and maximum 100 |

Resolve binding/session to its frozen original source stores, even if unpaired/revoked. Keep the
original host/lineage in every wrapper; wrong-source IDs are 404/409, never a current-home fallback.
These pages do not ensure a singleton, start/recover a worker, compact memory, resume a watch,
consume a grant, rewrite raw records or import old grants into home. Read-only archive access uses
the verified pinned native connection even after active enrollment is revoked; no new execution
authority follows. If source storage is absent, return unavailable/not found rather than synthesize
an empty archive. Original timestamps, audit phases and authorization revocation fields are preserved;
the archive wrapper makes even old non-revoked grant rows visibly frozen and non-executable.

History defaults to 100 entries, at most 500, 1 MiB encoded; other endpoints retain their existing
bounded page/query semantics with a 1-MiB envelope ceiling. Oversize individual entry blocks explicitly
rather than truncating authorization/history evidence. No transcript/thought payload is exported
through the remote watch journal; archive browsing is an explicit native read of retained history.
The source databases are preserved. Pending watches stop/audit without new delivery; fired notices,
audit and frozen grants remain readable, never silently executed or imported.

### One task/status DTO and merge precedence

`ControlDashboardSharedTask` is the sole thin row for both optional dashboard.sharedTasks and
snapshot.missionTasks (`ControlRemoteMissionTask` is an alias). `ControlDashboardReplicaMission`
is the remote-home replica summary. They derive authority from existing `SharedContextSummary`,
`DelegationGrant`, `SharedTaskRef` and shared proposal/freshness records; no new executable grant
or copied grant.request is introduced. Dashboard fields/counts stay optional for older producers,
and a negotiated v1 producer supplies explicit empty lists/counts.

Committed identity is exactly the tuple (missionHome.daemonId, missionHome.lineageId, missionId,
taskId). Stable display id is the compact JSON encoding of that array; binding, source, epoch and
execution host are not part of it. Proposal identity uses ["proposal",origin host daemon/lineage,
bindingId,bindingGeneration,proposalId]; new proposals have no canonical taskId/taskNumber. Known
existing-task proposals may reference the committed task but stay separate provisional evidence.
Do not count a proposed new task as a committed task or display it as a second committed row.

Rows carry title/status/number when known, observedOn source host, source
mission-home|execution-fact|replica|proposal, consistency committed|provisional, and binding/generation.
Optional delegationId/grantBindingId/grantBindingGeneration/executionEpoch/grantState are thin
references to the existing grant, distinct from the observer's replica binding; map
reserved/accepted/cancel_requested/sealed without inventing a second state machine. Optional
definitionRevision fences execution-fact eligibility. Proposal state/origin and up to 16 conflicts
retain bounded reason/evidence IDs, never executable proposal args. Omitted values are unknown.
`projectId` is the producer-local canonical or execution project, not cross-host task identity.

Merge before clipping/counting:
1. Prefer current mission-home canonical task definition/status and its tombstones.
2. Supplement only eligible execution facts matching the current grant's binding/generation,
   delegationId, definition revision and executionEpoch. A running fact is the last imported fact,
   not live liveness; idle/disconnect/stop receipt never proves seal/release/completion.
3. Use a complete committed replica only when canonical data is unavailable; select the greatest
   contiguous authorized mission sequence, never wall-clock newest. Equal-sequence conflicts remain
   explicit evidence, with stable binding-ID tie-break only for presentation. An incomplete replica
   is labelled incomplete, not used as proof of missing/deleted tasks.
4. Retain proposals/conflicts alongside committed state without applying them. Old-epoch execution
   facts stay audit evidence, not replacements. One committed row/count per identity across all
   home grants, execution snapshots and replicas. New-epoch data supersedes old execution display
   only through the authoritative current grant, never because a socket reconnected.

replicaSyncedAt/replicaAgeMs describe **local mission replica import**, unknown for legacy missing
timestamps; snapshotCapturedAt is the producer's remote capture time and remains distinct.
`ControlHostObservation` joins verified host availability/import time to rows: available,
disconnected or unknown is explicit, never inferred from age or outcome. For a delegated task row
availability refers to executionHost, otherwise observedOn. Missing transport evidence means unknown.
A stale capture remains stale even after import; clock skew is reported, not used to pick authority.
Replica summaries expose complete/sequence, pendingCount/conflictCount and age. Local/home/native
producers use these same DTOs; the app does not deduplicate by binding or mutate status based on a timer.
totals.sharedTasks and snapshot.missionTasksTotal count deduplicated display rows, including separate
provisional proposal rows. They are not canonical mission progress counts: never feed proposals into
missions.tasksTotal/tasksDone. Keep committed/provisional labels and count canonical progress only
from the authoritative mission/committed task identity set. Conflict text is at most 512 UTF-8 bytes
per item and 16 items per row; evidence IDs reference existing shared-context records, not copied args.

### Updates, transport shutdown and Stop presentation

Add GET `/api/control-hosts/:bindingId/lifecycle` on either peer →
`ControlHostLifecycleResponse`. It reports bounded operation delivery and update blockers;
at most 128 operations/blockers and 64 KiB, with truncated implying updateReady false.
These blockers join existing RuntimeUpdateStatus.blockers and existing process/terminal/job/transfer
drain proofs. They never replace the updater's target-side admission barrier.

| Control state | Remote update rule |
| --- | --- |
| queued and durably never exported/possibly transmitted | Does not by itself block target update; fence dispatcher until verified reconnect and retain original envelope. |
| unknown and possiblyTransmitted | Blocks initiating an update until original receipt is reconciled; timeout is not clearance. |
| pending/admitted handler, any control.* kind | Blocks readiness until its domain mutation is durably conclusive/recoverably drained; never kill a handler to make it look complete. |
| accepted/rejected, durable receipt and no in-flight domain commit | Does not by itself block; accepted running chats/jobs/PTYs still obey existing target resource blockers. |
| archive freeze or enrollment/native-approval commit in progress, journal fault or reconciliationRequired | Blocks, including after app disconnect/restart. |
| unacknowledged events or cached snapshot stage only | No blocker if retained durably and update preserves compatible journal/schema/lineage. Capacity/fault or incompatible migration blocks instead. |

The app reconciles possibly-transmitted unknowns before requesting update. Once a target-owned update
is accepted, its own durable admission barrier/drain controls progress independently of app liveness;
it cannot depend on a future Mac reply. New arrivals during that barrier remain pending/rejected
by explicit policy, never half-admitted. A mixed-version update rechecks hello, route/test evidence
and role epochs before courier dispatch resumes; unsupported schema work stays fenced. Never repair
an unknown operation by making a new ID, dropping its reservation or assuming the target is idle.

On sleep/quit, stop starting transfers, cancel bounded read/HTTP/SSH work and await owned-forward
cleanup plus native intent persistence. Interrupted responses are unknown; retain original envelope,
home ownership and any remote journal entries. Closing the courier quiesces transport only: no
remote Stop/Pause, service shutdown, role change, epoch bump, ownership release, cursor advancement
or fabricated failed outcome. Target agents and accepted update services continue independently.
Reconnect creates freshly verified endpoint clients and reconciles receipts before same-ID delivery.
These Control orchestration rules do not change the ordinary composer receipt-only reconnect policy.

For a Control-issued stop, lifecycle delivery queued/unknown/pending is shown as **Stop requested**;
only adopted matching accepted receipt is **Stop acknowledged**; rejected is an explicit refusal.
The UI keys this to operationId/target/host, persists requested across restart and does not infer
acknowledgment from an idle session, cancelled HTTP request or a later snapshot. Acknowledgment is
durable command admission, not quiescence or permission to reassign. Ordinary legacy native Stop
still has its documented lost-reply limits and is not retroactively given a durable receipt.

## Source-audit additions: boot fences, consent and courier ordering

### Role/freeze barrier before any recovery

The current boot chain is `sessions.load → ensureControlChat → watchLifecycle.reconcile →
importLegacyWatchAuthorizations → setWatches(ControlWatchSink)`; audit initialization can also
start a live Control worker. This order must not be reused unchanged for executor/archived roles.

Required startup contract for the enrollment/role owner and archive-transition owner:

1. Open and recover the durable Control-host role/enrollment/freeze store **before SessionManager
   load, session recovery scheduling, input admission, watch observation or any callback that can
   start a Control worker**. Install a process-wide trusted role/roleEpoch admission guard first.
   Missing, corrupt or uncertain policy fences Control creation/recovery/wakes; never default to
   home based on platform, SSH configuration or an empty store. Ordinary independent chats may
   recover when their own safety prerequisites hold.
2. Load metadata/history for all chats, but executor and archived-control must suppress execution
   recovery of legacy conversational Controls, queued Control inputs, scheduled wakes and provider
   dispatch. No `ensureControlChat` singleton allocation/start on those roles. Deferred callbacks,
   `controlAudit`, audit initialization, diagnostics and read APIs cannot bypass this guard or
   lazily start a live Control worker. Executor operation audit belongs in its domain journal,
   not a recovered remote conversation. Read-only archive audit opens preserved storage only.
3. Before observation/notice delivery, reconcile the durable freeze/removal intents. Executor and
   archived-control **skip importLegacyWatchAuthorizations** and never install the conversational
   `ControlWatchSink`. This prevents a restart from reviving old grant authority or notices.
   Their enrolled remote-watch journal writer is a separate sink, with no conversational wake.
   Home alone may install its live sink/import, after its own archive/watch reconciliation.
4. Recovery of already journaled remote control.* handlers is separate from recovery of a Control
   model turn: reconcile immutable operation/domain IDs under current enrollment/role fences, never
   replay an arbitrary old Control tool or ask a frozen model to finish an uncertain mutation.
   Preserve uncertain evidence and block cutover until it is reconciled. Accepted ordinary remote
   chats continue independently.
5. The archive operation persists its freeze intent before any asynchronous drain/reconciliation.
   A crash/restart sees that intent at step 1, not after sessions.load. Final role epoch/archive
   commit and idempotent watch-removal audit preserve that same fence. Every runtime ingress also
   checks the guard, so changing a row/filter cannot reactivate a frozen Control.

An explicitly approved executor role therefore freezes conversational execution immediately, even
if its legacy row remains visible pending end-to-end readiness. Final archive is the last
non-destructive cutover step; it is not the first execution fence. Native filtering alone is
insufficient. Staging must not run a second Control while waiting for the one-row UI gate.

Required implementation tests seed an old Control with a recoverable run, queued input, pending and
already-fired watches, grants and audit, then restart as executor and archived-control. Assert zero
legacy worker/model starts, zero imported legacy grants, no conversational sink/wakes, preserved
readable stores, independent ordinary execution, and same-ID remote handler reconciliation. Repeat
with a crash during freeze and with audit access before ordinary load completes.

### SSH trust is not Control-home consent

Devbox/SSH enrollment confirms transport identity only. Accepting an SSH fingerprint, importing an
SSH alias, installing the app's public management key or accepting a runtime update is **not**
approval to select a Control home, stage an executor role/freeze or archive a legacy Control.
No bootstrap/update code may infer that consent from its own successful setup result.

Native UI obtains a separate explicit structured `enroll` approval naming the pinned home,
executor, binding/generation, current role epoch and the effect on the legacy Control. Only that
approved daemon intent can persist the accepted Control home and executor role policy. The
management public-key pin merely authenticates this later decision; it grants no home authority
by itself. Updates preserve role, epochs, enrollment and freezes exactly and never silently enroll
or reapprove. The native pairing task owns the distinct preview/gesture; daemon role enforcement
owns the durable result.

### No authority downgrade through older operation kinds

Control-originated remote start/send/run/watch/revoke actions **must** use the reserved control.*
envelopes and their trusted authorization, ceiling, reservation, roleFence and idempotency data.
The courier may not translate them into naked `chat-create`, `chat-send`, legacy spawn/send/stop
HTTP calls, or `shared-*` operations to get around a missing Control handler.

Those existing kinds have independent UI/shared-context purposes and carry no Control grant or
ceiling. They are not a substitute authority container. An accepted Control start may internally
reuse an idempotent target allocation/input helper, but must retain its original control.* admission,
target, permission and reservation metadata. Shared-context grants remain additionally mandatory
where mission placement needs them; possessing one does not authorize arbitrary Control actions.
An incompatible/missing control.* route leaves the original operation pending or explicitly rejected,
never retries it under another kind or fresh ID.
Executors must reject trusted Control-attributed work arriving through chat-create, chat-send,
shared-* or legacy mutation routes, before allocating metadata or admitting input, with an explicit
OperationRejected/unsupported-authority outcome. Attribution comes from trusted admission origin,
persisted intent and permission context, not an agent-supplied caller label. A missing public
authorization field must not reclassify a Control intent as native user work. Home dispatch and
internal helpers preserve that provenance. Legitimate independent native UI/shared-context requests
retain their own authority paths; their existence does not provide a Control downgrade path.

### Status revision and publication CAS

`ControlRemoteStatusSnapshot.revision` is a positive, durably reserved, strictly increasing capture
counter per executor Control binding/generation/source lineage. It survives restarts and is never
derived from timestamps, role epochs, reconnect counts or mission/task revision. Reserve once per
new capture; all its pages keep the same revision/snapshotId/capturedAt and frozen content. A new
capture reserves a new revision even if display facts are unchanged; capture reads themselves do
not emit invalidations or trigger another capture. It is transport freshness ordering only, not
canonical task authority.

POST status/import now takes `ControlRemoteStatusImportRequest {page,expectedPublishedRevision}`,
not a naked page. Home's publication counter starts at 0, persists in the Control-memory cache
tables, and increments only on complete atomic publication. Read sync-state for the last published
counter before starting a capture import (0 when no status exists), and persist that same baseline
with every page of its stage. `ControlRemoteStatusImportResponse.publishedRevision` reports 0/current
counter while staged and the new counter after publication. Sync-state exposes the staged/last
capture revision separately from the publication counter.

- Exact repeated pages/imports return the original stage/result without advancing counters.
- Same snapshotId/revision with different page content is 409 reconciliation-required.
- A source revision below the published source revision is 409 stale_snapshot, even if capturedAt
  looks newer. A different snapshot ID cannot reuse a source revision. Do not pick a wall-clock winner.
- At final-page commit, compare expectedPublishedRevision with the current durable publication
  counter. If another complete capture won first, return 409 snapshot_cas_mismatch and discard only
  the superseded incomplete stage. Re-read sync-state and capture/import a current inventory; never
  rebase an older capture onto a new baseline to overwrite newer data.
- An ambiguous final import is resolved by sync-state or replay of the exact final request. Retain
  its original conclusive response so lost acknowledgments do not republish or regress importedAt.
  A duplicate old response does not mean it is still the currently published snapshot.
- Snapshot restart/expired-capture handling never resets event cursors, operation IDs, grants or
  committed task state. New lineage/enrollment starts a separate namespace; it cannot inherit a
  previous peer's publication counter as authorization.

### Priority lanes, head-of-line behavior and foreign changes

POST exchange accepts `lane:"revocation"|"ordinary"` (omission means ordinary); responses explicitly
name their lane. Each cursor is scoped to binding/generation/peer/lane and immutable queue ordering.
It is invalid to use an ordinary cursor on the revocation lane. Both lanes retain the existing
16-operation/2-MiB page bounds; their combined retained envelopes still share 4096 records/64 MiB.
No priority path evicts a safety record or changes its immutable envelope.

Revocation lane contains control.revoke, control.unwatch and non-spending control.run stop/pause.
Other agent actions and app-only archive use ordinary. Native unpair is a separate authenticated
management fence and takes priority over either lane. On reconnect/invalidation the courier scans
revocation first and performs receipt lookup before delivery of each original envelope. It need not
wait for old ordinary pending receipts to reach the revocation lane: cursor paging can pass them.
Priority does not pretend an offline peer has observed a tombstone.

Per-session ordinary ordering is mandatory. The serialization key is the actual routed
(destination daemonId, lineageId, sessionId), not the project's host alias, an unrouted member ID
or the whole host. A start uses its preallocated sessionId. Home durably orders its ordinary intents
for that key and exposes only its earliest unadopted ordinary intent as deliverable in exchange;
later same-session ordinary intents remain parked until that predecessor has a conclusive receipt
durably adopted at home. Unknown and pending therefore block later ordinary start/send/redirect/
resume for that session, but not work for other sessions on the same host. An accepted queued input
is conclusive admission; do not wait for the agent to finish its run. Explicit rejection also releases
that ordering barrier after durable adoption, without automatically authorizing a replacement action.

Page cursors may scan past a pending session head to other sessions, never past it to execute a
later intent for that same session. The executor serializes same-session ordinary admission/domain
commits; home does not expose the successor until receipt proof that its predecessor committed.
Retries of an earlier already-admitted operation return its original receipt, not a second input.
Do not compare sequence numbers from different producers to invent a global execution order.
The ordering index and predecessor/adoption frontier survive home restart and ambiguous imports.

The revocation lane intentionally bypasses that ordinary barrier. Revoke/unwatch install their
durable tombstones; stop/pause install the appropriate durable scheduling/input fence before a
conclusive acknowledgment. If a target or effect cannot yet be resolved safely, keep the safety
operation pending/requested, not falsely acknowledged. This exception never permits an ordinary
resume/send to leapfrog an unresolved stop, revoke or pause affecting it. Other sessions' independent
accepted execution is neither held nor cancelled solely by this session's queue head.

While a known revocation/removal or role freeze is pending/unknown, park new spend-capable ordinary
operations for that affected binding/grant/watch/target; unrelated targets/bindings may progress.
When the scope cannot be determined safely, park that binding rather than guess. Executor admission
prioritizes durable safety fences and rechecks them after asynchronous preparation, including for
already admitted but uncommitted work. A full/broken journal reports backpressure and holds ordinary
work; it never drops a revoke or claims success to free a lane. Removal/revocation does not itself
kill previously accepted ordinary execution or prove a task seal.

Courier scheduling is bounded and fair across hosts: at most four concurrent HTTP requests, with
one slot reserved for pending revocation/native safety reconciliation, at most one page request per
binding/lane at a time, and round-robin ordinary peers. One unavailable host or pending operation
cannot block another host's receipt/event/status reconciliation. A pending handler does not occupy
an HTTP request indefinitely: bounded pending receipt reads yield ownership to its daemon journal.
No tight retry/poll loop is a workaround for a head-of-line blocker. A new invalidation/reconnect
restarts affected scans; existing pending ownership remains durable. Continuous safety work may
deliberately hold affected spending, which UI reports as waiting, not failed.

Subscribe to control-hosts.changed on **both** home and every verified executor. Home emits outbox,
receipts, enrollment/readiness/archive and completed-import status changes for its bindings; executor
emits events after durable matches and status when its projection can change. Foreign session,
mission, delegation, replica freshness/proposal/conflict, PR/Linear and role changes invalidate every
affected Control binding's status, even when no local conversational Control exists. Shared-context
invalidations remain inputs to the producer; the app does not reinterpret them as complete snapshots.
Home republishes dashboard.changed after an eligible foreign import updates its merged view.
Coalesce/dedupe unchanged projections and ack replays, and never emit just because a page was read,
a capture was reserved or an outbox was scanned. Socket loss recovers by the durable HTTP state,
not an assumed empty queue. The defined lifecycle/update blockers apply to either lane.

## Final activation and legacy-work guarantees

### Freeze the conversational owner, not its accepted independent work

Legacy freeze blocks new legacy Control starts, follow-ups, scheduled/user/automatic wakes and
recovery turns. It **must not** Stop, Pause, cancel, seal, reassign or otherwise interrupt already
accepted independent remote agent work merely because the originating Control is frozen or archived.
Do not traverse origin/parent links and mass-stop spawned chats, mission grants, subagents or jobs
that belong to those independent accepted executions. Their original execution owner remains
responsible for them, including while the Mac/courier is absent.

Never raise their existing permission ceiling. Persist and recover the exact original ControlPermission,
accepted scope, per-input/child ceilings, reservation IDs, consumed follow-up/USD accounting, remaining
budget/caps and source authorization/audit provenance. Freeze/archive cannot reset usage, refund an
active reservation, convert a capped chat to unrestricted Build, attach a broader home grant, or
silently rewrite its origin. Missing historical metadata is not permission to invent a higher ceiling.
New home follow-ups require new explicit authorization and still cannot exceed the execution's existing
ceiling or accepted scope. Any separately requested cancellation/permission change is outside this
migration, not a side effect of freeze.

Pending legacy watches stop once with durable audit reason `legacy-control-frozen`, watched target,
watch ID, origin and role epoch. Preserve their records for read-only /archives/:sessionId/watches;
`ControlArchivedWatch` wraps the original Watch with stopped/fired disposition, stoppedAt and
auditReason. Already-fired notices remain in retained history/audit; do not enqueue or deliver them
again. Preserve whatever historical watch evidence exists, and report missing historical definitions
honestly rather than fabricate a grant from a notice. Legacy grants/authorizations remain frozen,
never merged, imported, rebound or revived at home. History and audit are read-only. Freeze and
archive retries do not append duplicate removal audits or erase consumed-budget/scope evidence.
These requirements apply to the pre-load role barrier as well as the final archive transaction.

### Prove assembled behavior before activation, without a dependency cycle

There are two independent required proof suites: the daemon/fake-courier two-daemon suite and the
native real-courier lifecycle/integration suite. Both must prove assembled actions, watches and
qualified task visibility **before production activation**. The real-courier proof must also cover
reconnect/update/sleep lifecycle and the role/archive acknowledgment round trip with the preserved
legacy stores. Daemon archive endpoints and their replay/read-only behavior can be implemented and
tested before activation; they do not depend on a visible native one-row UI.

Native routing/history code may land **inactive and fail-closed** first. A dedicated integration
harness can exercise the assembled supported routes and injected trusted fixture identities while
the production activation gate remains closed. Shipping a route handler or inactive UI does not
enable orchestration, hide a legacy row or count as proof. Test evidence is generated from the tested
immutable app/daemon build IDs and verified under trusted package/release provenance, not from native
UI toggles, agent messages, a tool result or a client POST containing `passed:true`.

`ControlAcceptanceProof` records daemon suite/build IDs and daemonProofId, plus optional realCourier
suite/appBuildId/proofId. The home can report daemon-only evidence while preparing, but **ready
requires both verified proofs**, matched to the installed paired builds and the current app build,
plus the existing route/role/runtime action/watch/task evidence. Missing/unknown/mismatched proof,
contract version, role epoch or archive-read support keeps preparing. The client cannot fill an
omitted proof or invent compatibleRoutes, archiveReady, homeReady or executorEnrolled flags.
Capabilities announce versioned route support, not permission to activate.
Proof IDs resolve retained, build-matched attestations already verified by the home daemon, not
arbitrary opaque IDs supplied by a client. The verified evidence and cutover reference are durable
in home's Control-memory store; unverified test output or an unsigned native flag is not evidence.

Thus the implementation order is acyclic: contract and inactive native plumbing; daemon handlers
and archive endpoint; daemon suite; real-courier assembled suite; verified evidence publication;
runtime readiness; explicitly approved archive; durable role/archive acknowledgment; active one-row UI.
No implementation is required to activate prematurely so another implementation can test it.

### Versioned role/archive acknowledgment

`ControlRoleAcknowledgment` is a daemon-produced durable record containing contractVersion 1,
binding/generation, exact home and issuer host pins, role/roleEpoch and intentId. Enrollment uses
its consumed native approval request ID as intentId. The executor's accepted archive result uses
the original archive operationId, original sessionId and archivedAt. It is not a client assertion
and not an authority transfer or a cancellation/completion proof for independent work.

- Enrollment PUT/readback supplies persisted roleAcknowledgments in ControlHostStateResponse
  (at most home and executor). A successful transport or approval decision alone is not the role ack.
- Archive remains the existing immutable control.archive operation/receipt protocol. Only after
  durable freeze, store preservation and role epoch commit does accepted ControlArchiveResult include
  roleAcknowledgment with role archived-control and the matching intent/session/time.
- Home validates operation/hash/target/destination, enrollment, proof version and acknowledgment
  identity/epoch, then durably adopts both receipt and role acknowledgment. Its
	ControlReceiptAdoptionResponse includes that roleAcknowledgment; GET state returns persisted
  roleAcknowledgments for restart/lost-response reconciliation.
- Exact replay returns the same role acknowledgment and archive timestamp. Pending/unknown has no
  conclusive role/archive ack. Reject a different intent, pin, generation, version, session or epoch;
  never repair it by synthesizing flags, creating a fresh operation, copying history or raising a ceiling.
- The client may show a single authoritative Control only after reading matching daemon-issued
  proofs and the home-adopted archive/role acknowledgment. A bare hello role, queued archive response,
  accepted-but-not-adopted remote response or native sidebar filter is insufficient. Reconnect
  verifies current hello pins/version/role epoch against the stored acknowledgment; loss of transport
  does not undo a completed cutover or promote the executor.

Both acceptance suites test lost archive receipt, lost home-adoption response, duplicate acknowledgment,
restart during freeze, preserved stopped-watch/fired-notice/audit records, and accepted independent
work continuing with unchanged scope, ceiling, budget usage and provenance.
