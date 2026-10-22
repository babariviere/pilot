# Scoped dependency patches

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
adds one method to its message scroller. `pause_following_tail(cx)` forwards to
GPUI's existing offset-preserving pause. Expanding/collapsing work is reader
navigation, not a request to jump to the newest output. Parser/stream updates
do not invoke that pause; Latest and wheel-to-bottom retain Kit's behavior.
When content still fits at the bottom, GPUI may immediately resume following.
No default, framework version, registry or global configuration is changed.

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
