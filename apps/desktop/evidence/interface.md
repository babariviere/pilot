# Conversation chrome and static dither

Scoped Rust presentation work atop `04830d53`. Reference: `DESIGN.md`,
`Theme.swift` palette/type/radius and `DitherCorner.swift` at that revision.
No Swift, daemon, protocol, service or permission behavior was changed.

## Delivered

- Central portable Kit theme configs: soft light/dark surfaces, neutral primary
  actions and persistent chat selection, no blue focus ring. Mode changes keep
  Kit/Base projections synchronized and preserve Kit's syntax theme. Normal
  windows follow system appearance through a window-owned subscription, not
  polling. Existing Swift appearance settings are not imported.
- Compact adaptive sidebar, title/status header and 760-point reading column.
  Working/failed rows use quiet static Bayer corners plus their text status;
  quiet rows draw none. Composer work carries a fainter matching corner.
- Two cached, bounded 104×48 SVG masks derived from the reference's 8×8 Bayer
  field, with hard 2-point cells. App-owned vectors and embedded Kit icons only,
  no external assets, shader, new dependency, clock or per-frame generation.
- User bubbles, preserved authorship labels without debug entry/row IDs,
  ordered work and bounded default previews. Explicit disclosure/selected-note
  choices still reveal all work; failure/uncertainty counts stay visible.
- Composer controls stack at narrow widths without changing send/Stop/draft
  semantics. Errors stay visible. Secondary limitations use explicit Details;
  history-capacity warnings remain visible even while details are closed.
- Cmd/Ctrl-F focuses chat search. Search/keyboard target and the opened chat
  remain separate. Existing composer/quit, Unicode, IME, selection, tail and
  durable-delivery behavior remain in their regression suites.

## Verification and reproduction

```sh
cd apps/desktop
bash scripts/check.sh
PILOT_NEXT_CHROME_DIR="$PWD/evidence/local/chrome" \
  bash scripts/cargo.sh test --locked --test chrome
bash scripts/cargo.sh build --locked
```

The native Metal corpus renders 16 production-view scenes: 680/1100-point
widths, light/dark and conversation/empty/loading/unavailable states. Text
readiness, sidebar/conversation/composer bounds and read-only action fencing
are asserted. Each window is closed before the next; retained scenes do not
grow with corpus length. Source is fixed synthetic data, with no Local API,
private draft store or visible window. Native pixels were inspected in light,
dark and narrow error states. The separate SwiftUI artifact is a static layout
reference, not compiled GPUI evidence. Real-content captures are not used here.

Final checks: 76 library tests pass, one explicit disk workload is ignored by
default; rustfmt, strict all-target Clippy, synthetic native fixture/browser,
all 16 corpus scenes and locked normal build pass. A timing comparison was not run:
content-free CGSession preflight reported a locked screen, so measurements
were rejected rather than treating locked-screen GPU/CPU behavior as evidence.
No visible app, unlock or desktop interaction was attempted.
The dither itself schedules no redraws; existing caret/scroll/fade machinery
is unchanged. Large-session streaming CPU/RSS impact has not been measured.

## Explicit gaps

This is a conversation interface slice, not Home/Inbox/project/settings/command
palette parity. No fake routes/actions were added. Dither motion, hover
recession, scene art, per-app appearance pinning, exact short-bubble sizing and
hover-only message controls are not implemented. Static corners are always
motion-safe, not proof of platform reduced-motion notification routing.

Native macOS 15/Wayland/OS IME, visible smoothness and matched release Swift
performance remain unverified. Giant-message parser scaling, full-snapshot
draft I/O, native termination flushing and artifact rendering remain separate.
No speedup or full replacement acceptance is claimed.
