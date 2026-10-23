# Composer surface contrast and motion evidence

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
