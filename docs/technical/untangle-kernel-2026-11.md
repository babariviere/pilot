# Kernel and shared-package cleanup decisions, November 2026

Status: selected changes implemented and focused checks run. The initial audit and this decision log
preceded production/test edits. The parent owns the full Node baseline and whole-repository coordination.

Scope: `packages/kernel`, `packages/protocol`, `packages/artifacts`, `packages/telemetry`, and their
cross-owner consumers. The earlier [kernel](untangle-kernel.md) and [artifact](untangle-artifacts.md)
cleanup decisions remain in force. This pass does not repeat their completed changes.

## Selected changes

### 1. Align artifact metadata and remove repeated processing

- `packages/kernel/src/artifact-tools.ts:192-196` advertises a fixed current NSH runtime and required
  `rendering`, while `packages/protocol/src/index.ts:893-901` permits historical runtime provenance
  and optional historical `rendering`. Actual reads copy saved metadata at `artifact-tools.ts:238`.
  Make the output schema match that contract. Do not rewrite stored metadata or add rendering authority.
- Add portable output-schema checks for both fresh and historical NSH reads using the existing injected
  capture seam. The native-host test checks omission of rendering but does not check schema conformity.
- `packages/artifacts/src/store.ts:137-139,167` parses a captured container, then
  `stored-revision.ts:108-112` parses it again for visual validation. Check visual fields over the
  already parsed result. Keep public bytes-based parser exports and result shapes.
- `packages/artifacts/src/render.ts:40,75` derives NSH metadata twice. Carry the first derivation through
  private validation/preparation state, as publication already does for serialized visual data.

Keep exact bytes, validation order, cancellation, identity checks, no-follow reads, committed revision
ceilings and passive historical reads. Capture and store are separate trust seams: do not trust a
caller-supplied hash or introduce a validation-bypass flag. Test behavior, not private call counts.

### 2. Give canonical serialization a neutral owner

`packages/kernel/src/interview-round.ts:4` imports generic key-sorting serialization from
`planning-worker.ts:80-86`. Standalone interview digests should not depend on planning worker ownership.
Move the unchanged algorithm into a dependency-light module and import its real owner from planning
and interview code. Coordinate with the daemon audit: its interview contract also uses serialization
from its operation journal. Do not introduce a kernel-to-daemon dependency or a runtime utility in
the nominally types-only protocol package.

Preserve exact JSON behavior, key order, hashes and persisted hold strings. Add fixed vectors for
nested object ordering and array order, and retain restart, stale-answer and planning-hold coverage.

### 3. Define telemetry closed catalogs once

`packages/telemetry/src/index.ts:41-159,230-313` repeats finite values in public unions and runtime
sets. Define readonly literal catalogs and derive types and membership sets. Keep the direct
attribute validator and explicit accounting-pair checks; do not add an extensible schema framework.

Preserve whole-observation rejection, zero-valued amounts, consent, revocation, queue/batch limits,
environment isolation, observer isolation and the distinction between liveness and useful progress.
The earlier pairing-condition cleanup is already complete and is not selected again.

### 4. Centralize SDK bundle compatibility, not its checks

The real compiled MCP writer is imported by hash-named SDK chunk in:

- `packages/daemon/src/mcp-setup.test.ts:97`.
- `apps/macos/scripts/check-runtime.sh:37`.
- `scripts/linux/check-runtime.mjs:33`.

Put this version-specific knowledge in one private compatibility adapter under kernel, which owns
the native SDK integration. The daemon test and both packaged-runtime smoke checks must use that
adapter while still calling the actual SDK writer. Retain coverage of both the extension writer and
the published CLI's compiled writer. Keep lossless numeric literals, foreign fields and bidirectional
Pilot/SDK editing interoperability. Do not replace these checks with a copied writer, mock, text-only
assertion, swallowed import failure or a search that silently selects an arbitrary chunk.

`packages/kernel/src/dependency-pins.test.ts:8-13` pins a different SDK chunk for the patched Undici
dispatcher. Keep that guard until functional dispatcher/proxy coverage replaces it. Centralizing
compatibility ownership does not establish that deleting this check is safe.

### 5. Repair package-interface and benchmark ownership

- Use the protocol package interface instead of relative source imports in `snapshot.ts:22`,
  `planning-worker.ts:3`, `mission-plan-tool.ts:4` and `funding-runtime.ts:13`. Mission thread and
  revision types are already exported; expose funding types through the intended interface first.
- `packages/kernel/bench/paged-history.ts:10` really imports daemon `ChatStreams`. Move the whole
  cross-owner benchmark to `scripts/bench/` and update invocation references. Do not duplicate
  `ChatStreams` or declare a production kernel dependency on daemon.
- The server imports in `packages/kernel/src/exploration.test.ts:24,26` are fixture-source strings,
  not package dependencies. Keep these cross-package source-analysis cases.

Production direction remains kernel to artifacts/protocol/telemetry, and artifacts to protocol.
No production kernel-to-daemon/server inversion was found in the inspected source.

## Additional findings and deferred decisions

- Protocol's large root barrel also owns declarations that feature modules import back. Move coherent
  groups to defining modules when touched, preserving root exports. Do not split everything first.
- `protocol/src/feature-events.ts:47-123` is a real runtime privacy parser with one daemon consumer.
  The parent selected moving the unchanged parser and its behavior tests into daemon `feature-events`.
  Keep wire types and the catalog in protocol, and update only the consumer import in `feature-usage.ts`.
- Remove unused `FEATURE_EVENT_PROCESS_LIMIT` from this private package. It has no repository consumer
  and is not the source of a producer's enforced cap. Leave native producer behavior and the documented
  remote cap unchanged; neither is the telemetry span queue cap. The move preserves privacy rejection.
- `kernel/src/todo-bridge.ts:16-76` also carries subscription and usage capabilities. The parent selected
  renaming it to `parent-bridge.ts` / `startParentBridge` and migrating the five internal importers,
  with no forwarding alias. Keep historical environment/route/error strings and drain order exact.
  Remove its repeated usage-body check only with direct byte-boundary coverage of the read loop.
- `mission-planning-skills.ts:8-18` carries detailed prototype procedures on every prompt. Move
  operation-specific detail into a trusted reference only after reviewing instruction behavior.
  Keep authority and human-answer provenance restrictions. Remove incidental wording assertions,
  not actual direct/nested denial tests, import restrictions, license checks or readable references.
- Remove or relocate the orphan array-identity comment at `native-adapter.ts:470`. Correct the stale
  configuration comment at `telemetry/src/index.ts:828` and the write/read compatibility explanation
  at `artifact-tools.ts:72`. Keep comments explaining durability, privacy and external constraints.

## Verification plan and completion criteria

Run affected artifact parser/store/render/tool, interview/planning and telemetry tests with temporary
state and faux providers. Run daemon MCP interoperability tests and both applicable packaged-runtime
smoke checks after the compatibility move. Run typechecking and formatting. Coordinate with the parent
baseline rather than starting a competing full suite. Record actual results after implementation.

For removed repeated artifact hydration, measure large synthetic containers before claiming a speedup.
No end-to-end performance qualification, production runtime qualification, live-account test, migration or native
visual acceptance is claimed by this audit. Completion requires unchanged persisted/wire behavior,
retained safety and interoperability coverage, and explicit reporting of unavailable smoke checks.

## Implementation decisions and results

- Added private `canonical-json.ts` and moved internal planning/interview consumers to it. Removed
  the unused `planningJSON` alias after independent review confirmed no public export or consumers.
  The daemon journal uses `localeCompare`,
  while kernel uses code-unit ordering. These differ, so they deliberately remain separate.
- Added `sdk-mcp-editors.ts` as the single explicit compiled-chunk owner. The daemon interoperability
  test and both runtime smoke scripts import it; neither real SDK writer was replaced or skipped.
  The adapter stays outside the kernel public export map. The Undici pin guard is unchanged.
- Moved the cross-owner paged-history benchmark to `scripts/bench/paged-history.ts`. Removed the
  old forwarding entry after the parent's review: no concrete external consumer requires it. Updated
  its sole documented invocation, without changing GPUI implementation or reviewing that app.
  Added funding type exports and replaced the four protocol source imports.
- Removed the orphan native-adapter comment and corrected the two stale comments identified above.
  Kept prompt text, incidental wording tests and feature-cap policy unchanged. Follow-up parent
  decisions moved the feature parser and renamed the parent bridge, as recorded below.
- Added portable NSH read-schema coverage for fresh and historical metadata. It checks the read
  branch specifically: the compact publication-reference branch permits extra artifact fields and
  would otherwise hide the mismatch. Added exact NSH preparation and canonical digest vectors.

Focused Node checks passed for artifact tools, canonical JSON, render/lifecycle, stored and captured
revisions, store, NSH provenance, interview state, planning holds, cold-reader imports, funding,
telemetry and daemon MCP interoperability. Commands used `node --test --test-force-exit`, two files
at a time, temporary state and inherited `PILOT_*` variables removed. The existing real native-host
artifact test remains skipped without its explicit wrapper. No native compiler was run.

An initial store/captured run stalled after several passing cases and hit the command deadline.
The cause is unverified. The isolated rerun passed all 19 tests in 1.71 seconds; no test or production
timeout was relaxed. Full typecheck initially reported only two implicit-any listener parameters in
daemon `server.test.ts`. A later check, after those changed, reported only a missing `authenticate`
fixture dependency in daemon `server-live-update.test.ts:116`. These are outside this owner and are
being handled by the parent/daemon owner. No shared-package type errors remain.
Shell/JavaScript syntax checks passed for the two changed runtime smoke scripts. Their complete
packaged-runtime checks were not run here because no runtime was assembled and native compilation
belongs to the native agent's lane.

### Before/after measurements

Compared the pristine parent snapshot `pilot-untangle-baseline-jf4xe981` with this checkout using
the same installed dependencies, Node 26.13.1, macOS arm64. One process alternated baseline/changed
order for seven measured pairs after one warmup pair. Deep equality checked reader, prepared metadata
and telemetry outputs before measurement. Each task ran sequentially; the entire probe took 1.3 s.

| Task per sample                                      | Baseline median wall/CPU ms | Changed median wall/CPU ms |
| ---------------------------------------------------- | --------------------------- | -------------------------- |
| 20 passive reads, 890,235-byte visual container      | 30.94 / 31.56               | 18.39 / 18.89              |
| 30 NSH preparations, 524,269-byte source             | 21.95 / 21.94               | 10.90 / 10.90              |
| 6,000 telemetry validations, maximum 24 valid fields | 19.06 / 19.05               | 19.10 / 19.13              |

The container had 240,002 source bytes and a 650,000-character JSON data string. NSH source used a
large Unicode comment plus an inert component export. Preparation measured metadata only, not native
compilation. Telemetry exercised token/accounting numeric fields plus closed operation/scope/status.
The catalog change kept the same runtime membership/validation algorithm; its tiny difference is noise.

These are warm synthetic measurements, not end-to-end daemon, streaming or GUI acceptance. They do
not establish cold-disk latency, native compilation cost, memory savings or fleet performance. CPU
samples include process-wide background/GC work. Baseline/changed wall-time ranges were 30.07-31.03 /
17.47-20.52 ms for reads, 19.60-23.09 / 10.31-11.86 ms for preparation, and 18.78-19.63 /
18.67-19.44 ms for telemetry. Ranges and alternating order reduce but
do not eliminate noise. The temporary probe and full samples are in
`/var/folders/yf/m1vtzvk12njd5zfr290g2qp00000gn/T/pilot-kernel-measure.yXU2uF/` for this session.

### Follow-up owner fixes

Moved the feature event parser and its three behavior tests from protocol into daemon
`feature-events.ts` / `feature-events.test.ts`. Its one production consumer now imports that owner.
The parser body is unchanged; protocol keeps only the shared event types and catalog constants.
Removed the unused private-package process-limit constant, without changing native producers or
the documented remote cap. All nine parser/local-aggregate tests passed. Biome passed the new owner
and moved test; the consumer has a pre-existing assignment-expression lint error outside the import
change. The parent owns the final shared typecheck gate as other daemon fixtures are changing.

Renamed `todo-bridge.ts` to `parent-bridge.ts` and `startTodoBridge` to `startParentBridge`, including
all five internal importers and the session's local ownership fields. No forwarding alias remains.
Historical environment, route and error strings are unchanged. Removed the redundant usage-body
check after adding a transport test proving 4096 UTF-8 bytes reach the callback and 4098 bytes do not.
The read-loop limit remains authoritative. Parent bridge/todo tests passed all six cases, including
concurrent child writes, unavailable-parent refusal and drain-before-close behavior.

All five subscription-limit cases passed, including the child-to-parent persistence call. The bundled
extension integration file passed eight cases and failed 16 jobs-related cases because `jobs` was
absent from discovery. The same clean-configuration `jobs` failure reproduced in the pristine parent
snapshot in this agent's earlier targeted run. This is not a reliable clean-baseline classification:
the parent's later isolated full-file pristine run passed with inherited `PILOT_*` settings cleared
(`job6a752555`). The discrepancy appears environment-dependent; its exact cause is unverified.
The real Build child-profile/auth/safeguards case passed after the rename. Do not treat the earlier
jobs failures as expected final failures. The parent's final full gate also clears inherited
`PILOT_*` settings and determines final status. Latest full typecheck passes. No commit or push was
made by this agent.

## Independent source review of daemon journal extraction

Reviewed `insights-journal.ts`, the `operation-journal.ts` extraction diff and all migrated production
guard callers. No reservation/guard semantic regression found. Reservations still enter synchronously
before queued filesystem work and decrement in `finally` on success, rejection or queue refusal.
Per-kind counts preserve the old legacy predicate, excluding `insights-workspace-*`, including
concurrent reservations of the same kind. Initial reads still use the journal serialization queue;
returned guards inspect live state synchronously rather than a stale snapshot. Transition digest
comparison, rejected-receipt exclusions, retained pending-intent fences, replacement qualification
and all owner transaction rechecks remain. No daemon edits or overlapping tests were made for this
cross-review. Existing late-reservation tests remain important evidence for the parent's full gate.

The initial extraction's iterable exposed journal-owned records to trusted internal readers, which
only inspect them synchronously. No clone/freeze framework is warranted by these callers. The parent
then identified the structural seam correction below. Prompt restructuring and whole-barrel
reorganization stay outside this behavior-preserving pass.

### Authorized journal seam correction

The parent identified a worthwhile structural follow-up to that review: public synchronous raw-state
access relied on a discarded asynchronous read for initialization. Acquire an initialized synchronous
reader with `openReader` instead. Keep raw stored-record types and state access private. Trusted
readers receive operation/receipt views and `original()`, which serializes the actual stored record
with unchanged `JSON.stringify(record)` semantics, including unknown-outcome markers and key order.
Each reader invocation observes current reservations and faults; no clone/freeze framework or detached
snapshot is introduced. Preserve serialized passive reads and all existing Insights policy checks.
Add cold-open, late-reservation and exact-original behavior coverage before the final gate.

Implemented `openReader(project)` as asynchronous initialized acquisition returning a synchronous
projection. `readState` and `StoredOperation` are private. Lightweight iteration views expose only
operation, receipt and `original()`; the latter calls `JSON.stringify` on the actual stored record,
not the view. Insights transition capture and transferred guards use that journal-owned serialization.
The existing passive `readRecords` keeps its serialized read semantics and uses the same views.

Passed 28 journal/workspace tests, including the existing late filesystem-publication race, plus
24 transition store/integration tests covering exact archives, Stop races, lost ACKs, cold reopen,
reservation dedupe and no effect replay. New public-interface tests verify cold acquisition loads
persisted unknown-outcome originals without a prior lookup, an acquired reader sees reservations
before the next await, and later disk persistence faults remain visible. Typecheck and Biome pass.

A short synthetic comparison with the pristine snapshot used 1,024 saved records (1,023 unrelated,
one qualifying Insights record), 200 warm replacement-reference reads per sample, seven alternating
measured pairs after one warmup pair, Node 26.13.1/macOS arm64. Results were equal. Median wall/CPU
time increased from 2.60/2.60 ms to 6.14/6.25 ms per 200 reads. Wall ranges were 2.57-3.87 ms before
and 6.07-6.29 ms after. The lightweight view iterator adds about 0.018 ms per 1,024-record read in
this probe; this is a real microbenchmark cost, not a speedup. This low-frequency migration/read seam
does not clone payloads or freeze records. The probe completed in 0.4 s and does not qualify end-to-end
daemon/streaming responsiveness, disk writes or memory. No further code edits are planned here.
