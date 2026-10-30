# Reliability roadmap

Updated 2026-10-30. This plan is not release or deployment proof. Baseline source spot-checks use repository snapshot `9b632623b07546d5b25d8d502bacc45d53dbdcdf`; research reads were non-atomic. Later deliveries are identified separately and are not claimed as part of that snapshot. See the [testing strategy](testing-strategy.md) and [documentation plans](documentation-plan.md).

## Ownership and authority

Rust/GPUI owns interaction state, rendering and private drafts. `apps/desktop/src/local_client.rs` owns read transport and projections; `interaction.rs` serializes mutations and owns the private Store. The daemon's loopback HTTP services own admission, session/mission state and `packages/daemon/src/operation-journal.ts`; `packages/kernel` owns execution and canonical history. Worker IPC carries commands and events; control and selected-chat WebSockets carry snapshots/deltas, not mutation receipts. A displayed row, GET, event or tracing span is not proof of durable acceptance, completion or authority.

The reader has bounded queues and coalesces projections; feature readers own cancellation and close. Courier Close has a separate lane, not a priority Stop guarantee. Stop shares pending ownership and is once-only, without equivalent receipt recovery. Cancelling HTTP after admission is Unknown, not rejection. A later Send racing an overtaking Stop needs an explicit daemon admission/withdrawal and recovery contract first. Authority-sensitive coordinator reads require durable same-mission/project membership and rechecks; UI freshness never grants authority. Ordinary loopback REST is not general hostile-local-process authentication.

`OperationJournal` validates identity, envelope, destination, lineage and sequence floors, persists pending before execution and final receipt before publication. Only typed rejection rejects; generic failures retain pending. Exact receipt lookup observes rather than replays. Mission writes and authority reads retain their real durability barriers. Capturing a same-replica commit-sequence obligation at a domain commit is a possible future design, not an implemented general replacement.

## Delivered bounded fixes

| Slice | Evidence and limits |
| --- | --- |
| Receipt isolation (#20) | Landed `aee8a784b523542dc5cdf49cb8f8ea1ac0ebc223`. Normalized receipt lookup avoids unrelated mission reply waits while retaining journal obligations. Builder reported 14 focused journal/HTTP tests using sibling dependencies and a temporary resolver; standard dependencies and typecheck blocked. Not standard-suite or CI success. |
| Ordinary Send owner/effect (#21) | Landed `513dd06dc373e3d5b5552d38d130a8edfa1f44b3`. Coordinator inspected the diff; builder reported 53 interaction and 39 store tests passing, with 1 and 2 pre-existing ignored, scoped Clippy and formatting. Held-response negative control failed old behavior; restored source recompiled with correct census. No native GUI, full-suite or deployment proof. Other adapters remain serialized except as subsequently changed. |
| Durable Send tracing (#23) | Landed `08c86aa5ccf76384119bd979a70ca2eddee5d9a3` after separate user authorization. Coordinator accepted the backend source narrowly: a validated attempt parent reaches real SessionManager admission/startup spans, separate from immutable bytes, not a real kernel/native journey. Builder reported 12 focused Node tests using sibling dependencies with the same lockfile and a baseline-negative control; typecheck blocked, standard suite and CI unproven. Attached variant used an empty attachment list; recovery used a fresh journal and direct handler, not full server boot. Staged image, full restart and desktop attempt creation remain unverified. |
| Receipt/answer owner seam (#22) | Landed `d62af634f021801acb725776ed4f94e7ea0c3168` on exact parent `9b632623b07546d5b25d8d502bacc45d53dbdcdf`; coordinator reviewed source and accepted completion. Builder reported normal fast-forward/readback with checked bytes unchanged. It generalizes SendOwner into an extracted DeliveryOwner, net production +30 lines, without Store/schema/daemon changes. Builder reports 13 recovery regressions, 66 interaction passes/1 pre-existing ignored, 40 store passes/2 pre-existing ignored and 51 overlapping question-filter passes, not 157 distinct tests. Clippy, rustfmt and whitespace passed. One held-lookup autosave test failed the original twice; restored final source was recompiled with the correct 67-test interaction census. Stop, subagent, model, project and mission adapters remain serialized. Question preflight retains stale-capture refusal; no atomic daemon question-CAS exists. No native, full-suite, CI or deployment qualification. |
| Atomic session-list adoption (#24) | Landed `1547378304284ad8d5fa25a6edebc16abb51b32d` on exact parent `ce7df78e` after coordinator source review of candidate `53ec4e6f` and acceptance of completion; builder reports the reviewed diff remained byte-identical after rebase across an unrelated rendering change. Final offline checks: 42 scoped client tests, including five new faux-WS regressions (0 ignored, 1039 filtered), 46 model tests (0 ignored, 1035 filtered), production Clippy, pinned rustfmt and whitespace passed. A faux-WS negative control failed old `9b632623` at retained-row equality; restored production recompiled with matching census. Builder reported normal fast-forward and matching remote readback. No native, full-suite, CI or deployment proof, nor selected-chat scroll pixel proof. The inspected baseline marked lists fresh then filtered/defaulted invalid content; no production incident or durable deletion established. |

The #20/#21/#23 hashes are ancestors of the inspected baseline; #22 and #24 landed afterward. None proves current runtime, native behavior or exact-head CI. CI triage is deferred.

### Subsequent targeted redesign slices

These later deliveries do not relabel the original closeout or historical inventory. Checks below are the builders' reported focused evidence, not independent re-execution by the documentation maintainer.

| Slice | Actual boundary, source/tests and remaining limits |
| --- | --- |
| Catalog ownership (#26, delivered) | `apps/desktop/src/interaction.rs` routes only `WriteCommand::Project { path: None }` through the existing Store-free `DeliveryOwner.effect` seam in `interaction_delivery.rs`. `interaction_catalog_tests.rs` holds faux HTTP while same/other draft edits persist, preserving FIFO, Close, catalog results/errors and disk-fault fencing. Builder reported 68 interaction passes/1 pre-existing ignored, including three catalog tests; production Clippy and changed-file formatting passed. Old-source held-read control failed; restored bytes/rebuild/census checked. Registration and other mutation adapters remain serialized and unqualified; no native/full-suite/CI/deployment evidence. |
| Typed reader state (#27, delivered) | `apps/desktop/src/local_client.rs` produces typed `SocketEvent` and derives output from `ReaderState`, keeping control/chat lifetimes and full-list adoption separate. `session_list_reader_tests.rs` covers actual faux WS baseline/retention, duplicate/cold/valid-empty/recovery, hello/disconnect, display-only wording and fatal identity fencing; the projection-poisoning control is in `local_client.rs`. Builder reported 48 client and 46 model passes, 0 ignored, production Clippy and changed-file formatting. Old producer-label-only controls failed; restored bytes/rebuild/census checked. Legacy hello fatal/retry substring classification remains unchanged, not fully typed. No native/full-suite/CI/deployment evidence. |

Current desktop ownership follow-up: Stop, model/thinking selection/inspection,
subscription Force/Continue, child sends and chat conversion now use the existing
Store-free effect seam. [Project registration](../../apps/desktop/docs/project-registration-autosave.md)
also moves its preflight, one-shot POST and post-registration catalogue waits onto
that seam. Catalogue-only Project was already fixed and is unchanged. The new
seeded held-HTTP regression failed original ownership while awaiting durable text;
focused writer/native checks cover its bounded boundary, not a new receipt or
idempotency guarantee. This reconciles the known `Interaction::run` HTTP/Store
adapters, without relabelling the historical evidence above. Commands remain FIFO,
not priority Stop. Project default-model PATCH remains blocked on its unsafe
mutation contract; broader app ownership, lifecycle, OS input, live latency and
deployment acceptance remain unqualified.

### Schedule shutdown boundary (#28)

The daemon remains the process-local owner. `packages/daemon/src/daemon.ts` wires `schedule-shutdown.ts` around one terminal store close, not a generic supervisor. The preserved dependency order is:

| Owner/resource | Cancellation and awaited boundary |
| --- | --- |
| Daemon admission | `sessions.beginClosing()`, watchdog stop and `server.close()` still precede shutdown. `server.close()` is not awaited. |
| Schedule dispatcher | `ScheduleService.stop()` closes its admission, cancels its timer/subscriptions, disables schedule detection and awaits the dispatch tail, including its final store writes. Failure prevents store close and the remaining tail. |
| Connectivity and system events | Connectivity clears timers/watcher/subscription, disables agent detection and awaits its write tail; system-event stop then releases its helper/generation. These prerequisites remain fail-fast. This is not a new proof of helper/probe process drainage. |
| Schedule SQLite worker | `ScheduleStore.close()` awaits its close RPC and, in `finally`, marks closed and awaits worker termination. Only this terminal close failure is deferred until the existing independent tail completes. |
| Remaining daemon resources | Existing order is unchanged: stop memory-project notifications; MCP/mission Linear/tracking/triage; memory/notices/compaction; import children/writes; setup/GitHub setup/terminals/sessions; feature usage/credentials; completion writes/tracked store; power/stats/environment/telemetry; mission store. Their own producer-before-store awaits remain authoritative. |
| Final result | One failure is rethrown unchanged, including falsy values. Store-close plus later-tail failures produce an ordered `AggregateError`. Success-only `process.exit(0)` remains after the bracket. A later tail failure still stops its dependent cleanup; this is not all-cleanup-error tolerance. |

Controlled offline evidence in `schedule-shutdown.test.ts`: a healthy actual worker receives an intentionally invalid close request at the IPC boundary, returns an actual RPC error, then exits before the held independent tail starts. This is injected protocol failure, not a demonstrated spontaneous `db.close()` failure. A separate runtime-worker termination and invalid-path bootstrap case exercise different failures. The test also drains an isolated actual Node child to confirmed exit, holds a real dispatcher before its final write and reopens SQLite afterward, fences each failed prerequisite, and preserves single/combined arbitrary errors. Faithful old sequential close/then-tail ordering fails the omitted-tail assertion; restored source and complete focused census pass. None is a reproduced production daemon crash, native terminal/kernel teardown or deployment qualification.

Existing limitation: already-entered async schedule create/update validations are not included in the dispatch tail, and HTTP close is not awaited. This slice neither repairs nor certifies complete HTTP/admission drainage. Broader startup/rollback, contention, remaining closer failures and updater ownership are still unqualified.

## Historical static inventory, not traffic

Accepted synthesis artifact `83d1bf79-be56-4bd2-868d-dc13f5afd130` revision 1, dated 2026-10-30, reconciles historical client/server source inventories. Its reads were non-atomic and not commit-pinned; these figures and all formulas below are not a re-census of the publication head. The scoped inventory identified 53 normalized core HTTP method/path pairs (25 GET, 20 POST, 2 PUT, 5 PATCH, 1 DELETE), 57 production builder sites and two WebSocket upgrades. Including local updater paths gives 56 unique HTTP pairs and 62 builders; a separate remote updater uses two logical endpoint templates and variable redirects. Kernel unions contained 47 daemon-to-worker and 42 worker-to-daemon discriminants, not invocation counts. This was not an exhaustive server/dynamic-caller inventory or measurement of availability, latency or traffic.

Successful-path formulas, not observed counts: local launch 2 HTTP + 1 WS upgrade; packaged macOS launch 3 + 1; open another loaded chat 1 + 1; history 3P HTTP for P completed pages; existing-chat fresh unknown-then-execute Send 7 HTTP; create and first message 6; Stop 3; Check 2; explicit unknown Retry 5 existing / 4 create. Existing model picker miss/hit 4/3; settings model-scope read 2 and save/readback 4. Mission catalog 2, detail 3, list then detail 5. Reconnect uses C hello requests + C upgrades for C in {1,2}, plus variable snapshots/replay. Restored selection, failed attempts, backoff, cancellation and release checks change totals.

Healthy core-reader idle has no periodic application HTTP; C control/selected-chat sockets send approximately 2C client Ping frames/minute after the immediate first tick. Server pushes, Pong/Close, records and background/provider work vary. Initial control push has three unconditional frames and up to five conditional frames; mission bursts coalesce list/detail work then fan out per subscriber. Count connections, frames, snapshots, HTTP calls, retries, debounce, internal fan-out and worker IPC separately. Runtime denominators, cancellation waste, retained memory and production impact are unknown.

## Nine-indicator ledger

Established means source evidence, not a quantified incident. Medium confidence is static, non-atomic evidence; low means hypothesis or unestablished harm.

| Indicator | Evidence and consequence | Smaller alternative and protection |
| --- | --- | --- |
| Implicit coupling | Historical medium-confidence finding: `local_client.rs` compared display connection text while changing freshness; #20 narrowed receipt coupling. #27 subsequently removed that presentation dependency with typed producer/read state. | Preserve #27's actual-reader/projection controls and real mission barriers; legacy hello substring classification is separate and unchanged. |
| Layer-first folders | Low: harmful change locality not established from layout. | No folder migration; map one real change first. |
| Duplication | Medium: mission/activity/tasks/changes readers own similar mailbox, cancellation and lifetime code. Redundant artifact application is unproven. | Compare contracts before a latest-read primitive; test cancellation and teardown. |
| Illegal states | Medium: `delivery_store.rs` validates combinations representable in stored intent fields; IPC result/error optionals allow both/neither. | Internal variants plus boundary validation and compatibility tests, not a wire rewrite. |
| God owners | Medium: `LocalViewer` coordinates navigation, forms and blockers; `server.ts` joins admission and response durability. Size alone is not proof. | Extract one coherent transition or durability owner with contract tests. |
| Shotgun surgery | Low: forms cross several legitimate owners; avoidable excess not established. | Checklist and integration test before abstraction. |
| Layering violation | Low: harmful inversion not established. `LiveTranscript::rows()` has projection side effects worth testing. | Compare identical streams with matching projection boundaries. |
| Pass-through wrappers | Low: identity and worker wrappers carry validation and lifecycle obligations. | Keep until a specific redundant boundary is proven. |
| Validation/errors away from boundary | High for inspected snapshot behavior: malformed list can appear fresh/empty; generic server error classification merits review. No live data loss proven. | #24 validates full candidate before adoption; test malformed, duplicate, valid empty and recovery through transport. |

## Remaining qualification and deferred work

Severity describes potential user harm, not effort; effort and confidence are estimates. Exact-head relevant integration/native and CI evidence is required before qualification; push is not deployment.

| Priority, severity / effort / confidence | Owner and overlap | Invariant, prerequisite and minimum boundary acceptance |
| --- | --- | --- |
| 1. High / medium / high | Desktop, #22 delivered | Preserve exact intent and newer text through Check, explicit Retry and answer waits. Retain held-response, disk, FIFO, receipt mismatch, pending/no repost and Close controls; qualify the journey on exact-head native/integration boundaries. |
| 2. High / small-medium / high | Desktop, #24 delivered | Invalid list must never replace the last coherent list or assert freshness; valid empty remains valid. Preserve snapshot, metadata, reconnect and incremental controls; retained state cannot grant authority. Qualify native behavior separately. |
| 3. High / medium-unknown / medium | Daemon + desktop; kernel lifecycle owner | Stop is once-only and must reach execution without replay. First specify late Send admission/withdrawal and recovery; inject held Send, Stop, lost ACK and crash across boundaries. |
| 4. High / unknown / low overall | Daemon lifecycle; updater owners | #28 narrows one schedule terminal-close omission with the contract/controls above. Startup, rollback, HTTP drainage, storage contention and other closer failures remain incompletely reviewed. Conditional fail-fast awaits are not a reproduced crash. `KernelSession.close` waits for exit with kill escalation. |
| 5. High / medium / medium | Daemon mission authority; no Control cutover | Preserve real mission-write and membership durability. Narrow unrelated waits only with explicit scoped obligations; test dirty replica, persistence failure, revoked permission and exact receipts. |
| 6. Medium / medium / medium | Desktop history + kernel | Preserve same-stream resume, canonical IDs, selection and history under live paging; test gaps, projection scheduling and native selection. No cache redesign without measurement. |
| 7. Medium / medium / medium | Desktop + Diagnostics owners | Add bounded correlation only for a concrete missing question. Preserve consent, redaction, overflow, retention and no recovery authority; distinguish native capture, backend spans and receipts. |
| 8. Medium / bounded implementation delivered / high for inspected coupling | Desktop connection owners, #27 | Presentation-driven freshness is replaced; preserve separate control/chat, disconnect/generation/stale/identity controls. Native/exact-head integration qualification and legacy hello error typing remain separate work. |

For lifecycle metadata, `sessions.ts` checks IDs/permissions and skips unreadable records without deleting files; full schema validation is not established. Queued metadata writes use temporary file/rename; only the durable path additionally flushes file and ancestor directories. It is not interchangeable with journal durability. Production recurrence and contention remain unknown.

Effect is optional, not a selected migration. First consider an explicitly owned Promise/AbortSignal interface, controlled teardown and typed errors. A bounded Effect pilot must demonstrate simpler lifetime/error composition and equivalent verification; fibers do not make jobs, receipts or state durable.

The original closeout deferred further lifecycle and Control deep dives. Subsequent #26/#27 and the bounded #28 contract above do not complete startup/rollback or the full shutdown dependency analysis, storage contention, Control ownership/facts or the prior documentation handoff. These remain unverified follow-up questions, not completed research or authorization for broader implementation. See [documentation plans](documentation-plan.md) for the preserved handoff blocker.

## Diagnostics and other owners

Use [agent diagnostics](../agent-diagnostics.md), [native diagnostics](../native-diagnostics.md) and [telemetry contracts](../telemetry-contract.md). Trusted persisted diagnostics role and current host/lineage and consent gates constrain read-only self-inspection; `diagnostic_context` performance reads the existing sanitized watchdog, not a new remote courier. Native `next_app` observations are bounded completed JSON transport records, not proof of receipt, lifecycle or frames. Logs should be bounded, correlated, actionable and redacted, with explicit overflow/retention and missing evidence; exclude raw prompts, replies, tools, attachments, paths and credentials. Do not expand exporters or grant repair authority through logs.

Control/Global owns Control facts and development, Automation owns setup, Diagnostics owns its bridge, Review owns its workflows, and Pilot Polish owns visual/interaction/accessibility work. Coordinate rather than duplicate. Updater qualification belongs with updater owners: native full-payload swap, relaunch, daemon survival and guarded cleanup are separate proofs. Current macOS coordination uses live profile/lease/native identity; GUI ACK alone does not authorize cleanup. Linux differs.
