# Compact composer correction

The earlier actual native captures showed a large outlined editor inside an
outlined tray, excessive text insets and a needlessly stacked narrow control
row. This corrects that presentation, not Local interaction or delivery logic.

## Layout

- One visible tray surface and outline, retaining the shared 14-point radius,
  subtle shadow and existing animated corner. The editor's opaque matching
  surface masks dither behind text without another contrasting card or border.
- Remove the extra 14-point horizontal / 12-point vertical wrapper padding.
  Kit already owns multiline text padding; its appearance/border switches do
  not remove that internal padding.
- Keep editor and controls together without the extra 8-point section gap.
  Stop and Send use the same compact size. Metadata yields space before the
  nonshrinking action row; the old viewport-under-800 forced column is gone.
- Reduce outer horizontal/bottom margins to 12 points. The existing single
  Thinking/Working activity line sits just above the tray, not inside another
  panel. Its lifecycle and privacy projection are unchanged.
- New-chat context, pending/error/recovery controls, labels, eligibility and
  handlers remain. No draft, transport, backend or dependency-patch changes.

## Checks and visual evidence

Native offscreen production-root rendering at **680 and 1100 points**, in both
light and dark, measures a **76-point single-line tray / 34-point editor**.
Mounted bounds verify that input, controls, Stop and Send are inside the tray,
buttons share one row and no extra field-to-controls gap remains. Pixel samples
verify a continuous surface rather than a contrasting nested editor card.

The focused editor matrix also mounts standalone pane widths **320/472/760**,
types synthetic Unicode text through the focused native input and checks the
live value, captured draft revision and absence of accidental Submit commands.
A 40-line draft checks the retained six-line growth cap and contained controls.
Existing tests cover deferred input changes, navigation, acknowledgement,
preedit/keyboard/pointer submit guards, duplicate-send protection and the single
thinking/Stop indicator.

Actual GPUI light/narrow and dark/working synthetic screenshots are attached
separately from the explicitly labelled static SwiftUI mock. The private raw
captures and logs stay ignored under `evidence/local/`. The earlier captures are
retained there for comparison. These are not visible-window captures or a claim
of visual acceptance, OS IME validation, CPU improvement or full app parity.

```sh
cd apps/desktop
bash scripts/cargo.sh test --locked --lib chat_editor -- --test-threads=1
PILOT_NEXT_STYLE_DIR=evidence/local/composer-captures bash scripts/check.sh
```

Full `scripts/check.sh` passes: **119 library tests, 1 ignored**, strict
app/helper/probe checks and native fixture/16 chrome/56 visual/disclosure/style/
slider regressions. The 720-frame disclosure matrix covers stream/manual
reading/Latest geometry. The 512-row / 812,434-source-byte cached-history scene
retains zero additional transcript renders across 12 dither ticks, not a CPU or
visible-smoothness result. Settled dark composer foreground/background loops
still change native pixels. Four runner tests, locked app/helper builds and
engine-symbol separation also pass; the engine is absent from the UI binary.
The outer launcher referenced an absent optional symbol-check script after the
main gate completed; equivalent direct symbol checks passed separately. The
existing `block 0.1.6` future-incompatibility warning remains.

No real Local create/send/stop, visible launch or restart was performed. Swift
remains unchanged. Linux/Wayland verification is deferred; its generated-source
execution remains fail-closed. No release or default switch is included.
