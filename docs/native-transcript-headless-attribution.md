# Native transcript: headless attribution follow-up

**Not a smoothness acceptance result. Keep the native transcript opt-in.**

The existing full-app release comparison still fails the rich-scroll and 4/s hitch gates. This
follow-up isolates a small avoidable binding operation. It does not establish the cause of all the
on-screen hitches, or claim that they are fixed.

## Method and boundary

- Base: main `e3bb09bd`, table layer `bd185d45`, native-row layer `c8cbd4de`.
- Release, same offline fixture, native transcript representable, bounded initial history window.
- Rich scrolling: 600 steps, 40 pt/step, nominal 16 ms deadlines, up then down.
- Streaming: 40 Markdown deltas, 100 characters each, nominal 4/s.
- A temporary prohibited-activation entrypoint hosts only `NativeTranscriptSection`, with no app
  window, composer, sidebar or viewer. Viewports: 1024×713 pt for rich, 1024×686 pt for streaming.
- Full bitmap draws replace window drawing. This is intentionally different from on-screen dirty
  drawing/Core Animation. CPU, RSS, raster-step percentiles and samples are component attribution,
  not comparable with the full-app performance tables or display hitch ratios.
- The initial full-shell attempt was rejected when its zero-window guard tripped. Its sample traced
  allocation to the editable composer's TextKit 2 selection update and TextInputUI cursor window.
  The revised harness excludes that shell instead of allowing hidden windows. A separate minimal
  hosting/layout/bitmap probe reported zero windows at every stage.
- All four accepted before/after component runs exited 0 and reported `windows=0 active=false`. No Swift Testing
  suite was compiled or executed locally. The entrypoint, app-launch edits and raster harness are
  temporary and are not part of the production patch.

## Before attribution

The 10-second samples include warmup/startup. Counts are samples, not CPU milliseconds; groups overlap.
Waiting leaves are excluded from the following counts.

| Inclusive main-thread sample group | Rich | 4/s |
| --- | ---: | ---: |
| All non-waiting samples | 3,102 | 874 |
| Forced bitmap drawing | 2,458 | 496 |
| Height transactions | 36 | 95 |
| TextKit | 546 | 211 |
| Cell binding | 85 | 5 |
| Native clip scrolling | 46 | 6 |
| Tracking areas | 4 | 3 |

Most rich cost belongs to the artificial raster path. It is not evidence for changing production
drawing or caching. Markdown parsing remains off-main. The samples do not justify a new row pool,
prefetch policy or height scheduler, so those were not added.

An attributable call site remains: native prose binding resets a text view's selection to an empty
range even when it already has that range. The explicit call at the old
`NativeMarkdownMessage.swift:272` appears directly in the AppKit selection setter stacks for both
workloads. Necessary TextKit selection updates after text-storage edits are separate and are left untouched.

## Focused change

Skip a rebind reset only when there is exactly one empty range at location zero with downstream
affinity. Still perform the reset for a selected range, displaced caret, multiple ranges or different
affinity. Apply the same helper at the existing prose, code and table rebinding sites. Selection
owners/keys, source, focus handling, styling, content, cadence and sizing do not change.

Added fixtures cover skipped resets and real ranges/carets, plus affinity and multiple ranges.
Existing row reuse and shared-selection fixtures remain the interaction coverage.

## After and verification

Production candidate: `a16dbb1dca7c3753e840b1619065fd8150e3404b`. The identical component runner passed
both workloads after the change, with zero windows and no activation.

| Component-only metric, one profiled pair | Before | After |
| --- | ---: | ---: |
| Rich main-thread CPU, one core | 37.3% | 35.5% |
| Rich forced-raster step p50 | 6.7 ms | 6.1 ms |
| Rich forced-raster step p95 | 12.2 ms | 12.2 ms |
| Rich steps above 16 ms | 7/600 | 8/600 |
| Rich peak RSS | 97.8 MiB | 97.8 MiB |
| 4/s main-thread CPU | 5.2% | 4.3% |
| 4/s peak RSS | 98.5 MiB | 98.4 MiB |

**Do not assign those differences to the reset guard.** This is one non-alternating component pair
with profiler overhead and cold-runtime/page-cache differences. Other phases vary substantially,
including a 533.7 ms awaited transcript-apply interval in the before run (async wall time includes
queueing). Raster-step p95 is unchanged and the count above 16 ms increases. There is no demonstrated
hitch fix or reliable speedup estimate.

Rich document/viewport geometry is identical: document bottom 6,202 pt, viewport top 5,489 pt, five
mounted cells, ten created cells, 43 height-cache entries. After streaming: 40 publications, 40
preparations, 57 text updates and 118 text measurements. This does not verify full-app display cadence,
focus, selection interaction or large revealed history.

Temporary entrypoint and fixture edits were removed before the production commit.
Swift syntax, font-role and whitespace checks pass. The normal-entrypoint release build and full
SwiftLint passed for the selection-reset candidate. Native Swift tests remain CI-only; the added fixtures have not been compiled or
run locally. No on-screen pairs have been authorized or run for this change.

Next: obtain permission for three alternating unlocked on-screen main/native pairs and separate
PID-attached profiling. The existing full-app no-go verdict remains unchanged.

## Provenance

Accepted before executable SHA-256:
`ca926c4bf4e4b254f8f3ade333740663be0b0986f5d6aaf6ccb047916b89fef7`.
Mach-O UUID: `36B595B8-EE08-3805-B82C-D44AB07F7B60`.
Temporary harness patch SHA-256:
`8af6f7ed32cb60467ea7ee134fd6229409789cab417c319be48c47b905b3d9f4`.
Runner SHA-256:
`c386986905d8ff7429a09a435eb65c1c541564f0988d683f2ea484d3da2c7323`.
Frozen local evidence: `/tmp/c912-headless-layout-v2/before/`.

After executable SHA-256:
`b3376410ee18305942310b3579e9e4248820e7633eb3311cefb94bb0e691a72a`.
Mach-O UUID: `8D52AAED-C48C-3CDF-A38F-07925BD8FFBF`.

[Raw component summaries, sample-group counts, hashes and limitations](benchmarks/native-transcript-headless-attribution-2026-10-20.json).
