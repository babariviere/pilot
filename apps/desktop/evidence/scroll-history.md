# Load older history at the top

Scrolling to the first loaded message now requests the previous bounded Local
history page. This reuses the existing GET-only history reader, canonical cursor,
generation/identity gates, capacity limits and independent interaction writer.
There is no backend, protocol, permission or mark-read change.

## Admission and position

- Genuine list/bounce scroll notifications drive the top check. Reset, layout,
  remeasurement, prepend, cached redraw and dither do not issue reads. An upward
  wheel fallback handles short content that fits the viewport and therefore
  bypasses the bounce callback. Initial display never silently drains history.
- One page is outstanding. A stale pre-request idle publication does not clear
  the reader's in-flight token; completion requires cursor progress, a newer
  page-result revision or an invalidated/loading scope.
- Automatic admission attempts each generation/cursor once. Failure or unchanged
  cursor cannot create an overscroll retry storm; the explicit Earlier button
  remains a manual retry. Exhaustion/capacity clears the cursor as before.
- A request captures explicit reader intent using the existing logical anchor
  hold. Prepending preserves the viewed message/pixel offset and selection.
  Repeated upward packets on fitting content retain that hold. Latest still
  resumes following; chat switches/refresh reset the request scope.
  Short documents retain only their existing unused bottom space while paging,
  avoiding an end-of-document clamp that would otherwise move the read message.
  Genuine bottom scrolling, Latest and reset release this bounded space.
- A quiet "Loading earlier messages…" appears in the existing header metadata,
  without adding a transcript row or moving its viewport.

## Scoped dependency change

The Component specification adds two exact edits for `MessageScrolled`, emitted
only from the existing event-derived scroll callback. Its default scrolling and
list behavior do not change. One read-only accessor identifies a real scrollbar
drag at its measured start; releasing it aligns the first loaded row before
requesting history, so sparse prefix heights cannot stop it at a later row.
One bounded accessor also reports unused viewport tail space for that short
document hold. Combined specification: **17 exact edits / two
files**, SHA-256
`b5e3c28b295316312b4cf9f84ee2321d852e86ed55f65934fc32e3a46c8619f1`.
Original archive and generated source checks remain fail-closed; no registry,
global configuration, version or generated `.patched` edit is committed.

## Verification

Focused reducer/controller and actual native offscreen production-root tests
exercise top traversal, fitting content, repeated scroll, paged prepend,
selection identity, stale idle publications, error/manual retry, exhaustion and
Latest. Native scroll traversal uses actual wheel packets with intervening
frames: a single huge packet only traverses currently measured virtual rows,
not necessarily the first loaded row. It does not substitute a programmatic
jump for a real scroll.

Full macOS `scripts/check.sh` passes: **121 library tests, 1 ignored**, strict
app/helper/native-probe checks, fixture/browser, 16 chrome / 56 visual scenes,
720 disclosure frames, style/lifetime and isolated-slider regressions, plus
**eight history scenes** (680/1100 points, light/dark, long/fitting histories).
The final history matrix also releases the real scrollbar pointer in the header
outside the transcript. Each scene verifies four admitted faux read commands,
no duplicate/error/exhaustion/layout-driven read, retained selection entity/range,
genuine bottom and Latest, and a prepend anchor of **91→90 points for long
history / 90→90 for fitting history**. Initial fitting drift of90→484.5 exposed
the end clamp and is fixed by bounded existing-space retention.

Composer geometry remains76-point tray /34-point editor in all four style
configurations. The512-row /812,434-source-byte dither scene retains zero
additional transcript renders through12 ticks, not a CPU/smoothness claim.
Four runner tests, locked app/helper builds and direct engine-symbol separation
pass. The existing `block0.1.6` future-incompatibility warning remains.

```sh
cd apps/desktop
bash scripts/cargo.sh test --locked --lib history -- --test-threads=1
PILOT_NEXT_HISTORY_DIR=evidence/local/history-captures \
  bash scripts/cargo.sh test --locked --features native-probes --test history
bash scripts/check.sh
```

Raw synthetic logs/captures remain private and ignored. Native rendering and a
separately labelled static SwiftUI mock are not visible-window performance,
platform/IME validation or user styling acceptance. No real Local action,
visible app launch/restart, Swift change, release or default switch is included.
Linux/Wayland verification remains deferred and source execution fail-closed.
