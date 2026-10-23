# Composer surface contrast and motion evidence

## Final verification ledger

Combined corrected source: `160c837ae15159b65f2c67a5726c2c67da3e154e`.
Verification is an explicit retained prefix plus a corrected tail, not one
uninterrupted successful invocation:

- `ae233a89` on frozen `10700d8e` passed strict checks, **150 library tests
  (two ignored)**, rendering, 16 chrome scenes, 56 visual scenes, disclosure,
  style, all 27 glyph roles, word motion, controls and all eight history scenes.
  It then exited 101 at an obsolete bare-label inset assertion in the shell
  probe. No failure is hidden or relabeled as a completed full run.
- The sole source difference from `10700d8e` to the corrected combined head is
  `src/shell_probe.rs`: measure the existing one-rem folder icon at the original
  leading inset and the exact half-rem label gap. No production or other test
  input changed. A machine-checked diff and SHA256 manifest preceded the tail.
- `0d3d4c87`, exit **zero**, completed shell, navigation/canonical reader, Inbox,
  jump palette and workbench, four mocked Python checks, locked app/helper
  builds and engine-symbol isolation. All guards and event outcomes remain.

The earlier `bb2ebf95` library-stage interruption led to an exact two-rem tool
leading-slot/quarter-rem label-gap regression check; focused `d276035b` passed
all five work regressions and native disclosure before the retained prefix.
No old fixed-pixel bound was merely widened. Both verification stages emitted
immutable source/hash fences before compilation and ran serially with the
shared resource scheduler. Raw logs remain private and ignored.

The icon-only parent has its own focused checks; the combined ledger includes
this child's contrast and test harness, so it is not claimed to be an identical
transitive build of the parent alone. A documentation-only publication successor
does not change the verified code. Existing `block` 0.1.6 warning remains.

## Priority surface correction

The compact editor should be an opaque card on its soft tray, as in Swift.
Compact/continuous refers to coherent spacing, not identical surface colors.
The sole production change is `composer-input` from `appearance::tray` to
`appearance::card`, with its comment corrected. The outer tray, inner padding,
radii, borders, editor state, eligibility and event handlers are unchanged.
This is the first scoped correction, not completed app-wide finishing.

The previous native style test explicitly required matching editor/tray pixels.
The replacement checks the semantic roles independently, exact geometry and
opaque backing instead of baking in the unwanted flat interpretation.

## Reproduction and focused verification

Frozen icon-only baseline `59d2ba3ed7097100999454384f4c1fca8511b95c` passed
native icon paint and production workbench checks. The tests-only contrast
negative control `35780f2c50e9e031b58ad5b998c8e08508738e67` failed exactly
at the new card assertion: the mounted light editor was `[245,245,245,255]`,
not `[255,255,255,255]`. Exact 76/34 geometry and containment passed first.
This was a rendered regression reproduction, not a compiler/setup failure.

After the one-line correction, focused job `358fb1ab` exited zero, including
strict all-target native-probe Clippy and the production style matrix:

| Window | Editor RGB | Tray RGB | Tray / editor height |
| --- | --- | --- | --- |
| 680 light | 255,255,255 | 245,245,245 | 76 / 34 pt |
| 1100 light | 255,255,255 | 245,245,245 | 76 / 34 pt |
| 680 dark | 48,48,48 | 44,44,44 | 76 / 34 pt |
| 1100 dark | 48,48,48 | 44,44,44 | 76 / 34 pt |

Alpha is 255. Pixel expectations come from semantic theme roles, not a second
palette. Samples avoid text and rounded edges. The input/control adjacency,
Stop/Send centerline and all control bounds are retained. A blank editor strip
stays opaque while the settled dark working/background corners visibly change
(4,879 / 2,928 changed pixels in that focused run).

Original private contrast checkpoint `77c372f2` changed only editor/style-test
source. A later private restack onto the owned icon parent's six artifact-chrome
glyph properties preserves this contrast delta. No public parent was rewritten.
The later combined head still needs its final coordinated verification.

Same-fixture before captures were completed separately on frozen baseline59
by focused job `bd8998e9`, exit zero. After captures are from the corrected
style run. Actual 680/1100 light/dark frames were inspected; captures and raw
logs stay ignored. The SwiftUI surface study is explicitly a static mock,
not a GPUI screenshot, input check or motion/performance result.

## Motion is a separate claim

The existing native style probe samples ordinary dirty-window draws, not a
forced refresh at every tick. Working/background/needs-you pixels change;
failed/ready pixels remain still. It observes intermediate hover at 150 ms,
settling at 300 ms, intermediate dissolve at 300 ms and settling at 600 ms.
Offscreen/unmounted, reduced-motion and hidden-window paths stop their shared
leases and ticks. A 512-row / 812,434-byte retained history had zero cached
transcript rerenders through twelve shared activity ticks in the focused run.
The visibility override is test-only, not native OS occlusion evidence.

A bounded production word-fade probe passed focused job `45e205a0`. It uses
the unchanged Kit fade policy (280 ms, 10 ms word stagger) through the actual
readonly transcript update path. Same-prefix Markdown `set_text` already
appends via Kit's existing implementation; no production update-path rewrite
or framework patch is needed. Native phase pixels, stable geometry/entity,
exact Copy and settled idle are checked, not endpoint-only shots. All four
width/appearance combinations contain real intermediate opacity pixels
(3,690 light / 3,618 dark), identical settled frames and zero idle transcript
rerenders. The same run passed all 27 icon roles and native control lifecycle
checks after the artifact chrome additions.
The probe uses bounded test wall-time sampling because Kit's fade uses Instant;
its executor timers and ordinary draws are exercised, not replaced by a new
production clock. PNG encoding is deferred until after phase sampling; the
first probe encoded between samples and missed the intermediate phase. Actual
readback observation times were approximately 93–140, 187–282, 279–426,
494–564 and 685–737 ms. These include readback overhead and do not establish
nominal sampling cadence, visible frame pacing or a whole-app speedup.

Existing disclosure checks sample real collapse/expand, streaming, prepends and
rapid interruption, preserving reading anchors and entity identity. Immediate
height disclosure remains deliberate; this change adds no blanket live-layout
animation. Forced-refresh disclosure samples establish geometry, not cadence.

None of this proves visible display smoothness, whole-app frame pacing, CPU/RSS
improvement, OS IME/hardware behavior, full parity or user acceptance. No real
chat action, visible benchmark, backend/helper/permission change, release,
default switch or Swift removal is included. Broad finishing remains open.
