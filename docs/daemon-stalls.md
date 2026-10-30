# pilotd event-loop stalls

pilotd serves the app, supervises kernels and runs mission bookkeeping on one Node event loop. When that loop
stops for a second or more, the app sees slow sends, stale sidebars and slow Changes. This page explains the
stall diagnostics and how to measure them. For the earlier CPU, memory and I/O audits, see
[performance-check.md](performance-check.md) and [io-performance-check.md](io-performance-check.md).

## Reading the log

The watchdog logs every timer gap of a second or more to `~/Library/Logs/Pilot/pilotd.log`:

```
pilotd: event loop delayed for 2726ms (main thread cpu 31ms: waiting for disk, CPU or system sleep); slow kernel working packet for <id> (2618ms, cpu 12ms); slow missions.sqlite transaction (2580ms, cpu 3ms); in flight GET /api/sessions/<id>/changes/summary (70ms)
```

- **main thread cpu** is the event loop's own CPU time during the gap. Close to the gap means synchronous work
  (classified as `synchronous work`). Far below it means the thread waited: for the disk, for a CPU core, or
  because the Mac slept. A gap of a minute or more with almost no CPU is reported as `likely system sleep`.
- **slow** entries are synchronous sections of at least 100 ms (kernel packets at 250 ms) that ended during the
  gap, with their own CPU time. `missions.sqlite` entries are mission-store statements and transactions. They
  run synchronously on the event loop, in memory since the store moved (see below), so a slow one is CPU work.
- **in flight** entries are HTTP requests still running. They are context, not causes: asynchronous work does not
  block the loop, but it finishes late when the loop is stalled.

Summarize a log (bucket sizes, stalled time per day, most frequent context, computing versus waiting):

```sh
node scripts/bench/pilotd-log.ts                      # ~/Library/Logs/Pilot/pilotd.log
node scripts/bench/pilotd-log.ts --since 2026-10-15
```

## Live diagnostics

`GET /api/diagnostics/performance` (loopback only, like the rest of the API) returns bounded counters since the
daemon started: event-loop utilization and delay percentiles (beyond the 20 ms sampling interval), stall counts by
kind with the last 32 stalls, slow-section totals per kind (session IDs folded), the oldest in-flight requests, and
process CPU, memory, file-system operation and context-switch counts.

```sh
curl -s http://127.0.0.1:4319/api/diagnostics/performance | jq '.stalls, .operations.slowByKind[:5]'
```

Nothing is written to disk or sent anywhere beyond the existing log line.

## CPU-bound context publication (2026-10-30)

A bounded, identity-pinned read of one running 1.98.0 daemon at 274 seconds uptime reported eight
stalls: six CPU-busy and two waiting, totaling 18,859 ms of delay. Only one slow section was labeled
(`missions.sqlite transaction`, 1,410 ms wall / 1,404 ms main-thread CPU). This does **not** attribute
the unlabeled stalls to SQLite, context publication or any overlapping request. The earlier observation
of 24 CPU-busy stalls totaling 51,687 ms likewise lacked sufficient attribution.

Source inspection and an isolated in-memory workload reproduced a separate concrete bottleneck:
every mission change, even a log-only change, rebuilt the complete mission detail once per member
before checking whether that member's prompt context changed. This repeatedly materialized unrelated
task bodies, comments, phases and artifact links. `memberContext()` now reads only the member's
unfinished task metadata, decisions and Linear links. The existing audience, pin, role, phase and
ticket selection remains authoritative. Each call reads current state, without a cross-change cache;
synchronous listener changes, publication order, deduplication and passive lifecycle flags are preserved.
No writes, durability waits, acknowledgements or action admission were changed.

The existing bounded slow-section recorder now times the full synchronous fan-out under the fixed
`missions.context.publish` label, including listener work. It records only elapsed/main-thread CPU
numbers using the existing 100 ms threshold, 16 recent sections and 64 aggregate kinds. Nested labels
can overlap and must not be added together. This is not worker CPU, provider latency or native GUI timing.

Reproduce with one process at a time, without a real profile, provider or disk-load generator:

```sh
node packages/daemon/src/mission-context.bench.ts
node --test --test-force-exit --test-concurrency=1 packages/daemon/src/mission-context.test.ts \
  packages/daemon/src/mission-context.stress.test.ts
```

The benchmark alternates the previous full-detail reads and the narrow projection on the **same**
fixture: 480 tasks with 1.92 MB of bodies, 400 members, 60 decisions and 400 artifact links. It discards
one warmup pair and reports five pairs, checking identical published context content and order.
One macOS arm64 / Node 24.21.0 run measured these medians per log-only change:

| Projection | Wall | Main-thread CPU |
| --- | ---: | ---: |
| Previous full detail per member | 934.82 ms | 929.43 ms |
| Narrow context inputs | 117.59 ms | 117.28 ms |

In the matching two-write burst regression, substituting the previous reads failed the CPU budget:
2,063.90 ms main-thread CPU, 2,087.18 ms heartbeat gap, 2,088.21 ms unrelated local HTTP latency,
one CPU-busy stall. Current reads used 253.99 ms CPU, 257.83 ms heartbeat gap and 261.65 ms HTTP,
with zero CPU-busy stalls. The heartbeat actually ran; waiting/sleep are reported separately. Structural
tests also reject full-detail reads and compare exact contexts across ownership, pin, phase and
coordinator changes. Existing mission durability, lifecycle, planning and service tests remain green.

These measurements prove this synthetic CPU path improved, not that all observed live stalls are fixed.
The running daemon/app were not installed, restarted, profiled, loaded or mutated by the investigation.
The current GUI is Rust/GPUI in `apps/desktop`; historical Swift observations below are not current
native performance evidence. Remaining unlabeled live CPU work still has unknown attribution.

## Mission store

The mission store (`missions.sqlite`) was the one database pilotd used on its event loop. Every read and commit ran
there, and each commit waited for the disk. Kernel packets write it (member runs and completions, GitHub action
audits, notice activity), so a busy disk stalled the whole daemon.

The store now runs in memory:

- At startup pilotd migrates the file as before, then copies it into an in-memory SQLite database (about 16 ms and
  9 MiB for a store with 9 missions, 360 tasks and 4,900 events). Reads and commits never touch the disk.
- An SQLite session records each commit's changes. A worker thread applies those changesets to the file in
  batches, with `synchronous=FULL`, so one disk sync covers every commit made meanwhile.
- **Acknowledgement waits for the disk.** Mutating HTTP responses, `mission` tool results, system-message
  acknowledgements, coordinator notices and new mission chats are released only after `durable()`. A power loss
  can only lose changes nobody was told about.
- Only the replica's own replies advance the saved sequence. Node's watch mode (`node --watch`, the development
  daemon) posts module-watch notices to the same worker port; they are ignored, so the daemon still answers every
  mutation instead of waiting for a save that never happens.
- A daemon crash loses internal bookkeeping committed in the last moments before its save (usually milliseconds,
  up to about a second on a saturated disk). These are rederived on startup or retried with stable request IDs.
- Shutdown waits up to 10 seconds for the last changes. If a save fails, waiting acknowledgements fail and the
  worker retries with backoff (up to 30 s), so a full disk shows errors rather than silently diverging.
- `artifact_links` gained an explicit `id INTEGER PRIMARY KEY` (copied from its rowid), because sessions only
  record tables with a primary key.

## Process class

The LaunchAgent now sets `ProcessType` to `Interactive`. Without it launchd ran pilotd at Utility QoS with
throttled CPU and I/O, so app requests waited behind builds. Kernels and the tools they run inherit the class, so
agent builds now compete with the UI like builds started from a terminal. The app rewrites the plist and reloads
the agent when it next (re)starts pilotd.

## Benchmark

`scripts/bench/daemon-stalls.ts` drives the mission-store work that kernel packets trigger (GitHub action
audits, member runs and completions, notice activity, and the mission detail pushed to subscribers) about
20 times a second on one event loop, on a quiet disk and while separate processes write and sync files. With
`--baseline <commit>` it also runs that commit's `missions.ts` under the same load. It only uses a temporary
directory. Writers are rate-limited; saturating settings write gigabytes, so keep those runs short.

```sh
node scripts/bench/daemon-stalls.ts --baseline <commit-before-this-change>
node scripts/bench/daemon-stalls.ts --baseline <commit> --seconds 3 --writer-mbps 2000 --writer-batch-mb 256
```

One saturated run (two writers flushing 256 MiB batches) on an 11-core M3 Pro:

| Store | Packet p50 | Packet p99 | Packets ≥ 100 ms | Loop delay max | Packet CPU p50 | Durable after p50 / p99 |
| --- | --- | --- | --- | --- | --- | --- |
| Disk-backed (before) | 33 ms | 257 ms | 2 / 33 | 255 ms | 1.1 ms | at return |
| In memory (now) | 1.0 ms | 4.9 ms | 0 / 58 | 5 ms | 1.0 ms | 18 ms / 320 ms |

Before, each packet spent about 1 ms computing and the rest waiting for the disk. Now the event loop pays only the
CPU, and the disk wait moves to the worker. An earlier, unthrottled run of the old store measured 340 ms at p99.
Timings vary with the disk and machine load; compare runs made back to back.

## Findings from one day of logs (2026-10-15)

- 532 stalls of a second or more, about 32 minutes of stalled event loop excluding likely sleep, across 26 daemon
  starts. 259 were 1 to 2 s, 178 were 2 to 5 s, 84 were 5 to 60 s.
- Requests caught behind stalls: Changes summaries (p50 5.5 s in flight), message sends (p50 19 s) and the model
  list (p50 4 s).
- Synchronous sections reported: `working` packets (23, p50 1.6 s, max 9 s) and `github.action` packets (22,
  p50 1.5 s). Both wrote the mission store on the event loop. Measured alone on a copy of a real mission store,
  those writes take well under 2 ms of CPU, so multi-second sections point to waiting rather than computing.
- macOS resource reports showed pilotd and its kernels at Utility QoS (no `ProcessType`).

These logs predate the CPU attribution above, so they cannot prove which stalls were disk waits. Reading the new
log lines after a day of normal use will.

## macOS "disk writes" reports

`/Library/Logs/DiagnosticReports/node_*.diag` lists Pilot node processes that crossed macOS's daily write
budget (about 25 KiB/s averaged over a day, counted as 16 KiB pages dirtied). Every process started by pilotd,
including agents' tools, shares the `com.babariviere.pilot.daemon` resource coalition, so the reports are not all
kernels. From 2026-10-08 to 2026-10-15:

- **8.5 GiB in 4 to 17 minutes:** heaviest stack `fs.cpSync`, which only Pilot's own test helper
  (`packages/daemon/src/testing/git-seed.ts`) uses: agents running this repository's test suite.
- **34 GiB:** `node -e` scripts writing synchronously. The latest one was this benchmark before its writers were
  rate-limited.
- **2 GiB over 15 minutes to 2.6 hours:** SQLite commits from a microtask. Kernels commit streaming progress every
  250 ms ([io-performance-check.md](io-performance-check.md)), about 0.2 to 2.5 MB/s of dirtied pages over a long
  run; one report was pilotd itself in the first 16 minutes after a start. The live endpoint's `fsWrites` counter
  can confirm the daemon's share.

No report pointed at a runaway kernel. The heavy ones were test runs and benchmarks inside agent sessions.
