# Pilot Next

## Source checkpoint status

This is an experimental draft source checkpoint, not a merge-ready replacement.
The synthetic fixture, input/selection fixes, bounded Local viewer and explicit
Local create/send/Stop with private durable drafts are implemented.
Compact tool/work presentation, adaptive light/dark chrome and a partial native visual reader are implemented.
The Local viewer has native Appearance Settings with explicit private preference saves;
the remaining Settings categories are unavailable, not simulated controls.
The artifact reader remains incomplete, not a replacement/parity claim. Swift remains unchanged and operational. See `evidence/` for the exact
focused checks and explicit platform/performance gaps.

Experimental Rust desktop, kept separate from the production Swift app.
`pilot-desktop --local` uses the existing loopback API. Its user-driven write
controls can create chats, send messages, Stop and convert an eligible existing
chat into a mission with explicit confirmation. Conversion requires the guarded
Local daemon capability; an older daemon is refused without a mutation. The default launch remains a
network-free synthetic transcript and memory-only local-echo composer, without
disk state. No read-status writes, service installation, updater or default switch.

### Appearance Settings

In the Local viewer, use **Settings…** in the sidebar or **Cmd-comma**. The separate native
window preserves the mounted chat, reader and composer, and refuses opening during marked
text composition. Choose System, Light or Dark, then **Save changes** (or **Cmd-S**) to apply.
Revert restores the last acknowledged choice. Unsaved, pending or unconfirmed saves must be
resolved before managed close/quit; save errors keep the selection and offer retry.

Preferences belong only to Next's private `settings/preferences-v1.json` under its own state
directory, separate from Swift defaults and draft/delivery state. Opening/loading never
creates the file. There is no automatic Swift import, credential access or daemon settings
mutation. Synthetic viewers do not resolve or change production preferences. Updates and
other missing categories state their gaps explicitly. See `docs/settings-parity.md` and
`evidence/settings-screen.md` for ownership, supported behavior and qualified checks.

## Use real Local chats

```sh
cd apps/desktop
bash scripts/cargo.sh build --locked
bash scripts/run.sh --local            # visible window; arrange first
# Optional content-free, bounded read check, no GUI:
target/dev/debug/pilot-desktop --local-check
```

Start Pilot normally first. The viewer never starts or reconfigures the daemon.
It reads `PILOT_PORT` (default 4319), and the existing `daemon-id` and
`storage-lineage` under `PILOT_HOME`, or `$XDG_DATA_HOME/pilot`, or
`~/.local/share/pilot`. Missing/corrupt identities fail closed, never create or
replace them. Only 127.0.0.1 is accepted; no arbitrary host/URL, proxies,
redirects, cookies, Origin, GitHub capability token or remote endpoint registry.

**Security boundary:** the current daemon does not authenticate Local
requests. Loopback + Origin rejection and identity pinning are not cryptographic
authentication. Protocol/full Local identity is checked before every socket and
history read, including reconnects. An identity/protocol mismatch fences all
subscriptions. Existing daemon chat-open semantics can refresh PR status and
perform ordinary internal subscription housekeeping. Read transport does not mutate
mission membership. Existing-chat conversion adds only the narrow atomic admission
guard described in [chat-to-mission.md](docs/chat-to-mission.md).

The read transport issues only allowlisted hello/history/WS/scoped artifact requests and sends
no application WS messages. A separate worker supports GET of the selected
chat, POST /api/operations/receipt, POST /api/operations and the selected chat's
Stop route. There are no legacy send/create fallbacks, focus, approvals, edits,
archive or mark-read routes. Retained Control, specialist, archived and continued
chats are readonly. The daemon remains the permission and execution authority.

### Make an existing chat a mission

In an eligible Local chat, choose **Make a mission…**. Review the title and optional
goal, coordinator role and draft-message choices, then confirm with the button or
**Cmd-Return**. Both choices default on, matching Swift. Drafting sends a follow-up
and may start a reply; creation does not independently acknowledge message delivery.
The same conversation, private draft and reader remain mounted. The outcome and
copyable mission ID stay reachable in the sheet.

The separate writer uses only scoped GET of the source/project/mission and the
existing `POST /api/missions` for this confirmation. Source identity, project and
Local runtime are rechecked; already-linked and delegated chats cannot silently
move. A private single-attempt record is durable before transmission. Lost replies,
non-201 responses and restart never automatically resend it. **Check Local** reports
current membership, not a durable creation receipt or attribution to an unknown
request. A full 32-record mission ledger refuses new conversion rather than evicting
uncertain work. This is not a mission dashboard or permission promotion. See
[the workflow and qualified checks](docs/chat-to-mission.md).

### Messages and private drafts

New chat requires an explicit configured Local **project**, selected with the
searchable project picker, and an Ask/Build choice (Ask by default). The canonical
project ID, not a guessed folder match, determines the chat association and daemon-owned
working directory/workspace defaults. No manual working-folder prompt or another
agent's isolated working copy is inherited. Selection is retained per private draft;
legacy unsent folder-only drafts keep their text and require an explicit project choice.
Pending deliveries keep their original destination and payload. Empty, unavailable or
changed project choices cannot create a chat. See `docs/project-based-chat-creation.md`.
Enter or Send submits; Shift-Enter inserts a newline. Marked text cannot submit. Follow-up
queues behind current work; unchecking it selects the existing steer delivery
mode. Sending does not force the reader down the transcript. Stop is available
for a working chat or its queued input; withdrawn text is saved separately, never
merged into newer typing. Copy or explicitly remove that recovery text.

Drafts survive navigation/restart, independently of Swift. A single-owner private
0700 directory contains 0600 state/lock files at macOS `~/Library/Application
Support/Pilot Next`, or Linux `${XDG_STATE_HOME:-~/.local/state}/pilot-next`.
No Swift state is imported. Normal window close and Cmd/Ctrl-Q wait for flushing.
Wait for “Draft saved privately” before forced termination; unsaved edits and
native Dock/system-quit behavior are not covered by that durability claim.

An immutable operation ID, fixed new-chat target, full Local identity, producer
sequence and exact payload/hash are fsynced before delivery. Lost replies remain
Unknown, not rejected. Check receipt is read reconciliation; explicit Retry uses
the **same** envelope. Pending is never reposted. Startup never automatically
delivers anything. Local receipt adoption clears only the matching revision and
does not retire backend receipts. Late replies cannot clear newer input, reopen
the wrong selected draft or create another chat. Stop has no receipt/idempotency
contract: it is sent once, never retried automatically, and uncertainty requires
explicit local acknowledgement before another action.

Limits: 128 private drafts, 32 pending intents, 32 KiB editable messages, eight
recovery texts (each up to 4 MiB), 16 MiB snapshot. Saved empty chat records retire
only after UI adoption; blank new-chat drafts are reused. Snapshot writes are
atomic and off-UI. Draft autosaves debounce for 250 ms idle, with a fixed 1 s
first-unsaved-edit ceiling during sustained typing. User actions and normal exit
force a flush without waiting for that timer; intent/adoption acknowledgments
still follow durable writes. Unchanged transactions do not rewrite the snapshot.
Corrupt/missing initialized state, wrong identity, unsafe ownership and write
failures fail closed, not to an empty replacement. The private directory admits
at most 64 files/64 MiB, with up to one additional 16 MiB atomic-write temporary.
Large full snapshots still amplify disk I/O; bounds do not establish performance
parity. See [interaction evidence](evidence/local-interaction.md) and the
[bounded autosave comparison](evidence/draft-autosave.md).

Search the virtualized chat list, optionally include archives, open by click or
Return. Earlier loads up to 24 entries. Latest resumes following; reading above
the tail preserves the anchor. Retained message entities preserve selection
through prepend, updates and streaming-to-commit; switching chats clears it.
Assistant Markdown uses Kit's built-in word fade. User/tool text is escaped
into inert preformatted content, not interpreted markup. Copy source is explicit.
Document images (remote/file/data) are disabled for both measurement and paint;
links have no open handler. Structured/unsupported content has honest placeholders.
Tool calls use semantic summaries and grouped work. Expand a step to inspect
bounded inert arguments, output and structured replacement/patch previews, never
to execute or approve anything. Work follows the turn by default, folds when
finished and stays open on failure/unknown status; explicit choices persist
through streaming, commit, history prepend and row remount. Hidden bodies have
no parsers. Opened panes keep selection/copy state and a 256 px scrolling region.
See [tool presentation evidence](evidence/tool-presentation.md). This is not full Swift parity.

## Limits and lifecycle

### Native visual reader, work in progress

Use Artifacts in a Local chat's header to browse its bounded metadata gallery,
then explicitly open a pinned revision. No preview auto-runs from a message or
metadata update. Canonical artifact publication entries also have inline pinned
Open cards; body links/JSON and legacy tool-only output are not parsed into reads.
Cards cannot switch owners or silently open the latest revision. Previous revisions, source/provenance and Copy source remain
available even for unsupported kinds. Reader state is in memory for eight
revisions, separate from Swift and canonical data; it resets on restart.

Native text/layout/stats/tables, buttons/toggles/tabs, slider steppers and
bounded non-stacked line/area/bar/scatter charts and a bounded static canvas
subset are implemented with explicit display limits and simplified typography/axes.
Category labels show all through12, sparse endpoints above; labels/legends/units
are visibly elided after80 Unicode scalars; stored source/data remain intact.
Static canvas supports trusted native path/text painting, limited transforms,
viewport margins and approximated curves; animation/pointer scheduling and
non-uniform strokes/transformed text remain unsupported. Mermaid, image/SwiftUI
previews and stacked/out-of-domain charts currently show honest placeholders.
HTML/React/browser libraries and shaders remain deferred and stored data is not
deleted. Links are inert. No prepared HTML or external assets are consumed.

Only validated macOS confinement enables source/handlers, in a separate helper,
never the desktop process/thread. Linux source execution is explicitly disabled
pending native validation; source still works. Failure discards/reaps the entire
helper and keeps the last validated scene/state; Retry is fresh and explicit.
`scripts/run.sh --local` prepares/builds the pinned helper but starts no VM until
user Open. `scripts/check.sh` uses only native synthetic/faux-server tests.
See [exact boundaries, checks and remaining work](evidence/native-visuals.md).
The [bounded chart follow-on](evidence/chart-parity.md) adds signed stacked bars,
explicit bar-domain clipping, positioned x-ticks/numeric scatter domain labels
and Swift's visual palette. It retains unsupported placeholders for stacked
areas, duplicate categorical grouping and non-bar clipping; it is not full
artifact parity. Existing helper/security/provenance boundaries are unchanged.
The [native slider follow-on](evidence/slider-interaction.md) adds dragging with
one in-flight isolated callback and one latest pending value, new-version
revalidation, failure rollback and lifetime fences. Precise steppers remain;
unsupported numeric grids explain their dragging fallback. Generated handlers
never run in the UI process, and pending values are not canonical writes.

### Conversation interface

The Local browser uses the app's soft light/dark palette, follows system
appearance, keeps a compact adaptive sidebar and centers a bounded reading
column. Neutral selection identifies the opened chat independently of search.
Home and Inbox are global navigation, above an exact-project browse selector.
The bounded project catalog opens inline and closes with Escape; All chats,
Overview, history, archive visibility and search remain reachable. Home leads
with Projects, Working now and Recent chats, with a loaded-Local qualifier and
quiet title/metadata rows. Shell-only spacing/type roles do not reset editor or
Markdown metrics. See [shell hierarchy evidence](evidence/workbench.md).
Cmd/Ctrl-F focuses chat search.
Cmd/Ctrl-K opens a read-only resource jump palette over loaded pages, projects
and chats. Search is case/diacritic/width folded, grouped and bounded to six
matches per group. Empty search offers pages, projects and recent writable
nonarchived chats; explicit search also finds retained/archived chats. Arrow keys
choose, Return opens, Escape or Cmd/Ctrl-K closes and restores focus. No actions
or background reads run from search; explicit chat opens use the existing Local
subscription contract. Catalog/search work runs off the UI thread only while
open; closing releases it. See [jump evidence](evidence/jump.md).

Swift-style 4/6/8/10/12/14-point radii shape small
controls, rows, controls, cards, user bubbles and composer trays. Native 2-point
Bayer corners ripple while working (half-speed for background jobs), breathe
for needs-you and stay steady for failed/ready states. Hover recedes over 300 ms;
signal changes dissolve over 600 ms. Reduce Motion stays still. One bounded clock
per window sleeps for hidden, unmounted and nonmoving decorations, with fixed
off-thread alpha atlases and cached transcript/artifact viewports.
Details reveals prototype limitations; capacity/error notices remain visible.
See [interface verification and remaining gaps](evidence/interface.md).
See [rounded surfaces and motion evidence](evidence/rounded-dither.md), including
native light/dark/narrow/wide checks and remaining ancestor-rendering costs.
The composer uses one continuous tray surface, Kit-owned text padding and a
compact control row, with the single transient activity line just above it.
See [composer layout correction](evidence/composer-layout.md) for native bounds,
synthetic captures and interaction-preservation checks.
Scrolling to the transcript top loads the previous bounded history page while
holding the reading position and selection. Earlier remains a manual retry;
failed pages do not retry automatically on repeated overscroll. See
[scroll-history checks](evidence/scroll-history.md).
The Local viewer starts at Home with loaded-chat activity and configured projects.
Home includes all projects; selecting a project filters chat browsing by exact
`projectId`, never by checkout path. All chats restores the global list and current
conversation. Cmd/Ctrl-1 opens Home and Cmd/Ctrl-2 opens All chats. Navigation
captures the current draft, refuses active preedit and preserves the current
transcript/reading state; hidden stream projections coalesce until return.
Project browsing is read-only. New chat still asks for its own explicit Local
folder and does not inherit a project, path, model or permission from selection.
See [everyday parity inventory and checks](evidence/everyday-parity.md).
Back/Forward (Cmd/Ctrl-[ / ]) keeps up to100 window-local destinations.
The project sidebar restores its last valid chat or Overview, search/archive
filter and scroll positions (up to64 scopes). An explicit Overview button and
Home project cards still open Overview. Current-chat history stays retained in
its one retained transcript; switching back from another chat uses the Local
reader and a bounded canonical entry/model/block or tool-call position token, never a transcript cache or silent
history drain. Preedit and refused reads cannot advance history, and draft
destinations reuse existing slots without replaying sends. See
[navigation boundaries and verification](evidence/navigation.md).
Inbox provides a bounded read-only view of attention in loaded Local chat summaries,
with Needs you and Ready to merge groups and a searchable exact-project filter.
The filter starts from the current project on fresh entry; Back/Forward restores
explicit filter destinations. Counts describe loaded chat rows, never authoritative
Inbox/approval totals. Opening rows uses the existing reader without mark-read,
archive, status, merge or approval actions. Private review marks, other Inbox sources
and actions remain in Swift. See [Inbox boundaries and checks](evidence/inbox.md).
Home/dashboard, settings and full Inbox/app parity remain incomplete. macOS is the current focus.
Linux builds and launches on native Wayland; that verification covers the
build, the link, the offscreen renderer and the visible window only, not a
support claim. See [Linux Wayland verification](evidence/linux-wayland.md).

### Private rendered-UI capture

```sh
cd apps/desktop
bash scripts/capture.sh <exact-Local-chat-ID>
```

This opt-in development harness uses Kit's documented native
`HeadlessAppContext::capture_screenshot` on the production `LocalViewer` with a
read-only snapshot of exactly the requested chat. No fallback chat, live write
client, private draft store or visible window is created. It needs no macOS
Screen Recording grant. Source readiness is checked before saving actual pixels.
Test support stays development-only, not enabled in normal app builds.

Files go into ignored `evidence/local/captures/`, with a private directory and
0600 PNGs; existing files/permissions are never overwritten. Captures contain
real private content. Do not commit them, publish them as artifacts, or attach
them to a PR. The harness does not reproduce the running window's current
scroll, expansion, preedit or unsaved drafts. It is a fresh rendering of the
same views and selected chat data, not an OS window screenshot or a smoothness
benchmark. See the [Kit testing guide](https://gpui-kit.com/docs/test/).

A private single-thread async runtime owns read decoding/reduction and network I/O.
At most one control socket, one selected chat socket and one history request;
4 queued UI commands, 2 queued wire frames, 1 coalesced full UI projection.
Only complete projections are coalesced, never deltas; UI delivery is capped at
about 31 updates/s. Old chat generations and reconnect epochs cannot replace
new data. Drop aborts sockets, pending reads and timers without joining on UI.

HTTP bodies: 4 MiB. WS messages/frames: 8 MiB. Request/upgrade timeout: 5 s
(connect 2 s). Protocol ping every 30 s; no received frame for 90 s triggers a reconnect,
not a quiet chat alone. Bounded exponential reconnects, up to
8 consecutive failures, then explicit Reconnect. 44xx refusal and size/protocol
errors stop rather than spin. Resume uses the last accepted stream sequence;
replacement split snapshots retain the last visible projection until complete.

List: at most 1,000 summaries. Transcript: 256 entries, at most 512 rows before
work folding, up to 32 running progress slots, 8 MiB projected source budget (including live/tool reserve),
1 MiB per message and 64 KiB per running tool output. Oversize messages get an
explicit placeholder; capacity stops further entry/history admission without
silently evicting selected rows. Initial oversized histories show a bounded
suffix and a capacity warning. These are prototype limits, not production parity.
Escaped display strings, parser graphs, raw in-flight JSON, saved split-snapshot
history, queued projections and GPU allocations are additional memory; the
source budget is not an RSS guarantee. One retained parser per admitted row is
bounded, but not an LRU solution for arbitrary history.

Tool detail reserve: at most 256 retained call identities and 2 MiB aggregate,
including 12 KiB arguments, 40 KiB output and 12 KiB diff per call plus metadata.
Oversize/capacity cases are explicit. Incomplete output prefixes do not receive
later deltas as if complete; full updates/results can replace them. Wire output
trim uses UTF-16, not scalar/grapheme counts. Expanded panes are bounded, not a
claim of arbitrary-output virtualization or syntax-highlighting parity.

Never record real chat content, IDs, titles or credentials in shared logs,
tests or published artifacts. Explicit private capture above is the sole screenshot
exception; never publish those pixels. `--local-check` prints only counts/byte totals and
uses bounded reads, not GUI/smoothness instrumentation. See
[evidence/local-viewer.md](evidence/local-viewer.md) for verification and gaps.

## Build and launch

Requires existing `rustup`, `curl`, `python3` and platform native build tools.
Bootstrap downloads dependencies. Only explicit --local / --local-check or the
opt-in private capture helper connects to the existing Local daemon.
No sudo, global mise config, shell integration or `mbx setup` is required.

```sh
cd apps/desktop
bash scripts/bootstrap.sh
bash scripts/cargo.sh build --locked
# Opens a visible, interactive window. Arrange this with the user first.
bash scripts/run.sh
```

macOS baseline: 15+, Apple Silicon bootstrap, native Apple development tools/SDK.
Kit's runtime shader compilation is enabled by its own baseline Metal backend;
this is not support for user-authored shader artifacts.

Linux: GNU x86-64/aarch64 bootstrap, native Wayland only. Install the native build
prerequisites for GPUI 0.3.9 using your distribution's documented mechanism
(compiler/pkg-config, Wayland/xkbcommon, font/text, Vulkan/EGL libraries; Kit also
enables X11 build dependencies). This prototype does not install system packages.
It requires `WAYLAND_DISPLAY` and a reachable compositor socket, checks a real
socket connection, and selects `WindowingModes::WAYLAND`. No X11 or XWayland
fallback. An inherited `WAYLAND_SOCKET`-only launch is not supported in this proof.

When the distribution ships the X11 and xkbcommon runtime objects but not their
development symlinks (`libxcb.so.1` without `libxcb.so`), the final link fails
with `unable to find library -lxcb`. The package build script links a private
directory of symlinks to the installed runtime objects inside Cargo's own
`OUT_DIR` and adds it to the link search path, so the build works without root.
The objects keep their original `SONAME`, so the runtime still loads the real
system libraries. Installing the development packages remains the supported
path (`libxcb-devel` and `libxkbcommon-devel` on Fedora, `libxcb1-dev` and
`libxkbcommon-dev` on Debian, `libxcb` and `libxkbcommon` on Arch); the build
prints the missing names and the package hints when it has to fall back. The
build never writes outside Cargo's build directory and never installs anything.
See [Linux Wayland verification](evidence/linux-wayland.md).

Close the window or use Cmd/Ctrl-Q to flush Local drafts and exit. The synthetic
fixture remains memory-only. This is not an installer or production lifecycle shell.

## Activity and reader position

In the Local viewer, work disclosures preserve the reading anchor instead of
following their newly expanded bottom. Latest or scrolling to the bottom resumes
following. Reasoning-only/empty assistant shells never become transcript rows or
Markdown documents. Active projected reasoning uses the composer's existing
single **Thinking...** indicator in place of **Working...**, without exposing
reasoning bodies. History and reconnect snapshots do not activate it. Tools,
ordinary text, terminal events, errors and Stop clear it. Canonical daemon history
is unchanged. See [focused evidence](evidence/disclosure-thinking.md).

## Synthetic fixture mode

- 24 deterministic Markdown/code/table history rows start at the tail.
- **Earlier (+12)** reveals 12 of 48 additional older rows while preserving the
  current logical anchor. No async history source or canonical data is involved.
- **Stream fixture** grows a synthetic reply by up to 100 Unicode scalars every
  250 ms. Kit's built-in `stream_fade(true)` fades arriving words and honors
  reduced motion. **Stop** keeps its partial text. No custom animation is added.
- Wheel/trackpad upwards to read above the tail while streaming. **Latest** resumes
  following, as does scrolling back to the bottom manually. Sending an echo does
  not force the reader back down. The list's default vertical inset is disabled
  to avoid a pinned-GPUI bottom-detection bug; spacing between rows is retained.
- Type in the textarea. Enter or **Echo locally** adds a verbatim user row and a
  synthetic response containing only the character count, not interpreted user
  Markdown. Shift-Enter inserts a newline. Cmd/Ctrl-L focuses the composer.
- The composer remains editable while streaming; another send is rejected and the
  draft retained. Submit is guarded against marked text. That guard is not proof
  of operating-system IME behavior.
- **Copy source** copies that row's original source. Ordinary text-selection copy
  uses Kit's current behavior, not the source-copy button's behavior.
- The proof stops accepting new rows at a bounded 128-row capacity, without
  evicting history or truncating content. Relaunch to reset. It retains at most
  128 TextView states; this is not a scalable history cache design.

Opt-in giant-row reproductions, not automatically launched benchmarks:

```sh
bash scripts/run.sh --fixture giant  # exactly 1 MiB, 2,000 paragraphs
bash scripts/run.sh --fixture fence  # exactly 5,000 fenced Rust source lines
```

Generation is deterministic and outside the UI event loop. Fit-content rendering
is deliberately unmodified, without nested scrolling, truncation or a false
virtualization claim. These cases may stall. Arrange a visible session before
trying them. Large user pastes are not optimized or production-size hardened.

## Pins, cache and resource ownership

- `rust-toolchain.toml`: Rust **1.98.1**, edition 2024, minimal + rustfmt/clippy.
- `Cargo.toml` and `Cargo.lock`: **gpui-kit =0.8.0**, matching baseline
  **gpui-pre 0.3.9** via Kit re-exports only. No GPUI Fast, WebView, terminal,
  tree-sitter languages, syntect, shaders or iOS integration is enabled. Code
  fences render, but syntax highlighting is not part of this small proof.
- `patches/` contains scoped, checksum-pinned source edits. Builds materialize
  these into ignored `.patched/`, never into Cargo's registry/cache. See
  `patches/README.md` for provenance and the selection-lifetime contract.
- `scripts/bootstrap.sh`: **mbx 1.26.0**, platform archive SHA-256 verified.
  Rust lives in ignored `.tools/rustup`, mbx in `.tools/bin`, not user tool config.
- `scripts/cargo.sh`: private absolute `target/dev` per checkout; no shared Cargo
  target or incremental directory. Shared eligible mbx outputs live in
  `${XDG_CACHE_HOME:-$HOME/.cache}/gpui-fixture-mbx-v1`, separate from Pilot data.
  Managed mbx target views are disabled. Remote cache URL is explicitly empty.
- Cargo has two build jobs. The shared fixture mbx scheduler has two CPU shares
  and a 4 GiB **admission estimate**, not an OS memory limit. Action-store budget
  is 2 GiB, with a 4 GiB free-disk reserve; private Cargo targets are separate and need disk headroom. Tests run
  sequentially. Existing Swift verification scripts/slots are unchanged.
- No machine-wide cache cleanup is run. Inspect with
  `bash scripts/cargo.sh cache stats` or `bash scripts/cargo.sh gc --dry-run`.

**Bootstrap incident:** the first installation, before `--no-self-update` was
added, let rustup automatically update its existing manager from 1.29.1 to
1.29.2. The toolchain/default was confined to the project-local Rust home; the
existing user default remains Rust 1.99.1. No user config was intentionally
changed. Current bootstrap disables manager self-update. This incidental binary
change is disclosed, not claimed as a fully project-local first setup.

## Checks and evidence

```sh
bash scripts/check.sh
# Real offscreen renderer, optional local screenshot. Does not open a visible UI.
GPUI_FIXTURE_SCREENSHOT="$PWD/evidence/local/offscreen.png" \
  bash scripts/cargo.sh test --test rendering --locked
```

Pure tests cover stable IDs, history bounds, stream/prepend identity, exact UTF-8
source reconstruction, local echo/overlap/stop/capacity and stress fixture sizes.
UI integration tests use the production view on GPUI's test platform, dispatch
real Kit pointer/key/scroll events, and check owner state/geometry. A separate
main-thread test uses the real native offscreen renderer. Neither establishes
visible smoothness, OS IME routing or assistive-technology correctness.

See `evidence/initial.md` for exact commands, results, build/cache observations
and limitations. Raw run logs/screenshots are ignored under `evidence/local/`.

Reproduce the serial build-loop and tiny cache probes without opening a GUI:

```sh
python3 scripts/measure-builds.py  # baseline, no-op, comment edit, exact restore
python3 scripts/cache-probe.py     # tiny two-source-root cache restore, NOT GPUI
# macOS only, explicit synthetic native workload observations:
python3 scripts/measure-rendering.py target/dev/debug/deps/rendering-<hash>
```

The first script temporarily edits `src/lib.rs` and restores its bytes. Run it
without another writer in this workspace. It does not clean targets or caches.
The second uses two temporary, private targets and removes only those probe
directories. Neither is a repeated cold-build/second-worktree benchmark.

For opt-in native text scaling, build `bash scripts/cargo.sh test --locked --test scaling --no-run`
and pass that exact executable to `scripts/measure-scaling.py` with its build-time
`--base-patch-sha256`. The wrapper freezes it before serial synthetic runs. It
does not read chats or open visible windows. See [scaling evidence](evidence/scaling.md)
for source-readiness/copy assertions, the unchanged4096-entry cleanup trigger,
the selected-source timeout fix and unresolved long-line/layout costs. These
debug offscreen results are not release, frame-pacing or Swift comparisons.

## Known gaps and next review

This is not full Swift parity. The Local interaction and selected interface/native
visual subsets above are connected; their wider parity gaps remain. Tool summaries have conservative generic fallbacks;
unsupported image/rich result content is not silently treated as text.

- The fixture now opts into message-local selection retention through its
  pinned source patch. Actual selection/copy survives unmount/remount, prepend
  and another message's stream, with Unicode and dismissal tests. This is not
  full selection parity: long three-viewport gestures, table TSV and list-prefix
  copy remain acceptance work. User
  rows in fixture mode are literal text plus source-copy. Live user/tool rows
  use selectable inert preformatted text, not Markdown interpretation.
- Fit-content TextView builds all blocks of a giant message; this proof does
  not solve giant-message layout, parser-state scaling, async code highlighting
  or 1k/10k histories.
- The fixture's pinned patch fixes ordinary grapheme navigation/deletion, including
  combining accents, family emoji, flags, modifiers, Hangul and chunk boundaries.
  Synthetic marked-text/UTF-16/undo/focus tests cover the guarded input path;
  actual macOS/Wayland IMEs, candidate windows and broader RTL still need native
  verification. Queue editing, pickers, rich paste and complete submit semantics
  are intentionally absent, not silently claimed equivalent.
- Dedicated accessibility work is deferred for this personal-use app. Existing
  Kit support remains unchanged; no custom AccessKit/TextRun patches or
  VoiceOver/Orca integration/tests are being added. Known AX gaps are not an
  initial implementation or acceptance blocker. Ordinary keyboard, Unicode,
  focus, selection and IME correctness remain in scope.
- Visible macOS smoke, real Wayland smoke, narrow-window/reflow, light/dark,
  reduced motion, matched Swift runtime/build measurements and repeated cache
  A/B trials remain separate from this offscreen proof.

**Review point:** inspect the implementation and synthetic evidence before using
real write controls. No automated real mutation smoke was run. Packaging,
defaults and Swift removal remain unapproved. A successful build or an
attractive screenshot does not establish runtime improvement or full parity.
