# Contextual navigation and history

The conversation leads. Secondary navigation, archive filtering and history
commands remain reachable without a permanent row of text buttons.

## Subtract, retain, reveal

- Back/Forward use the shared named icon actions beside the app title. The group
  appears only when history exists; each direction retains its disabled state,
  tooltip and Command-[ / Command-] route. On macOS, Command-Left / Command-Right
  are also Back/Forward outside text fields (see [native menus](native-menus.md)).
- Chat filters opens a native checked Include archived menu item. Archived
  included remains visible beside the list when active. Filtering keeps the
  canonical list selection where still visible and never navigates or retargets
  a conversation. Scope/search restoration remains owned by the existing cache.
- The header's More (…) menu replaces the permanent Earlier/Latest and Make a
  mission… buttons. It exposes Load earlier messages (including explicit retry),
  Return to latest and Make a mission… (also in the chat row menu), then Copy
  session path and Copy session link (see [chat actions](chat-actions.md)).
  Native arrow/Enter selection and Escape dismissal remain available.
- A single contextual Latest action appears inside the transcript when reading
  away, refreshing a bounded window, or recovering an unavailable reader mark.
  Refresh latest and Retry latest retain the existing reader's fresh-generation
  Open, rather than merely scrolling to the bottom of old rows. Ordinary Latest
  follows the loaded tail without a read request. Loading/errors stay visible,
  and failed refresh keeps the last usable window.

## Owners and safeguards

`workbench_view.rs` owns navigation placement. `contextual_navigation.rs` builds
the native menus and applies the archive filter through the existing list/scope
owners. Menu callbacks retain weak owners and validate their project scope or
chat/generation before acting. Pointer guards run before button focus can retire
IME composition; callbacks guard again.

The pinned Component specification corrects dismissal focus with one exact edit:
prefer the retained trigger over the containing popover's disappearing content
handle. Ordinary non-dropdown fallback and the existing moved-focus/dialog guard
remain intact. The regression unit explicitly blurs before opening, matching the
readonly native fixture rather than masking the bug with a focused textarea.

`TranscriptView` owns the scroller and contextual action. Its small retained
history presentation updates on explicit reader publications/actions/resume,
not by mutating state from render or rerendering the parent on every wheel.
The generation-tagged Latest event returns to `LocalViewer::latest`, keeping
the existing bounded-window and follow semantics. Standalone readonly transcript
fixtures without this owner do not display an unhandled action.

Top-of-transcript paging, cursor/revision admission, one in-flight page, failed
attempt suppression, exhaustion and generation fences are unchanged. No new
timer, backend contract, durable format, command authority or automatic write
is introduced. Drafts, model choices, pending delivery and canonical identity
remain with their existing owners. The 76/34 composer geometry is unchanged.

## Scoped qualification

Change to check rationale:

| Changed behavior | Focused coverage |
| --- | --- |
| Archive filter / stale scope / IME / canonical list selection | `local_view::contextual_navigation::tests::` |
| Latest event / bounded reload / reader admission and retry | above plus `local_view::refresh_tests` |
| Central Filter/More glyph roles | `app_icon::tests::` real embedded SVG loading |
| Real menus, navigation, draft/copy/reader restoration and limited/error latest | named native `navigation` |
| Scroll/prepend, selection, no retry storms, manual history recovery and contextual containment | named native `history` |
| Two old checkbox entry points and unchanged project/reader/composer workflow | named native `shell` |

Use `scripts/check-scoped.py` with these explicit filters/targets and matching
lint, under its normal shared admission. No full desktop/all-native sweep is
needed for this slice. PRE/POST receipts freeze source and protected inputs;
captures are synthetic, offscreen production GPUI at 680/1100 in asserted light
and dark. Menu captures include their mounted bounds and built-in item names.

For a focused history reproduction, `PILOT_NEXT_HISTORY_CASE=680-dark-long`
selects one exact width/theme/length case. Unknown selectors fail; the probe
asserts exactly one selected case or all eight by default. Final qualification
uses the default complete affected target, not a selected diagnostic case.

### Results

Frozen source `930712698e2b581ace86d4eb099df9a491e9a7fd`, tree
`a8254b168d893bb1bc2b9e253b65ae37c38e0a5f`, passed:

- Matching library and named navigation/history/shell Clippy with warnings denied.
- Four contextual policy units, including blurred Escape/Tab/Enter and focus
  moved to another input during menu dismissal.
- Twenty native cases: eight history, four navigation, four fresh canonical
  reader/latest-retry and four shell, across 680/1100 in light/dark.
- All five existing refresh/admission tests and the embedded-SVG role test on
  the identical frozen source/inputs. PRE/POST checks matched for both runs.

The native command used `--unit local_view::contextual_navigation::tests::
--test navigation --test history --test shell --lint --timeout 480`. Separate
small filters covered `local_view::refresh_tests` and `app_icon::tests::` with
`--native-probes`. No all-native/all-target/full desktop sweep was run.

The original 24-edit Component specification failed the blurred keyboard unit.
The one-edit trigger-restoration correction passed that regression, the isolated
native dark-history reproduction and then the complete affected native targets.
An earlier content-focus experiment failed and was fully reverted. Failed and
partial receipts are retained, not relabeled as passes. The before-state run
completed all eight history and three navigation cases before its combined
deadline; its captures are partial baseline evidence, not a green baseline gate.

Actual captures were reviewed against the calmer hierarchy: compact title-bar
navigation, readable checked archive filtering with an active caption, contained
history menus and one contextual Latest/Retry action. Errors and the last usable
window remain visible, while the white/card editor and gray tray stay unchanged.
The publication-only change after this tested tree records these results here;
application, patch, native fixture and protected build inputs remain identical.

Static captures do not establish visible motion, performance, OS IME/accessibility,
Linux support or product acceptance. No live action or production service change
was performed.
