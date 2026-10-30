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

## Pointer-selection follow-up

`tool_selection_probe.rs` separates pointer-down, pointer-move, pointer-up,
selected-text extraction, keyboard Copy and select-all Copy. Each stage flushes
a start marker before execution and wall/process-CPU timings after it. Each
process covers one source size/appearance/width/history choice. Its hidden
production root uses native shaping, not the unit-test text-system substitute.
The independent `scripts/measure-tool-selection.py` freezes that executable,
uses a credential-free environment and gives each case a30s deadline (maximum
60s), including confirmed owned-process-group cleanup on failure. Reports and
partial stage markers survive a deadline; a timed-out stage is never a pass.
The runner's synthetic tests cover frozen bytes, environment isolation and
deadline cleanup. Native measurements run serially under CPU2/4GiB mbx reserve,
not concurrently with another native measurement.

Plain selection retains the existing paragraph serializer, including its
terminal separator. The fixture checks its exact keyboard-copy bytes separately
from the selected source-byte range. Keyboard select-all retains its existing
rendered-paragraph formatting (no terminal source newline). Full-source Copy remains byte-for-byte
against the original script, including Unicode and its final newline. These
checks use the headless clipboard, not the macOS pasteboard or an OS IME.

The scoped candidate changes only the shared selection projector's line lookup.
Its character queries are nondecreasing UTF-8 offsets: current, next, next.
A local cursor advances through the same shaped native lines rather than
restarting at line zero twice per character. Native per-line glyph/wrap lookup,
selection midpoints, source states, serializers, logical identities, stale
fences and current bounds/scroll remain unchanged. The cursor is discarded
after each projection, so it introduces no cache or invalidation owner.
This specifically removes the quadratic multiline prefix scan. It does not
optimize native glyph lookup inside one enormous unwrapped line, and is not
a general large-source smoothness claim.

For one independently bounded case, from `apps/desktop`:

```sh
bash scripts/cargo.sh test --locked --features native-probes --test disclosure --no-run
# Use the executable printed above and its matching build-time patch checksum.
MBX_CACHE_DIR="$HOME/.cache/gpui-fixture-mbx-v1" MBX_SCHEDULER=1 \
MBX_SCHEDULER_CPUS=2 MBX_SCHEDULER_MEMORY=4GiB \
  .tools/bin/mbx reserve --cpus 2 --memory 4GiB -- \
  python3 scripts/measure-tool-selection.py <disclosure-executable> <fresh-directory> \
    --base-patch-sha256 <build-time-gpui-base-spec-sha256> --lines 64 --top-only
```

Start small. Increase to256/1024 lines only after inspecting the flushed
stages; use `--profile` for a separate one-second own-process CPU sample.
Remove `--top-only` to exercise current inner bounds/scroll at top, middle
and end. `--width 1100`, `--dark` and `--live` select independent cases.
Never treat a profiled sample or a deadline as a comparable completed timing.

### Paired observations

Same Mac15,6/dev profile and ce7df78e application base as above, independent
frozen before/after executables, one unprofiled case per size and arm. The
fixture was identical between these paired cases. Timings include helper frames
and automatic dirty draws, not isolated event handlers. CPU is process
user+system time; it closely tracked wall time in these unprofiled stages.

| Script bytes | Pointer move, before → after | Extraction, before → after | Keyboard Copy, before → after |
| --- | ---: | ---: | ---: |
|2752 |35.3 →27.5ms |4.3 →0.8ms |57.0 →28.4ms |
|11008 |147.3 →30.8ms |53.3 →2.7ms |258.3 →36.6ms |
|44032 |1799.1 →58.5ms |791.3 →11.3ms |3494.0 →82.5ms |

The original344000-byte script case expired at its independent10s process
deadline during `pointer_move`; owned-group cleanup was confirmed. This is
not a completed pointer timing, nor attribution of the historical1200s failure.
The candidate completed that same top-only case within10s: move283.6ms,
extraction83.5ms, keyboard Copy450.7ms, with exact range/copy assertions.
Paired small cases had identical source ranges and selected-byte counts.
The giant history case also reached the current inner top, middle and end,
selecting the corresponding source occurrence at each offset.

A separate one-second1024-line own-process sample placed selection-paint
stacks in `project_selection` calling `TextLayout::position_for_index`, mostly
repeated line-prefix iteration. The profiled arm and earlier fixture-only
serializer expectation failures are not counted as successful paired timings.

The improvement removes the demonstrated quadratic multiline scan; it does
**not** establish smooth pointer interaction. Hundreds of milliseconds remain
in the giant dev/native fixture. No FPS/frame-pacing, OS pasteboard/IME,
release-build, Linux or production acceptance is claimed.

Composition on the pinned37dd4d7a parent passed eight independently
bounded344000-byte cases (680/1100pt, light/dark, history/genuine live tool run),
each exercising top/middle/end, reverse drag and exact selected-source keyboard
Copy. Live output updates retained the canonical source entity, source range
and copy bytes. A reverse-drag helper itself takes roughly2s over its multiple
event/draw frames in this dev fixture, reinforcing the lack of smoothness
qualification. The scoped work17/readonly8 tests, normal hidden disclosure
journey, matching native/production library Clippy, plain production build,
changed-file rustfmt and two runner tests also passed. No live app, service,
provider, install/restart or visible benchmark was used.
After the subsequent memory-browser integration, the affected work/disclosure,
native/production lint, plain build and one narrow/dark/live giant case passed again.
