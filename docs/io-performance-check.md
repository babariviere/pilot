# I/O amplification audit

## Scope and changes

The installed app's persistent processes did not reproduce sustained high disk throughput in the
initial 30-second observation. Source review and offline fixtures did identify costly work amplification:

- Sidebar summaries ran a Git process per untracked file every ten seconds for mounted chats.
- Changes regenerated full patches every four seconds, including idle chats.
- Hidden windows did not suspend those tasks.
- Model and tool progress inherited 100 ms durable checkpoints, producing many small SQLite writes.

Repository reads now share base/path/line metadata between endpoints. Git resolves binary attributes
in one NUL-delimited stdin batch; a single reader thread counts untracked lines without spawning a
process per file. It preserves binary overrides, custom driver flags, Git's 8,000-byte NUL test and
large-file threshold, symlink text (never its target), empty files and unterminated last lines.
The thread uses a 64 KiB buffer, reuses up to 1,024 unchanged metadata entries, admits at most 16
requests and retires after 30 idle seconds. A failed/racing file read rejects rather than showing zero.

One window visibility observer gates repository polling. Hidden, occluded and minimized windows
stop; becoming visible and session activity refresh immediately. Working cadences stay 10 seconds
for sidebar stats and four seconds for full diffs. Idle cadences are 60 and 30 seconds. External
editor changes still use this periodic fallback, and the manual Changes refresh remains available.
Full-diff client reads now share the bounded admission limiter and a small single-flight cache.
Returning to a window clears completed repository cache values without splitting in-flight reads.

Progress checkpoints now use 250 ms for both model and tool output. This changes displayed progress
to at most four checkpoint updates/second and increases the uncheckpointed crash suffix from about
100 to 250 ms in a healthy stream. It does not change admissions, final result/terminal transactions,
SQLite sync settings or replay-unsafe tool recovery. User extensions/subagent storage remain outside
this kernel policy.

## Repeatable offline measurement

```sh
pnpm install --frozen-lockfile --ignore-scripts
node scripts/bench/io.ts
# Optional comparison against this task's original base:
node scripts/bench/io.ts 4eb47dd4b72193418a83c387dd43b86f333ada67
```

The optional baseline loads that commit's `changes.ts` with current subprocess plumbing, not the
installed application. The fixture uses a disposable Git repository, ignores user Git configuration
and hooks, and never opens user sessions/accounts. It alternates baseline/current cases under the
same host load. The 1,000-file case runs only the new implementation to avoid 1,000 old subprocesses.

One local run:

| Untracked files | Before commands | After commands | Before time | After time |
| --- | --- | --- | --- | --- |
| 0 | 6 | 6 | 434–472 ms | 281–314 ms |
| 100 | 106 | 8 | 3,506–4,730 ms | 359–439 ms |
| 1,000 | not run | 8 | not run | 422–614 ms |

Counts stayed accurate (ten added lines per file). The repeated current read scanned **zero content
bytes** after metadata reuse. Command counts are deterministic; timings vary with machine load and
are not a universal latency claim. Binary-driver attributes can add one fixed config lookup.

The streaming fixture seeds 1,000 history entries and writes the same 30 KiB final progress text
through the installed durable Session/LiveDoc mutation path. It accelerates a simulated 60-second
stream, not a real provider run. Its WAL auto-checkpoint threshold is elevated only in the fixture
so appended frames remain countable rather than being reused. Initial history and final settlement
are excluded. This measures generated WAL bytes, **not physical device throughput**.

| Progress | 100 ms (600 commits) | 250 ms (240 commits) |
| --- | --- | --- |
| Model | 10,205,240 WAL bytes | 4,070,560 WAL bytes |
| Tool | 10,180,520 WAL bytes | 4,054,080 WAL bytes |

Both workloads produced about **60% fewer WAL bytes**. Progress uses deltas; this is page-write
amplification, not repeated whole-history serialization. Very large files still require a full
initial text scan, retained caches are estimates rather than hard allocator limits, and full patch
generation still needs content reads. This audit does not claim that all filesystem operations,
third-party extensions, subprocesses or device traffic are eliminated or globally bounded.

## Checks

Focused regressions cover Git numstat parity, constant command count, endpoint metadata sharing,
unchanged-file reuse, worker queue/lifetime/error recovery, binary stdin/early child exit, visibility
gating/idle cadence, client full-diff coalescing/invalidation and persisted short model responses.
Typechecking, formatting and changed-file lint checks passed. The final full TypeScript run passed
860 tests, skipped 14 and failed the existing submodule snapshot rejection-message assertion. The
same assertion was reproduced using current-main versions of the test, workspace store and original
subprocess implementation in a disposable directory, without this change's scanner or subprocess edits.
The initial full Swift run completed 166 native and 266 core tests but the UI runner was incomplete
with project-discovery, message-pencil margin and grouped-sidebar failures outside this patch.
Current main's newer UI test fixes were incorporated by rebasing only this task before final checks.
The rebased full Swift run completed 166 native and 275 core tests, but its UI runner was again
incomplete. Focused repository/cache tests pass; the full UI runner is not green without its summary.

The native app builds. Its offline streaming check rendered 1,001 rows with 201 chat-body evaluations,
24.8% of one CPU core and 210 MiB peak RSS under the observed load. This is an after-only GUI smoke
check, not a before/after CPU claim. No installed-app session was restarted or rewritten. A static
SwiftUI mock documents unchanged metadata presentation, not a real-view visual check. Packaged-app
device I/O and battery life remain unverified. Existing unrelated repository lint warnings remain.

## Background metadata under load (2026-10-15)

A read-only observation of installed Pilot 1.35.0 found machine load averages around 60–70 on
11 logical CPUs, concurrent agent-owned Go builds/tests/hooks, and substantial OrbStack activity.
In one ten-minute log window, pilotd recorded 41 watchdog gaps above one second (maximum 16.2 s);
34 included pending repository-summary requests. Pending requests identify affected work, not proof
that those requests caused the gaps. Watchdog gaps can also include scheduling delays or sleep.
No live agents, jobs or services were stopped or restarted.

Two bounded changes reduce avoidable work, without imposing new agent/build concurrency policy:

- PR polling reads active mission IDs/project IDs and indexed ownership PR resources, not full
  mission details or attention aggregates. Task bodies, brief, comments, decisions and events are
  not materialized. Chat-only bindings, reference exclusion and durable PR caches are preserved.
- Visible sidebar rows poll `GET /api/sessions/:id/changes/branch`, which resolves the branch or
  jj bookmark without diff metadata or untracked-file scans. File/line counts load only while a
  row's tooltip is hovered. Both loops retain visibility gating, idle backoff, single-flight caches,
  bounded admission and cancellation. The Changes pane and the existing summary API are unchanged.

Repeat the offline probe with:

```sh
node scripts/bench/background-metadata.ts
```

It uses temporary SQLite/Git fixtures, not accounts, providers or live workspaces. The PR comparison
alternates the previous `list()`/`detail()` projection with the narrow reads, discards one warmup pair
and reports medians of five samples. The fixture has 1,001 tasks and 8 MB of task bodies. Twenty
projections measured **461.44 ms wall / 454.42 ms CPU before**, and **0.28 ms wall / 0.28 ms CPU
after** in one local run. This isolates synchronous projection work, not end-to-end daemon latency.

With 1,000 untracked text files, a row refresh used **8 Git commands before and 1 after**, with no
file-content reads on the branch path. Warm alternating samples measured 145–328 ms for summaries
and 20–61 ms for branch reads. The first summary scanned 512 KB; subsequent summaries reused their
file-content metadata. Cache and host scheduling affect timings; operation counts are the stronger
comparison. This is not a live streaming/UI benchmark, leak test or claim that host pressure is solved.

Targeted regressions cover projection isolation/index use, reference and inactive-mission exclusion,
PR cache behavior, branch cache expiry/invalidation, detached heads, endpoint guards and client
on-demand/cancellation behavior. Local checks are limited to affected Node tests, TypeScript checking,
Swift parsing and PilotCore typechecking; full Swift builds/tests and full Node suites run in CI.
No layout changed, and the installed UI was not rebuilt or visually rechecked for these changes.
