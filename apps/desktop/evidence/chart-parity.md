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

Duplicate categorical grouping was at first an explicit unsupported case (see
below for its later support). Out-of-domain line/area/scatter values
were later supported (2026-10-28): each gap-free run is split at its exact edge
crossings (scaled like the domain, so extreme finite values stay finite), strokes
draw only inside the domain, area fills hold at the edges, and out-of-domain
scatter points and hover dots are hidden while readouts keep published values.
Swift Charts does not clip these marks; the native plot deliberately does. Visual
case 15 checks actual pixels at 680/1100 light/dark and the pointer readout.

Stacked areas were later supported (2026-10-28). A Swift Charts fixture
(`AreaMark` stacking `.standard`, rendered offscreen and sampled) showed each
value stacks on the earlier values of its sign at that x, so bands diverge from
zero like stacked bars, and lower/upper edges interpolate linearly between x
positions. Swift drops null points: other series stack as if the value were
absent, but the series' own band bridges the null and overlaps the bands drawn
after it. Native keeps the stacking and draws a null as a gap in that series'
band instead (no overlap), matching native line/area gaps. Each band is one
closed outline: the clipped top edge, then the clipped bottom edge reversed,
reusing the same edge-crossing clip; bands are opaque like Swift. Readouts and
keyboard steps keep published values; hover dots sit on band tops. Visual case
16 checks band colors by sign, the null gap, top-edge clipping and the readout at
680/1100 light/dark.

Repeated category labels were later supported (2026-10-28), following Swift's
source (`VisualChartView`; no Swift fixture was run for this slice). Swift dedups
the categorical x domain in first-seen order and plots every entry at its label,
so marks sharing a label meet there. Native does the same: each entry keeps its
own source values and takes its category's position; axis labels and the dense
12-label rule count categories, not entries. Bars at one category stack by sign,
like Swift Charts' default bar stacking: across series when `stacked`, otherwise
within each series' own grouped bar (single-series charts included). Lines and
areas follow data order, so a repeated label turns the line back to that
category, and stacked areas stack the repeat on the category's earlier values.
Each direction of an area run fills as its own band (split where x turns or
stays), so even-odd filling never cuts holes where the run folds back. Nulls
remain gaps. The pointer reads the category's first entry with a value in entry
order; Swift takes the first point in series-then-entry order, which differs
only when the first series is null at the first repeat. Arrow keys still visit
every entry left to right, repeats in entry order. Visual case 17 checks
grouped-bar stacking by sign, the turning line and pointer readouts at 680/1100
light/dark; the chart keyboard probe steps through a repeated category's entries
and their values.
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

The later [native slider slice](slider-interaction.md) implements bounded dragging
and coalescing; its evidence and limitations supersede that item below only.

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
