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

Pilot's identity comes from its icon: the Bayer-dithered sky (Home sky, row
state), neutrals tinted toward that sky (a slate night sky in dark) and its sky
colour as the one accent. The accent marks commit actions
(Kit primary buttons, including Send), links, the caret and text selection, and
Kit's checked/slider controls follow it. Navigation, row selection, hover and
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

The conversation and composer share `ui::CONVERSATION_MAX_WIDTH` (960pt outer
cap), shrinking with the available pane width. Keep their existing 12pt content
insets aligned; pages and artifact inspectors retain their separate 760pt cap.
Contextual recovery, delivery/Unknown information and errors sit above the tray,
not inside or below its editor/actions. Never mount an empty recovery region.
The transcript opts into Kit's scrolling scrollbar mode, even when global chrome
requests permanent scrollbars: wheel input reveals it, a visible track supports
hover/drag, and idle fades it away without changing layout or scroll ownership.

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

Kit owns existing word fade; `dither_view` owns its bounded per-window activity
clock/leases, reduced/hidden/offscreen/idle behavior. These components add neither
durations nor clocks. Keep shared lifecycle checks separate from static catalog
screenshots. Native phase checks are not visible smoothness/FPS/CPU/RSS proof.
Dither marks chat-row state (sidebar, Inbox) and the Home sky only. The composer,
buttons, progress bars and cards never carry it; the working line covers live work.

Glass: `appearance::enable_glass` (called by the app before its windows open) makes
the window background blur what is behind it on macOS, KWin and Hyprland, and turns
the page, sidebar and list into a frosted, milky wash (macOS uses the heavier
window-server blur, falling back to GPUI's material). Cards, the composer tray/editor,
popovers, buttons and code stay opaque. Never stack the page tint under the sidebar.
Elsewhere, and in offscreen probes, every surface stays solid.

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

A chat row is its title, then at most one quiet caption line right under it:
the project (across all projects) and the state reason, never repeating the
row's section heading (no "Working" under Working, "Archived" under Archived).
The accessible name keeps the full state. Every row has the same height. The
row's … menu overhangs a text-height slot, so it never pushes the caption away,
and shows only on hover or on the keyboard-selected row while the list has
keyboard focus; the right-click menu always reaches the same actions. The open
row keeps its faint neutral fill. Missions is the sidebar's only mission entry
(Command-3 opens the same browser); mission and member chats stay ordinary rows.
`examples/sidebar_scroll_native.rs` times sidebar wheel draws in a hidden
native window with production dispatchers, cold (first traversal) against warm.
The sidebar chat and project lists hide Kit's scrollbar in every scrollbar mode
(`List::scrollbar_visible(false)`); wheel, keyboard selection and retained offsets
still scroll them. Other panes keep their scrollbars.

Chat order and groups follow Swift (`src/chat_order.rs` documents the exact
rules). Every summary list uses Swift's `listPrecedes`: pinned, unsettled PRs,
newest list activity (`updatedAt` while working, else the later of the last
user message and the visible result), newest creation, then id. The sidebar
groups that order into Pinned, Needs you (failed, questions, other attention),
Ready to merge, Working and Recent, with Swift's caption headers and counts on
Needs you and Working. Next has no review marks, so unread results stay in
Recent; drafts lead under Drafts and the Archived filter adds Archived last.
Selection follows the chat id when rows move.

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
