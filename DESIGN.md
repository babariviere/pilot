# Design

Pilot's app should be calm and beautiful. It runs agents in the background so the user does not have to watch
them. The interface reports what matters, stays out of the way, and is a pleasure to look at.
[AGENTS.md](AGENTS.md) holds the working rules, `apps/macos/Sources/Pilot/Theme.swift` the shared tokens. This
file records the intent behind them.

## Calm

- **Status, not a control panel.** Pages answer "what needs me, and what is in progress". Show only that.
  Finished and quiet things recede, and empty sections are one quiet line or hide.
- **One primary action per screen.** Secondary actions live in menus and settings (progressive disclosure).
  Do not duplicate a control that already exists elsewhere.
- **Color and badges are signals.** Reserve them for states that need the user (failed, waiting, ready to merge).
  Everything else uses hairline rows and muted secondary text.
- **Quiet motion.** Subtle state changes only, and respect reduced motion. No attention-grabbing animation.
- **Stable layout.** Live updates change content in place. They must not reflow the page, steal focus, move the
  scroll position or blank content that is already shown. Loading shows a spinner only on first open, errors keep
  the last data under a muted banner.
- **Bounded and scannable.** Lists show a handful of rows and a count, titles stay on one line, long details are
  clamped. Full lists are one click away.
- **Plain language.** Short sentences that say what happened and what to do next, without jargon or alarm.

## Beautiful

Calm is not plain. The app should look sleek and feel pleasant to the eye, like a well-made native Mac app.

- **Restraint is the style.** Generous whitespace, a clear type hierarchy, one accent color and a small, soft
  palette. Let spacing and alignment do the work that borders, boxes and decoration usually do.
- **Polish in the details.** Consistent corner radii, optical alignment, crisp icons from one family, smooth
  hover and focus states. Small imperfections add up to a restless app.
- **Native first.** Use system materials, SF Symbols, system fonts and platform conventions. The app should look
  at home on macOS, in its light appearance, and at any window size. Dark mode is out of scope.
- **Typography carries the page.** Weight and size separate headline, section and row. Use secondary and
  tertiary text colors for meta information, and keep line lengths comfortable.
- **Delight without noise.** Motion and effects are subtle and purposeful (a soft transition, a gentle highlight).
  They explain a change, never decorate it.
- **Dithered gradients are Pilot's signature.** Prefer ordered (Bayer) dithering with hard square pixels over smooth
  gradients, glows and blurs: the Home sky and the empty Inbox's coast (`DitherScene`, bundled pictures softened
  and dithered, with the procedural `DitherSky` as fallback) and the sidebar's status corners (`DitherCorner`)
  set the tone. Use it for
  atmosphere and state, with a soft palette and quiet motion (a slow ripple, a breath, a dissolve from cell to
  cell), and keep text readable over it.
- **Check it by eye.** Beauty is reviewed, not assumed. Look at the real result with real
  and long content, before calling a UI change done.

## Attention budget

Only things that need the user may interrupt: notifications, sidebar and menu bar badges, and colored status.
Failed chats, unreviewed results, agent and mission questions and failed scheduled items qualify. An agent's question
stays until it is answered, not until the chat is viewed. Working, finished and
merged things do not, they wait on the page. When lists mix states, sort by urgency: failed, question, scheduled
failure, unread, then the rest.

## State vocabulary

Each state has one label and one icon and color token in `Theme`, used the same way in the sidebar, Home and
the project page. Do not restyle a state for a single screen.

| State | Meaning | Interrupts |
| --- | --- | --- |
| Working | An agent is running | No |
| Needs you | Failed, unreviewed result, agent or mission question, scheduled item that could not start. A read result keeps its place while its chat is open and leaves once the user leaves the chat; failures and questions stay until retried or answered | Yes |
| Ready to merge | Open PR with no blockers (Pilot never merges) | Optional notification |
| Blocked or pending | PR waiting on checks, reviews or conflicts | No |
| Done | Finished and reviewed | No |

In the sidebar, a chat's state is its dithered corner (`DitherCorner`), not an icon column: an ordered dither
growing from the row's bottom-right corner in the state's tint. Working is a soft indigo ripple, needs you an amber
breath, failed a steady dense red, ready to merge a steady light green. Done and other quiet chats draw nothing.
Density and motion differ per state, so color is never the only signal, and VoiceOver reads the state. Changes
dissolve cell by cell. Under the pointer the corner recedes toward the trailing edge (fewer cells, same pixels) and
the row's revealed buttons use the space it frees: rows with a corner draw no hover fill and nothing cuts holes in
the corner. Reduce Motion keeps it still and recedes it without animating.
An agent that is idle while its background jobs run is still Working, drawn with a fainter, half-speed ripple so it
reads as work in the background. Live work inside a view, such as a chat's working line, uses the same ripple as a
small strip (`DitherRipple`) instead of a spinner or shimmer.

## Sidebar

The sidebar answers "what needs me" before "where is it". One header row holds the scope switcher, Home (badged with
what needs the user) and compose; archived chats, search (⌘F) and grouping live in the switcher's menu. All
projects groups chats by urgency (Pinned, Needs you, Ready to merge, Working, Recent) with each row naming its project; a focused project
lists its own missions and chats. Rows are a title and one metadata line. Time, pin and mission marks, and project
header actions, appear under the pointer. Quiet chats fold past the first few, and the footer appears only while
pilotd is unreachable.

A row's metadata line is a `RowLine`: whole segments in a fixed order (project, Ask or Coordinator, reason, PRs,
mission, branch) with a dot only between shown segments. When they do not fit, the line fades out before the
corner instead of truncating each segment or widening the row; the tooltip and VoiceOver keep every segment.
Home, Inbox and Overview rows use the same line and may wrap it once.
An unsent composer draft replaces the segments after the project with a pencil and the draft's first line, in
muted text. It is the user's own work, so it never colours, badges or regroups the row.

## Consistency

- Reuse shared components and `Theme` tokens (color, type, spacing, radius, motion). Add missing tokens or
  components centrally instead of styling a screen on its own.
- Icons come from `PilotIcon` (`PilotIcon.swift`): one SF Symbol per concept, sized by its context (row,
  toolbar, inline, empty state, structural disclosure) and outlined unless its documented state fills it.
  Use symbols, not emoji or Unicode stand-ins. Add a missing concept there instead of
  picking a symbol per screen; service and Git marks use `PilotMark`.
- Chrome text uses `.pilot` type roles and shapes use `Theme.Radius`; `apps/macos/scripts/check-font-roles.py`
  (run by the Swift test step) rejects new fixed font sizes and SwiftUI text styles.
- A row's selection is its only fill. Actions inside rows use `rowIconButtonStyle` (no background) and whole-row
  buttons `rowButtonStyle`, which both draw the keyboard focus ring; `QuietIconButtonStyle` is for standalone
  toolbar and composer buttons.
- Follow existing layouts, terminology and visual hierarchy. Pages such as missions and projects share one
  reading column, section headers and hairline rows (`PageComponents.swift`).
- Pages, sheets and panes share their chrome (`PageComponents.swift`): `PageHeader` for page titles,
  `InspectorPaneHeader` for inspector panes (no per-pane close button), `EmptyStateView` for empty or failed
  panes, `DisclosureChevron`, `ListToggle` ("Show all N" / "Show fewer") and `MetaText` for quiet metadata
  instead of capsule tags.
- Errors use `InlineProblem` (a `Theme.error` triangle, muted text and "Retry") beside what failed. Amber stays
  for things the user can act on, so errors never use `warning`, `blocked` or orange.

## Sheets

Every sheet uses `SheetScaffold`: a sentence-case title ("Edit schedule", "Rename chat") with an optional subtitle
and accessory, the content, an inline error slot, and a footer pinned to the bottom with Cancel and the primary action
on the right (a sheet with nothing to confirm has a single Done). Esc cancels. Return confirms a form of single-line
fields; a form with a multi-line editor confirms with Command-Return, because Return inserts a newline there, and its
button shows ⌘↩.
- Check every change with long content and with loading, empty, error and disabled states. Keep keyboard access
  and readable contrast.

## Project page

The project page follows these principles: a single reading column with a one-sentence summary, then sections in
order of urgency (Needs you, Working now, Pull requests, Missions, Scheduled, Tracked, Recent), at most five rows
each. Sections added later follow the same rules.

## UI review checklist

- Looks calm and polished, checked by eye (attach a SwiftUI artifact for new layouts).
- Long content, and loading, empty, error and disabled states.
- Narrow and wide windows.
- Keyboard access, readable contrast, reduced motion, and VoiceOver labels (color is never the only signal).
- No layout shift from live updates, and nothing slows scrolling or typing.
