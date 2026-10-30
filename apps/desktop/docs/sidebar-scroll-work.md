# Sidebar wheel work

## Scope

The chat header is a fixed 48pt cached view, sized to the conversation's resolved
width. `LocalViewer` retains all state, exact IDs, callbacks and navigation guards.
The header observes actual owner, editor, mission-form and mission-context changes.
A sidebar wheel redraw is not an owner notification. Resize, theme and focus still
use GPUI's ordinary cache invalidation. No app-wide redraw suppression or prewarming.
The sidebar rows, fold clocks/list-height preparation and transcript are unchanged.

The first experiment cached the whole main pane. Although cheaper while wheeling,
GPUI's nested-cache refresh then rebuilt the transcript on an editor invalidation
and an owner-title update. That experiment was rejected, not shipped. The header
has no transcript/editor descendants, and regression checks retain their cache.

## Comparable hidden measurement (2026-10-30)

Source base: `954ef2dba1a9835a680a88db273ac21567d8fe4b`. Both variants use the
**same final binary**, including upstream changes and identical native-only timers.
The probe-only `PILOT_NEXT_SIDEBAR_SCROLL_EAGER_HEADER=1` control renders the same
header directly from LocalViewer, reproducing the previous eager composition.
The cached variant leaves that control unset. This control is absent from
non-probe production builds.
macOS 27.2, arm64, Apple M3 Pro; pinned Rust 1.98.1, ordinary **unoptimized dev**
profile, no build/profile overrides. Private targets, CPU2/4GiB mbx admission;
builds and native runs serialized. No app activation, visible window, Local
profile, provider, settings or service changes.

`sidebar_scroll_native` uses actual hidden GPUI, synthetic 240 chats at 1100×760,
170 down / 170 up / 170 down 40pt wheels, each followed by synchronous draw.
Three alternating before/after pairs, 1,530 measured frames per variant:

| Median | Before | After |
| --- | ---: | ---: |
| Main-thread CPU per wheel + draw | 13.585 ms | 13.150 ms |
| Process retired instructions | 116.624 M | 113.783 M |
| Header subtree executions | 1,530 | 0 |
| Transcript renders | 0 | 0 |

Per-run CPU medians: before 13.689 / 13.457 / 13.627 ms; after
12.830 / 12.933 / 13.854 ms. The pooled reduction is **3.2% CPU, 2.4% instructions**.
The third pair reversed the CPU improvement; timing is noisy, while every pair
retired fewer instructions and eliminated header work. These are descriptive
measurements, not a statistically qualified timing or smoothness claim.
Instruction counters are process-wide, not exclusive subtree counters.

Before-change inclusive subtree CPU medians (request-layout / prepaint / paint):

| Region | CPU, ms |
| --- | --- |
| Sidebar | 1.394 / 5.663 / 1.745 |
| List (inside sidebar) | 0.713 / 5.348 / 1.241 |
| Main pane | 0.562 / 0.434 / 1.273 |
| Header (inside main) | 0.111 / 0.046 / 0.096 |

These transparent wrappers do not add layout nodes. Request-layout includes
element construction, prepaint can include virtual-row layout, and the table
excludes work outside those regions. Nested rows are **not additive**. List work
still dominates; this is a small isolated reduction, not a full scroll fix.

## Reproduction and regression

```sh
bash scripts/cargo.sh build --locked --features native-probes --example sidebar_scroll_native
PILOT_NEXT_SIDEBAR_SCROLL_DIR=/tmp/sidebar-work \
PILOT_NEXT_SIDEBAR_SCROLL_ASSERT_ISOLATED=1 \
  target/dev/debug/examples/sidebar_scroll_native
```

Run under the shared CPU2/4GiB native reservation, not alongside another probe.
JSON contains each frame's CPU, draw, instruction, root/transcript render counts,
scroll offset and `regions_cpu_ms` arrays in the phase order above.
Set `PILOT_NEXT_SIDEBAR_SCROLL_EAGER_HEADER=1` without the isolation assertion
for a same-binary eager control. The isolation assertion failed on the original
baseline's first wheel and passes with header caching.

The `style` target also covers narrow/wide light/dark production windows: actual
wheel movement without header/transcript renders, retained focus and bounds,
owner/child invalidation, changed native title pixels and resolved-width resize.
The existing navigation target covers keyboard, reader state and synthetic preedit.

These are **hidden draw/work measurements**, not release-build, glass-window,
120Hz, presentation/deadline, hardware sleep/clock or visible smoothness qualification.
The historical visible benchmark is separate evidence, not this baseline.
