# Scoped dependency patches

The opt-in `TextViewState::plain` constructor uses the existing paragraph,
selection, range-highlight and reveal primitives with literal UTF-8 source
positions. It interprets neither HTML nor Markdown. Next's user/automatic
message text uses this instead of generated `<pre>` HTML, which has no source
mapping and cannot use range highlights. Markdown and HTML defaults stay
unchanged. Plain updates and reparses share the existing source/revision
tracking; no alternate selection or paint layer is added.

These are isolated desktop-prototype edits to published, pinned sources, not registry/cache
edits, an upstream fork or a framework upgrade. The application still imports
GPUI exclusively through Kit 0.8.0 re-exports, with baseline GPUI 0.3.9.

`gpui-base-0.8.0.json` records exact preimages/replacements and the original
crates.io archive SHA-256. `scripts/prepare-patches.py` verifies that archive,
extracts it into ignored `.patched/gpui-base-0.8.0`, checks every edit count,
and fingerprints generated inputs. It refuses to overwrite changed generated
files. Never edit `.patched` by hand, Cargo's registry or the shared cache.
Change the tracked edit specification instead. The extracted crate retains
its upstream Apache-2.0 license and copyright notices.

Bootstrap may fetch only the checksum-pinned original crate archive into
`.tools/downloads`. Normal builds materialize offline from that archive or an
existing Cargo archive. Run `bash scripts/bootstrap.sh` on a fresh checkout,
then use the regular `scripts/cargo.sh` wrapper. `[patch.crates-io]` applies only
inside this standalone fixture. No global Cargo/Rust settings are changed.

## Selection retention

Five further exact edits keep plain `SelectableText` paint checks local to the
participant's cached copy projection, instead of serializing all window selection
participants twice for every cell. Explicit window copy and its callbacks remain
unchanged. The new helper is crate-private, adds no state, and does not invoke
callbacks while painting. App-side320-cell, Unicode pointer-selection and changed
selection/copy regressions exercise the actual patched components. See
[`../docs/artifact-scroll.md`](../docs/artifact-scroll.md) for native timings,
remaining dense-table layout cost and the deterministic-scheduler caveat.

Opt-in `TextViewState::retain_selection_on_unmount(true, cx)` adds message-local
selection to the fixture's existing stable-ID, app-owned TextView states. Kit's
default behavior remains unchanged for callers which do not opt in.

The selected document retains its logical source byte ranges when its row
unmounts. Window bookkeeping keeps only the weak participant identity needed
for copy/clear, without mounting offscreen row elements. Detached registrations
are excluded from hit testing and touch geometry. Remounting projects the
retained document ranges, not old window coordinates. New drags cannot widen
into another message. An ordinary click elsewhere clears the retained range.
The existing 128-message fixture bound still bounds retained state; this is not
a scalable parser/history cache implementation.

The patch does not redesign table/list/source copy formatting. Tests compare
actual clipboard output before/after recycling, separately from Kit's window
query serializer (which can add a paragraph newline). Unicode source offsets,
prepend, other-message streaming, real unmount, remount and dismissal are tested.
Existing selection is never transferred to a newly appended message ID.

Rich-text selection resolves its own content-relative endpoints against the
current layout origin and scroll offset. Inline paint precedes registration of
that geometry, so last-frame window points would otherwise project into the
wrong text. A committed-row label exposed this ordering bug even without a source
change. Detached participants still use logical retention; mounted ones can
reproject selection after a streamed parse, and ordinary clicks still clear it.
Readonly regressions cover prepend/commit, Unicode copy, completed background
parsing and a changed canonical reader identity.

Before live integration, this patch needs upstream review and broader native
interaction testing. It does not establish accessibility, giant-message,
cross-platform or rendering-performance parity.

## Composer keyboard and marked text

The same pinned Base patch makes ordinary Left/Right, Shift-selection,
Backspace and forward Delete use Unicode extended grapheme boundaries. It
walks Ropey's actual chunks with `unicode-segmentation::GraphemeCursor`, supplying
preceding context for regional indicators and chunk-split clusters. It does
not copy the full document for each key, change atomic inline tokens/folding,
or alter exact byte/UTF-16 input-handler replacement APIs.

The Enter action now refuses both Return and Shift-Return while marked text
exists. Native IMEs normally intercept those keys first. This defensive action
path prevents a fallback newline from clearing preedit and causing a previously
queued Enter event to submit the draft. Pointer-submit guards remain in place.

Tests exercise grapheme editing/copy/undo/redo, actual rope chunk boundaries,
UTF-16 preedit with a surrogate-pair prefix, Hangul rewrites, cancellation,
commit, focus and local echo. These are real component/input-handler tests,
not a running OS IME/candidate window test.

Dedicated AccessKit/TextRun/caret and screen-reader work is deferred under the
personal-use scope correction. This patch does not change built-in accessibility
support, and those deferred gaps are not an initial acceptance blocker.

## Readonly document image policy

Four additional exact edits to Base state add the opt-out
`TextViewState::images_enabled(false)`. It replaces the document image source
with one inert missing embedded asset, for both layout measurement and paint.
Remote, file and data URLs therefore never reach the default resolver. The
Component wrapper has no image-policy forwarding method in 0.8.0; owning the
policy in retained Base state keeps Component styling and built-in fade intact.
The default remains enabled for other callers. A fake HTTP-client regression
checks zero image requests while rendering a remote Markdown image in live mode.

Image-policy specification: 22 exact edits, still four Base source files.
Earlier evidence documents the prior 18-edit selection/composer revision; its
historical checksum is not the current image-policy specification checksum.

## Reader-controlled work disclosures

`gpui-component-0.8.0.json` pins the original Component archive separately and
contains seventeen exact edits across two files: thirteen to its message scroller
and four for an opt-in `ListItem::hover_fill(false)`. The original
`pause_following_tail(cx)` forwarding method remains available. A separate
`hold_for_disclosure(cx)` records reader intent and preserves the logical anchor
in Normal mode. A temporary Tail pause alone immediately re-arms during bottom
layout, which made expansion jump to the new bottom. Layout and streaming never
release this explicit hold. Both list and ScrollBounce user-scroll callbacks use
the measured scrollbar range, even while offscreen heights remain unknown.
The hover-fill option defaults to true. App-owned dither rows opt out of the
default fill while retaining input, selection, keyboard highlight and hover
callbacks. Other lists retain their original behavior.
Genuine scrolling to the bottom (including content
that fits), Latest or a chat reset re-arms Tail. Shrinking content still clamps
normally when the old viewport would extend past its end.
Only explicit app-owned disclosure actions opt in. No default, framework version,
registry or global configuration is changed. Native production-root regressions
cover header/icon positions, streaming, prepend, tall detail, remount, wheel and
Latest; see `../evidence/disclosure-thinking.md`.

Two additional edits expose a `MessageScrolled` event from the existing genuine
list/bounce callbacks. Layout, remeasurement, reset, splice and decoration do not
emit it. The app uses this event for bounded top-of-history reads, with an
upward-wheel fallback when content fits and the bounce lets events bubble.
History paging reuses the explicit anchor hold; no default scroll behavior or
automatic network operation is added to the component itself.
The Base scrollbar's opt-in `on_scroll` callback also reports track clicks,
thumb drags/releases and touch drags. The explicitly-modeled message scrollbar
routes those events through the same deferred `user_scrolled` handler as wheel
input. Previously, a scrollbar could reach the physical bottom while disclosure
hold stayed in Normal mode, hiding the next reply and telling the bounded reader
to hold older rows. Layout/remeasurement never releases the hold; ordinary older
reading stays anchored. The native disclosure probe asserts final-reply bounds
after actual scrollbar input, tool completion and a sliding history window.
An additional read-only accessor lets the app identify an actual scrollbar drag
at its measured start on pointer release. It is not a render-time boundary poll.
Another bounded accessor reports existing unused tail space. The app retains
that space while prepending into a short document, without adding a message row;
genuine bottom scrolling, Latest or reset releases it before normal Tail use.

Four further exact edits add `MessageScroller::with_scrollbar_mode`. Its default
is `None`, preserving the original scrollbar layer. An explicit mode uses the
same Base scrollbar, layout viewport and list handle with a stable scroller ID;
only visibility is overridden. The transcript chooses `Scrolling`, without
changing global theme/OS preferences, drag geometry, events or anchor handling.
Native history checks compare active/idle pixels and exercise real wheel/drag.

## Retained-layout cleanup

The combined Base specification now has28 exact edits across six files. The
four additional `inline.rs` edits keep the4096-entry sweep trigger and weak
identity checks unchanged. This trigger is not a live-entry size cap.

Previously, every retained inline above that trigger walked the whole table,
even if all states were still alive. A zero-sized state-lifetime marker now
increments an atomic destruction epoch, including on the parser thread. Each
UI thread remembers its last completed sweep epoch and skips redundant walks
when no state has died. Below the original trigger, cleanup remains deferred.
Live layouts are never evicted, capacity is not raised and text/selection/fade
or source mappings do not change. A destruction during a sweep remains visible
to the next sweep because the pre-walk epoch is recorded.

Two test-support-only edits expose the actual cleanup invariant assertion to the
desktop's library tests (dependency packages cannot run their dev-tests as
non-workspace members). This seam is absent from normal builds; it adds no tool,
transport or host capability. The ordinary threshold/dead-entry/live-entry and
cross-thread-drop regression therefore runs against the real patched code.

## Dropdown dismissal focus

One exact Component edit prefers an explicit retained menu trigger when restoring
focus on dismissal. Dropdown menus are built after the containing popover takes
focus, so their captured previous handle can name the disappearing popover
content. With no focus before opening, Escape previously left that orphaned ID
and an empty keyboard context. Ordinary menus without a trigger retain their
previous/action-context fallback. The existing guard still leaves focus alone
when a menu item has moved it to another input or dialog. No layout wrapper,
activation, dependency version or default menu selection changes. A blurred
keyboard unit is the negative regression; native history verifies the real
Escape, Tab-to-trigger, Enter and arrow/Enter path.

## Styled selectable ranges

One Base edit adds `SelectableText::styled_ranges`, which forwards byte-range
highlights (weight, color, italic, strikethrough) and font-family overrides to
the element's own `StyledText`. They resolve against the inherited text style at
layout. Selection, hit testing and copy still use the unchanged plain text, so
native visual text runs keep exact selection/copy. Callers give every run its own
range: GPUI applies a family override only to whole runs.
