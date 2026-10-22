# Native slider interaction with bounded reader callbacks

2026-10-22. Follow-on to [bounded charts](chart-parity.md), not full artifact
parity. Synthetic data only, Apple M3 Pro/36 GiB, macOS 27, Kit 0.8.0/GPUI 0.3.9,
Rust 1.98.1. No visible app, real content, canonical mutation or backend change.

## Scope and authority

Visual sliders now have a native draggable track/thumb while preserving precise
minus/plus buttons. Value/unit text reflects the latest admitted user intent
while the isolated reader is pending, then its validated authoritative result.
The thumb stays responsive during its own callback and does not jump backward to
an intermediate acknowledgement. Other busy controls remain disabled.

Generated handlers still execute only in the existing confined helper. Native UI
only submits the existing typed numeric event after independent scene/control
validation; there is no new host bridge, runtime, permission or daemon write.

Native dragging uses a finite uniform grid of 1..1,000,000 integer tick indices,
mapped back to f64 values without converting extreme f64 endpoints into f32.
Finite endpoints, signed/subnormal/extreme ranges and fractional ordinary steps
are covered. A range/step that cannot safely form that grid keeps the original
precise steppers and explains why dragging is unavailable. This is a bounded
supported subset, not arbitrary numeric-grid parity.

Kit's built-in accessibility remains. The accessible label includes the actual
value/unit, but its numeric slider metadata is the internal tick index. Dedicated
AX/screen-reader parity remains deferred; no accessibility validation is claimed.

## Scheduling and lifetime

`visual_slider.rs` holds a fixed-capacity **one in-flight callback, one latest
queued value** flow. It is event-driven, without a per-slider polling timer.
Intermediate drag values overwrite the single pending slot. When the first
callback commits, the latest value is revalidated and sent with the **new**
scene version. This is intentional continuation of the same control, never
generic replay of arbitrary buttons or stale events.

Generation, full pinned artifact/revision ownership, binding serial and the
control's range/step/label/unit/key fence admission. Replacing or removing the
control, changing its descriptor, errors, reader exit, navigation/close or a new
revision discard pending input. Same/older-version snapshots do not manufacture
an acknowledgement. Initial creation, programmatic adoption and pointer release
do not submit duplicate events. A failed enqueue ends that reader generation;
an ended update stream clears pending state rather than leaving a forever-busy
control. Explicit Retry can reopen a fresh pinned reader if its channel ended.

Validated scene/state/provenance remain unchanged on failure. Pending values are
not written into the eight-entry validated reader-state cache and are not
persisted/replayed after close. Model/subscription entries are reconciled only
when scene/version/liveness changes and retained only for current bounded controls.

There is no callback-per-second guarantee: fast helpers may acknowledge at input
rate. Coalescing bounds concurrent/queued work; it is not an overall CPU, latency,
memory or speedup claim. Existing helper execution/deadline/kill/reap/fresh-process
limits are unchanged. Aggregate resource evidence remains a separate gap.

## Verification

Full `scripts/check.sh` passes: **118 library tests, 1 ignored**, fixture/browser,
16 chrome scenes, 56 visual scenes, 720-frame disclosure/activity and style/lifetime
matrices, plus four native slider scenarios with their lifecycle phases. Strict
app/helper/probe Clippy, formatting, locked builds, four scaling-runner tests and
separate-engine symbol checks pass. Existing `block 0.1.6` future warning remains.

- Pure grid/flow tests cover finite endpoints/steps/extreme ranges, unsupported
  grids, malformed input, 4,096 updates reduced to one latest slot, duplicates,
  busy-other-control rejection and faults.
- The actual pane/controller test covers no creation send, one active command,
  new-version dispatch, same/old snapshot fences, fault discard, semantic
  replacement, ended reader and close.
- An explicit native `controls` probe mounts the production `LocalViewer` and
  artifact pane at 680/1100 points, light/dark, using native text/GPU and real
  pointer dispatch. Its reader channel is **faux**, not generated execution.
- Across each eight-move drag, only first/latest commands are sent; actual
  track/thumb pixels change, the target bounds stay fixed, an intermediate ack
  cannot pull the thumb back, and release/adoption produce no duplicate event.
- The native matrix also covers exact stepper dispatch, fault rollback, recovery,
  descriptor/range replacement, stale binding rejection and close during pending
  input. Mounted endpoint-thumb bounds caught clipping; horizontal reserve now
  keeps the thumb and hover ring inside the pane.

Private captures/logs are ignored. Actual synthetic native image artifacts are
separate from the explicitly labelled static SwiftUI mock. Offscreen checks do
not prove visible interaction performance or OS IME/keyboard/platform acceptance.

```sh
cd apps/desktop
bash scripts/check.sh
PILOT_NEXT_SLIDER_DIR=evidence/local/slider-captures \
  bash scripts/cargo.sh test --locked --features native-probes --test controls
```

## Remaining work

Uniform-grid fallback, numerical accessibility metadata, detailed keyboard/OS
input validation, matched helper-inclusive resources and broader artifact parity
remain gaps. Canvas scheduling/transforms/text/pointer work, per-run typography,
Mermaid, safe prepared images and durable private reader state are not completed.
No Linux/Wayland validation was run or made a delivery gate; existing Linux
generated-source execution remains disabled. Browser/HTML/React, artifact shaders,
terminal, iOS, updater/release/default switch and Swift removal remain deferred.
