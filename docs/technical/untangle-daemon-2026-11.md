# Daemon structural audit, November 2026

## Status and evidence

The initial audit was read-only and preceded implementation authorization. The implementation
dispositions and focused evidence are recorded below. The parent owns the full Node gate and all
version-control actions. Native intake counterpart tests belong to `apps/day/native`.

Read `CODING_STANDARDS.md`, the previous untangle decisions, and the technical documents for testing,
durable operations, resumable upgrades, host routing, Insights history and daemon stalls. Inspected
composition, session/mission integration, persistence, planning, source adapters, worker clients,
HTTP/WebSocket ownership and representative tests. This is not a claim that every daemon function
was reviewed. A static inventory counted 331 top-level implementation files and 1,126 local import
edges, including type imports. Those edges do not establish runtime cycles.

Line references below describe the audited checkout and will move during implementation.

## Findings and proposed changes

### 1. Production listener order exists solely for a test

Evidence:

- `packages/daemon/src/server.ts:4432` says to keep the following `sessions.onChange` registration
  last because `server.test.ts` drives the most recent listener.
- `packages/daemon/src/server.test.ts:1005–1007` and `1171–1173` overwrite one captured callback
  whenever a listener registers.

The fake implements a single callback slot rather than the actual subscription contract. Production
code preserves registration order to satisfy that inaccurate representation.

Change the fake to keep a listener set, return real unsubscribe functions, and emit to every current
listener. Remove the production ordering comment and restriction. Keep observable socket assertions.
Verify that adding another subscriber does not suppress existing deliveries and unsubscribe works.

### 2. HTTP construction is also application construction

Evidence:

- `packages/daemon/src/server.ts:387–413` takes 26 positional arguments, including `_reserved`.
- `server.ts:421–498` installs diagnostics and process guards into sessions.
- `server.ts:514–979` constructs stores, journals, update admission, reviews, planning, intake,
  attention and several Insights services.
- `server.ts:832` starts planning research.
- `packages/daemon/src/daemon.ts:438–475` supplies the long positional call with placeholder values.

Creating the server changes session behavior and starts domain reconciliation independently of
listening. Optional argument combinations form many partially configured applications.

Use one explicit daemon composition owner. Construct domain services there, install bridges, restore
metadata, and start eligible background work in a visible order. Give the server a named dependency
object containing route-facing services and identity. The server owns transport resources only.

This is justified if it can be done as a direct extraction without new service registries or lifecycle
frameworks. A named options object alone improves call safety but does not complete the ownership fix.
Preserve mission-membership installation before session recovery, maintenance freezes before recovery,
and durable admission ordering. Add a construct/restore/start test that proves no execution starts early.

### 3. Subscription cleanup is inconsistent

Evidence:

- `packages/daemon/src/server.ts:4309–4365` keeps several unsubscribe functions and calls them on close.
- `server.ts:4366`, `4371`, `4433` and `4455` discard project, artifact, session and mission disposers.
- `packages/daemon/src/mission-service.ts:278` installs a session listener without keeping its disposer.
- The underlying methods return disposers at `projects.ts:140`, `sessions.ts:4719` and `sessions.ts:5614`.

Closing and recreating a server against existing services leaves callbacks holding old maps and
broadcast closures. MissionService also has no clear lifetime for its constructor-installed observer.

Keep subscriptions with their owner and expose idempotent close. Use a small disposer list, not a new
framework. Test close/recreate against the same services: one delivery while open, none after close.
The baseline also emits MaxListenersExceededWarning for server close listeners. Consolidating transport
cleanup can address that warning; increasing the listener limit would not fix the ownership issue.

### 4. Injecting a worker changes unrelated session dependencies

Evidence in `packages/daemon/src/sessions.ts`:

- `2504` creates the pool only without `factories.worker`.
- `2508–2510` omits the default subscription-usage cache when a worker factory exists.
- `2524` omits DatabaseService when a worker factory exists.

Worker substitution silently disables accounting and database capabilities. Session tests therefore
exercise a different configuration without selecting those differences explicitly.

Inject these dependencies separately. Put deliberate offline choices in a shared named test fixture.
Keep production defaults. Test the fixture's supplied capability/admission contracts. Pool ownership
may legitimately depend on who supplies workers; subscription accounting and database access do not.

### 5. The session/mission bridge exposes too much domain policy

Evidence:

- `packages/daemon/src/sessions.ts:256–326` spans admission, lifecycle, membership, context,
  capture ownership, PRs, artifacts, accounting and durability in one bridge.
- `packages/daemon/src/mission-service.ts:248–251` installs four Insights stores into sessions.
- `mission-service.ts:300–428` installs callbacks that directly inspect and mutate mission state.
- Session setters separately install memory, knowledge, sharing, schedules, tracking and update services.

Callbacks avoid some direct imports but leave conceptual coupling and partially configured instances.
Moving methods into neighboring files would not solve this.

Keep worker lifetime, durable input and session metadata in the session runtime. Let mission and
Insights owners consume narrow execution ports. Keep a small explicit admission/context interface
where execution genuinely needs domain decisions. Move domain tool dispatch and projections to owners.

This is an incremental direction, not authorization for a wholesale session rewrite. Preserve final
synchronous spawn admission, post-await rechecks, durable-before-result barriers and generation fences.

### 6. Generic operation persistence owns Insights migration policy

Evidence in `packages/daemon/src/operation-journal.ts`:

- `81`: legacyInsightsReservations.
- `265–312`: replacement-reference parsing and qualification.
- `314–348`: legacy-transition capture.
- `350–373`: transferred-legacy guards.
- `375–390`: Insights-specific admission guard.
- `426–451`: reservation tracking based on Insights kind prefixes.

Consumers include `insights-legacy.ts:96–100` and `insights-transition.ts:105,398`.
The generic journal understands feature names, payload fields, successor relationships and migration
exceptions. This makes feature migration policy part of every consumer's persistence primitive.

Keep serialization, immutable records, reservations and guarded snapshots in the journal. Move
Insights selection and qualification to an Insights-owned adapter. Expose a concrete consistent
snapshot/admission-guard primitive, not unrestricted maps or a speculative plugin framework.

An asynchronous list alone is not equivalent. Current guards detect reservations already in journal
I/O but not yet published in memory. Preserve those synchronous checks at transaction boundaries.
Run transition, replacement, concurrent reservation and cold-recovery tests after extraction.

### 7. A forwarding export leaks disk implementation into pure callers

Evidence:

- `packages/daemon/src/tracked-items.ts:37–38` forwards types and validatePatch from tracked-items-disk.
- `server.ts:152,2474` imports and calls that validator through tracked-items.
- `sources.ts:59` imports policy constants directly from tracked-items-disk.
- `tracked-items-disk.ts:3` imports node:sqlite and its imports include disk helpers/classification.
- The validator itself is at `tracked-items-disk.ts:1600`.

Importing the module does not itself open SQLite, but pure validation and source policy needlessly load
the disk implementation graph on the daemon thread.

Move shared request types and pure validation to their contract owner, and Slack polling constants
to Slack policy. Import directly with no forwarding layer. Keep disk construction worker-only.
Preserve validation/error behavior and run tracking HTTP, patch and source tests.

### 8. Removed Slack quota still has executable plumbing

Evidence:

- `tracked-items-disk.ts:400–402`: reserveSlackRead ignores its arguments and always returns true.
- `tracked-items.ts:162–165`: still describes a shared hourly budget and sends an RPC.
- `tracked-items-worker.ts:86–87`: dispatches that no-op.
- `slack-waiting.ts:23`: still requires it in a dependency type.
- `tracked-items-disk.ts:405–412`: classification retains ignored time/force parameters.
- `slack-cache.test.ts:70–82`: repeatedly asserts that the no-op returns true.
- `slack-source.test.ts:298`: performs 150 such reservations.
- `sources.ts:625–632`: exposes the quota policy as disabled.

Remove internal no-op RPCs, unused dependency requirements and ignored arguments. Keep old stored budget
rows untouched. Preserve externally visible disabled-policy fields if consumers depend on them.

Replace repeated no-op assertions with behavior: old exhausted budget data does not block a real read
or classification; interrupted classification remains non-replayable. Keep provider limits, bounded
passes and explicit retry semantics. Do not reintroduce the removed quota under a different name.

### 9. Native authority is owned by GitHub setup

Evidence:

- `github-setup.ts:107–116` creates/authenticates the native capability.
- `server.ts:1176` and many unrelated routes call githubSetup.authenticate.
- `server.ts:2159,2173` conditions Insights/mission-control capabilities on githubSetup.
- `server.ts:3406–3407` explains the shared historical capability filename/header.

GitHub enrollment owns authority used by unrelated native operations. The historical wire naming
has become an internal service dependency.

Extract a local native-capability owner and inject it into GitHub setup and authenticated routes.
Preserve the capability filename/header, private storage and exact identity/authentication behavior.
Tests must show absent/incorrect tokens and browser origins still fail before effects or receipts leak.

### 10. Recursive source scans freeze implementation, not behavior

Evidence:

- `retained-review-contract.test.ts:1018–1054` reads daemon/kernel/protocol files recursively and
  rejects imports/identifiers with regexes and filename exceptions.
- `retained-review-linkage-contract.test.ts:944–974` repeats that pattern.

Harmless extraction can fail while aliased/indirect effects pass. Keep behavioral negative controls:
unauthorized entry points, unavailable producers, unchanged state, and absence of effect calls.
If a static rule remains useful, express it once over actual imports, not repeated recursive text scans.

Do not delete meaningful internal/performance tests indiscriminately:

- `funding-packaging.test.ts:8–25` exercises generated-worker packaging and stale-source detection.
  That protects a real distribution constraint.
- `usage-history.test.ts:290–312` counts statement preparation to protect hot-path reuse. Keep that
  measurement; remove the unnecessary private statements-map assertion at `308–309`.
- `sessions.test.ts:2795–2838` protects authorization after asynchronous work. Keep the race coverage,
  even if better fixture ports can replace direct private-state mutation.

### 11. Intake compatibility tests parse Rust implementation text

Evidence: `connected-intake-routes.test.ts:8–24` finds URI literals by regex, finds get() by exact
declaration spelling, uses planning_inventory() as an end delimiter, and extracts literal header calls.
Moving an unrelated Rust method, extracting authentication or adding a harmless header can fail without
changing requests. The test does not execute the native client, so it does not establish native behavior.

Keep real-router tests with explicit GET cases for `/api/projects/:id/intake` and
`/api/projects/:id/saved-linear`, using `x-pilot-github-capability`. Preserve authentication, origin,
project isolation, no-store, missing-service, saved-row and no-external-work assertions.

Coordinate native-side tests in `apps/day/native` that execute the production request/client path against
a local HTTP fixture and observe method, URI and authentication. Remove Rust source parsing and rename
source-matched tests. No generated cross-language contract system is needed for two fixed routes.

The running parent baseline log `/tmp/pilot-untangle-baseline-test.log:361` records failure of
“source-matched reads distinguish…”. Its cause was not established by the audit. Do not label it a
parser or fixture failure until the final diagnostic is available.

### 12. Hand-built server fixtures drift from required contracts

Historical evidence: `docs/technical/testing.md:187–196` records 15 daemon fixtures missing the newer
Insights subscription. That is a previous baseline, not a confirmed current count.

Current evidence:

- `sessions.ts:5114–5124` provides onInsightsReviewChange.
- `schedules.ts:78,154–155` currently treats that subscription as optional.
- `native-intake.fixture.ts:73–104` casts a partial MissionService and sets server arguments by index.
- Finding 1 proves production ordering already accommodates an inaccurate fixture.

Use shared typed server-fixture setup for common identity, subscriptions, cleanup and offline
dependencies. Prefer real SessionManager with explicit offline execution dependencies. If a fake is
needed, implement the complete narrow port, including subscription/unsubscription semantics.

Do not add production optional chaining or empty subscriptions just to satisfy stale fixtures. Separate
genuinely optional product/platform services from required methods on an installed service. Use the
parent baseline to determine whether the historical failures still exist; they were not recounted here.

## Comments and special cases

Remove comments that preserve test implementation accidents, false quota descriptions, and speculative
future uses. Concrete candidates are server.ts:4432, tracked-items.ts:162 and sessions.ts:2557.

At planning-workers.ts:1727–1733, onPowerResume is optional because “Test doubles may not have it”.
Fix the fixture contract rather than accommodating an incomplete SessionManager in production.

Keep comments explaining constraints that names cannot express:

- WebSocket's 123-byte close-reason limit.
- Node watch notices sharing worker message ports.
- Durable-before-ACK and stable lost-reply identity.
- Non-replayable effects and lookup-only recovery.
- Post-await authorization and final synchronous admission.
- Stop/Pause and upgrade generation fences.
- Retired remote ownership remaining occupied, never becoming local execution.
- Absent review prerequisite producers refusing approval.
- Provider limits despite removal of the local Slack quota.
- Historical capability naming and generated-worker packaging requirements.

## Unified design and scope

Use one composition owner, a transport-only server with named dependencies, a session execution core,
domain-owned orchestration, generic persistence primitives, pure boundary contracts, and behavior-focused
fixtures. Extract ownership directly instead of adding forwarding modules, registries or parallel systems.

Do not split canonical mission SQLite merely to split missions.ts. In-memory state, shared transaction
boundaries and worker-backed durability serve responsiveness and atomicity. Migration/schema organization
can move without changing storage ownership.

Do not force funding, usage, snapshots and subprocess workers into one generic runner. Cancellation,
capacity, accounting and shutdown differ. Share bookkeeping only where it is demonstrably identical.

Recommended order:

1. Fix listener fakes, typed shared fixtures and subscription disposal.
2. Replace intake source parsing with explicit router/native behavioral tests.
3. Extract tracking contracts/native capability ownership and remove quota no-ops.
4. Move Insights migration policy out of the journal with race guards intact.
5. Separate composition from transport if the extraction remains straightforward.
6. Narrow session/domain ports incrementally; no wholesale session rewrite.

## Verification plan

Capture the parent's final full-baseline failures before attributing regressions. Run focused tests after
each change, then workspace typechecking/formatting and the complete Node gate. Coordinate native intake
tests through the Day verification wrapper rather than running unqualified native builds independently.

Required coverage: HTTP/socket contracts, subscription cleanup/recreation, startup order, exact receipt
reuse, lost replies, crash/reopen, concurrent reservation/transition guards, post-await ownership changes,
Stop/Pause races, retired ownership, offline provider fixtures and packaging relocation/stale generation.
Measure large-session and streaming responsiveness for hot-path changes. This audit claims neither a
speedup nor a green baseline nor native visual acceptance.

## Implementation dispositions

The authorized implementation removes the concrete accidental links. It does not claim that every
dependency in the session runtime is accidental or that the whole daemon is now a small module.

| Finding                                         | Disposition                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Test-controlled listener order               | Completed. The two server fakes now keep all subscribers and return real disposers. The production registration-order instruction is gone.                                                                                                                                                                                                                                                                                                                  |
| 2. HTTP/application composition                 | Completed as a direct extraction. `daemon-services.ts` constructs domain/runtime services and installs session bridges. Production `daemon.ts` calls it explicitly, then gives the assembled services to `createDaemonServer`. The transport factory no longer constructs those domain services or installs those bridges. All internal callers migrated with no positional overload. Tests use `testing/daemon-server.ts` to compose the same services.    |
| 3. Subscription lifetime                        | Completed. One server close handler runs owned cleanup; previously discarded project/session/artifact/mission subscriptions are detached. `MissionService.dispose()` detaches context observers after execution shutdown. `MissionContinuations.stop()` now releases its store observer. `closeServices()` joins planning/attention cleanup, and the production composition owner awaits it.                                                                |
| 4. Worker injection disables unrelated services | Completed. `subscriptionUsage: false` and `databases: false` are independent explicit options. Default account/config services no longer depend on `factories.worker`. Forty-one synthetic-worker fixture files select `testing/offline-session-options.ts`; explicit fixture services still override the offline defaults. The pool exception remains necessary: a supplied worker factory owns worker creation and does not need the default worker pool. |
| 5. Broad mission/session bridge                 | Kept as an execution policy boundary, not treated as a reason for a wholesale session rewrite. See the concrete decision below. The accidental HTTP boot wiring is removed by finding 2.                                                                                                                                                                                                                                                                    |
| 6. Insights policy in generic journal           | Completed. `insights-journal.ts` owns replacement/transition selection and legacy policy. The journal owns serialization and reservation lifetime. The independent kernel review tightened the initialized reader seam; its observations expose exact original serialization without exporting the private stored-record type or cloning the journal.                                                                                                       |
| 7. Pure callers load disk implementation        | Completed for runtime edges. Patch validation lives in `tracked-item-patch.ts`; Slack polling policy lives in `slack-poll-policy.ts`. Callers import those owners directly, with no validator forwarding export. Storage query/record types remain with their storage owner where imports are type-only; moving them would not remove runtime loading and does not justify a duplicate domain model.                                                        |
| 8. Retired quota plumbing                       | Completed for the obsolete read RPC and classification arguments. `reserveSlackRead`, its worker dispatch, dependency requirement and no-op assertions are gone. Classification no longer takes ignored time/force parameters. Legacy budget rows and disabled-policy diagnostic fields remain unchanged for compatibility. Provider retry delays, crash-safe classification admission and bounded refreshes remain.                                        |
| 9. Native capability owned by GitHub            | Completed. `native-app-capability.ts` owns token publication/authentication; transport consumes explicit native authority separately from GitHub setup. `setup-error.ts` owns the unchanged error class, avoiding an SDK/PTY dependency through setup. Native-only fixtures no longer pretend to implement GitHub setup. Historical filename/header, status strings and class identity are preserved.                                                       |
| 10. Source scans/private cache assertions       | Completed by audit-native. The two recursive source scans and private statement-map assertion are removed. Behavioral negative controls and statement preparation-count measurement remain. All 57 focused tests and Biome passed; its native domain log records the evidence.                                                                                                                                                                              |
| 11. Rust source parsing in intake tests         | Daemon side completed. Router cases now state their request paths/header explicitly and execute the real router. No Rust declaration spelling, method ordering or header regex is read. Native request execution tests are coordinated with audit-day, not implemented by this daemon agent.                                                                                                                                                                |
| 12. Fixture contract drift                      | Completed for reproduced failures. `testing/session-observers.ts` shares multi-subscriber, planning-bridge, reload and review observer behavior. The dashboard fixture now supplies the real planning observer contract; Inbox supplies the reload observer through the same helper. No production fallback was added. The old count of 15 missing Insights fixtures remains historical evidence, not a claim about this run.                               |

### Execution ports kept deliberately

`SessionMissionBridge` is broad, but its concrete callers make execution-time decisions: final spawn
admission and rollback, current membership/context, exact upgrade resume generations, ownership scope,
durable tool-result barriers and PR ownership. Replacing those callbacks with generic change events
would lose synchronous or post-await authorization. Splitting their TypeScript interface into several
objects without moving their owners would add wiring while leaving the same runtime knowledge.

The four Insights store setters installed during MissionService construction bind canonical durable
records used by session admission. Moving those setter calls into another helper while preserving the
same owners would only relocate the hidden link. A real change needs a separately reviewed execution
ownership design. This pass keeps that policy boundary and its safety tests rather than adding a facade
or spreading authorization through event listeners. It is a rejected interface-only rewrite, not a
claim that the large SessionManager has been fully redesigned.

### Composition ordering and ownership

`createDaemonServices` keeps the previous boot order: diagnostic/process bridges, runtime resource
assembly, synchronous maintenance freeze/load, durable operation journal and domain services, then the
existing planning reconciliation/migration startup. The transport is attached after composition.
Production still awaits runtime readiness before connectivity, power, schedule and session restoration,
then resumes eligible runtime work. During shutdown, composed service cleanup joins concurrently with
session and terminal shutdown, rather than waiting ahead of the worker shutdown it may need.
No new feature producer, approval prerequisite or recovery retry
was enabled. Configuration is not dead data: composition reads storage/config paths and settings flags;
transport reads route policy and storage settings.

The new composition is a construction owner returning actual services, not a forwarding facade for
their methods. `testing/daemon-server.ts` is fixture setup only. There is no alternate production
constructor or positional compatibility shim.

### Stale expectations corrected without production changes

- Intake reads with retained Linear rows report an idle source while withholding rows from a removed
  configuration. The test now checks exact Slack/Linear states instead of asserting every source is
  not configured. The parent reproduced the old assertion failure in the pristine snapshot.
- Project settings tests now verify that real writes advance `workflowGeneration`, including clearing
  a model. The rest of the stored response and cold reopen remain exact comparisons.
- The passive schedule test allows the scheduler's initial membership inspection before the GET phase,
  then forbids validation/effects throughout the GET phase. Its timer, state and revision assertions remain.
- The map-source fixture fills beyond the actual linked-Knowledge summary policy. The test checks an
  incomplete summary and continued access to the exact cited entry, not an obsolete literal count of 40.

## Focused verification after implementation

Workspace `pnpm typecheck` passed after composition, independent service options, capability/error
ownership and lifecycle changes. Changed daemon files were formatted. Biome reports existing warnings
and private-test-access suggestions; no suppression or blanket unsafe rewrite was added.

Selected passing runs, with overlapping tests not summed:

| Files or behavior                                                                             | Passing tests |
| --------------------------------------------------------------------------------------------- | ------------: |
| Server, live update, lifecycle, independent services and intake router after composition      |            40 |
| GitHub setup, model controls, dashboards and subscription usage after composition             |            28 |
| Replacement and native transition integration after composition                               |            52 |
| Session model/subscription and Slack waiting/start/Linear start                               |            66 |
| Journal/workspace guard extraction before composition, including unpublished reservation race |            26 |
| Intake/dashboards/Knowledge before composition                                                |            32 |
| Corrected Inbox, map-source, passive schedule and project model expectations                  |             5 |
| Final lifecycle and mission continuation                                                      |             3 |
| Retained-review and usage-history cleanup, verified by audit-native                           |            57 |
| Real headless daemon and isolated daemon handoff/restart after composition                    |             2 |

`session-services.test.ts` exercises both default services and explicit offline services with the same
injected worker. It mocks subscription startup and database refresh to prevent account/config access,
then checks the emitted worker capability and service lifecycle. `server-lifecycle.test.ts` checks
close/recreate against the same owners and idempotent mission observer cleanup.

The parent's original long run overlapped source migrations and is not a valid final gate. The parent
owns the clean full run and any remaining baseline/environment failures. No full-green claim is made here.

## Small before/after fanout probe

`packages/daemon/src/server-events.bench.ts` runs the same code against a chosen checkout. It uses 5,000
synthetic session summaries, 10,000 changes, two real control sockets and 20,000 observed deliveries.
It yields every 100 events and reports CPU, wall time, a five-millisecond heartbeat and whole-process RSS.
It uses no model/provider, user account or native GUI. Only this comparison probe supports the old server
signature; production does not.

Three alternating runs on macOS arm64, Node 26.13.1, compared the parent's pristine snapshot with the
completed composition. Every sample delivered all 20,000 messages. Medians:

| Metric                |     Before |      After |
| --------------------- | ---------: | ---------: |
| Wall time             |  129.06 ms |  129.48 ms |
| CPU                   |  179.38 ms |  181.18 ms |
| Largest heartbeat gap |    7.96 ms |    7.61 ms |
| Whole-process RSS     | 204.85 MiB | 208.38 MiB |

This is no meaningful timing change or demonstrated speedup. The RSS increase is reported, not hidden;
separate processes and module initialization make it unsuitable as a steady-state allocation comparison.
The probe does not measure transcript history, cold disk, live provider work or native responsiveness.
Other local verification may add noise. The old snapshot emitted the server close-listener warning;
the new implementation did not.

Reproduce from the current checkout:

```sh
node packages/daemon/src/server-events.bench.ts /path/to/pristine-checkout
node packages/daemon/src/server-events.bench.ts .
```

## Final-review scoped corrections

The final structural review found two remaining concrete links. Both were corrected before restarting
the clean full gate:

- Durable-operation admission and recovery closures moved from `server.ts` to `daemon-services.ts`.
  Constructing/listening on the transport no longer starts domain recovery, with or without live update.
  Production explicitly invokes the service owner's recovery after session restoration. The six callers
  migrated; tests access the actual composed `services`, not a production forwarding method.
- Worker usage-history generation/floors no longer depend on `factories.worker`. The independent
  `workerUsageHistory` option defaults to true without changing capture consent. The shared offline
  fixture explicitly defaults it to false. Spec tests inject a real temporary UsageHistoryStore and prove
  default state delivery, offline omission and an explicit offline override.

Typecheck and 70 focused tests passed after these changes, including planning/recovery, durable-send
tracing, accounting/subscription admission, lifecycle and real daemon restart/handoff. All inherited
`PILOT_*` settings were cleared for the four paired regression batches. The parent owns the complete gate.

## Post-gate cold-reopen fixture cleanup

The full gate reproduced the pre-existing `ENOTEMPTY` failure in
`insights-transition-store.test.ts`, in the cold-reopen case. The isolated test passed, so a temporary
teardown probe checked ownership immediately before the shared root's removal. That probe failed
deterministically: the shared fixture had finished manager cleanup and reached directory removal while
the reopened MissionStore remained open. The test's later `t.after` hook had not run. The original store
was also registered too late in the other cases, even when it happened to close without a visible race.

This was fixture cleanup order, not evidence of a production persistence regression. Node's after hooks
run in registration order. The lower fixture registered root removal before the upper fixture/test
registered its mission-store cleanup. An open SQLite replica could still create/write files during removal.

`testing/session-workspace.ts` now provides a fixture-owned `beforeRemove` registration point. Its owner
first joins every session manager and its startup/save work, then awaits registered dependent cleanup,
then removes the root using the existing removal flags. The transition fixture registers both mission
stores there and explicitly stops/disposes their mission observers before closing storage. No sleeps,
retries, extra force-removal fallback or production changes were added.

All original receipt, old-ID fence, row and byte-preservation assertions remain. The cold-reopen test also
checks that the home exists while the reopened store closes and that shared cleanup removes it afterward.
The temporary boundary probe went red before the ordering fix and green afterward, then was removed.
Five final isolated cold-reopen runs passed. The complete transition-store file and the shared workspace
recovery file passed together, 15 tests with file concurrency two. Typecheck and Biome passed.
