# Inline native visuals

The conversation's job is to make an exact published result usable without a
navigation detour. Native content sits on the conversation surface, with its
title/revision and quiet Source and Expand actions. Source reveals an exact-copy
action; errors reveal Reload. There is no diagnostic toolbar or outer card.
Legacy HTML/React remain inert stored source, not future rendering fallbacks.

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
* Adapt: its lazy retained-view pattern (`RETAINED_VISUALS = 8`) becomes at most
  two **paint-visible** readers and eight small closed reader-state owners.
  Pilot keeps its stricter exact revision and hello identity checks. Expansion
  transfers the same reader entity to the existing pane, not a cloned VM.
  Existing Kit buttons, checkbox, slider, charts and canvas retain their typed
  event/version checks. Preview height is bounded with scrolling and deliberate
  expansion, not arbitrary full-tree transcript growth or scale-to-fit text.
* Avoid: MonoCode's synchronous in-process `VisualRuntime::new` / dispatch,
  source-based document identity, hand-built control styling and 3D scene/orbit
  handling. `scene.rs` was audited as a boundary, not adopted. No browser,
  WebView, rquickjs or new runtime is linked into Pilot's UI process.

This implementation is independently written against Pilot's existing reader
and renderer. No MonoCode source was copied or translated.

Swift reference: `ArtifactCard` uses visibility-driven `ArtifactContent`, pinned
`latest: false`, and remembered inline size. `VisualArtifactContent` grows the
native tree with the transcript; Next deliberately retains a bounded viewport
for this first slice rather than adopting uncapped layout work.

## Ownership and bounds

`inline_visual_transcript.rs` admits only final-layout visible current-chat pinned
rows, after the frame. Hydrating history alone starts nothing. Membership is
sampled on scroll/geometry/transcript changes, not empty cached-control redraws.
Duplicate pins
share one owner and one mounted control tree. At most two distinct visible
previews are admitted; additional rows keep an explicit Open path. Scrolling
away closes readers, preserving bounded local state by exact revision. New
readers wait for canceled readers' completion receivers before starting. The
existing process semaphore, sandbox attestation, deadline and kill/reap behavior
are unchanged. The cache never retains a worker for an offscreen artifact.
Untyped pin reads are serialized through the existing single image-envelope
permit until their exact metadata arrives; this does not raise image limits.

`inline_visual.rs` is presentation on `ArtifactPane`, reusing its off-UI worker,
scene validator, native renderer, slider pacing and generation/state-version
fences. The fixed 440pt viewport keeps row geometry stable during load, controls
and tool events. Content scrolls at actual size rather than shrinking charts.
Source shows at most 8,192 characters, labels that limit and copies exact source.
Native source selection/copy stays available. The existing raster renderer and
off-UI source-copy path are reused when an untyped pin resolves to an image.
Pane expansion preserves local state and source mode. Back closes the pane;
the visible inline reader resumes from that exact revision's remembered state.

Nothing is written to conversation history by a visual control. No control can
run tools, access files/network or change revision. Host/chat changes fence the
whole inline cache. Unsupported stored sources remain accessible without a
fallback execution path. The full revision picker/latest-follow/export work,
additional renderer/control corpus, Mermaid, shaders and 3D are not this slice.

## Verification

Smallest matching selection (real confined helper, synthetic GET-only server,
offscreen production LocalViewer, no real Local profile):

```sh
PILOT_NEXT_INLINE_DIR=/tmp/inline-captures python3 scripts/check-scoped.py \
  --unit artifact_view::inline_visual --test inline_visual --lint
```

The library tests target exact provenance, stale callbacks, retired surfaces and
presentation transfer. The native target covers the 680/1100 light/dark mounted
matrix, native controls, keyboard activation, slider dragging, table/canvas
scrolling, exact source and selection, pinning, Find, prepend, pane transfer,
offscreen closure, duplicate/multiple pins, cache eviction and inert legacy data.
No performance, visible smoothness, OS IME, Linux or release acceptance is
implied by these offscreen checks. See the task receipt for actual results.
