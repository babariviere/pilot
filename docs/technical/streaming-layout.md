# Streaming text sizing

## Cause

The release streaming fixture was measuring text about 46,000 times in ten seconds at four updates per second.
Instruments Time Profiler with the Streaming signposts showed the path through
`NSHostingView.invalidateSizeConstraintsIfNecessary`, SwiftUI size probes and
`MessageSelectionTextView.layOut`. TextKit invalidated display when those probes resized its text container.
The paced fade was not the per-frame layout driver. It remains an opacity-only Core Animation animation.

A temporary width/cache diagnostic corrected the initial attribution to the streaming row: most misses were
unchanged, 22-character historical user bubbles. SwiftUI cycled through six widths, including 159, 660, 153,
264, 760 and 593 pt. The four-entry measurement cache evicted each width before its next use. Sizing also
changed the drawn container to each proposed width, then changed it back, feeding another layout pass.

The fix makes every measurement use a view-less TextKit layout sharing the same storage. Only placement
changes the drawn container. An eight-entry bounded cache retains the full probe cycle, so unchanged history
does not need measuring on each streamed chunk. Appended content still invalidates its cached sizes, and
native wrapping, selection, links, hugging bubbles and horizontally scrolling code remain native.
No animation, durable checkpoint cadence or transcript architecture changed.

## Method

MacBook Pro, built-in 120 Hz display, AC power, awake and unlocked. Both revisions used the same release
fixture and script, with three runs per case. Tables report the observed ranges, not selected best runs.
The before build is based on PR #891 (`d78e5b4d`); the after build contains the sizing fix. Before and after
runs have no Instruments recording or diagnostic logging enabled. Other agents and browser processes were
active on this shared Mac, so absolute results are noisier than the earlier quiet-host measurements in #891.

```sh
apps/macos/scripts/build.sh -c release
PILOT_BENCH_RUNS=3 apps/macos/scripts/bench-streaming.sh --no-build
```

The performance check uses synthetic data and never connects to a daemon or model provider. Instrumented
recordings were separate from the comparison runs; only aggregate findings are published, not raw Instruments
traces, which include the process environment. Temporary diagnostic code was removed.

## Before

| Case | Hitch time (ms/s) | Dropped frames | Longest gap (ms) | Main CPU | Text measurements |
| --- | ---: | ---: | ---: | ---: | ---: |
| 4/s × 100 chars | 465.0–600.1 | 553–717 | 181.0–265.7 | 52.7–60.4% | 45978–46380 |
| 10/s × 12 chars | 744.1–798.8 | 883–945 | 131.5–307.5 | 85.7–87.8% | 88255–95698 |
| 50/s × 12 chars | 904.3–920.5 | 1544–1760 | 291.6–412.1 | 95.1–98.4% | 128394–130483 |
| 100/s × 12 chars | 914.0–925.9 | 3630–4081 | 327.7–391.5 | 94.9–96.5% | 266441–272252 |
| scrolling | 91.8–141.4 | 105–162 | 40.2–198.5 | 46.9–52.5% | not collected |

The nominal streaming workload is ten seconds. Before the fix, the overloaded 50/s and 100/s cases
overrun their deadlines, so their dropped-frame counts cover longer than ten seconds. Hitch time ratio
normalizes by the actual display time.

## After

| Case | Hitch time (ms/s) | Dropped frames | Longest gap (ms) | Main CPU | Text measurements |
| --- | ---: | ---: | ---: | ---: | ---: |
| 4/s × 100 chars | 260.6–378.8 | 311–450 | 93.4–291.1 | 32.4–39.0% | 525–525 |
| 10/s × 12 chars | 387.5–488.3 | 463–578 | 70.8–250.4 | 48.8–55.7% | 568–571 |
| 50/s × 12 chars | 752.4–850.1 | 901–1326 | 153.3–265.8 | 93.9–98.9% | 1094–1316 |
| 100/s × 12 chars | 823.9–827.2 | 1866–1959 | 171.8–334.8 | 96.2–99.2% | 1866–2229 |
| scrolling | 183.5–582.9 | 210–664 | 55.9–217.8 | 50.5–54.6% | not collected |

At four updates/s, measurements fell by 98.9%, to exactly 525 in every run. Total measured text-layout
time fell from 1,576–2,066 ms to 39–52 ms per ten-second run. Main-thread CPU fell from 53–60% to 32–39%.
Physical footprint did not improve: 240–245 MiB before and 242–245 MiB after at four updates/s. The second
layout per text view is bounded but is not a memory optimization.

**The under-10 ms/s hitch target is not met.** Streaming still spends substantial time outside TextKit sizing.
The scrolling results are worse in this batch and cannot establish a scrolling improvement; background builds
and other app activity were present during portions of the after batch. These results must not be read as a
quiet-machine smoothness claim. No reused-cell transcript was built; further architecture changes need review.

## Alternating recheck without competing Swift builds

Three paired runs repeated the 4/s case and rich scrolling while holding the shared Swift verification slot,
excluding other Swift builds for the whole recheck. Pair 2 reversed the order. Other apps and background
agents remained active. These use the same saved before release and final after release, with no code changes.

| Pair | 4/s hitch time before → after (ms/s) | 4/s main CPU before → after | Text measures before → after |
| --- | ---: | ---: | ---: |
| 1 | 437.1 → 272.7 | 48.9% → 32.8% | 46,414 → 525 |
| 2 (after first) | 535.3 → 299.9 | 54.8% → 32.0% | 46,478 → 524 |
| 3 | 524.3 → 269.3 | 54.9% → 32.5% | 46,181 → 525 |

The median 4/s hitch ratio fell 48%, from 524.3 to 272.7 ms/s, but still misses the under-10 target.

| Pair | Scroll hitch time before → after (ms/s) | Scroll main CPU before → after | Scroll p50 / p95 before → after (ms) |
| --- | ---: | ---: | ---: |
| 1 | 193.6 → 158.8 | 48.0% → 45.2% | 3.6 / 8.8 → 3.7 / 7.9 |
| 2 (after first) | 414.8 → 464.8 | 44.7% → 48.9% | 4.5 / 11.4 → 4.9 / 13.2 |
| 3 | 258.2 → 252.6 | 59.0% → 60.3% | 4.4 / 8.0 → 4.6 / 8.2 |

Scrolling is mixed, rather than the large consistent regression suggested by the non-alternating batch.
Its median hitch ratio is 258.2 → 252.6 ms/s, main CPU 48.0% → 48.9%, p50 4.4 → 4.6 ms and p95
8.8 → 8.2 ms. This does not prove a scrolling improvement or rule out a small cost from the second layout.

## Remaining profile

Separate Time Profiler + Streaming signpost recordings sampled the same nine-second interior window at 4/s.
These are inclusive sampled milliseconds, so rows overlap and must not be added together:

| Stack | Before | After |
| --- | ---: | ---: |
| Main-thread running samples | 4,582 ms | 3,233 ms |
| Text measurement | 1,036 ms | 52 ms |
| `NSHostingView.layout` | 1,647 ms | 1,112 ms |
| Hosting size-constraint invalidation | 1,031 ms | 528 ms |
| Pending fade preparation | 28 ms | 24 ms |

The remaining cost is largely in SwiftUI/AppKit hosting/layout paths, not TextKit measurement or fade
preparation. This supports a focused follow-up on retained whole-window layout work. It does not by itself
prove that a reused-cell transcript is necessary. The narrow sizing change is not a claim of completed
streaming smoothness, and no broad transcript change is included.

## Verification

Regression tests in `MessageTextSelectionTests` cover drawn-container geometry remaining untouched by initial
and appended sizing probes, reuse of the complete six-width cycle, cache invalidation on content change,
wrapping, short bubbles and unwrapped code. The existing selection and Core Animation veil tests remain.

The final source builds through `apps/macos/scripts/build.sh -c release`; both full benchmark batches passed.
Swift parsing checks passed for the source and test file. Native test suites are delegated to remote CI,
not claimed as locally executed. The fixture screenshots show unchanged wrapping, code and table geometry.
