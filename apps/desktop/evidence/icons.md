# Native icon vocabulary

## Scope and visual intent

One outlined Lucide family supplements existing labels. App-owned meaning lives
in `app_icon.rs`; existing Button/List/editor owners retain their state, IDs,
eligibility and handlers. Glyphs inherit the host's semantic text color, use the
existing rem scale, and introduce no entities, motion clocks, caches or I/O.
The calm workbench hierarchy, neutral selection and shared Bayer activity stay.

`ChromeAssets` composes seven selected static additions before Kit's default
asset source. The full catalog enum alone does not embed these glyphs. Missing
paths never cause an external/network fallback. Kit's default search, select,
checkbox and disclosure assets remain available. The additional icons come from
the already pinned `gpui-kit-assets` 0.8.0; no dependency or generated patch was
changed. `licenses/LUCIDE.txt` retains the upstream Lucide ISC and Feather-derived
MIT notices verbatim. It must accompany any eventual distribution of the icons.

## Surface coverage

| Surface | Treatment |
| --- | --- |
| Global navigation | House, Inbox and MessagesSquare with existing labels and neutral selection |
| Project scope and choices | Folders for global scope, Folder for exact projects; existing disclosure and keyboard owner |
| Home projects | Folder beside the existing title/metadata block, with bounded long labels |
| Back, Forward, New chat, Reconnect | ChevronLeft/Right, SquarePen and RefreshCw; labels/accessibility and eligibility unchanged |
| Jump palette | Destination-kind cues from the typed destination, not parsed titles or raw payloads |
| Composer | Outlined Square for Stop, ArrowUp for send/create; labels and guarded handlers retained |
| Delivery recovery | Existing Check/Retry/Open/Copy/Remove/Acknowledge actions gain semantic glyphs, no new actions |
| History and artifacts entry | Earlier/Latest, gallery/back and Details retain existing routes and labels |
| Tool steps | FileText, SquarePen, SquareTerminal, CodeXml, Search, Globe or Wrench from the existing typed kind |
| Failed tool step | TriangleAlert from actual error status; existing failure text remains |
| Tool copy | Copy beside the existing label; hidden parser and selection lifetimes unchanged |
| Empty Inbox | Inbox plus the same loaded-summary qualifier and empty/loading explanation |

Intentional exceptions: chat rows keep their dither corner and state/reason
text, without a generic chat glyph or second status column. Archive remains a
labeled framework checkbox. Counts/section headings need no decoration.
Disclosure chevrons, search/select/checkbox glyphs remain Kit-owned. Arithmetic
steppers and stored artifact content are not app-chrome icon replacements.
Finished tools gain no checkmark. Notes and private reasoning gain no icon or
new exposure. Unknown/question and archive glyphs are not embedded speculatively.

Artifact-pane gallery, back, retry, previous revision, source and copy controls
also receive glyph properties only, after ownership coordination. Their labels,
callbacks, generation/eligibility fences, controller and runtime stay unchanged.
App-wide finishing is separate. This is not a complete-parity/acceptance claim.

## Verification plan and current limitations

The first strict pass found a missing InteractiveElement probe import and an
unnecessary IconNamed test import. Both were corrected; all-target native-probe
Clippy, the static asset test and formatting passed. Frozen initial source
`59d2ba3ed7097100999454384f4c1fca8511b95c` passed focused job `f773ee0f`:
all 26 initial roles actually painted at 680/1100 light/dark, plus four production
workbench scenes with real icon pixels, label/slot bounds and all existing
navigation/preedit/draft/reader/no-write assertions. Synthetic Home/chat/scope
captures were inspected; raw images and logs stay ignored. The later six
artifact-chrome glyph properties and Source alias also passed focused job
`45e205a0`: all 27 roles paint in all four configurations, and native control
pointer/lifecycle/rollback/replacement/stale-binding/close checks pass. Removing
the import and six glyph-property additions reproduces the complete prior
artifact view byte-for-byte, including every handler and controller.
No complete native/full-suite or readiness result is claimed yet.

The first combined gate stopped in the library suite (149 passed, one failed,
two ignored) before native suites: a prior leading-text guard assumed one
glyph and a fixed 40-pixel budget. Tool rows now contain a chevron plus a kind
glyph. The replacement checks their actual two-rem leading slot, quarter-rem
label gap, leading inset and label containment, rather than widening the bound.
Lazy parsing, pointer expansion, exact Copy and hidden-update checks remain.
Focused job `d276035b` passed strict checks, all five tool-work regressions and
native multiframe disclosure/anchor/lifecycle cases. The corrected combined
source requires a fresh final gate; the interrupted gate is not reused as one.

The static glyph board proves actual SVG paint within mounted bounds for every
mapped role at 680/1100, light/dark. It is not a production-root layout test.
The production workbench probe separately checks navigation icon pixels,
leading slots/label gaps, hit targets and the existing route/preedit/draft/
reader/cursor/no-write invariants. Correct bounds or catalog names alone do not
establish painted coverage. Existing editor, history, palette and tool checks
remain required; the glyph target is explicit in the full check wrapper.

Only offscreen synthetic fixtures are permitted. No real send/create/Stop,
archive, mark-read, approval, live content capture or visible benchmark is used.
No backend, helper, source-execution or permission semantics change. Browser,
shader, terminal, release/default switch, Swift removal and deferred platform
work remain out of scope. OS IME/hardware and performance acceptance are not
established by static images or element counts.
