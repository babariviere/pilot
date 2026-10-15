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
  gap, with their own CPU time. `missions.sqlite` entries are mission-store statements and transactions, which
  run synchronously on the event loop and wait for the disk on commit.
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

## Benchmark

`scripts/bench/daemon-stalls.ts` drives the mission-store work that kernel packets trigger (GitHub action
audits, member runs and completions, notice activity, and the mission detail pushed to subscribers) about
20 times a second on one event loop. It runs quiet and with separate processes writing and syncing files
(like agents building or installing), with SQLite `synchronous=FULL` (current) and `NORMAL`. It only uses a
temporary directory.

```sh
node scripts/bench/daemon-stalls.ts --seconds 8 --writers 2
```

One run on an 11-core M3 Pro with other work running:

| Scenario | Packet p50 | Packet p99 | Packets ≥ 100 ms | Loop delay p99 | Packet CPU p50 |
| --- | --- | --- | --- | --- | --- |
| Quiet, FULL | 4.2 ms | 8.3 ms | 0 / 145 | 15 ms | 4.1 ms |
| Quiet, NORMAL | 3.5 ms | 6.7 ms | 0 / 148 | 14 ms | 3.3 ms |
| Disk pressure, FULL | 21.7 ms | 340 ms | 12 / 84 | 224 ms | 2.1 ms |
| Disk pressure, NORMAL | 3.2 ms | 7.2 ms | 0 / 148 | 15 ms | 3.1 ms |

Under disk pressure each packet waits on commit syncs while using about 2 ms of CPU, so the loop stalls without
computing. This is the pattern the CPU column in the log is meant to confirm on real machines. Timings vary with
the disk and machine load; the comparison, not the absolute values, is the result.

## Findings from one day of logs (2026-10-15)

- 532 stalls of a second or more, about 32 minutes of stalled event loop excluding likely sleep, across 26 daemon
  starts. 259 were 1 to 2 s, 178 were 2 to 5 s, 84 were 5 to 60 s.
- Requests caught behind stalls: Changes summaries (p50 5.5 s in flight), message sends (p50 19 s) and the model
  list (p50 4 s).
- Synchronous sections reported: `working` packets (23, p50 1.6 s, max 9 s) and `github.action` packets (22,
  p50 1.5 s). Both write the mission store on the event loop. Measured alone on a copy of a real mission store,
  those writes take well under 2 ms of CPU, so multi-second sections point to waiting rather than computing.
- macOS resource reports show pilotd and its kernels at **Utility** QoS (a LaunchAgent without `ProcessType`),
  and repeated "disk writes" limit reports for Pilot node processes: 2 GiB per 15 to 45 minutes for the daemon,
  and up to 8.5 GiB in 5 minutes for kernel processes.

These logs predate the CPU attribution above, so they cannot yet prove which stalls were disk waits. Reading the new
log lines after a day of normal use will.

