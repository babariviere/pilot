# Pilot Next, Native Shell chat slice

Additive macOS native chat runtime. The shipping GPUI binary and its entry point
are unchanged. This is not a complete replacement or a release package.

## Source and reuse

NSH **0.4.0**, upstream `main`/HEAD observed at **2026-11-06T18:37:37Z**:
`7571948ee4ad05fbc0b08d774e6afc63e039773d`.
All NSH dependencies, including testing and transitive platform/core crates,
share this exact revision in `../Cargo.lock`. No NSH patches, forks, Cargo-cache
edits, QuickJS, TSX or WebViews are used.
The update from `0e4a20bd41ee72a35515cecbf9a7fba88742d911` spans seven upstream
commits. Its relevant changes add macOS app-owned windows and route input/focus
through each event's window root, plus an optional standalone restart command.
Other changes concern packaging, Android, Linux, Windows and gallery audio.
Pilot does not adopt these new features. Historical experiments keep their pins.

The layout and tokens start from `experiments/nsh-pilot` at `39a4913c`, not the
older patched `nsh-chat` study. NSH owns native input, undo, text selection,
Markdown, scrolling and rendering. Pilot owns canonical locations and actions.
The slice uses upstream Rust `Input` (native multiline composer/search),
`Button`, `TextView` (Markdown/plain documents), `Scroll`, `VirtualList`, keyed
regions, and the Rust application-menu API with native editing/window roles.
Pending questions use upstream `Input`, `Checkbox`, `Radio`/`RadioGroup` and
`Button`. NSH owns selection, keyboard activation and radio arrow-key movement;
Pilot supplies the existing labels, colors and captured reply identity. No
choice is selected or submitted by default. Database decisions have no default
focus or Enter-to-approve shortcut.
There is no custom text editor, button engine, scroll engine or text renderer.
The AppKit embedding host is needed because upstream `run_app` closes immediately
and exposes no cancellable draft-save close hook at this revision. It owns only
native input capture and the existing courier's close acknowledgment.
The embedding delegate also targets native Undo/Redo menu roles. Upstream's
plain embedding window has no responder for these actions. AppKit owns the undo
stack; the delegate reports its result with NSTextView's standard text-change
notification so NSH and the saved draft stay in sync. The fixture explicitly
groups synthetic insertions, which are not real hardware keyboard events.
The upstream `Tree` was also inspected. The sidebar keeps the production flattened
project/mission/fold-action rows and composes NSH Buttons inside Scroll, rather
than introducing a second expansion/selection model for the same rows.
The small `../src/nsh_adapter.rs` facade uses the shipping `LocalClient`,
`Interaction`, `delivery_store::Store`, `local_model`, `sidebar_tree` and
`sidebar_memory`. It creates no new transport, delivery protocol or storage
schema. The temporary dependency on `pilot-desktop` still builds GPUI. Separating
that dependency is later work, not a second copy of the safety-critical code.

## Build and run

From the repository root:

```sh
bash apps/desktop/scripts/bootstrap.sh
bash apps/desktop/scripts/cargo.sh build --locked -p pilot-nsh
# Explicit existing-daemon connection. Never starts or replaces a daemon.
apps/desktop/target/dev/debug/pilot-nsh --local
```

`--local` uses existing Local profile discovery and hello identity pinning. This
is the established loopback contract, not authentication. Running it explicitly
enables user-driven sends and Stop. It shares the shipping draft directory and
format; the existing writer lock refuses a second simultaneous writer. It never
deletes a lock or migrates data. `--state-dir PATH` selects a separate private
directory in that same format. No arguments make no connection.

The composer keeps exact UTF-8 text, including whitespace and multiline input.
Each callback captures its canonical chat and navigation generation. The existing
courier saves immutable operations before effects, reconciles eligible sends with
the same durable envelope, and keeps Unknown across restart. Historical Unknown
is not a new send. Stop is not automatically replayed. Ordinary legacy Ask and
restricted chats remain read-only. Unsupported saved draft forms direct the user
to the current app, without sending them as ordinary text.

## Pending questions and database access

Only the production reader's structured pending-question projection opens the
question panel. Agent prose never creates a question or approval. A reply has
its own exact text, choices, entry/fingerprint and captured revision, separate
from the ordinary draft. Send answer uses the existing `Answer` courier command
and daemon `questionReplyId` contract, not ordinary composer Send. A changed
question keeps old text separately; Keep reply in recovery uses the existing
Store action. Accepted replies retire only through the existing exact-ACK path.
Pending/Unknown answers remain in the production Store across navigation and
restart. Neither a stale callback nor a new question retargets the saved reply.

The only supported approval is a well-formed structured database-access request.
Its title and scope come from the reported environment and read/write mode,
never agent prose. Allow/Deny invokes the production `DatabaseAccess` command
with the exact request ID. Malformed requests stay unavailable; this slice adds
no execution, elevation, Review, repair or other approval authority.

**Existing contract limit:** database decisions have only a volatile courier
reply, unlike durable question answers. Pending/Accepted/Unknown remains tied to
its original request during navigation in this process, and nothing is replayed
on restart. The original decision/result cannot be restored after process exit.
A still-open request can receive another explicit choice, as in the shipping UI.
Cross-restart approval-result retention needs a separate storage/receipt contract;
this facade does not invent one. Full approval restart acceptance remains open.

AppKit Close/Quit captures both native editors and releases focus, then waits for
the existing courier's final `Close`/`Flushed` publication and exact saved drafts.
Marked text, unsaved input or save failure keeps the window open. This embedding
host is Pilot integration, not a patched NSH lifecycle.

## Work groups and tool details

The transcript uses the production `local_model` work groups and
`tool_presentation`/`tool_script` summaries through `nsh_adapter`. Canonical
entry and top-level call identities stay separate from Markdown. Assistant
Notes remain chronological messages between groups; true Thinking remains a
transient composer status. Printed tool names or outcomes never create state.

A compact effects-first summary opens the full quiet call list. Without a user
choice, a live group shows the latest five production work units (consecutive
successful reads count as one), with Show earlier. An explicit open or fold wins
over streaming updates. The folded first error opens only its original call.
No ribbon or grid is used. Each call shows output first, with its own outcome;
Code or Command is separately collapsed. Copy uses the exact kept literal
source/output, including any recognized codemode header omitted from display.
Existing output limits and patch-preview omissions remain disclosed.

NSH's native `Collapsible`, `Button`, `Scroll` and selectable `TextView` provide
disclosure, keyboard activation and text rendering. `Accordion` was inspected;
the live-tail/full-list/explicit-fold workflow is not an accordion's binary open
set, so Pilot composes the lower-level native controls. No engine or control
replacement is needed. Disclosure choices live outside recycled cells, keyed by
chat and canonical calls; an inner keyed region prevents a recycled row from
keeping another call's callbacks. Navigation generation still fences actions.
NSH owns keyed-list scroll anchoring and follow-end behavior. Cross-recycled-row
selection remains unqualified.
The list uses NSH's bottom-aligned chat mode. Latest overlays the transcript,
so revealing that control does not resize the reader viewport.

## Lazy history and Find

The initial chat socket opts into the existing `history=paged-v1` recent window.
No history GET runs on initial selection. NSH's native
`on_load_more_at_start` requests the next existing 24-entry page as the reader
approaches the top. Earlier messages remains a native list-header fallback.
Canonical `ReaderKey`s, not projected row allocations, key the list. Native
anchoring preserves the reading position during prepend and concurrent append;
Latest follows the end and rereads the bounded tail only when the production
reader says newer entries were omitted.

Find (⌘F) opens a native input with count, wrapping previous/next and Close.
Enter/Shift-Enter navigate; Escape closes and returns focus to the composer.
Search is literal and case-sensitive, with the existing 1 KiB query and 1,000-hit
limits, committed-message eligibility and tool/placeholder exclusions. The tray
explicitly says Loaded messages only until Load full history finishes the same
sequential read lane used by the shipping app. Stop loading, query changes,
close and chat switches cancel further traversal. An already-entered read may
finish; it never starts another traversal for an old query or location. Failed,
limited and cancelled coverage never becomes All messages or an unqualified
No matches. One off-thread scanner coalesces queued work and rejects old results.

Upstream components inspected at unmodified `7571948e`: native Input, Button,
VirtualList keys/header/start-loading/viewability, ElementRef measurement and
scroll-to-index, and owner-scoped `on_key`. They cover this workflow without a
custom scroll engine. NSH does not keep Pilot's cross-chat canonical reader
marks; a small app-owned in-memory mark uses native measurements and re-pages
to its key on return. The hidden native 96-entry fixture also exposed a return
from entry 73 to the tail during concurrent prepend/append despite stable keys.
The same measured mark is reapplied through native scroll-to-index on prepend.
NSH's `after_answer` waits for the row props to reach the list; navigation then
resolves the canonical key again, rather than keeping an index from an old page.
This is an observed integration mismatch, not a hardware
scrolling claim or an upstream root-cause diagnosis. It adds no store, transport
or custom scroll engine. NSH TextView has no public
literal-source-to-rendered range mapping/paint-range API. As in the shipping
Find's source context fallback, an exact Unicode context marks the active
occurrence beside its original row without replacing Markdown or native
selection. No upstream patches, cache edits or selection workaround is used.

## Isolated verification

```sh
bash apps/desktop/scripts/cargo.sh test --locked -p pilot-nsh \
  --features native-probes --test chat --test work --test history -- --test-threads=1
bash apps/desktop/scripts/cargo.sh clippy --locked -p pilot-nsh \
  --features native-probes --all-targets -- -D warnings
bash apps/desktop/scripts/cargo.sh build --locked -p pilot-nsh --features native-probes
apps/desktop/target/dev/debug/pilot-nsh --fixture --capture /tmp/nsh-light-wide.png
apps/desktop/target/dev/debug/pilot-nsh --fixture --dark --capture /tmp/nsh-dark-wide.png
apps/desktop/target/dev/debug/pilot-nsh --fixture --width 680 --capture /tmp/nsh-light-narrow.png
apps/desktop/target/dev/debug/pilot-nsh --fixture --dark --width 680 --capture /tmp/nsh-dark-narrow.png
python3 apps/desktop/nsh/scripts/native-check.py \
  --binary apps/desktop/target/dev/debug/pilot-nsh --output /tmp/nsh-native-check
```

The fixture binds an OS-assigned loopback port. Both the runtime and tests use
the actual production HTTP/WebSocket reader and courier against it. It makes no
provider/model/account calls. Automated captures require `--fixture`, create
hidden AppKit views and never activate a window. The synthetic host is test
authority only, not an alternate production transport.
`nsh/scripts/native-check.py` runs all four appearance/width combinations and
then starts a second process per profile to check exact saved-draft restoration.
It also checks that normal Send/Stop settled before closing. The adapter tests
cover a refused second writer and failed private save without a false close ACK.
The matrix also runs hidden native question/choice and read/write permission
interactions, capturing each at both widths in both themes. Tests cover exact
reply formatting/identity, stale revisions and chat switches, unsent recovery,
lost ACK/restart without new submission, explicit Allow/Deny, refusal, malformed
requests and restricted roles. These are real NSH views with a synthetic host,
not mockups or evidence of live approval behavior.
The native question probe also simulates AppKit marked text and verifies that
Close does not release it. This is not hardware input-method qualification.

The history matrix uses 96-entry histories across four pages. It checks a passive
bounded first load, top-triggered prepend with concurrent append, the same reader
position on chat return, explicit Latest, keyboard Find, an older-page-only
Unicode match and wrapping navigation. Adapter/headless tests also cover query
and chat cancellation, reader failure and partial coverage, the inherited query
and hit limits, and preserved drafts. Native reader checks wait for the canonical
source and its position, not a transient Latest button during page restoration.
An isolated history run reproduced missing composer readiness. Its original
failure evidence is kept. The coordinate follow-up below fixes
a demonstrated probe error, not production composer mounting.

The matrix also exercises hidden real native work groups in each profile
(`--check-work`): folded, expanded, live-tail, individual output/code and failure
captures, native Space disclosure, chat switching and Stop. The Rust work tests
use the same isolated HTTP/WebSocket host and production adapters. They check
mixed steps, merged reads, interleaved Notes, Pending/Failed/Unknown, literal
codemode labels, late output, row recycling and exact Copy without touching the
system clipboard. The native reader-anchor check sends a synthetic wheel to
the same native tree while briefly detached, then reattaches it. An ordered-out
window has no display-link frames; upstream reports an unmapped scroll
immediately. This uses public embedding/AppKit behavior, not an engine patch,
and does not qualify hardware scrolling or visible-window timing.

The `7571948e` dependency recheck passed all 12 adapter/headless chat tests and
locked builds with and without `native-probes`, without Pilot API changes.
The hidden native matrix passed all four profiles (12 processes, 20 captures).
Its first invocation failed the composer lookup after initial chat selection;
the unchanged binary then passed the complete matrix twice. The cause remains
unresolved; these passes do not establish hardware input or full-workflow acceptance.
The probe now clicks each chat once and waits, within the existing 15-second
readiness deadline, for that exact chat's attached, editable, laid-out native
composer instead of assuming a 350ms settle proves selection. Native negative
checks reject a missing composer and another chat's composer. On a readiness
failure it prints expected/observed editor identities, selected native rows,
before/after hierarchy and geometry, elapsed time, and saves a separate
`*.readiness-failure.png` capture. This is fixture-only probe hardening, not a
production fix or an explanation of the original failure. Two bounded follow-up
runs (one unchanged, one diagnostic-only) did not reproduce that failure.
Scoped clippy (`pilot-nsh`, all targets, `native-probes`, warnings denied),
Rust formatting, exact shared-pin checks and all 72 CI-wrapper tests also passed.

### Native probe coordinate follow-up

The captured history failure had no selected row and still showed Choose a chat.
Its before-click layer rectangle for chat a was `(0,32,231,50)`. The old probe
therefore sent window point `(115.5,57)`, which NSH's flipped root reads as
`(115.5,763)`, not the chat row. The snapshot and click run in the same main-queue
closure. Label existence did not establish backing-layer attachment. The later
layer rectangles alone must not be used as the before-click geometry.

The probe now checks that the target's backing-layer ancestry reaches the
content layer before using layer conversion. Until it does, AppKit's native
view conversion supplies the center without waiting for display. A deterministic
nested-view regression reproduces the wrong layer conversion before layout and
checks the exact native center. Attached layers keep the original conversion:
NSH scrolls can move content with layer transforms before view bounds catch up.
A first broad view-only change failed the native work-disclosure check for this
reason; that failed run is not counted as a pass.
The one click, original 15-second deadline, exact attached/editable/nonzero
composer predicate and failure capture remain. It observes the exact native
sidebar selection before checking the composer, and failure reports distinguish
selection publication from editor readiness and include both view/layer geometry.
No app callback, adapter, backend, NSH source or dependency pin changed.
This does not diagnose the older uncaptured failure or qualify hardware input.

Follow-up verification passed the deterministic disconnected/attached-layer
regression, the full hidden light/dark × 680/1180 matrix (20 processes, 84
captures), scoped rustfmt/clippy with warnings denied and the locked native-probe
build. All native work used the private mbx CPU2/4GiB reservation. Runtime and
adapter code did not change, so this follow-up did not rerun headless adapters.

## Slice boundary

Home, Inbox, Review, Missions, Automations and Settings are visibly unavailable.
Chat creation, attachments, unsupported permission types,
persistent sidebar preferences, update/package integration and
other workflows remain in the current app. Stored sources remain untouched;
unsupported image/artifact content shows a placeholder, never a browser fallback.
Lazy-history/Find tests use synthetic multi-page histories through the real
production reader, not live conversations. Hardware scrolling/selection and
release-build long-history performance remain acceptance work.

Tests and captures do not qualify hardware IME, cross-recycled-row selection,
large-history speed, OS shutdown/logout, power loss, updater close coordination or
Linux. No performance or production-completeness claim is made.

## Attribution

Existing MIT and third-party notices remain in `../licenses/`. NSH is unmodified
upstream Apache-2.0 code. Embedded fonts and Lucide icons keep their existing
attribution there; the source references the existing app assets and prototype
icon mapping rather than duplicating them.
