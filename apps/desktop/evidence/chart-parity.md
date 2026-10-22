# Bounded signed bars and positioned chart ticks

2026-10-22. Incremental native artifact presentation, not full viewer parity.
Apple M3 Pro/36 GiB, macOS 27, Kit 0.8.0/GPUI 0.3.9, Rust 1.98.1.
All checked views/data are synthetic; no visible unattended app, real content,
canonical mutation, backend/helper protocol change or default switch.

## Delivered subset

Read Swift `VisualArtifactView.swift`'s `VisualChartView` and Theme chart tokens
as references. Signed stacked bars accumulate positive and negative values
separately in series order, keep null gaps, and share a category center/width
instead of being drawn as grouped bars. Zero values remain zero-height.
Automatic domains include cumulative stack endpoints, not individual values.
Explicit bar domains clip each interval's base/end without moving its category.
Overflow/nonfinite cumulative sums produce a node-local unsupported message;
source/data and other nodes remain intact.

X-axis tick marks and label slots use actual normalized positions: bar centers,
line category positions, or numeric scatter extrema. Unsorted scatter input no
longer labels the left/right bounds with the first/last input values; constant
numeric domains have one centered label. Dense categorical labels remain sparse,
and label/name/unit text keeps its existing 80-character display cap. X labels
and explicit Y labels are now shown. This is not a complete axis/hover engine.

Shared visual tokens now match Swift's blue/amber/emerald/violet/rose/cyan palette
in light/dark. Native pixel inspection caught Kit's default monochrome-blue ramp;
tests now assert hue families as well as different colors. Visual accent uses
blue, independently of deliberately neutral app chrome. Text-weight semantic
success/warning follow the Swift visual tokens.

## Bounds and unchanged authority

- Original 2,048-point per-chart display budget remains.
- Precomputed chart plans now admit at most 4,096 points across a scene, matching
  the existing renderer's total unit ceiling. The existing mixed text/table/plot
  renderer budget is unchanged, not raised. Unsupported plans consume no geometry
  admission; source nodes are retained and over-budget nodes explain the limit.
- Finite normalized bar rectangles remain inside [0,1]. Planning is off UI;
  no generated source executes on UI and no new I/O, capability or runtime exists.
- Existing strict parent schema/state/events, confined helper, kill/reap/fresh
  recovery, pinned reference provenance and revision caches remain unchanged.

Duplicate categorical grouping, stacked areas and out-of-domain line/area/scatter
clipping remain explicit unsupported cases, rather than false approximations.
Native hover/readouts, detailed Y ticks/text metrics and duplicate-series-name
grouping are not parity claims.

## Verification

Focused model tests cover signed bases/totals, null/zero values, clipped intervals,
finite/extreme/constant ranges, overflow, sparse-label budgets and numeric domains.
The scene test retains all five 2,000-point source nodes while admitting only two
plans; an unsupported sibling does not consume admission for a later valid node.

The native expected-tree corpus now has **56** narrow/wide/light/dark scenes,
adding signed stacks, unsorted numeric scatter, clipped signed stacks and sibling
plots with independently scoped element identities. Actual
mounted plot pixels at the same category center distinguish blue positive,
amber cumulative and emerald negative layers, including explicit-domain clipping.
These are production GPUI views/native text/GPU, not SVG approximations or mock
platform images. No generated source execution is inferred from expected trees.

Full `scripts/check.sh` passes: **114 library tests, 1 ignored**, fixture/browser,
16 chrome scenes, 56 visual scenes, disclosure/thinking and style/lifetime suites,
strict app/helper/probe Clippy, formatting and locked helper build. Four runner
tests, locked app build and separate-engine symbols also pass. The existing
`block 0.1.6` future-incompatibility warning remains. Native captures/logs
remain private/ignored; session artifacts use only synthetic captures. The
separately labelled SwiftUI chart artifact is a static mock, not GPUI evidence.

## Remaining work

This is only the chart portion of the larger artifact backlog. Slider dragging/
coalescing, per-run typography, complete canvas transforms/text/animation/pointer
scheduling, Mermaid candidate/license/corpus, safe prepared image/SwiftUI decoding
and private durable reader state are still incomplete. OS IME, macOS 15 hardware,
visible performance and helper-inclusive matched aggregate RSS remain unverified.
There is no claimed speedup, memory-gate pass or replacement acceptance.
Linux/Wayland validation is deferred and not a delivery gate; Linux generated
source execution remains disabled/fail-closed. HTML/React/browser libraries,
artifact shaders, terminal, iOS, release/updater/default switch and Swift removal
remain outside this slice.

```sh
cd apps/desktop
bash scripts/check.sh
PILOT_NEXT_VISUAL_DIR=evidence/local/chart-parity-captures \
  bash scripts/cargo.sh test --locked --test visuals
```
