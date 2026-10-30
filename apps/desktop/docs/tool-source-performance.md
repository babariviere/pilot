# Large tool source, hidden native measurements

Tool Code, Command and Arguments use the existing literal `TextViewState::plain`
path, not generated HTML. The same text state, typography, manual call disclosure,
canonical call identity, nested scroll owner and exact-source Copy button remain.
Output's header handling/failure wash and diff presentation are unchanged. There
is no source limit, omitted suffix, new renderer or backend change.

The narrow Base patch avoids `LineLayout::x_for_index` for selection hit-box rows
entirely outside the current paint mask. Previously it scanned a huge unwrapped
line twice for **every** wrapped row, then discarded invisible rectangles. The
skipped rectangles already had empty intersection with the mask. Text, shaping,
wrap boundaries, visible hit boxes and full-source selection/copy are unchanged.

## Method and limits

2026-10-30, Mac15,6, macOS27.2, Rust1.98.1, Kit0.8.1/GPUI0.3.10,
existing unoptimized dev/test profile, private target, mbx CPU2/4GiB admission
(not an OS RSS limit). Free disk exceeded86GiB. No visible window, real Local
transport, provider, app/service installation or restart was used.

`tool_arguments_probe.rs`, selected through the existing `disclosure` native
target, mounts the actual synthetic LocalViewer root with native text shaping
and offscreen rendering. Each arm covers680/1100pt, light/dark, history/live,
344000-byte multiline Unicode script and352016-byte pretty JSON containing a
long escaped string. Each case has eight wheel events, including end and return
to top. Final checks assert changing inner offsets, end/top reachability, exact
full clipboard bytes, literal source and retained parser identity across updates.

`expand` includes the native click helper's frames and queued parser work.
`scroll_dispatch` includes `HeadlessAppContext::update_window`'s automatic dirty
frame, not just event handlers. Queued settling and an additional already-settled
draw are recorded separately. CPU is process user+system time, including workers.
Screenshots, filesystem writes and process sampling are outside measured stages.
There is **no isolated shaping-only measurement**, GPU/presentation timing,
frame-pacing/FPS qualification, release-build result or production smoothness claim.

## Observations

Baseline application source4c4bea59, then the same fixture with the scoped change.
One full matrix per arm, not a statistical performance guarantee. Ranges below
span the relevant cases; wheel figures are each case's median of eight samples.

| CPU-path wall time | Baseline | Final candidate |
| --- | ---: | ---: |
| JSON expansion |2049–3813ms |158–292ms |
| JSON wheel update,680pt |3414–3470ms |46–73ms |
| JSON wheel update,1100pt |1811–1887ms |44–53ms |
| JSON live update/settle |1811–3473ms |47–55ms |
| Script expansion |236–257ms |81–205ms |
| Script wheel update |39–42ms |37–54ms |

CPU broadly tracked wall time. Additional settled draws were roughly5–16ms;
queued settling was under0.02ms. Script scrolling did **not** demonstrate a gain.
Process peak RSS was200.6MiB before and193.2MiB after. These are cumulative
high-water marks from separate processes, not per-section retained memory,
allocation profiles, a reliable memory saving or an RSS ceiling.

An intermediate literal-text-only arm improved script expansion to82–93ms but
left JSON wheel updates at1.9–3.7s. A one-second native sample of that synthetic
process found217/275 main-thread samples in `Inline::text_line_bounds`, chiefly
glyph scans in `LineLayout::x_for_index`. This motivated the clipped-row patch,
rather than attributing the remaining cost to HTML parsing or shaping alone.

An added giant pointer-drag/copy exercise between timed phases subsequently
exceeded the1200s check deadline after one script case. It was removed from the
expansion/scroll matrix, not counted as a pass. Giant pointer-selection latency
remains unqualified; existing real selection/unmount tests and the new literal
Unicode/source-range/select-all retention test pass. No claim that this work
solves every large-source interaction is made.

## Reproduce

From `apps/desktop`, run serially with fresh output/report paths:

```sh
PILOT_NEXT_TOOL_ARGUMENTS_DIR=/tmp/tool-source-new \
  python3 scripts/check-scoped.py --unit transcript_view::work_tests \
  --test disclosure --lint --report /tmp/tool-source-new-check.json
```

The directory contains native captures and incrementally flushed `timings.ndjson`.
To profile only this synthetic process on macOS, additionally set
`PILOT_NEXT_TOOL_ARGUMENTS_PROFILE=1`: the fixture invokes `/usr/bin/sample` on
its own PID for one second during the first JSON scroll case and stops after it.
Do not compare that profiled case's timings with unprofiled arms. Do not run
against a visible window or a live profile.
