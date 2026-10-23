# Pane-wide native slider dispatch cadence

Scoped follow-up to [native slider interaction](slider-interaction.md), based on
the explicitly allocated `f666beed7c1397d1aa38c4abcd90aca9512e0132` source. This
does not include the older private cadence experiment, change its head, or reuse
its partial/failed checks. No generated-source execution, helper/worker/dependency patch, host bridge,
Local action, visible app or Linux verification is part of this work.

## Controller and authority

- All drag dispatches in an artifact pane share a monotonic **34 ms minimum
  enqueue gap**, conservatively below 30 Hz. A fast helper acknowledgement does
  not reset or bypass the rate gate; switching sliders does not create another
  budget. Late timers do not catch up with a burst.
- At most one callback is in flight, one latest intent is pending, and one
  cancellable wake is held. Overwriting the pending value reuses the existing
  deadline/task instead of spawning per-input/per-slider timers. No timer is
  needed while waiting for the in-flight callback's actual acknowledgement.
- The pending thumb/value remains separate from validated scene/state and the
  existing bounded state cache. Acknowledgements keep the latest thumb rather
  than moving it backwards to the intermediate value. Dispatch uses the current
  validated version and repeats descriptor/control/value/binding/generation
  checks, never generated execution on the UI thread.
- Returning to the current canonical value cancels that control's unsent intent
  and deadline. Returning to old canonical while a different value is still in
  flight remains pending, because the in-flight callback can still commit. A
  programmatic/canonical value from another slider cannot erase the pending one.
- Descriptor/range/key/label/unit changes, removed bindings, faults, reader end,
  owner/revision/navigation/close and stale wake tokens cannot flush old input.
  Cancellation does not reset the pane's dispatch budget. Existing fresh-worker
  Retry and helper validation/confinement/deadlines remain unchanged.
- Precise minus/plus and other explicit controls use the existing immediate
  typed-event path and cancel older unsent drag input. They are not drag-rate
  limited. The claim concerns drag callbacks, not every artifact command.

The rate bound limits dispatch count/concurrency, not handler cost, end-to-end
latency, frame pacing, CPU/RSS, or full artifact/app parity. Timer/task scheduling
can be slower than its deadline. No matched Swift speedup is claimed.

## Reproduce

Use the existing local mbx wrapper with CPU2/4GiB admission and private targets.
Heavy checks are serialized in the shared machine-wide verification slot.
Coordinate the native probe slot with the UI owner; do not run another visible
app or competing full native suite.

```sh
bash apps/desktop/scripts/cargo.sh fmt --all -- --check
bash apps/desktop/scripts/cargo.sh clippy --all-targets --locked -- -D warnings
bash apps/desktop/scripts/cargo.sh clippy --locked --features native-probes \
  --test controls -- -D warnings
bash apps/desktop/scripts/cargo.sh test --lib --locked visual_slider::tests -- --test-threads=1
bash apps/desktop/scripts/cargo.sh test --lib --locked artifact_view::tests -- --test-threads=1
# Only after the native slot is released:
bash apps/desktop/scripts/cargo.sh test --locked --features native-probes --test controls
```

Pure monotonic-clock cases cover 4,096 queued inputs, continuous immediate
acknowledgements across two sliders, fixed shared deadlines, canonical withdrawal,
busy/duplicate/invalid input and preserved numeric-grid boundaries. Controller
cases use the actual pane, faux reader, and deterministic GPUI timers to cover
the 33/34 ms boundary, one deadline despite continuous input, stale generation/
version/token/binding/descriptor, canonical adoption/removal, faults, ended
reader, precise stepper supersession and late wakes after close.

## Native proof method and limits

The native `controls` executable mounts the production LocalViewer/artifact pane
for lifecycle/pixels, and the same production ArtifactPane directly for cadence,
at 680/1100 points in light/dark with real native text/GPU and pointer dispatch,
but only a faux reader channel. It retains the earlier first/latest, actual
thumb pixels/bounds, exact stepper, rollback/replacement and close matrix, adding
canonical-return cancellation and cross-slider continuous-pointer/fast-ack cases.
The continuous case uses raw held-pointer moves with periodic real renders,
not a forced full render after every input. It asserts actual input has more
than 30 moves in a sampled one-second window and at least 90 sub-25 ms gaps.

HeadlessAppContext uses a **virtual TestDispatcher clock**, even with native
rendering. Its virtual advance alone is not real-time evidence. The pacing case
therefore advances only 8 virtual ms after at least 8 actual ms of explicit test
waiting, without catching up render time. It records both executor and actual
monotonic timestamps at the production enqueue point (bounded 512-entry,
native-probes-only trace), acknowledges every command immediately, and checks
both sliders share one budget. Virtual enqueue gaps must be >=34 ms, actual
gaps >=33 ms (explicit 1 ms observation tolerance), with no >30 dispatches in
any sampled half-open actual one-second window. This is conservative wall-paced
offscreen/faux evidence, not a real helper latency or visible performance test.

First native pass: all four native lifecycle cases and the existing 56-scene
artifact visual matrix passed. Its initial continuous harness rendered every
pointer move, yielding 181–210 ms actual enqueue gaps despite virtual 34 ms.
That was not adequate high-rate actual-input stress evidence. A probe-only
correction removed per-move forced rendering and added explicit actual input-rate
assertions. That correctly failed at 27 moves/actual second: GPUI test mode's
`App::flush_effects` still draws dirty windows on every update, and the unrelated
full transcript kept input below the budget under test. The cadence subcase now
mounts the same production ArtifactPane directly after the full-viewer matrix;
no framework patch or production/controller change was made. This is not a
full-app throughput claim. The corrected stress case then passed, as below.

## Final native results

Corrected native-probe strict checks and all four `controls` scenarios passed
on 2026-10-23. Each cadence case dispatched 120 actual native pointer moves,
alternated two sliders with immediate faux acknowledgements, and emitted 29
drag callbacks. At least 103/119 input gaps were under 25 ms, with the following
measured actual one-second input peaks and minimum enqueue spacings:

| Pane | Actual input peak / s | Virtual minimum gap | Actual minimum gap |
| --- | ---: | ---: | ---: |
| 680 light | 66 | 34 ms | 58.264 ms |
| 680 dark | 61 | 34 ms | 57.805 ms |
| 1100 light | 61 | 34 ms | 57.493 ms |
| 1100 dark | 64 | 34 ms | 53.899 ms |

Every sampled half-open actual one-second callback window contained <=30
enqueues. The production gate is 34 ms; the slower measured wall gaps include
offscreen rendering/harness overhead and are not a handler-latency target.
The full-viewer first/latest matrix still changes 9,260 / 14,540 track/thumb
pixels at narrow/wide sizes, preserves bounds and the latest thumb through
intermediate acknowledgement, and passes canonical-return/no-late-dispatch,
precise stepper, rollback/replacement/stale-binding/close phases. The earlier
56-scene native artifact regression pass is reused: only the timing probe
changed afterwards, not production state/controller/rendering code.

The production-tree regression passed **146 library tests / 2 opt-in disk
workloads ignored**, fmt/strict all-target and native-controls Clippy, plus
locked helper/app builds. Focused state/controller tests passed 5 + 4 cases.
Earlier transient formatting/import/mutability errors were corrected before
these passes. The existing `block 0.1.6` future-incompatibility warning and mbx
missing-input prediction warning do not change the source or reported results.
Existing platform/feature deferrals, exact callback schema and confinement remain.
