# Desktop UI vocabulary

The app owns presentation, Kit owns controls. Start with `src/ui.rs`; examples
in `src/catalog_probe.rs` compile and paint in the actual synthetic GPUI catalog.
Do not copy styles from a screenshot or add a second theme/framework.
Paths in this guide are relative to `apps/desktop`.

Use the [Pilot Next design skill](../../../.agents/skills/pilot-next-design/SKILL.md)
for product hierarchy, progressive disclosure and design review. This guide remains
the source of truth for components and their contracts, not a second specification.

## Direction and sources

This is the existing calm native workbench, not a new visual direction. Reconcile:

| Role | Light / dark | Authority |
| --- | --- | --- |
| Page | `#ffffff` / `#23262c` | `appearance::palette` |
| Sidebar | `#f6f8fb` / `#1c1f24` | same |
| Card | `#ffffff` / `#363b44` | `appearance::card` |
| Tray | `#f1f4f8` / `#2a2e35` | `appearance::tray` |
| Text | `#1f2633` / `#d6dbe3` | active theme foreground |
| Metadata | `#5f6b7d` / `#a3acba` | active theme muted foreground |
| Accent | `#2f6fc6` / `#7db9e8` | `appearance::accent`, the app icon's sky |

Pilot's identity comes from its icon: the Bayer-dithered sky (the Home sky,
atmosphere only, never row state), neutrals tinted toward that sky (a slate night sky in dark) and its sky
colour as the one accent. The accent marks commit actions
(Kit primary buttons, including Send), links, the caret and text selection, and
Kit's checked/slider controls follow it. The one role mark it colours is a
mission coordinator's sidebar Compass and mission name (`appearance::accent_mark`,
the deeper light sky so caption text keeps AA on row washes). Navigation, row selection, hover and
chat-state tints stay neutral or keep their state colours; never use the accent
as decoration, status or a focus ring.

Type is embedded, not installed: Inter for the interface and conversation,
Inter Display (semibold) for the `Display`/`Title` page roles, JetBrains Mono
for code (`appearance::{UI_FONT, DISPLAY_FONT, CODE_FONT}`, licences in
`licenses/`). Shell typography is the existing26/22/15/13/12/11/10pt scale
(`Text` routes to `appearance::TextRole`, not a second scale).
Inputs/editors/Markdown keep their existing native metrics and selection rules.
Conversation content uses `typography::Content::{Chat,PlainChat,Code}` over the existing
TextView renderer. Optional user-chosen font sizes are physical point values, not app zoom;
unset values leave the existing renderer metrics untouched. Chrome/composer typography is
not a font-preference target. See [font preferences](font-preferences.md).
Space and Radius re-export the existing source. Glyphs use the approved static
`app_icon.rs` mapping, one-rem chrome or0.875rem inline; don't invent emoji,
SF-symbol strings or raw SVG paths in feature views. Test actual rem-derived
bounds: Kit's default test rem and the app's14pt rem need not match.
The one non-Lucide exception is `app_icon::BrandMark` (GitHub, Linear, Slack, from
Swift's `BrandMark`): only beside an exactly recognized service link in message text
(`markdown_service_links`), in the link colour, never as decoration or status.

Layout is a left-aligned reading column, not a grid of nested cards:

```text
Page title
context / scope

Section
label and description   existing control (or stacked in a narrow container)
validation, only when meaningful

Section
existing interactive owner [glyph  title / detail]
```

Keep one primary action in a real workflow. Prefer an unboxed section; a card
or hairline must encode grouping. Surfaces provide **color only**, not automatic
padding, corners, clipping or shadows. Compose those separate existing roles
deliberately. In particular use `Surface::Card.color(cx)` on an existing editor
root, not another padded wrapper. Preserve76pt tray/34pt editor and the opaque
white-on-gray/light, card-on-tray/dark distinction.

Popup content is opaque even with glass enabled. Use `ui::dialog` on Kit dialogs:
Kit's default uses the page token, which is translucent with glass. The shared
wrapper uses the opaque popover background/foreground without replacing native
focus, dismissal, geometry or shadows. Kit popovers, menus, selects and tooltips
already use that popover token. Translucent modal scrims are separate from their
opaque content; page/sidebar/list glass stays unchanged.

Message content and composer share `ui::CONVERSATION_MAX_WIDTH` (960pt outer
cap), centered and shrinking with the available pane width. The transcript's
existing scroller fills that pane, placing its scrollbar at the far right edge,
never across an open detail split. Kit's 0.75rem row inset sits on the capped
column, so message text aligns with the composer at every width. The find tray,
contextual Latest and loading/empty placeholders follow the same column; only
the scroller and tray background span the pane. Pages and artifact inspectors
retain their separate 760pt cap.
Contextual recovery, delivery/Unknown information and errors sit above the tray,
not inside or below its editor/actions. Never mount an empty recovery region.
The transcript opts into Kit's scrolling scrollbar mode, even when global chrome
requests permanent scrollbars: wheel input reveals it, a visible track supports
hover/drag, and idle fades it away without changing layout or scroll ownership.
Scrollbar tracks are transparent everywhere (`appearance` sets the Kit
`scrollbar` track token to clear); only the thumb paints, at rest, on hover and
while dragging (`tests/scrollbar_track.rs`).

Plan critique: a generic card grid or a second accent would compete with the
conversation and fail the approved brief. Keep the neutral hierarchy, the one
sky accent, physical hairlines, restrained icon family and shared meaningful
Bayer activity.
No marketing headings, all-caps labels, automatic entrance animations or broad
transitions of live transcript geometry.

## Chooser and contracts

| Need | Use | Don't use it for |
| --- | --- | --- |
| Reading column | `page`, `header`, `heading`, `text` | Scrolling/focus ownership, user Markdown |
| Background/grouping | `Surface`, `surface`, `rule` | Implicit wrapper/padding or new color literals |
| Standard action | `action` + `Action` | Automatic submit, authority or confirmation |
| Icon-only action | `icon_action` | Unnamed controls or status inference |
| Resource row content | `ResourceLabel` inside existing Button/List | Another nested interactive owner |
| Setting/field | `FieldRow` + existing Kit control | Value mirrors, persistence, a replacement input |
| Empty/error/status | `Notice` + truthful caller text/`Tone` | Inferring unread, success, severity or totals |
| Measured transfer | `transfer_progress` (Kit 6pt bar, indeterminate without a measured percent) | Estimated or time-based percentages, completion without verification |

Functions return the actual Kit Button/Div where practical. Keep normal builder
APIs instead of wrapping every control or forwarding a second event interface.
Variants Primary/Secondary/Quiet/Danger only select existing Kit variants; size
defaults to small. Caller `.disabled`, `.loading`, `.selected`, `.on_click` and
accessible-name overrides remain native. Loading disables the actual Kit button,
not just its paint. Avoid optimistic "Saved" text without a durable receipt.

The specialized `session_todos_view::{summary,rows}` is an app-owned passive
progress-strip composition, not a checkbox list. `session_todos_tray` supplies
the real Kit disclosure Button, exact source guards and bounded user intent;
`ChatEditor` retains the slot above its unchanged76/34 editor/control tray.
The compiled `session_todos` native gallery exercises zero, unknown, closed,
active, foreign-assigned, long/capped and retained states through that production
owner at680/1100 in both themes. See [session todos](session-todos.md) for source
contracts and precise MonoCode attribution. Do not reuse it for mission tasks,
infer statuses from tools, add mutation callbacks or auto-fold on stream updates.

`session_jobs_tray` uses the same tray-strip shape for running background jobs,
directly above the task strip: a quiet disclosure summary and per-job rows with
Copy log path and Stop. See [running jobs](running-jobs.md).

`ResourceLabel` is passive, full-width/left-aligned, with a fixed rem glyph slot,
truncated title/detail and physical Control gap. Give the real owner its full
accessible name. Its native test parts are resource-icon/title/detail, scoped
by the owner's stable ID. List selection still belongs to `ListState`; updating
only a delegate's color does not synchronize keyboard selection.

`FieldRow` defaults to Stacked; choose Inline only when the actual containing
layout has room. Labels/descriptions wrap, controls shrink within their column,
validation follows the row. Supply the real control's accessible name and
disabled/error state too; a red caption is not input validation or a disabled
guard. Values, entities, subscriptions, IME, callbacks and persistence belong to
the caller. Re-rendering a row must reuse the same input entity. It does not
capture Return/Escape, focus, selection, preedit or submit anything.

`Notice` has no action, timer, spinner or fetch. Compose an explicit action next
to it if needed. Tone uses existing semantic colors, never guessed state.
Components do not allocate per-row view entities, fetch data, launch work,
create clocks or mirror model values. Existing Kit controls keep their native
hover/focus/keyboard/built-in accessibility. No new rings or global font reset.

## Copyable examples

These patterns are compiled in `catalog_probe.rs::Catalogue::render`.

```rust
use crate::ui::{self, Action, FieldRow, FieldLayout, IconRole, ResourceLabel};
use gpui_kit::{ParentElement, Styled};
use gpui_kit::component::{Sizable, button::{Button, ButtonVariants}, input::Input};

ui::action("catalog-primary", "Run example", Action::Primary)
    .on_click(cx.listener(|this, _, _, cx| this.clicked(cx)));

// The caller supplies the existing input entity and its accessible name.
FieldRow::new("name", "Name", Input::new(&self.input).aria_label("Name"))
    .description("Used only in this example.")
    .layout(FieldLayout::Stacked);

Button::new("project-a").ghost().small().w_full()
    .accessibility_label("Example project")
    .child(ResourceLabel::new("Example project")
        .detail("4 loaded chats").icon(IconRole::Project));
```

Do use existing guarded callbacks. Don't fetch/save in a RenderOnce component,
read environment/disk during render, create a timer for a hover, or replace an
input entity on rerender. Don't change identity/reader/selection semantics to
make a styling probe pass. Don't hard-code wider inset allowances after adding
a glyph: assert actual slot width, gap, containment and original leading inset.

## Motion, exceptions and ownership

### Work line

`work_view` shows a turn's tool work as one effects-first line (D94): edited
files and their +/−, then outcomes in words (a failed command by name, unknown
status), then a faint count of reads, searches and fetches. While its run is live
it reads Working and the current call. There is no per-call ribbon. The chevron
opens the full list, which keeps every call on its own row. While the run is
live and the user has not chosen, the latest five steps show under the line
(D93: Swift's step count, consecutive successful reads as one), with Show N
earlier; an explicit open or close always wins. A folded finished group keeps
its first error line (a failed script's own error, not its printed output),
which opens just that call.

Working follows the run (`run_start`/`run_end`, snapshot, stale connection),
not gaps between tool events; a committed reply or a new user turn ends it.
Codemode names (`tool_script.rs`) come only from literal nested `tools.*` calls
or a leading `//` comment, never from execution, and the status is always the
outer script's. An opened call is one quiet panel on the code tint, its
sections split by hairlines and never folded: the command or script code, the
output with its outcome (Failed, Running, Status unknown) and failing lines on a
faint danger wash, then any patch preview. Arguments show only for tools with
neither source nor preview, since a script's or command's only repeat it. Long
sections scroll inside (`nested_scroll.rs`): the scroller under the pointer when
a wheel gesture starts keeps the whole gesture, so an output that can move takes
it, an output at its end or a short one leaves it to the transcript, and a
transcript gesture that slides an output under the pointer stays with the
transcript. Text is monospace. A script's codemode header (status,
wall time, `Output:`) is dropped from the shown text only when it matches
exactly; the wall time moves to the caption. Every section copies its exact
source, header included. A call that is running now shows three bouncing dots in its glyph
slot (`transition::Pulse`, frame-driven only while painted); they hold still
under reduced motion and give way to the kind or error glyph when the call ends,
fails or its run goes stale.

Kit owns existing word fade. These components add neither durations nor clocks.
Keep shared lifecycle checks separate from static catalog screenshots. Native
phase checks are not visible smoothness/FPS/CPU/RSS proof.

Dither is atmosphere only: the Home sky (`home_sky`). Rows, the composer,
buttons, progress bars and cards never carry it; the working line covers live work.
Chat state on sidebar and Inbox rows is a still mark (`state_mark`, which also
owns `Signal` and its tints for task status, attention, chat order and mission
overview): amber dot Needs you and questions, red triangle Failed, green pull
request Ready. Working and Background have no glyph (their neutral state word
carries them; a collapsed mission's roll-up says "N working"), so their trailing
slot stays empty but keeps the column. Marks
never loop. `state_mark::Fade` cross-fades a changed mark once (180 ms) on the
`transition::Transition` clock, requesting frames only while it runs; a first
sight never fades and reduced motion swaps at once. The `style` native target
checks still marks, the settled fade and reduced motion.

Glass: `appearance::enable_glass` requests glass before windows open;
`follow_appearance` admits it from the actual native capability, not desktop names.
macOS keeps its native behind-window material (unless Reduce Transparency is on).
Protocol-capable KWin/Hyprland receive explicit blur regions. The page, sidebar
and list retain their frosted, milky wash. Cards, the composer tray/editor,
popovers, buttons and code stay opaque. Never stack the page tint under the sidebar.
Elsewhere, and in offscreen probes, every surface stays solid.
See [native glass](native-glass.md) for request lifecycle, fallback and the separate
visible compositor qualification boundary.

`transition::Transition` is the one-shot entrance helper: it runs on the executor
clock (settled by probe clock advances), requests frames only while running and is
instant under reduced motion. It drives the page entrance
(200ms fade and 6pt rise when the destination changes, never on the first frame)
and Send's takeoff (the arrow lifts away and lands again after an admitted send).
Layout may animate too. `transition::Reveal` eases an extent from what is shown when
its key changes, so reversals continue smoothly. The chat side panel (`side_panel.rs`)
uses it: mission context, links and changes ease open and closed over 200ms. The panel keeps
its full extent inside a clipped slot, so its content slides with the edge rather
than reflowing; only the conversation narrows. Closing removes the panel at once
(focus returns, its work stops) and collapses only an empty edge. Switching panels
eases between extents, a reversal continues from the extent shown, and resize or
reduced motion apply immediately. The `side_panel` native target checks these phases.

Content exceptions: stored visual/chart palettes, source code/Markdown typography,
SVG geometry and genuine data-driven sizes retain their separate authorities.
Do not neutralize categorical charts or style user-authored content with chrome
tokens. Add a source note for a new legitimate exception. New shared roles belong
in the existing source, with their intended use and mounted regression checks.

Owner: app UI module. Keep changes small and source-indexed, retain existing IDs
and protected handlers, then adopt incrementally. Overview uses the real page,
header, section headings and action factory. The catalog is not production
adoption by itself; functional Settings is a separate implementation.

## Verification

### Sidebar presentation

`workbench_view::sidebar` keeps compose beside Home, matching Swift's
`SidebarHeader`. Add project is a named folder-plus action inside the disclosed
project selector, not a permanent full-width label. Open the selector, Tab to
Add project and press Return; Escape closes the existing guarded sheet and
returns focus to mounted sidebar search. Opening, cancelling or browsing choices
never creates a project or chooses a new-chat folder.

Navigation, scope choices and footer use the same 12pt outer inset, one-rem
glyph slot, half-rem gap and two-rem control height (28pt at the app's 14pt rem).
Chat rows have no phantom glyph column: their title and status align with the
leading resource column. Compose, filters and chat menus share a trailing action
column and 28pt targets. Long names truncate without shrinking body text; actual
owners retain full accessible names. Search, filters, archive, navigation history,
Usage, Settings and connection/recovery state keep their existing owners.

The sidebar list (`sidebar_list.rs`, rows built by `sidebar_tree.rs`) has
four sections: Drafts, Pinned, Chats and, with the Archived filter, Archived.
Chats holds mission threads and standalone chats in the user's own order
(below). Across all projects, once two or more projects (or project-less
folders, labelled `~/path` with a folder glyph) have chats, Chats splits into
flat project sections: a caption-style label like Pinned, its chevron right
after the name, then its rows; the Chats heading gives way to them. Sections
are ordered by the user's latest send to anything in them, rows inside keep
the same order, and agent activity never moves either. A thread sits with its
coordinator's project; a member from another project names it in a quiet
caption before its state word. Rows inside a section don't repeat the project;
Pinned, Archived and search results stay flat with their project caption, and a
chosen project shows no labels. A collapsed section is only its label, with its
chat count and most urgent mark in the trailing column. Enter, a click,
Left/Right or the label's … and right-click menus collapse and expand it; Left
from any row in a section returns to its label, Right from an expanded label
enters it. Opening a chat expands its section, and a collapse keeps the
selection on the label. Collapsed sections are remembered in `sidebar-v1.json`.
One text edge holds navigation glyphs, section and project labels, chat titles
and a mission's Compass; mission names, members and "+N finished" share a second
edge; every mark and collapsed count shares one trailing column (one-line rows
keep a narrower slot with a margin that centers their mark in the same column).

Project folders (for example Work and Personal) are the user's own grouping,
stored with the sidebar memory on this machine only (`sidebar_folders.rs`). The
project picker lists All projects, then Folders with their project counts,
then Projects, then Add project… and Edit folders…. Choosing a folder narrows
the sidebar to its projects' chats (pinned chats always show) without becoming
a navigation scope; choosing a project or All projects replaces it. Edit
folders… (also in a section's … menu, beside the folder choices) adds, renames
and removes folders and files projects in them; Save applies the edits
together and is enabled only when they differ and every name is unique;
Cancel or Escape keeps the saved folders.

A standalone chat row is its title, then at most one quiet caption line
right under it (a row with nothing to caption is one line): the project (across all projects) and the state reason, coloured
only for amber, red or green states. Its still mark sits in the trailing slot on
the title line. The accessible name keeps the full state, mission and "new
reply". A thread's parent is the coordinator chat titled with the mission name
(Compass and name in the accent, state word and mark on the right). Its fold
chevron sits in the row's 7pt leading gutter before the Compass (the Compass
stays on the text edge), shown while collapsed or on hover and keyboard
selection; its target spans the gutter and the Compass, and the rest of the row
opens the chat. While collapsed, the roll-up of member marks follows the mission
name on its line (the name truncates first, the roll-up stays whole); a second
line holds only the project, outside project sections. Members are one-line 28pt rows indented to the mission name. A
faint `border` stem runs down from the Compass's center, with a short branch
(4pt radius) to each member's title line that stops 4pt short of the title; it
ends with the last member's branch, and "+N finished" hangs off nothing. The
pieces only touch at the fork, so the translucent hairline stays even. Rows have fixed
heights per kind through the patched Kit list's `ListDelegate::item_height`
(48pt two-line, 32pt for a chat or parent without a caption, 28pt member,
24pt fold, 30pt project label). Left/Right
(`SidebarCollapse`/`SidebarExpand`, bound ahead of the search field's caret
moves and passed on when they do nothing) collapse, expand or move between a
member and its parent; Enter opens a row's chat, opens a coordinator-less
mission or shows/hides finished members. Needs you (here or rolled up) hides
the "new reply" dot and its spoken words. The small neutral "new reply" dot
follows the title. The row's … menu overhangs the trailing slot, replacing the
mark (and a one-line row's state word), and shows only on hover or on the
keyboard-selected row while the list has keyboard focus; the right-click menu
always reaches the same actions. Both
menus hold actions only, never a header repeating the row's title. A linked
chat's menu adds Open mission, the same navigation as its mission link. Only the
hovered row, the selected row and the row whose menu opened last build the
button (Tab reaches the selected row's); the rest keep an empty slot, because
GPUI caches by absolute bounds and every row re-renders while the list scrolls.
The open row keeps its faint neutral fill. Missions is the sidebar's only mission
entry (Command-3 opens the same browser); missions are never sidebar rows, only
their chats are. Flat rows (search, Pinned, Archived) keep the mission caption:
a linked chat's metadata line ends with its mission: Map (`AppIcon::Mission`)
for a member, Compass (`AppIcon::Coordinator`) for the summary's coordinator
role, as in Swift, then the mission name. As in Swift, names come from the
session socket's `missions` list (sent on connection and after every mission
change), which is authoritative once it arrives; before it, or from a daemon
that never sends it, the cached mission catalog names it. Only a coordinator's
Compass and real (current or last known) mission name take the accent; the
member Map, placeholders, Info, title and project stay neutral. Beside it the project
keeps a `Space::SECTION` start and its own separator, the name segment keeps
two of them, and the state shares the rest; the title and menu slot are
unchanged. The tooltip and row accessible name give the
full wording. Without a known name it says "Name unavailable"; malformed
association metadata gets Info and "Mission unavailable", never a guessed link,
UUID or row fetch. Offline names are labelled last known. Summary and
mission-cache updates refresh the segment without changing row identity.
A linked segment is a link to that mission: a click opens its overview (or
the mission list, which opens it once listed or says it isn't there), and on
the selected row Tab reaches it and Enter or Space opens it. Hover and keyboard
focus underline the name only (not its separator or glyph), while the whole
segment stays the target; the open chat, its draft and Back stay as they were.
Info and plain Coordinator marks stay text.
`examples/sidebar_scroll_native.rs` times sidebar wheel draws in a hidden
native window with production dispatchers, cold (first traversal) against warm.
`examples/sidebar_scroll_visible.rs` (release build; from an agent, launch it
inside a minimal .app with `open`) wheels a shown window from display frame
callbacks and logs frame intervals, main-thread CPU and process instructions and
cycles. The first one to three frames after any pause retire the same
instructions as later frames at a lower CPU clock, so a heavy frame can miss
its first deadline; less work per scroll frame is the lever, not warming caches.
The sidebar chat and project lists hide Kit's scrollbar in every scrollbar mode
(`List::scrollbar_visible(false)`); wheel, keyboard selection and retained offsets
still scroll them. Other panes keep their scrollbars.

Home, Inbox and Jump keep Swift's `listPrecedes` (`src/chat_order.rs`):
pinned, unsettled PRs, newest list activity, newest creation, then id. The
sidebar does not group by state and never reorders on agent activity. Its order
lives in `sidebar_memory.rs`, a private per-machine file next to the draft store
(`sidebar-v1.json`, never sent or imported from Swift): a chat is seeded once
from `lastUserMessageAt` (else creation), because the daemon also stamps
automatic notices there, and then moves only when the user sends to it from this
app. A thread sorts by its coordinator, or by the user's sends to its members.
Members sort by creation. The same file records the latest reply (`outcomeAt`
of a done, question or failed result, never `updatedAt`) seen in each chat for
the "new reply" dot; replies older than the file's first baseline never light
up. Selection follows the row's key (chat id, `mission:<id>`, `fold:<id>`,
`group:<section>`). The `style` native target also runs
`sidebar_sections_probe`: both edges and the mark column, chevrons, captions,
keyboard collapse, folder editing, the picker's folder scope and 132 rows at
680/1100 light/dark.

The `workbench` native target measures these columns/hit bounds and glyph paint,
including long Unicode, empty/loading/unavailable and retained-error states at
680/1100 light/dark. `project_add` dispatches actual pointer/Tab/Return/Escape
through the selector and checks mounted focus restoration, zero POSTs before
confirmation and retained conversation/draft identity. `navigation` covers
scope/filter/search/scroll/history and preedit. These synthetic offscreen checks
are not OS IME, screen-reader, motion/performance or user acceptance.

Use the shared serial slot and `scripts/cargo.sh`. Focused native target:
`bash scripts/cargo.sh test --locked --features native-probes --test catalog`.
It uses isolated synthetic content, not Local clients, actions or user state.
Then run the appropriate full `scripts/check.sh` once, including production
shell/workbench and existing editor/reader/lifecycle guards. Freeze exact source
and hashes before builds; images, logs and build outputs stay ignored. Capture
680/1100 light/dark bounds/paint and interaction evidence, not a docs-only mock.
No Linux or visible benchmark gate in this macOS-first slice.
