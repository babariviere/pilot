# Inline native visuals

The conversation's job is to make an exact published result usable without a
navigation detour. Native content sits on the conversation surface, with its
title/revision and quiet Expand action. Source/copy remain in the expanded pane;
errors reveal Reload. There is no diagnostic toolbar or outer card.
Legacy HTML, React, SwiftUI and shader revisions show a quiet "No preview" note;
Expand opens View source, history and exact copy. They remain inert stored
source, not future rendering fallbacks.

## Reference audit, retain / adapt / avoid

UX reference: MonoCode's **native** branch `mc/migrate-monocode-to-gpui`, pinned
[`ea6c8219bae954a3d8a9e8c536242b9531a683f7`](https://github.com/hardbeat920/monocode/tree/ea6c8219bae954a3d8a9e8c536242b9531a683f7).
Read `docs/native/visuals.md`, `crates/monocode-gpui/src/visuals.rs`,
`visuals/{scene,source}.rs`, `transcript/visuals.rs`, and
`crates/monocode-core/src/visual.rs` / `visual/sdk.js` at that revision.

* Retain: transcript-first results, semantic host colors/fonts, local controls,
  a concise title, unobtrusive source access, errors local to their visual.
  Its `VisualView::render` separates title/actions/content; its source view
  bounds long programs instead of stretching the conversation with code.
* Adapt: its lazy retained-view pattern (`RETAINED_VISUALS = 8`) becomes **paint-visible** readers and eight small closed reader-state owners,
  without a content-count gate.
  Pilot keeps its stricter exact revision and hello identity checks. Expansion
  transfers the same reader entity to the existing pane, not a cloned VM.
  Existing Kit buttons, checkbox, slider, charts and canvas retain their typed
  event/version checks. Visuals take their natural height in the conversation,
  never scale-to-fit text.
* Avoid: MonoCode's synchronous in-process `VisualRuntime::new` / dispatch,
  source-based document identity, hand-built control styling and 3D scene/orbit
  handling. `scene.rs` was audited as a boundary, not adopted. No browser,
  WebView, rquickjs or new runtime is linked into Pilot's UI process.

This implementation is independently written against Pilot's existing reader
and renderer. No MonoCode source was copied or translated.

Swift reference: `ArtifactCard` uses visibility-driven `ArtifactContent`, pinned
`latest: false`, and remembered inline size. `VisualArtifactContent` grows the
native tree with the transcript; Next does the same, with no height cap or inner
scroll viewport.

## Ownership and bounds

`inline_visual_transcript.rs` admits only final-layout visible current-chat pinned
rows, after the frame. Hydrating history alone starts nothing. Membership is
sampled on scroll/geometry/transcript changes, not empty cached-control redraws.
Duplicate pins
share one owner and one mounted control tree. All distinct visible previews are admitted. Worker concurrency is not a
content visibility limit. Scrolling
away closes readers, preserving bounded local state by exact revision. A decoded
still raster has no worker, so it stays bound to its row offscreen within the
same eight-entry cache; returning neither re-reads nor resizes it. New publication
entries carry the image's upright header size (`data.image`, PNG/JPEG/GIF), so the
row reserves its fitted frame before the read and keeps it through decode. Each
exact revision's decoded size is also remembered per host, so a re-read after cache
eviction keeps its geometry. Only legacy pins without a size, on first load, still
start at the 440pt viewport. The hint is layout only: the read keeps its identity,
kind and codec checks, and decoded pixels win. New
readers wait for canceled readers' completion receivers before starting. The
existing two-process semaphore queues FIFO. A reader keeps its helper warm for
2 s after each load, event or draw, so drags and runs of clicks skip process
start-up: in the debug-build inline probe, cold events/draws took ~22-27 ms
(p50) and warm ones ~0.5/0.2 ms. It releases the slot after that idle window, or immediately when
another reader is waiting for a slot or a restart fence wants it. A later request
on a released reader reconstructs closures from committed state in the same
bounded lane, verifies that the reconstructed tree and state match, then dispatches.
A mismatch fails closed rather than targeting different controls. Sandbox
attestation, source/wire limits, deadlines and kill/reap behavior remain intact. The cache never retains a worker for an offscreen artifact.
Untyped pin reads are serialized through the existing single image-envelope
permit until their exact metadata arrives; this does not raise image limits.

`inline_visual.rs` is presentation on `ArtifactPane`, reusing its off-UI worker,
scene validator, native renderer, slider pacing and generation/state-version
fences. A loaded native visual has its natural height, with no inner scrolling:
it reads like the rest of the conversation, which scrolls instead. When its laid-
out height changes (load, a control re-rendering a taller view), the pane emits
`Resized` and the transcript remeasures that row. Each exact revision's natural
height is remembered per host, so its placeholder and loading reader reserve it
when scrolled back or re-read. A visual revision never seen reserves nothing and
grows once when it loads; pins of unknown kind (possibly legacy rasters) keep the
440pt loading reserve.

Controls stay enabled while a visible canvas redraws. A control used during a
draw queues (latest wins) and dispatches when the draw's reply arrives, still
fenced by generation, state version and control type; a slider intent waits in
its existing pacing queue. Only an in-flight control event disables controls.
Animated canvases have no clock of their own: each paint that shows the canvas
advances its `t` (on the executor clock) and requests the next Draw once the
previous reply has arrived, so frames follow the display with one Draw in flight.
Offscreen, collapsed, source view or another presentation paint nothing, and a
hidden window does not advance `t`, so the animation pauses; on return `t`
advances at most 0.1 s. Under Reduce Motion it draws once at `t = 0`. Each frame
re-renders the reader. A draw over the helper's 8 ms limit is retried
once on a fresh helper; two in a row for the same canvas stop the reader with
the error until Retry.
Canvas frames are planned on the worker, not the UI thread: shapes become
triangles, and consecutive shapes of one color share a batch, so painting only
places vertices. Everything the published draw contract admits (20,000
commands, 100,000 path points, 64 Ki characters) is planned, with no command or
text cap, and shapes past the canvas edge are clipped. Two native guards remain,
each shown as the canvas error rather than a partial frame: a frame holds at
most 1,048,576 triangle vertices (about 110 MB of GPU vertex data per frame;
GPUI drops frames over 256 MiB), and a filled free-form path has at most 4,096
points and a bounded number of self-crossings, because sweep tessellation is
quadratic in the worst case. Strokes and built-in shapes are linear.
Decoded raster artifacts instead hug their aspect-fitted natural size, constrained
by the conversation width and Swift's 720pt image ceiling (48pt minimum target).
Small images no longer sit inside a 440pt blank box. Raster completion remeasures
its transcript row; clicking the image opens the existing expanded reader.
Expanded raster readers have Fit, 100%, zoom and Reset controls. Native chart,
canvas and Mermaid geometry is repainted at bounded scale, never rasterized.
Text, tables and controls keep native text/interaction metrics. The expanded
reader owns two-axis scrolling and middle-button drag panning; inline wheel
scrolling never zooms. The inline header intentionally has no Source button. The expanded pane retains
its existing source/provenance, native selection and exact-copy path. The existing
raster renderer is reused when an untyped pin resolves to an image.
Pane expansion preserves local state and source mode. Back closes the pane;
the visible inline reader resumes from that exact revision's remembered state.

Charts show Swift's hover readout: a rule at the x entry nearest the pointer
(the category under it, or the nearest scatter x with a value), dots on line and
area series, and a small card with the x label and every series' colour, name
and published value plus `unit`. Series with a gap there are omitted. The card
sits inside the plot, beside the rule on the side with more room. Hover is pane-
local presentation keyed by reader generation, presentation and node path: it
never reaches the visual's state or worker, takes focus or changes selection.
It follows re-rendered values while the pointer stays over the same chart, and
clears when the pointer leaves the plot or window, or content scrolls under it.

The plot is also a tab stop. Focusing it shows the readout for its first x
entry with a value; Left/Right step through entries with values in plot order
(scatter by x, not input order), and Home/End jump to the ends. Unmodified keys
only, and only while the plot itself has focus. While focused, the readout stays
when the pointer leaves or content scrolls, and the pointer can still move it.
Escape closes it (with no readout open, Escape propagates); blur closes it too.
There is no focus ring: the readout is the focus indication. Focus is scoped to
the reader generation, like the readout. `chart_keyboard` covers this beside a
real composing input at 520/1100 light/dark, inline and expanded:

```sh
PILOT_NEXT_IMAGE_DIR=/tmp/chart-keyboard python3 scripts/check-scoped.py \
  --unit visual_chart --native-probes --test chart_keyboard
```

Nothing is written to conversation history by a visual control. No control can
run tools, access files/network or change revision. Host/chat changes fence the
whole inline cache. Unsupported stored sources remain accessible without a
fallback execution path. The full revision picker/latest-follow/export work,
additional renderer/control corpus, Mermaid, shaders and 3D are not this slice.

## Verification

Measured dense-conversation scrolling causes, fixes and remaining limits are in
[Artifact-heavy conversation scrolling](artifact-scroll.md).

Smallest matching selection (real confined helper, synthetic GET-only server,
offscreen production LocalViewer, no real Local profile):

```sh
PILOT_NEXT_INLINE_DIR=/tmp/inline-captures python3 scripts/check-scoped.py \
  --unit artifact_view::inline_visual --test inline_visual --lint
```

The library tests target exact provenance, stale callbacks, retired surfaces and
presentation transfer. The native target covers the 680/1100 light/dark mounted
matrix, native controls, keyboard activation, slider dragging, chart hover
readout (values, placement, state-driven updates, leave/scroll, no dispatch or
focus change, expanded pane), table/canvas
scrolling, exact source and selection, pinning, Find, prepend, pane transfer,
offscreen closure, duplicate/multiple pins, cache eviction and inert legacy data.
No performance, visible smoothness, OS IME, Linux or release acceptance is
implied by these offscreen checks. See the task receipt for actual results.
