# Loaded-conversation Find

## Audit and source

Pilot already retained canonical `ReaderKey` identities, bounded Local reader
windows, selection-preserving TextView entities, prepend anchors and explicit
Latest/tail-following controls. Links already inspected loaded source, but there
was an existing Cmd-F sidebar-focus shortcut, but no conversation Find bar or navigation between source occurrences. These
existing owners and controls are retained, including sidebar Cmd-F outside the active
conversation/composer. There is no backend/search endpoint.

Native adaptation reference, verified checkout HEAD:
`hardbeat920/monocode@26465c620977f3951d0a532a0f7db32c3c179007`:

- `src/features/sessions/ui/TranscriptFind.tsx`: compact input, count, previous/
  next/close controls, wrapping active match and composition-aware keys.
- `src/features/sessions/model/transcriptFind.ts`: literal source inspection
  and stable block identity, narrowed here to committed visible message rows.

The reference root LICENSE is MIT, copyright (c) 2026 Nick. Its full, unchanged
notice is already retained in `licenses/MONOCODE.txt`, shared with the earlier
tool-helper adaptation. Root NOTICE disclaims agent-vendor affiliation and notes
provider trademarks. No assets, provider marks, runtime or dependencies are
copied. Source comments pin the adaptation and point to that existing notice.

## Native behavior and intentional differences

Cmd-F opens a native Input in the current loaded conversation, from its reader
or ordinary composer. Dialogs, sheets, question/model/project fields and marked
preedit win. Enter/Shift-Enter navigate, Escape or Close dismisses. Keys are
captured inside Find, so they cannot submit a composer. Closing uses Window
deferral and restores the retained mounted reader focus without selecting text
or requesting Latest. The ordinary composer and its selection are untouched.

The bar states **Loaded messages · literal source**. Matching is exact,
case-sensitive UTF-8 literal source, without normalization or regex. Each
non-overlapping occurrence has a canonical committed entry/model/block key,
captured source and byte range. Working notes/groups, raw tool bodies, images,
artifacts, transient streaming text, non-message metadata and viewer placeholder
rows are excluded. No hidden group is expanded and no archive is searched.
Conservative placeholder exclusion can also omit a message quoting one of the
viewer placeholder strings; there is no new model/provenance contract here.

Scanning runs off the UI thread, caps 512 eligible rows, 2 MiB of source,
1,000 matches and 1 KiB queries, and reports incomplete counts/no-match scope
truthfully. A cancellation token plus query/source generation and history scope
fence discarded results. Clearing or replacing the conversation cancels the
old work. A stable selected occurrence survives prepends. Data/stream updates
refresh counts without scrolling or enabling follow; only explicit query edits
and navigation move the reader. The mounted row keeps a short source context
for its occurrence. Visible matching text also has a sky-tinted background,
stronger for the current occurrence, separate from native text selection.

Find converts each source byte range through the current TextView parsed
snapshot (`RenderedText::range_for_source`) and uses the shared
`RangeHighlight` painter. It does not insert `<mark>`, rewrite Markdown or
alter Copy source. Markdown syntax and link destinations that render no
text remain source-only matches, identified by the context line. Tool bodies
remain excluded. Literal user/automatic messages use a source-mapped plain
TextView paragraph, not generated HTML, so the same painter supports them
without interpreting their Markdown-looking text. A folded user message only
paints matches in its visible prefix; Find does not expand it automatically.

Ranges refresh on query, next/previous, history, parser commit and theme
changes. The captured canonical key, exact row source and parsed source must
agree before conversion; close, empty query or a chat reset clears paint.
An unchanged parsed snapshot/range set does not notify the text view again.
Query observation includes native input-handler edits; marked composition
still blocks navigation and dismissal until committed.

## Verification scope

Use the smallest library state filter plus the real offscreen native production
root target, matching selected Clippy/build, through the shared CPU2/4GiB slot:

```sh
PILOT_NEXT_FIND_DIR="$PWD/evidence/local/find" python3 scripts/check-scoped.py \
  --unit transcript_find --test transcript_find --lint
```

The native target checks 680/1100 light/dark, actual query input, offscreen rows,
repeated/Unicode matches, previous/next/Enter/Shift-Enter, prepend and streaming
publication, retained reader selection, clear/no-match, close/focus, source
replacement, marked composition and an unchanged composer/no send. Captures
come from GPUI's real offscreen renderer, not a SwiftUI mock or web view.
Word-paint regressions compare actual message pixels while advancing between
repeated matches, in both Markdown and literal plain text. They also check
Markdown/code source-to-rendered ranges, emoji/combining text and exact source
Copy, independently of count and accessibility assertions.
This is not OS IME candidate-window, screen-reader, Linux/Wayland, visible motion,
performance, full-suite or production-app acceptance. No animation was added.


### Verified receipt (2026-10-26)

After rebasing this isolated feature onto remote main `6874ae0a`, the scoped
command above passed: 3 library cases, all 4 real native width/theme flows,
and strict selected library/native Clippy, with the linked production library
and native executable built by the normal wrapper. Targeted changed-source
rustfmt and `git diff --check` also passed. Final private report:
`/tmp/find-check-d947-13.json`. This is the minimum matcher/state + mounted
conversation composition gate; no broad unrelated suites were run.

The native matrix additionally exercises an actual chat-row switch/return and
its retained original draft, plus the visible 1,000-match cap and pointer Close.
Author pixel review of narrow light and wide dark confirms the compact bar,
readable scope/count, mounted source context, unchanged composer and existing
surface hierarchy. The source context replaces the existing row label, without
adding/removing transcript height. Live-only source publications reuse the
committed-source snapshot instead of rescanning it. No measured runtime speedup
is claimed; representative CPU/RSS, visible motion and OS IME remain unverified.
