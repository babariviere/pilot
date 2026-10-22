# Reader-controlled disclosures and transient thinking

2026-10-22. Synthetic production views only, Apple M3 Pro/36 GiB, macOS27,
Kit0.8.0/GPUI0.3.9, Rust1.98.1. No visible app, real chat content, canonical
data writes, automated real actions, backend change or default switch.

## Disclosure diagnosis and fix

An opt-in native headless harness mounts the actual `LocalViewer` production
tree, native text and GPU renderer at620 and1100 logical pixels wide. It is not
the mock TestPlatform, a SwiftUI reconstruction or a live-window capture.

The before-fix reproduction has24 running tool calls and20 preceding Markdown
messages. Twenty sampled native frames per phase showed:

| Header top, logical px | Before | After |
| --- | ---: | ---: |
| Initial preview | 570 | 570 |
| Collapsed | 710 | 710 |
| Expanded | 38 | 710 |

Before the fix, following remained active on collapse/expansion. Relative
icon/text alignment stayed22.5px and group identity stayed fixed. Settled
samples did not show an intra-phase oscillation. This identifies a viewport/
follow displacement, not measured icon relayout or proof of every reported
back-and-forth. The before-fix mounted header-anchor regression failed.

GPUI's temporary Tail pause re-arms during bottom layout. Explicit disclosures
now hold the existing logical anchor in Normal mode. Streaming/measurement do
not release this reader intent. Latest, chat reset or actual scrolling to the
bottom re-arms Tail. Collapse still clamps if the old viewport would extend
past the shorter document. No blank-space/overscroll reserve is introduced.

Two initial hold iterations failed the native bottom-wheel regression: Kit's
ScrollBounce bypasses the list scroll callback, and `is_scrolled_to_end()` is
unknown while any offscreen height is unknown. Both event-derived scroll paths
now use the measured-coordinate scrollbar range. A bubbling wheel when content
fits also resumes following. Measurement never calls this resume path. Default
callers do no additional range lookup unless they opted into a disclosure hold.

The tracked Component patch has9 exact edits to one file, verified against the
unchanged original crate archive. Specification SHA-256:
`ff22c3bdae099e664682e74205800d5df0248f82dd90fbf1eb5fdecfd0a66cb4`.
Registry/cache/generated sources are not edited.

The native matrix samples20 frames per phase across18 phases at each width (720 frames): tail preview,
collapse/expand, streaming, prepend, repeated toggles (including12 successive
pointer toggles), manual reading, detail expansion,120-line streaming output,
detail collapse, wheel-bottom, offscreen unmount/remount, revealing the header,
another disclosure hold and Latest. Group identity and relative icon/text
positions are asserted. Expanded/streaming/prepended header remains710px;
manual reading/tall detail remains410px. Wheel-bottom and Latest resume Tail.
The existing bounce can move the viewport after genuine wheel input; that is
not claimed to be disclosure jitter or disabled by this patch.

## Thinking is activity, not a transcript body

Typed reasoning and whitespace-only assistant shells are filtered before
Message construction, block-alias allocation, Markdown, highlighting or view
creation. Mixed messages retain ordinary text/tool content, exact substantive
notes (including literal `Thinking:` text), source/copy and stable visible IDs.
The canonical daemon history/reasoning/provenance is unchanged. The UI projection
retains only marker types and bounded byte counters for omitted reasoning,
not its body. Required wire decoding, frame/content-index limits and aggregate
source-budget enforcement remain.

Active projected reasoning uses the composer's single existing activity slot:
`Thinking...` instead of `Working...`. Historical entries and reconnect snapshots
never create thinking activity. Text/tool progress, thinking-end, message/run
end, errors and Stop clear it. Stop/errors fence late reasoning deltas. Navigation
resets the indicator; Refresh latest/loading also clears the cached activity.
Deferred Stop activity notifications carry their original chat key, so an old
chat cannot suppress the newly selected chat. Reconnect identity/generation
fences remain in force.

Synthetic work-count evidence, not an overall CPU/smoothness benchmark:

-1024×4KiB reasoning deltas create0 assistant Messages,0 block aliases and0
  visible rows; their retained body is absent. Byte accounting saturates at the
  existing1MiB limit plus one sentinel byte rather than retaining4MiB of text.
- A faux HTTP/WS daemon exercises the actual background worker. The same1024
  deltas produce0 additional UI publications. A per-worker test-only counter
  proves this even if the bounded receiver coalesces publications. Only the
  subsequent terminal event publishes; existing transcript source is unchanged.
- Native mounted history→thinking→deltas has0 transcript rows and0 TextView
  states, exactly1 activity indicator and unchanged viewport height. The label
  changes in place, not through inserting/removing a transcript placeholder.
- Native tools/text/terminal/reconnect/Stop phases assert the corresponding
  single/no indicator. Synthetic composer pointer-Stop rejects late stale
  presentations and navigation clears its local fence. No real Stop is sent.

## Reproduction and verification

```sh
cd apps/desktop
bash scripts/check.sh
bash scripts/cargo.sh build --locked -p pilot-desktop
python3 -m unittest discover -s scripts -p test_measure_scaling.py

# Optional synthetic-only native captures. Keep outputs ignored/private.
PILOT_NEXT_DISCLOSURE_DIR=evidence/local/disclosure-captures \
  bash scripts/cargo.sh test --locked --features native-probes --test disclosure
```

The feature is opt-in and absent from normal builds. It only exposes this
synthetic production-root harness, not a real-data capture/transport capability.
Screenshots are actual GPUI with synthetic content. The separately published
static SwiftUI mock illustrates the activity layout only, not the regression.

Verified:106 library tests pass/1 explicit disk-I/O workload ignored;4 scaling
runner tests pass; formatting, strict app/helper Clippy and the explicit native
probe Clippy pass. Locked app/helper builds pass. Native fixture/browser,16 chrome
scenes,40 visual scenes and the disclosure/activity production-root matrix pass.
The dependency's existing `block0.1.6` future-incompatibility warning remains.

No native Wayland/macOS15,
live-window interaction, OS IME or visible scrolling-performance acceptance is
claimed. No general performance speedup, full styling/animation parity or
artifact expansion is part of this correction.
