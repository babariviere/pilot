# Single-scene transcript measurement

**Historical measurement, before the default switch.** This report repairs the benchmark, not the renderer.
Native was subsequently selected by default at the user's request, with the legacy renderer retained as
an explicit fallback. That product choice does not change these source-pinned results or close their gaps.

## What was wrong

The performance fixture closed SwiftUI's main scene window and created another `NSHostingView<MainWindow>`.
Closing the scene window retained its graph. Both graphs observed the same shared feed, so the fixture
prepared and rendered each update twice, including into the closed window.

A bounded diagnostic trace confirmed two native controllers in different windows: the invisible
`AppKitWindow` with identifier `main`, and the visible manually created `NSWindow`. Each prepared all
12 versions of `streaming-0` in a three-second, 4/s probe. After reusing the real scene window, the same
probe recorded one controller in the visible main scene and exactly 12 preparations. No events were dropped.

The fixture now selects exactly one existing main scene, preserves its content graph, sizes it and brings
it forward. Missing or ambiguous scenes fail instead of silently adding another host. Regression fixtures
cover existing-window/root identity and missing/ambiguous rejection. Production rendering, cadence,
selection, focus, artifact engines, sizing rules and the default flag are unchanged.

Do not compare the new numbers with the old two-graph batch as a renderer speedup. The real scene also has
its actual toolbar/chrome. Both new controls request the same 1280×820 content size with the corrected
fixture. Historical reports remain evidence of those older experiments,
not clean one-window acceptance controls.

## Corrected release comparison

- Main control: `e3bb09bd2eff35a0fc41f7d1fdaffb0e8571a954`, with only the same fixture correction.
- Native: `f6c09610a36331594bf18dec72fee5b03fae94f4`, with the fixture correction.
- M3 Pro, macOS 27.0.1, AC, unlocked built-in 120 Hz display. Positive unlocked/AC guards before and after
  every run. One shared Swift verification slot, no competing checks from this experiment.
- Normal release entrypoints, no profiler or diagnostic hooks. One warmup each, then three alternating
  pairs per workload: main/native, native/main, main/native.
- Streaming: 40 Markdown deltas, 100 characters each, nominal 4/s over ten seconds.
- Rich scrolling: the same fixture, 600 programmatic 40-point steps at nominal 16 ms deadlines, up then
  down, live-scroll notifications and synchronous layout/display. This is not a manual wheel-input journey.
- Other machine activity was uncontrolled. Process snapshots were retained locally, and every pair is
  reported below. No thermal or performance warning was recorded.

### Medians

| Metric | Main | Native |
| --- | ---: | ---: |
| Streaming main-thread CPU, one core | 22.4% | 10.8% |
| Streaming hitch time ratio | 150.5 ms/s | 59.4 ms/s |
| Streaming peak physical footprint | 202.3 MiB | 181.5 MiB |
| Streaming peak RSS | 221.4 MiB | 199.7 MiB |
| Rich-scroll main-thread CPU | 47.0% | 18.0% |
| Rich-scroll hitch time ratio | 15.7 ms/s | 34.8 ms/s |
| Rich-scroll step p50 | 4.3 ms | 0.2 ms |
| Rich-scroll step p95 | 5.6 ms | 7.1 ms |
| Rich-scroll peak RSS | 213.6 MiB | 186.5 MiB |

### All pairs

| Pair | Streaming hitches, main → native | Rich-scroll hitches, main → native | Rich p95, main → native | Rich steps over 16 ms, main → native |
| --- | --- | --- | --- | --- |
| 1 | 150.5 → 78.5 ms/s | 101.9 → 34.8 ms/s | 7.2 → 7.1 ms | 9 → 1 / 600 |
| 2 | 134.7 → 59.4 ms/s | 15.7 → 27.8 ms/s | 5.6 → 5.9 ms | 0 → 0 / 600 |
| 3 | 205.4 → 33.4 ms/s | 9.6 → 44.3 ms/s | 5.5 → 7.2 ms | 0 → 3 / 600 |

Every native streaming run exceeds the under-10 ms/s target. Rich-scroll hitches and p95 regress in two
of three pairs. The first main scroll run is an outlier, not a reason to hide the two regressions.
Native streaming retains one 6-point newest-row reversal per run, with zero bottom-gap changes; main
has zero reversals but 27/33/22 bottom-gap changes. These are different anchoring observations, not parity.

All native rich runs ended bounded: viewport top 5,569, bottom/document 6,202; five mounted cells, nine
created, 85 bindings, 110 measurements, 49 height transactions and 43 height-cache entries. Canonical
history is large but the normal initial history window is retained. This does not prove 1,000/10,000
actually revealed rows or one giant message/work-row lifetime.

## Attribution and rejected experiments

The first tracking-region lifetime candidate had no reliable hitch win and worse rich p95 in all three
matched native/native pairs. It was reverted, including its test; it is not in the production patch.

PID-attached Time Profiler and Animation Hitches probes located AppKit layout/display/commit work, but
inclusive CA samples do not independently attribute transaction overhead. Instruments app-update ranges
can include normal main-run-loop idle; overlapping `Blocked` time is not proof of synchronous I/O.
Frame stages must be joined by `(display, swap-id)`, with containment duplicates removed. Other displays
must not be assigned to the transcript without ownership evidence.

The temporary generation/window trace found the duplicate graph. It and all temporary source hooks
were removed before the measured release build. It did not change scheduling or content. One combined
Instruments configuration failed internally with a `backtrace`/`tagged-backtrace` schema mismatch; that
capture was rejected, not described as an app failure or a performance result.

### Generation-correlated commits

A separate frozen single-scene diagnostic combined Activity Monitor, Points of Interest and Core Animation
Commits, without Sampler. It recorded 2,077 bounded events with zero dropped, one streaming source with
40 generations, and 29 completely captured generations (12–40). Sequence alignment uses metadata's raw
`uint64`, not its locale-formatted `seq=1 000` string. The initial formatted-string parser incorrectly
reported 411 markers; the corrected parser matches 1,486 unique markers, rejects conflicting duplicate
timestamps and has 18.75 µs p95 / 76.67 µs maximum clock-alignment residual. Generation coverage and the
ordering below are unchanged by that correction.

Nine of 29 generations (15, 16, 17, 25, 27, 28, 35, 39, 40) have a main-thread CA commit after prepared
text application but before the table's new height is installed. For generation 17, relative to source:
application completes at 5.60 ms, a commit spans 6.93–22.41 ms, height installation is noted at 22.51 ms,
then a 3.69 ms commit starts at 23.86 ms. The late-height group has a median 26 sizing proposals versus
12 in the other group, with no viewport changes.

This identifies a narrow scheduling experiment: commit a completed async preparation's known height
before the next commit, while preserving ordinary binding/layout/artifact deferral. It does **not** prove
that the first commit presented an old-height frame, that height installation caused all subsequent
commit cost, or that the change improves hitches. Tiny later commits remain unattributed. The 7.57 ms
captured main-thread commit p95 is not a presentation-hitch measurement.

[Bounded correlation data, complete-generation mapping and confidence limits](benchmarks/native-transcript-commit-correlation-2026-10-21.json).

### Rejected prepared-height experiment

The candidate gave successful async Markdown preparation a dedicated callback, after prepared state and
task cleanup. The controller immediately installed that row's height only outside binding/update/flush
and with no unrelated pending item. Generation fencing and a shared reentrant flush guard preserved
later pending work; ordinary binding, layout and artifact callbacks remained deferred. It did not change
source cadence, content, selections, sizing rules or the opt-in default.

Both frozen native release binaries used the repaired scene fixture, requested 1280×820 content size,
and had no profiler or trace hooks. After one rich warmup each, three alternating pairs per workload ran
on AC and an unlocked built-in 120 Hz display. An earlier attempt stopped at its initial lock guard,
before any warmup, window or measurement; none of its output is a sample. The valid run passed every
pre/post-run lock and power guard, with no recorded thermal/performance warning. A process-snapshot
`sort | head` pipeline emitted a broken-pipe notice once; it did not affect the app run or its output.

| Pair | Streaming hitches, before → candidate | Rich hitches, before → candidate | Rich p95, before → candidate | Rich steps over 16 ms, before → candidate |
| --- | --- | --- | --- | --- |
| 1 | 50.9 → 52.6 ms/s | 39.1 → 53.1 ms/s | 7.3 → 8.3 ms | 4 → 4 / 600 |
| 2 | 50.1 → 40.9 ms/s | 47.8 → 33.0 ms/s | 8.0 → 6.0 ms | 2 → 0 / 600 |
| 3 | 48.5 → 77.8 ms/s | 46.9 → 56.5 ms/s | 7.8 → 8.5 ms | 4 → 2 / 600 |

Median streaming main-thread CPU improved 11.0→9.6%, but hitch time regressed 50.1→52.6 ms/s and
peak RSS rose 187.6→199.8 MiB. Physical footprint was effectively unchanged at 181.0→180.5 MiB.
Rich main-thread CPU rose 19.7→21.1%, hitches 46.9→53.1 ms/s and p95 7.8→8.3 ms. Rich RSS fell
186.4→175.1 MiB. These mixed metrics are not a smoothness win. Streaming had zero bottom-gap changes
in all runs; before had one 6-point reversal per run and candidate had 1/0/1. The reversal remains unresolved.
All runs ended at the same document/viewport positions for their workload. Rich runs retained exactly
the same five mounted/nine created cells, 85 bindings, 110 measurements and 49 height transactions;
streaming ended with 42 height transactions on both sides. Moving completion timing did not establish
less total layout/commit work.

The candidate regresses hitches in two pairs for each workload and rich p95 in two pairs. It and its new
tests were **reverted**, rather than retained for lower CPU alone. Four new message/lifecycle fixtures
were syntax-checked but not compiled or run, per the CI-only native-test rule. Read-only review found no
obvious source blocker but identified missing controller nested-flush/drain coverage and a weak post-await
timing assertion; those would have required stronger tests before retaining the candidate. They are not
claimed as passing regression coverage. No further causal profile is claimed for the rejected candidate.

[All raw summaries, binary/diff/runner hashes and limitations](benchmarks/native-transcript-prepared-height-2026-10-21.json).

## Verification and remaining gates

Main and native release builds, SwiftLint, syntax, font-role and whitespace checks passed. The new
window-selection regression fixtures are CI-only and were not compiled or executed locally. The parent
native-row head `f6c09610` separately passed its actual macOS CI, including the broad 1,338 tests and
308-test UI partition. That does not pre-validate these new fixtures.

No renderer optimization or default-switch acceptance is claimed. Remaining work includes actual hitch
attribution/fixes, selection through recycling, keyboard/VoiceOver, focused editor and artifact lifetimes,
dark/Reduce Motion, artifact edge scrolling/late sizing/teardown, and large revealed histories. The
production relevance of retained hidden-window rendering is a separate investigation: manual fixture
publications alone do not prove a production subscription leak.

## Provenance

- Main binary SHA-256: `05ad20005728174a7bf061dd045a61301e8c679d22279445e1c739dafeeebb5d`.
  UUID: `5E6E5E16-B906-3FB9-966D-9995264B5055`.
- Native binary SHA-256: `70b5036dfc51cca4203932652e16e525495e572bd33af11441a105bff3d93d30`.
  UUID: `DF810183-46A0-300B-BDA1-D46CFE1ED15B`.
- Frozen runner SHA-256: `511fecbe0960a43b0fb269198cb142cf21f5dbdcfd49fac11a9756b232e97e95`.
- Raw summaries, per-run output hashes and limitations:
  [native-transcript-single-scene-2026-10-21.json](benchmarks/native-transcript-single-scene-2026-10-21.json).

**Measurement verdict:** lower CPU and memory, but not smoothness acceptance. The recommendation at the
time was to retain the old default. The later default switch does not establish a renderer performance fix.
