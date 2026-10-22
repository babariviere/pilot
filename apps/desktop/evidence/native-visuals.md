# Bounded native visual reader, incremental checkpoint

WIP partial viewer, not full artifact parity/security certification. Native
gallery/detail/read/runtime wiring is implemented. Source/handlers only execute
in the separate OS-confined helper, never the desktop process/thread. No Swift
or backend changes, real automated mutations or real capture-scope expansion.

## Read boundary and supported display

Metadata comes only from the selected chat subscription, max64 items. Explicit
Open fetches exactly that session/artifact/revision using an allowlisted GET,
4 MiB response cap and full hello before/after. No proxy/redirect/cookie,
unpinned resolution or cross-chat fallback. Check id/session/revision before
accepting source. Prepared HTML is ignored for every kind. Unknown runtime/kind
keeps read-only source/provenance instead of executing it. Metadata never
automatically changes an open pinned revision. Previous revision/All artifacts
give explicit historical/latest navigation.

Native rows/columns/grids, plain selectable text, stats, tables (numeric/null
cells), rules/spaces, inert links, buttons/toggles/tabs and slider steppers.
Non-stacked line/area/bar/scatter charts use trusted native primitives over
finite normalized geometry prepared off UI; missing values stay gaps. No
dynamic SVG/image cache. Aggregate4096 weighted display units include nodes,
text, table cells and geometry. Max8192 bytes per text node,1024 table cells and
2048 chart points plus shared budgets. Overflow is explicit. Per-run typography,
some alignment/axis/hover details, slider dragging, stacked plotting and
out-of-domain clipping remain incomplete. Large numeric table labels are
compact. Source/data is unchanged.

Static canvas supports bounded native rect/circle/line/path/arc/text drawing,
save/restore, finite transforms and opacity. PD1 validates reserved bytes/counts,
strict UTF-8, finite words, exact op lengths, color/paint/text indices, depth,
command/point/text aggregate caps. Off-UI display plan:512 commands,4096 weighted
geometry/text units,4096 text bytes, bounded transforms/font/stroke and viewport
margin. No untrusted geometry reaches native tessellation unbounded. Curves are
polygonized (up to64 segments per circle); text metrics are approximate. Non-uniform
strokes, rotated/mirrored text, out-of-margin clipping, animation and UI pointer
scheduling are explicit unsupported cases. Helper pointer/time inputs match the
shared codec corpus, but that is not animated/pointer UI parity.

Draw only when visible, serialize/coalesce size requests, pin scene version/id/
dimensions, reject late frames, invalidate after validated state changes. No
animation timer. Drawing failures kill/reap the process and retain committed
state; display-plan limits are node-local unsupported cards. View close has a
separate close-only cancellation source, never consumes a queued user command.
Canvas failure/null tests prove fresh VM recovery. Faux GET-only load/event/draw/
close and real GPU colored-pixel assertions cover the supported static path.
Fixture frames use actual mounted bounds (including scroll gutter), not viewport
width guesses that can correctly be rejected as stale and silently appear blank.

Animated/unsupported canvases and Mermaid have node-local cards; shaders are explicit
deferrals, retaining mixed visual siblings. Image/SwiftUI previews are not yet
wired. HTML/React/browser libraries/standalone shaders stay deferred. Source
preview is bounded plain selectable text, not an editor/interpreter. Copy source
retains the full fetched source. Eight revision-keyed states are in memory only,
not Swift import or durable restart support. Clipboard controls are user-driven.

## Isolation

`pilot-visual-worker` is a separate Cargo package. It compiles the existing C
engine/shared runtime with QuickJS-NG0.17.0, no std/os/libc JS modules or host
bridge. Checksum-pinned preparation materializes only in private `.tools`,
verifies archive/materialized bytes and refuses changes. No registry/vendor or
Swift source edits. Source/version/archive pin matches existing Swift preparation.

Trusted native bootstrap closes inherited fds, sets limits, creates intrinsics
and a parked watchdog, then confines before reading any source:
- macOS deny-default Seatbelt after loader bootstrap, self process-info only.
  Active file/network/actual exec denial before hello, independent parent file
  sandbox attestation of the actual child. `sandbox_check` is SPI; absence or
  failure refuses execution. Its exec query was unreliable; actual exec denial
  is required. No broad file/sysctl grants. Validated on the current macOS27
  host, not security certification or macOS15 verification.
- Linux draft: no-new-privs, non-dumpable, parent-death kill, close-range,
  320 MiB AS cap and architecture-checked seccomp allowlist with TSYNC to the
  watchdog. No open/socket/connect/exec/clone/ptrace/io_uring/executable mappings.
  Draft parent checks `/proc`. Not compiled/run on native Wayland. App source
  execution is explicitly disabled off macOS pending validation; source view
  remains available. No unconstrained fallback.

Child env cleared, cwd `/`, stderr null, private pipes only. A parent-owned
synthetic listener ensures denial probes cannot contact the daemon/real service.
Hello pins protocol, engine, runtime hash and actual child pid before source.
Max2 workers globally. Failed reap latches execution unavailable.

## Transactions and lifetime

32 MiB JS heap,512 KiB JS stack; setup/view250 ms, handler100 ms, draw8 ms.
Parked watchdog exits after1.5 s active work; parent hard deadline2 s and bounded
kill/reap. Idle has no polling. Every error/interrupt/OOM/invalid reply discards
the whole helper, never continues a poisoned VM. Explicit retry creates fresh
VM/closures from last committed reader state. Normal success keeps setup state.
Closing cancels pending load/event IPC then kills/reaps. Trusted startup is
always joined before source, never cancelled into an orphan.

4 MiB request/2 MiB reply. Strict PV UTF-8, finite values, duplicates, varint
overflow, trailing-data, depth/value/expanded-byte caps. Independent closed API1
tree/text/node/sibling-key/dimension/chart-length/current-path validation. State
is a bounded JSON array. Tree/state commit atomically after validation. UI exact
resource/generation/scene-version/type checks fence late snapshots/controls.
No host file/network/tool/daemon bridge for generated code. Shaders stay data.

## Evidence and gaps

Foundation:83 library tests pass/one ignored workload, fmt-all, strict helper/
parent Clippy, native fixture/browser plus16 chrome scenes, locked builds and
symbol separation. `JS_NewRuntime` present in helper, absent from UI.
Native tests: actual sandbox/parent attestation, load/events, real heap exhaustion
and handler interrupt, null-OOM metadata, fresh-VM retry, no partial state commit,
stale events, malformed wire/schema. SIGSTOP the exact owned/attested child before
exchange: parent2s deadline kills/reaps it; fresh helper then succeeds. Nine shared
view/event/state and30 non-draw error fixtures match.

Follow-on focused tests: GET-only faux server load/event, identity change after
fetch admits no revision/source, generation/revision/typed-event rejection and
8-slot state-cache eviction.36 expected-tree narrow/wide/light/dark native GPU
offscreen scenes, no VM/network/account. Native drag selection and exact keyboard
Copy (fake clipboard), full Copy source, Source disclosure and huge wheel-to-bottom/
back assert bounded scrolling. Selecting plain text explicitly focuses the pane
so search/composer Copy cannot swallow it; app Copy preserves boundary whitespace.
Full UI checkpoint:88 library tests pass/one ignored workload, fmt-all, strict
helper/parent Clippy, native fixture/browser,16 chrome and36 visual scenes,
locked app/helper builds and engine-symbol separation pass.
Synthetic GPUI images and separately
labelled static SwiftUI mock attached internally; no real content is published.

Static canvas checkpoint:92 library tests pass/one ignored workload, strict
workspace Clippy/fmt, native fixture/browser,16 chrome and40 visual scenes,
locked app/helper builds and symbol separation pass. Both shared PD records
(including supplied pointer/time) match native command/ops/string output. New
draw interrupt/null recovery and faux load/event/draw/close tests pass; viewport
margin, geometry/transform budgets and real canvas pixels are asserted.

Pinned publication follow-on: canonical `pilot.artifact` entries produce stable,
bounded inline Open cards, without a Markdown parser or source lookup on arrival.
Body links/JSON never become reads. Explicit click carries its original revision;
the selected-owner fence rejects other chats without fallback. Gallery metadata
and fetched revisions remain strict; minimal journal references do not relax them.
Legacy tool-only output still uses the gallery. Native mouse-click/no-parser,
deduplication, malformed-reference and parent owner-fence tests cover this path.
Charts show all category labels through12 and endpoints above12; numeric scatter
axes retain endpoints, rather than misplacing nonuniform middle labels. Axis/legend/unit
labels are visibly elided at80 Unicode scalars; stored source/data remain intact. Displayed
category text is charged against the aggregate budget, including sparse last labels.
All12 ordinary shared draw errors match exact message/line through the real helper
and every failed process is reaped. The single command-overflow fixture requests
5000ms; production remains8ms, so its exact command-limit error OR truthful8ms
timeout is accepted. This is not full5000ms fixture equivalence or a larger cap.
Full follow-on gates:98 library tests pass/one ignored workload, fmt-all, strict
workspace Clippy, native fixture/browser,16 chrome and40 visual scenes, locked
app/helper builds and engine-symbol separation pass. Static SwiftUI mock revision2
illustrates the inline card separately; it is not the running GPUI views.

Complete canvas transforms/animation/pointer/text
metrics, image/SwiftUI previews, Mermaid
candidate/license/corpus, durable reader state and complete chart/style parity
remain unfinished. Native Wayland/macOS15, broader escape probes, OS IME and
matched performance unverified. Count helper RSS in future measurements. No
visible unattended app, real writes, service/global install, release/default
switch, Swift removal or merge. No full parity/security-certification/speedup
claim; locked-screen timings are not used.

```sh
cd apps/desktop
python3 scripts/prepare-visual-worker.py
bash scripts/cargo.sh build --locked -p pilot-visual-worker
bash scripts/cargo.sh test --locked --lib visual_ -- --test-threads=1
bash scripts/check.sh
```
