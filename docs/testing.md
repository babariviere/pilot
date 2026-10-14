# Testing and test speed

Node 24 strips our erasable TypeScript directly. Tests still use `node:test`, isolated processes, and
fresh temporary state. Model tests use faux providers, never user accounts. `tsx` remains available for
runner comparisons and the existing reopen benchmark, but is not needed by the default runner.

## Commands

| Command | Scope |
| --- | --- |
| `pnpm test:fast` | Explicitly selected unit and offline service tests for quick feedback |
| `pnpm test:integration` | Real repository, process, persistence, transport and kernel integration tests |
| `pnpm test:stress` | Large-file diff budgets, fan-out and 10,000-event notice regression tests |
| `pnpm test` | Every group, including runner/helper tests. This remains the CI gate |
| `pnpm test:timings` | Full gate plus the slowest reported test-file execution times |

New tests default to integration unless explicitly admitted to the fast list in `scripts/test-suites.ts`.
`*.stress.test.ts` belongs to stress. No group is silently dropped by the full command.
`pnpm test -- --list` lists the full selection; each group also accepts `--list`. Native Node test flags
can be forwarded, for example `pnpm test:integration -- --test-name-pattern='restore'`.

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

Swift test and app-bundle CI jobs already run independently. Both now cache only pinned dependency
repositories/downloaded artifacts and the patched Ghostty vendor sources. Keys include OS, architecture,
Swift and SDK versions, package pins/manifests, and vendor/patch scripts. No executable build products,
signing material or user data are cached; dependency resolution still runs and verifies binary artifacts.
Local APFS sharing in `share-artifacts.sh` remains separate from this download cache.
