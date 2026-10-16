# Testing and test speed

For packaged SSH workflow coverage, the shared-context/credential fault matrix and manual-only
deployment gaps, see [devbox verification](devbox-verification.md).

Node 24 strips our erasable TypeScript directly. Tests still use `node:test`, isolated processes, and
fresh temporary state. Model tests use faux providers, never user accounts. `tsx` remains available for
runner comparisons and the existing reopen benchmark, but is not needed by the default runner.

## Commands

| Command | Scope |
| --- | --- |
| `pnpm test:fast` | Explicitly selected unit and offline service tests for quick feedback |
| `pnpm test:integration` | Real repository, process, persistence, transport and kernel integration tests |
| `pnpm test:stress` | Large-file diff budgets, fan-out and 10,000-event notice regression tests |
| `pnpm test` | Every group, including runner/helper tests, on the current host |
| `pnpm test -- --lane=portable` | Broad Linux CI gate, excluding native-only integration files |
| `pnpm test -- --lane=macos` | Native-only integration plus explicit Darwin smoke coverage |
| `pnpm test:timings` | Full gate plus the slowest reported test-file execution times |

New tests default to integration unless explicitly admitted to the fast list in `scripts/test-suites.ts`.
`*.stress.test.ts` belongs to stress. No group is silently dropped by the full command.
`pnpm test -- --list` lists the full selection; each group also accepts `--list`. Native Node test flags
can be forwarded, for example `pnpm test:integration -- --test-name-pattern='restore'`.

CI runs the portable lane and typechecking on Ubuntu x86-64. A smaller macOS arm64 lane retains
the real coordinator sandbox, native Ask artifact publication/preview, wake sampling, PTYs, runtime
environment and bundled-extension coverage, plus packaging and relocated production-runtime checks.
Both lanes gate releases alongside Swift tests, the app bundle and the Linux production package.
Production packages are built once in this workflow and promoted to publishing after commit checks.
The separate Linux headless smoke workflow still verifies daemon/kernel execution and the native
dependency ABI, but no longer builds a second production package.

Lane selection is explicit in `scripts/test-suites.ts`: new files default to the portable lane; only
`kernel/ask.integration.test.ts` is currently native-only because it publishes and previews SwiftUI.
OS-sensitive files intentionally run in both lanes. `--lane` intersects `--suite`, supports `--list`,
and never changes plain `pnpm test` into a host-dependent subset. Running the macOS lane on another OS
fails instead of silently losing native coverage (listing it is allowed). Renderer-dependent tests
keep their existing optional-browser and `PILOT_SWIFTUI_TESTS=1` guards.

The default is two test files concurrently, including in CI. `PILOT_TEST_CONCURRENCY=4 pnpm test`
is useful on an otherwise quiet machine with headroom, but more Git/jj and compiler processes can make
individual tests slower. The runner starts known expensive workspace groups early to avoid a long tail.
Reported file durations exclude imports/startup and overlap, so do not sum them as wall time.
The per-test deadline remains two minutes, configurable with `PILOT_TEST_TIMEOUT_MS`. Tests with explicit
timeouts keep their own limits; the runner rejects invalid concurrency or timeout values.

To run just affected files without importing every file in a group:

```sh
node --test --test-force-exit --test-concurrency=2 packages/daemon/src/github.test.ts
```

### Shared heavy-verification slots

Iterate with affected test files. Run the relevant full suites once before publishing, not after each
edit. Use background jobs for long checks, and never bypass the queue or launch duplicate suites while
waiting. `pnpm test` (also `npm test`) and all `test:*` suite commands use the Node pool;
`--list` only lists files and needs no slot. Direct, focused `node --test …` stays lightweight and unqueued.

`apps/macos/scripts/{build,test,bundle}.sh` share the Swift pool, including package preparation and all
build/test subprocesses. Use these wrappers rather than raw `swift build` / `swift test`. Existing
per-command limits (`PILOT_SWIFT_JOBS`, `PILOT_TEST_CONCURRENCY`) still apply inside each slot.

The Python 3 stdlib runner, `scripts/verification-slot.py`, uses local OS file locks under
`$PILOT_HOME/verification` (default `$XDG_DATA_HOME/pilot/verification`, or
`~/.local/share/pilot/verification`). All checkouts using that home share **1 Swift slot and 2 Node
slots**, even outside the app. Set the same absolute `PILOT_HOME` in every session/shell; separate homes
intentionally have separate pools. No daemon, npm package or lock service is required.

To configure the machine-wide capacities, create `$PILOT_HOME/verification/limits.json`:

```json
{"swift": 1, "node": 2}
```

Omitted keys keep their defaults; values must be integers from 1 to 64. Invalid configuration fails
visibly rather than running without a limit. Change limits while checks are idle, since each queued
invocation reads the configuration once. Raising these limits can overload the machine.

Waiting reports each holder's PID, executable, workspace and elapsed holding time immediately, then
every 15 seconds. It waits indefinitely until admitted or explicitly interrupted; a quiet job log is
never a queue timeout. Exit codes/signals and command arguments pass through unchanged. Only the
executable name, not its arguments, is stored in holder metadata.

Locks are inherited across `exec`, and the OS releases them when the holder exits, including SIGKILL.
Stale JSON left by a crash is ignored once the kernel lock is free. Never delete a lock file to clear
a queue: a live process could still hold its old inode. Stop the actual holder instead. Long-lived
children that inherit the descriptor keep the slot until they exit as well. This is a local-filesystem
semaphore, not a distributed lock or strict FIFO scheduler.

### Local measurements

On 2026-10-13, sequential runs on macOS arm64 (Node 24.21.0, pnpm 12.10.1, jj 0.46.0, 11 logical CPUs),
the same installed dependencies, and no competing Swift build produced:

| Selection | File concurrency | Wall time | Passed / skipped |
| --- | --- | --- | --- |
| Main `522759f`, original `tsx` full command | 2 | 197.11s | 867 / 14 |
| Changed full command with `--tsx` | 2 | 212.78s | 877 / 14 |
| Changed full command, native Node | 2 | 155.81s | 877 / 14 |
| Changed full command, native Node | 4 | 90.41s | 877 / 14 |
| Changed fast group, native Node | 2 | 5.63s | 341 / 0 |

The like-for-like default full command improved about 21%, despite adding ten tests. All original
workspace/stress test declarations remain, and renderer-dependent skips are unchanged. These are single
local samples, not a CI guarantee. Keep concurrency 2 as the safe default; 4 is an opt-in for headroom.
The split suite with `tsx` was slower than main in this sample; native Node avoids that added loader
overhead. Do not assume splitting alone or seed copies alone explain the combined improvement.
The baseline used a temporary snapshot of main with the same installed dependencies and independent
test state. The original audit's 323.86s and an early verification overlapping a cold Swift build are
not suitable isolated comparisons. Swift CI cache savings require a subsequent Actions cache hit.

For a runner comparison, alternate `pnpm test:timings` and `pnpm test:timings -- --tsx` on the same quiet
machine, with the same concurrency, installed renderers and dependency cache. Record wall time, failures
and skips. Do not benchmark a full suite concurrently with a Swift build or another suite.

## Bundled extension verification

`packages/kernel/src/bundled-extensions.integration.test.ts` uses fresh agent directories, synthetic
providers and mocked transport responses. It checks the default profile, reload, pre-import suppression
of package/symlink duplicates, unrelated personal extensions, direct/nested jobs, a real child worker's
inherited profile/auth and repeated IPC input/stop, static model configuration and API-key/OAuth request
shaping. Ask tests ensure personal, project and inline extension factories never execute.
`apps/macos/scripts/check-runtime.sh` also exercises parent/child profile loading, Ask web and daemon
auth from the isolated production install, both before and after ZIP extraction.

To compare profile overhead on synthetic large history and streaming, without account access:

```sh
node packages/kernel/src/bundled-extensions.bench.ts 5
```

The baseline disables only the bundled capability profile, retaining mandatory auth and the same
Pi 1.1.0 runtime. This is a feature-overhead comparison, not a Pi 1.0.4 versus 1.1.0 benchmark. It seeds
10,000 messages and streams a 65,536-character faux answer through the real Harness/native adapter.
It alternates variants and excludes the first warmup pair from medians. On 2026-10-14, Node 24.21.0 on
macOS arm64, five samples after the suites completed gave:

| Metric | Baseline | Bundled |
| --- | --- | --- |
| First in-process profile startup | 93 ms | 579 ms |
| Warm startup median | 23 ms | 103 ms |
| Streaming median | 215 ms | 232 ms |
| Streaming CPU median | 250 ms | 259 ms |

The added profile has a startup and small measured streaming cost, not a demonstrated speedup.
RSS output is whole-process data with shared module caches and GC across alternating samples, not
isolated per-profile memory overhead. This does not measure a real provider, browser, idle authenticated
usage polling, daemon first-request latency or live GUI responsiveness. No GUI/storage path changed.
Repository-wide lint still reports pre-existing assignment-expression errors in `jobs.ts` and
`system-events-helper.ts`; the new bundled-profile implementation, integration tests and benchmark lint cleanly.

## Provider error recovery

Pi's Anthropic serializer moves images out of failed tool results. The model integration fixture
persists a codemode image-then-error, reopens the failed chat and completes through the real Anthropic
serializer with offline SSE, checking that the error result is text-only, the image is still sent, and
history, request hooks and already-committed tool effects remain intact.

## Daemon activity hot path

```sh
node scripts/bench/daemon-activity.ts 55f111dc46c6670a959f147c5451b7b39550de27
```

This offline fixture compares the baseline's session-membership and member-run/completion reads with the
current implementation. It seeds 1,000 tasks with 8,000-character bodies, ten owned by the observed member,
then processes 100 summary reads, one run snapshot and 20 completion observations per sample. It alternates variants,
discards a warmup pair and reports median wall/process CPU time from five samples. Stores are independent
temporary copies; no real chats, providers, credentials or network services are opened. Database setup and
index migration are outside the measurement. This isolates synchronous store work, not whole-daemon latency,
Git diff performance, IPC throughput or live GUI responsiveness. Run without a competing local test/build.

## Mission startup recovery

```sh
node scripts/bench/mission-recovery.ts 965ff12b 3
```

This offline probe alternates baseline/current notice recovery with real mission-context subscribers,
using three in-memory missions, 120 members and 240 tasks with 8,000-character bodies. It excludes
setup/imports, discards one warmup pair and reports medians. No daemon, workers, accounts, network
services or user state are opened. On 2026-10-16, macOS arm64/Node 24.21.0, three samples measured:

| Metric | Before | After |
| --- | --- | --- |
| Recovery wall / process CPU | 10,031 / 10,039 ms | 259 / 259 ms |
| Mission notifications | 360 | 3 |
| Full detail reads | 14,403 | 123 |

Recovery still reconciles every member/hand-linked PR and completion. One transaction now publishes
final contexts once per affected mission after phase reconciliation, instead of rebuilding all member
contexts after each recovered PR. `mission-notices.test.ts` guards final task/phase/cache state and
notification fan-out; `missions.test.ts` guards nested batching, membership and rollback. This isolates
synchronous recovery cost, not full daemon launch time, provider startup or live GUI responsiveness.

## Native model-catalog ownership

`model-catalog-owner.test.ts` checks one serialized full-refresh/availability lane per native runtime,
queued registration coalescing, trailing invalidation, explicit option boundaries, credential changes,
independent cancellation and error recovery. Concurrent callers share pending availability work, not
settled results or credentials. Worker catalogs remain separate because extension providers are local
to each session. The broker's canonical reads and concurrency/queue limits are unchanged.

`credential-broker.test.ts` drives eight overlapping real SDK availability calls through a temporary
broker, plus native startup with twelve extension provider registrations. Without ownership, the
availability burst fails with `Credential broker busy`; with ownership all eight calls succeed.
These are offline fixtures with synthetic auth, not real accounts or a live GUI launch check.

A count-only Pi 1.1.0 probe with eight concurrent callers and a synthetic asynchronous credential
store reduced credential reads from 1,328 to 166, and peak concurrent SDK read invocations from 672
to 84. Runtime creation was outside the count; network model refresh was disabled. These are
operation counts, not broker socket concurrency, wall-time measurements or streaming benchmarks.

## Shared model discovery

`shared-model-catalog.test.ts` covers shared pending/settled discovery, source invalidation, TTL,
cancellation, bounded admission, failure recovery and metadata filtering. `shared-catalog.integration.test.ts`
uses the real SDK and same-host broker to check concurrent startup, project scopes, worker provider
overrides, virtual routing, runtime keys, live config/login/logout changes, operation types and independent
host credentials. A blocked discovery must not block a model request. Existing credential-broker and
per-runtime catalog-owner tests retain their canonical OAuth, Jiti and registration regressions.

```sh
node packages/daemon/src/shared-model-catalog.bench.ts 12 3
```

This offline probe alternates per-worker discovery and daemon-owned discovery across twelve real child
processes, with the merged two-start admission limit retained in both variants. Ready workers remain
resident. It excludes one warmup pair and reports three sample pairs. Temporary agent directories,
synthetic configuration and a minimal environment prevent account or provider access. The baseline
disables only the shared catalog capability; the merged per-runtime startup fixes remain active.

On 2026-10-16, macOS arm64/Node 24.21.0, medians of the three sample measurements were:

| Metric | Per-worker | Daemon-owned |
| --- | ---: | ---: |
| Shared discovery passes | 12 | 1 |
| Canonical credential reads | 4,536 | 378 |
| Median catalog startup | 102 ms | 22 ms |
| p95 catalog startup | 141 ms | 72 ms |
| Complete cohort startup (including child imports) | 3,497 ms | 3,082 ms |
| Largest 5 ms heartbeat gap | 14.7 ms | 11.1 ms |
| p95 broker status response | 2.37 ms | 1.65 ms |
| Controller/daemon peak RSS | 262.7 MiB | 265.8 MiB |
| Sum of resident worker RSS | 2,074.8 MiB | 2,067.7 MiB |

The static catalog snapshot was 2,799 bytes. An earlier full-copy implementation increased worker RSS
by about 350 MiB for this cohort; static-definition reuse removed that cost. RSS differences in the final
probe are small and noisy, not evidence of a memory reduction. This measures SDK catalog startup and
broker responsiveness, not Harness/history reopening, live providers, GUI responsiveness, large streaming
conversations or sandboxed worker startup. The controller is not a complete running pilotd. Source
signatures are checked on demand, with a five-minute backstop for ambient sources; no polling is added.

The daemon does not load project or personal extension factories. Registered providers, virtual models,
runtime keys and explicitly private SDK stores/catalog endpoints stay local. Refreshed models reuse
worker-local transport templates; when a transport cannot be represented that way, workers restore its
cached request configuration locally without repeating shared network discovery. Authentication is
resolved again in the requesting process for every model request, through the canonical broker.

## Durable todo progress probe

An offline probe on 2026-10-15 (macOS arm64, Node 24.21.0) seeded 10,000 transcript entries and
256 todos with 768,000 bytes of Markdown. Five samples of 20 unchanged reads compared the prior
`TodosWatch.refresh()` filesystem metadata scan with a warm `TodoProgressDoc` snapshot. Median wall
time was 29.45 ms versus 0.019 ms; process CPU was 67.60 ms versus 0.026 ms. Twenty fresh read-only
SQLite count reads took 4.20 ms wall and 4.84 ms CPU. Creation and initial imports were outside the
measurement. No providers, accounts or GUI were used.

This isolates repeated progress retrieval, not streaming or whole-daemon latency. The new implementation
does not schedule those unchanged reads at all: committed document watches replace the one-second
filesystem poll. Count-only cold reads use the same bounded reader queue as transcript reads, without
materializing transcript entries or todo Markdown. Live counts arrive on worker readiness/mutations.
`todos.test.ts` covers bounded latest-only documents, concurrent child writes, restart and workspace
replacement; the real child-process profile test checks structured todo calls through codemode.

## Cold subagent reader startup

```sh
node packages/kernel/src/subagent-reader-startup.bench.ts 4cc44c17 4 5
```

This offline probe alternates five fresh reader threads from each revision, with four bounded CPU-busy
threads owned and terminated by the probe. It materializes baseline source and package metadata in a
temporary directory, reuses the identical dependency installation, and reads the same synthetic live
`runs.sqlite` under its writer lease. It never starts an agent or uses real accounts. Omit the second
argument (or use `0`) to measure ambient load alone. All readers, load threads and temporary files are
released on completion or failure.

JSON lines separate Worker `online`, bootstrap, cold import completion and first snapshot. Load hooks
count module loads/source bytes; CPU and heap belong to the reader thread at import completion, not
whole-process RSS. The 30-second probe ceiling deliberately permits observations beyond the old
five-second fixture budget. It is not a production deadline. Fresh threads have independent module
caches even when the parent process has already imported the same modules.

The live-reader test uses a post-import readiness message, not Worker `online`, before starting its
unchanged snapshot/delta polling budgets. The overall 20-second test bound, unchanged-data assertion,
full snapshot and incremental-entry assertions remain. Readiness is internal control traffic, never
transcript data. Normal cold reads do not load the coding SDK; saved compaction statistics still load
its estimator lazily to preserve the existing numbers. `cold-reader-imports.test.ts` guards the ordinary
reader entrypoints against accidentally restoring eager SDK imports.

On 2026-10-15, macOS arm64/Node 24.21.0, five alternating pairs against `4cc44c17` with four busy
threads and ambient one-minute load 35–61 gave the following medians (ranges in parentheses):

| Metric | Baseline | Changed |
| --- | --- | --- |
| First snapshot | 10.93s (5.92–16.14s) | 5.94s (3.31–7.27s) |
| Thread online | 83ms (47–204ms) | 101ms (36–209ms) |
| After import completion to snapshot | 134ms (45–207ms) | 135ms (85–138ms) |
| Import thread CPU | 1146ms | 430ms |
| Module loads / source bytes | 1696 / 8.29MB | 752 / 1.67MB |
| Heap after imports | 49.1MB | 24.5MB |

The unchanged live-reader fixture also failed on clean `4cc44c17` with no updates after its polls
expired under load. The graph reached the SDK through `chat-events.ts`'s estimator and
`attention.ts` importing the question entry constant from the tool implementation. Each fresh thread
paid that eager import cost before its first read. Removing those dependencies reduces the work, but
import scheduling alone still exceeds five seconds under heavy load. That is why readiness separates
module startup from the read budget rather than merely replacing one timeout number. This probe
isolates cold startup of a tiny transcript, not disk-cold OS caches, large-history rendering or GUI
responsiveness. It does not claim a fixed speedup under arbitrary machine load.

## Worker recovery admission

`subagent-activity.test.ts` covers idle-parent activity and completion replay, update/sleep recovery,
daemon restart and confirmed kernel exit with pending child work. `subagent-pause.integration.test.ts`
uses faux models through the bundled subagent supervisor and a real child process. It pauses during an
in-flight child tool (update) or generation (sleep), replaces the kernel, checks that committed effects
are not replayed, and verifies exactly one child-result follow-up reaches the idle parent. No live
accounts or workspaces are opened.

A synthetic summary probe on 2026-10-15 compared the prior background-work predicate with the
child-aware predicate, alternating five pairs of 10,000 summary reads over 1,000 metadata records.
Each record held 100 children with the working child last. Median wall time was 101.2ms before and
102.1ms after. This isolates the in-memory summary projection under a worst-position scan, not real
provider streaming, GUI rendering or cold database recovery. No polling, history reads or child
process inspection were added to the activity path.

`packages/daemon/src/worker-starts.test.ts` and `sessions.test.ts` cover a 150-session recovery burst,
two concurrent cold starts, FIFO admission, per-session coalescing, failure release, queued Stop,
role changes, archival, sleep and shutdown. The limit lasts through worker readiness, not the agent's
run. Memory wake failure or its 1.2-second deadline remains nonfatal; the kernel integration fixture
also checks timer cleanup on success, error and timeout.

On 2026-10-15, macOS arm64/Node 26.10.0, a local offline probe compared `9c221642` with this change in
five alternating pairs. It seeded 150 initializing sessions with stable pending input IDs and used
faux workers with 2ms synchronous constructor work and held readiness promises. A 1ms heartbeat ran
during metadata loading and admission. Medians, with no competing verification commands:

| Metric | Before | After |
| --- | --- | --- |
| Workers constructed before releasing readiness | 150 | 2 |
| Time until `load()` returned and metadata could be listed | 315ms | 13ms |
| Largest heartbeat gap | 306ms | 5ms |

This isolates admission pressure, not real extension load time, provider streaming, large-history
rendering, GUI launch latency or total retained worker memory. All admitted agents may still run
concurrently. Two connected but stalled initializations can hold both slots: elapsed time alone must
not revoke a live writer's storage lease. No live chats, credentials or model services were used.

## Subscription admission

`subscription-policy.test.ts` and `session-subscription-usage.test.ts` cover the 95% boundary, all-window
blocking, fresh lower readings, reset timers, unknown/error/stale readings, per-chat force expiry and
restart persistence, and children using another provider. `subscription-pause.integration.test.ts`
checks the real parent Harness/native adapter, safe tool drainage and SQLite recovery without replay.
`subscription-limit.test.ts` and `subscription-limit.integration.test.ts` cover provider-reported
exhaustion, persisted admission acknowledgement, request-only recovery after a committed tool result,
restart recovery and Stop. They exclude transient throttling, authentication and API billing failures.
The pinned pi-extensions gate tests cover child admission, direct model/compaction calls and aborts.
Continuation tests cover provider-neutral handoffs, same-provider model changes, ownership transfer,
read-only originals and journal recovery. All providers and cache data in these checks are synthetic.

Run `node packages/kernel/src/subscription-gate.bench.ts` for the incremental gate cost. On macOS arm64,
five alternating samples of 1,000 sequential admissions measured medians of 0.14ms wall/0.14ms CPU
without a configured gate and 58ms wall/63ms CPU with an empty policy file (about 58µs per admission).
File reads are asynchronous; there are no timers while unblocked, and only blocked requests wait on a
cancellable two-second local-file check. This isolates the new boundary, not large-history preparation,
provider/GUI latency, or disk-cold performance. Parked never-opened chats update display policy in memory
instead of writing admission files on every usage change; files are persisted before workers resume.

## Workspace fixtures and clocks

Workspace tests are separated into refresh/import/recovery/lifecycle and retention groups. Their real
Git/jj safety, failure and crash assertions are retained, not replaced by replay. `testing/git-seed.ts`
builds immutable Git-only seeds once per test process, then copies independent objects, refs, config and
files for every case. No hard links, alternates, mutable shared stores or copied jj workspace paths are
used. Seed preparation disables ambient Git config, signing, templates and hooks.

Use completion promises or transport barriers to observe asynchronous work. Fake clocks can exercise
deadline boundaries without waiting for production timeout lengths. Keep real timers where the test is
specifically about native process cancellation, I/O or scheduling. Test cleanup must release any gated
operation even when an assertion fails. Polling helpers should use monotonic time if tests freeze `Date`.

## Offline API cassettes

`packages/daemon/src/testing/cassette.ts` is a replay-only helper. Examples for GitHub, Linear and Slack
live under `packages/daemon/src/fixtures/cassettes`, and `service-cassettes.test.ts` drives the real
adapters and parsers through them. The versioned JSON format is:

```json
{"version":1,"entries":[{"request":{"tool":"issues","args":{"team":"example"}},"response":{"issues":[]}}]}
```

- `cassetteRunner` matches executable plus the complete argv, including GitHub's GraphQL query and
  variables. It never runs `gh` or a fallback process. Cwd, environment and timeout are not recorded.
- `cassetteSource` matches the fixed source tool plus every JSON argument, including scope, fields,
  cursor and page bounds. Only object key order and omitted `undefined` properties are normalized;
  array order, request order and values must match exactly.
- Responses are copied per call. Unexpected, reordered or extra calls fail immediately. Call
  `assertDone()` to catch missing calls and unused responses. Mismatch diagnostics do not echo payloads.
- There is no live fallback or recording mode, including on a cache miss. Author synthetic fixtures
  explicitly and review contract changes before updating them. Never commit raw account responses,
  private messages, repository data, model prompts, authorization headers, cookies or signed URLs.
  Use fake identities and public example domains, not merely redacted tokens in otherwise private data.

Keep small inline fakes for dynamic scenarios and error injection. Cassettes complement those tests;
they do not replace real daemon HTTP/WebSocket tests or certify compatibility with a live provider.

## Swift checks and CI caches

Continue using `apps/macos/scripts/test.sh` and `apps/macos/scripts/build.sh`, which select the supported
SDK and test macro plugin. After a successful build, `apps/macos/scripts/test.sh --skip-build --filter
<name>` is appropriate for repeating an affected test without rebuilding.

A full native test run executes the WebKit content-measurement matrix in a separate test process after
the other tests, reusing the same build and verification slot. This prevents unrelated MainActor/AppKit
fixtures from consuming its one-minute budget. All clipping, resize, visible-overflow and Mermaid assertions
remain enabled. The output guard requires that the isolated test actually starts, so a stale filter cannot
silently drop coverage. Explicit `--filter`, `--skip` and listing requests remain a single scoped invocation.

CI runs native Node, packaging and Swift tests in one `macos` job, because the free plan runs only a few
macOS jobs at once. PRs skip the Swift steps when they change nothing under `apps/macos/`, the release
workflow, `package.json` or the verification-slot script. PRs that run Swift package the debug binaries from
the test build (`BUNDLE_PREBUILT=1 CONFIGURATION=debug bundle.sh`) and smoke-test that app, instead of
compiling an optimized build. Main and manual runs also build and verify the optimized app in `app-bundle`,
so release-only compiler problems surface on `main` before publishing, not in the PR.

Both Swift jobs cache only pinned dependency
repositories/downloaded artifacts and the patched Ghostty vendor sources. Keys include OS, architecture,
Swift and SDK versions, package pins/manifests, and vendor/patch scripts. No executable build products,
signing material or user data are cached; dependency resolution still runs and verifies binary artifacts.
Local APFS sharing in `share-artifacts.sh` remains separate from this download cache.
