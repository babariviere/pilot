# Rounded surfaces and bounded status motion

2026-10-22. Synthetic production views, Apple M3 Pro/36 GiB, macOS 27,
Kit 0.8.0/GPUI 0.3.9, Rust 1.98.1. This is a scoped desktop styling checkpoint,
not full app parity, a measured responsiveness win or acceptance of a Swift
replacement. Swift remains unchanged. No visible app launch, real chat capture,
canonical write, backend change, service install or default switch was used.

## Actual Swift references

Read `apps/macos/Sources/Pilot/{Theme,DitherCorner,Composer,ToolViews,LoopingLayerView}.swift`
and the session signal/working-line references before implementing:

| Surface | Radius, points |
| --- | ---: |
| Small control | 4 |
| Row | 6 |
| Control | 8 |
| Card | 10 |
| User bubble | 12 |
| Composer tray | 14 |

The composer uses the tray/card fills, 4-point inset, 14/12-point editor padding
and subtle 6% shadow (12-point blur, 4-point vertical offset). Plain tool detail
uses the code surface, 8-point radius, 10-point padding and 260-point maximum
height. Source/copy and expansion identities remain unchanged.

Native corners use 2-point cells, a 52x24 row grid and a 78x36 composer grid
(extent 1.5). Working ripples and needs-you breathes over 36 frames at 12 fps;
background-only working uses the fainter 72-frame ripple, not an idle freeze.
Failed/ready are steady. The working tint is #6366F1 in light and #818CF8 in dark;
attention/failed/ready keep the Swift amber/red/emerald tokens.

Hover recession is 300 ms ease-out; signal dissolve is 600 ms ease-in-out.
Reduce Motion stays still and applies hover without animation. Composer corners
are limited to working, as in Swift, and never recede. Dither rows suppress the
default hover fill without disabling click, hover callbacks or keyboard selection.
Decoration reads bounded summary fields; it neither changes action eligibility
nor imports Swift-private unread marks or writes read-status.

## Bounded ownership and remaining cost

`src/dither.rs` ports geometry, Bayer coverage, easing and timeline state.
Twenty fixed alpha loops total **1,184,352 bytes**, built once off the UI thread.
The first decoration waits for atlas readiness. Native quads preserve hard cells,
with physical-pixel boundary strips clipping the rounded corner. There are no
per-frame SVG/image creation, image upsampling, artifact shaders or new runtimes.

`src/dither_view.rs` has one clock per window: 12 fps for steady moving signals,
temporarily 60 fps for transitions. Weak members must renew a clipped, visible
paint lease. Unmounted retained models expire; settled nonmoving states leave
the clock. Visibility cancels the timer, and window/model lifetime owns cleanup.
The atlas has no dynamic content keys or unbounded frame cache.

GPUI leaf notifications also invalidate ancestors. An initial root-count probe
failed, and Kit's `TestWindowExt::render_frame` was found to force `refresh()`,
bypassing view caches. Accepted ordinary-frame checks use `Window::draw` without
that forced refresh. Standard definite-size caches now surround transcript and
artifact viewports and unchanged corner leaves. **Cheap ancestor chrome and the
editor still render**. This is not Core Animation compositor-only ownership,
zero-root work, zero allocation or an overall CPU/scrolling speedup claim.

The opt-in Component patch now contains 13 exact edits across two files: the
existing nine disclosure edits plus four for `ListItem::hover_fill(false)`.
Defaults remain unchanged. Specification SHA-256:
`93f717274b839d7e6f1b0ceeafc1e5e9340dd17cb380a6b0bbfa4690ee1708a3`.
The original archive checksum and Base retained-layout patch are unchanged.

## Native evidence

The opt-in `style` test mounts the actual `LocalViewer`, native text and GPU
renderer with `show:false`, not a mock platform or reconstructed SwiftUI view.
All scenes are synthetic. 680/1100-point light/dark cases check:

- Twelve timed shared ticks visibly change foreground-working,
  background-working and needs-you pixels. Failed/ready pixels are identical.
- Transcript and nonmoving corner render counts stay fixed through those ticks.
- Actual rounded composer pixels differ from the outer corner, not just a
  declared radius. Hover keeps mounted row bounds unchanged and adds no fill.
- Hover midpoint is ~0.684642 and its 300 ms endpoint settles. Dissolve midpoint
  is ~0.499997; the signal settles at 600 ms and leaves membership by the next
  pending clock packet. This permits one finite deadline packet, not a loop.
- Filtering retains corner models while unmounting them. After lease expiry,
  membership/task are zero and another second produces no ticks. Remount resumes.
- Reduce Motion stops membership/ticks, including hover. Turning it off resumes.
- Simulated-hidden cancellation stays stopped for another second; showing resumes.

A second production-root case retains **512 messages / 812,434 source bytes**.
Twelve shared ticks produce **zero transcript renders**, with the same fixed
atlas. This measures avoided rendering work, not isolated parser CPU or RSS.
The existing large-message negative evidence and memory gates are not waived.

Private ignored captures include start/loop/hover images at both sizes and
appearances. Session image artifacts contain actual synthetic GPUI captures.
The separately labelled SwiftUI artifact is only a static mock, not motion or
production-view evidence.

## Verification and explicit gaps

- `scripts/check.sh`: 110 library tests pass, 1 ignored; focused native fixture,
  browser, 16-scene chrome, 40-scene visual and 720-frame disclosure/activity
  regressions, plus the style/lifetime matrix pass. Strict app/helper/probe
  Clippy and formatting pass.
- Four scaling-runner tests, locked app/helper builds and symbol separation pass.
  `JS_NewRuntime` remains present in the confined helper and absent from the UI.
- Additional settled composer checks sample after the initial dissolve, so a
  one-time fade cannot be mistaken for a foreground/background loop. The native
  1100-point dark tray changes 4,962 foreground and 3,005 background pixels,
  visibly beside the opaque editor/controls; the full style matrix and strict
  probe Clippy were rerun after adding these checks.
- Existing dependency warning: `block 0.1.6` future incompatibility.

Actual OS occlusion/minimize, visible interaction/CPU/scrolling benchmarks,
macOS 15 hardware and OS IME remain unverified. The headless visibility override
exercises cancellation, not native occlusion delivery. Full Home/Inbox/settings,
quit durability and remaining artifact parity are separate work. Dedicated
accessibility engineering remains deferred; built-in support is retained.
Linux/Wayland verification is deferred, not a macOS delivery gate or support
claim. Existing Linux source-execution fail-closed guards remain intact.

Reproduce without real accounts or content:

```sh
cd apps/desktop
bash scripts/check.sh
PILOT_NEXT_STYLE_DIR=evidence/local/style-captures \
  bash scripts/cargo.sh test --locked --features native-probes --test style
```

Raw logs, captures, state, dependencies, generated patches and build caches stay
ignored and are not publication evidence files.
