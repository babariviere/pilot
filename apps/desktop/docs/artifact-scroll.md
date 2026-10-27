# Artifact-heavy conversation scrolling

The conversation must keep every visible preview and the reading position. This
fix changes no admission, source/image limits, worker isolation, revision/state
identity, zoom, copy, selection or raster sizing policy.

## Measured causes and small fixes

* Plain `SelectableText` painting serialized the **whole window's** selection
  before and after each cell's projection. A table therefore scanned all
  participants twice per cell, even with no selection. The pinned Base patch now
  compares only that handle's cached projection. Copy callbacks run on explicit
  copy, not unrelated paint. No new cache or public API is introduced.
* Native tables left their width implicit and participated in vertical shrink
  measurement inside an already scrolling reader. Explicit full width and
  nonshrinking natural height avoid redundant intrinsic layout. The original
  flex rows, equal-width columns, wrapping, gaps, borders and content remain.

No-op reader updates, duplicate raster remeasurement, chart tessellation reuse,
cached fixed preview viewports, alternate grid rows and flattened grids were
also investigated. They did not materially improve the measured scroll stalls
or added needless complexity, and are **not shipped**.

## Native timed journey

Mac15,6, macOS27.0.1, Rust1.98.1, pinned mbx1.26.0, CPU2/4GiB admission,
private target, ordinary unoptimized dev profile (`opt-level=0`, `debug=0`).
The final control and candidate used the same synthetic source and1100×1000
hidden native macOS window, production foreground/background dispatchers,
real text system and Metal renderer. No app activation or visible window.

Six groups mix text,600-point line charts, a40×8 native table, Mermaid, canvas,
1024×640 raster pins and qualified conversation images. Every phase contains
160 wheel packets: cold first traversal, resident ±2pt movement, warmed repeated
traversal, and traversal with a growing synthetic tail every fourth packet.
The full traversals move42pt down for80 packets, then back. Streaming is
synthetic `replace_readonly` publication, not a real-provider stream or a claim
about Working animation. Source SHA-256:
`fd4c10f6b05a9df1c64256fc49a73a3cd332313b8c2d326d68ae02df5be4fd79`.

Each explicit `Window::draw` is timed separately from the whole wheel/update
turn. PNG capture/encoding and the16ms driver delay are outside those intervals.
These are synchronous native draw/layout work observations, **not VSync,
presentation, dropped-frame or visible-smoothness measurements**. Test-support
instrumentation is enabled in both arms. Cold helper/font/GPU first-use costs
are not interchangeable with warmed traversal costs.

| Draw work, ms (median / p95 / max) | Original | Fixed |
| --- | ---: | ---: |
| Cold |156.24 /167.86 /190.70 |47.26 /56.92 /60.72 |
| Resident |160.93 /184.50 /208.65 |47.87 /53.08 /60.00 |
| Warm re-entry |159.36 /168.94 /182.53 |47.51 /60.20 /76.74 |
| Growing tail |159.40 /170.23 /184.12 |47.54 /51.88 /58.74 |

Warm median work fell about70%. **This does not establish smooth60/120Hz dense
tables:**47–48ms median remains too high, and warmed maximum remains76.74ms.
Every resident sample still exceeded16.7ms in this deliberately dense dev
fixture. Remaining intrinsic-layout work needs a separate focused follow-up,
not a claim that these captures prove final performance acceptance.

A live6s main-thread sample of the original hidden native journey identified
both selection serialization and Taffy intrinsic layout. The small chart-only
fixture was not representative of the dense-table problem. Reader opens/closes
remained8 per traversal,0 while resident; warmed artifact reads stayed8. No
content was omitted to obtain the improvement.

64 raw native PNGs per final arm cover consecutive packets30–37 and108–115 in
each phase. Inspection and sampled-pixel translation checks found the expected
±84px movement (±4px resident at2× scale), without blanking or relayout jumps in
those sequences. These sample windows do not establish every possible journey.
Private raw records are `/tmp/pilot-artifact-scroll-native-final-{before,after}`.
The original control was run before rebasing onto `b522a09a`; the final candidate
also preserves the newer uncapped source admission, adapting only the fixture's
`Source::read` call. Fixture source, shapes, codec bounds and timed driver match.

Important measurement trap: `HeadlessAppContext`'s deterministic scheduler also
runs background tasks on its driving thread. Its `advance_clock`/drain timings
included PNG decode/BGRA conversion which runs off-UI in production. Those large
exploratory scheduler spikes were discarded as evidence of UI-thread stalls.

## Reproduce and check

Use the ordinary pinned wrapper, not Blaze or a release/profile override. The
example is opt-in and is not added to CI's native correctness registry. From
`apps/desktop`, with a fresh private capture directory:

```sh
PILOT_NEXT_ARTIFACT_SCROLL_DIR=/tmp/fresh-artifact-scroll \
python3 ../../scripts/verification-slot.py swift -- bash -c '
  set -eu
  python3 scripts/prepare-visual-worker.py
  bash scripts/cargo.sh build --locked -p pilot-visual-worker
  bash scripts/cargo.sh build --locked --features native-probes --example artifact_scroll_native
  cp target/dev/debug/pilot-visual-worker target/dev/debug/examples/pilot-visual-worker
  target/dev/debug/examples/artifact_scroll_native
'
```

The helper copy is only an adjacent executable in this worktree's private build
output, not an installed runtime. The example refuses artifact error placeholders.
For a control, revert only the feature's Base patch additions and table sizing
hunk in an isolated checkout, preserving the exact fixture and environment.

Focused verification, with rationale: the Base change affects plain selectable
text; table sizing affects artifact layout; image and inline-reader checks guard
the measured raster leaf, reader lifecycle and existing native controls.

```sh
python3 scripts/check-scoped.py --unit scroll::tests \
  --test inline_visual --test visuals --test conversation_images --lint
```

Two unit/UI checks cover320-cell paint without unrelated copy callbacks,
explicit callback copy, real pointer Unicode selection and changed selected text,
dense wrapping/equal columns, the last reachable row and exact `319` copy. The
full inline-reader matrix,56-scene native visual corpus and conversation-image
journeys passed. Raster row bottoms still equal fitted image bottoms, including
small/landscape/tall images, narrow/wide themes and pane transfer. Matching strict
Clippy and native example build passed. No full suite, release/profile change,
real Local mutation, installation, restart or Linux qualification is claimed.
