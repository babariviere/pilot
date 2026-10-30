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
  at home on macOS and at any window size, in light and dark. Pilot follows the macOS appearance unless
  Settings → Appearance pins one.
- **One theme, two appearances.** Every colour comes from `Theme` tokens, which resolve per appearance
  (`Color(light:dark:)`); never use literal, system or `.secondary`-style colours in views, and add a missing token
  centrally. Dark keeps the light hierarchy: a darker sidebar beside the page, lifted cards and trays, light primary
  buttons with `onPrimary` text, text-weight colours lightened for contrast. Dithered scenes dim to dusk; status
  corners keep one translucent tint set. Home instead uses separate daytime clouds and evening sea pictures, preserving
  their own colours. Artifacts are light documents and keep a light page in both. Native visuals are the exception:
  they sit on the chat itself, without a card, and follow the appearance through Theme tokens (`accent`, the
  `successInk`/`warningInk` text colours and the `chart1`...`chart6` palette).
- **Typography carries the page.** Weight and size separate headline, section and row. Use secondary and
  tertiary text colors for meta information, and keep line lengths comfortable.
- **Delight without noise.** Motion and effects are subtle and purposeful (a soft transition, a gentle highlight).
  They explain a change, never decorate it.
- **Dithered gradients are Pilot's signature.** Prefer ordered (Bayer) dithering with hard square pixels over smooth
  gradients, glows and blurs: the Home sky and the empty Inbox's coast (`DitherScene`, bundled pictures softened
  and dithered, with the procedural `DitherSky` as fallback) set the tone. Dither is atmosphere, with a soft
  palette and quiet motion, and keeps text readable over it. In Pilot Next it is atmosphere only: rows show state
  with still marks and words (see State vocabulary), never dither. The Swift app keeps its status corners
  (`DitherCorner`) unchanged until it retires.
- **Check it by eye.** Beauty is reviewed, not assumed. Look at the real result with real
  and long content, before calling a UI change done.

## Attention budget

Only things that need the user may interrupt: notifications, the Inbox and menu bar badges, and colored status.
Failed chats, unreviewed results, agent and mission questions, failed scheduled items, a stopping subscription
limit, a pull request Pilot could not get unstuck, an MCP server that needs sign-in and a background job running for
over an hour qualify. Working, finished and merged things do not, they wait on the page. When lists mix states, sort
by urgency: failed, question, scheduled failure, unread, then the rest.

- **Every Needs you item says why.** One short reason (`NeedsYouReason`: "Failed: …", "Asks: …", "Long job: …",
  "Limit reached · resumes 18:00", "Not reviewed: finished 5m ago") appears in the row's metadata line, its tooltip
  and VoiceOver label, and the Inbox badge's tooltip sums the reasons. Use these words everywhere; do not invent a
  screen-specific phrasing.
- **Needs you clears itself.** There is no "mark as reviewed" or "remove" action. A read result leaves once the user
  leaves its chat (never while it is open, so nothing jumps), failures stay until retried and questions until
  answered. Scheduling a follow-up message counts as an answer: the chat leaves at once and returns only if the
  schedule is cancelled or fails. Live reasons (a long job, an MCP sign-in) clear when their cause does.
- **Ready to merge waits, it never badges.** It is the user's next step, not an alarm.
- **Changes without a PR need you.** Idle Build chats with known workspace changes and no PR say "No PR created"
  until a PR is created or attached, or the changes are removed. Reading the chat or pushing does not clear it.
- **Waiting is working.** An idle agent whose background jobs still run is Working: no done outcome, notification or
  Needs you entry, and it never wakes a mission coordinator. Only a job past one hour asks for the user.

## Views

Each top-level view has one role. Keep new content in the view whose role it serves.

- **Home watches.** It always covers every project and answers "how is everything doing": a short count line,
  quiet subscription bars, projects under their folder headings, Working now, Missions and Activity. It has no badge;
  its only actions are starting a chat and adding a project.
- **The Inbox acts.** It is the one place to act across projects: Needs you, Ready to merge, Linear and Slack, most
  urgent first, and it carries the attention badge. A toolbar menu filters it to one project, preset to the focused
  project when opened from it and never remembered.
- **Overview orients.** A project's or mission's Overview leads with what is next for it, then what is in progress
  (see Overview pages).
- **Lists stay light.** Sidebar rows, the Inbox, Overviews and Home show the PR badge, branch and reason, never file
  or line diff counts. Changes live in the chat's Changes pane and the row tooltip.
- Name sources (Linear, Slack, GitHub), never an umbrella word for "items Pilot follows".
- A chat started from or linked to a Slack message or Linear ticket in triage shows that service's mark after its
  sidebar title, and a header chip with the channel or ticket. The chip opens the Slack message in triage, or the
  ticket in Linear.

## State vocabulary

Each state has one label and one icon and color token in `Theme`, used the same way in the sidebar, Home and
the project page. Do not restyle a state for a single screen. Linear tickets and mission tasks share one status
ladder: empty circle to do, one-third filled in progress, two-thirds filled in review, then done.
The progress pies fill clockwise from 12 o'clock.

| State | Meaning | Interrupts |
| --- | --- | --- |
| Working | An agent is running, or it is idle while its background jobs or subagents run | No |
| Needs you | Failed, unreviewed result, agent or mission question, scheduled item that could not start, limit reached, stuck pull request, code changes without a PR, MCP server needing sign-in, job running over an hour. Clears itself (see Attention budget) | Yes |
| Ready to merge | Open PR with no blockers (only the user can confirm a merge) | Optional notification |
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
reads as work in the background. While a chat works, its composer wears the same working corner in its bottom-right,
behind the editor and controls, and draws nothing when idle. Live work inside a view (a running tool step, the chat's
working line) uses the ellipsis spinner (`EllipsisSpinner`): three grey dots that turn indigo and lift in turn, left
to right, like a typing indicator, fainter and half speed while only background jobs run, and still under Reduce Motion.
Chat motion plays on Core Animation (`LoopingLayerView`), never as per-frame SwiftUI updates, and changes only
opacity, colour or a transform inside a fixed frame, so it never moves the layout.

Pilot Next draws no row dither. A sidebar or Inbox row shows its state in words beside it or on its caption, plus
one still mark in its trailing column: a neutral circle for Working (fainter when only background jobs run), an
amber dot for Needs you and questions, a red triangle for Failed and a green pull-request glyph for Ready to merge.
The circle is also the "replied since you looked" mark: hollow once you have seen the latest reply, filled when the
agent replied since you last opened that chat, and a quiet chat with a new reply shows it filled; there is no
separate reply dot. A collapsed mission rolls up its members as each mark with a count (a hollow ring for Working).
Quiet, read chats draw
nothing. Colour is only amber, red and green; Working stays neutral, and the words and the accessible name always
carry the state. Marks never loop: a change cross-fades once (180 ms), instantly under Reduce Motion, and never moves
the row. When you last looked is kept only on this machine (no read-status writes, nothing imported from Swift);
opening the chat empties the circle, and a collapsed mission or project fills its circle for its members' new
replies. Needs you, Failed and Ready rows show no new-reply state (their coloured mark already asks for a look), nor
does a collapsed mission with a member that needs you.

In Pilot Next, an unforced current per-chat subscription hold reads **Paused**, with a neutral pause mark.
**Usage limit reached** is disclosed in its tooltip/details and accessible name. It is unfinished, never folded
into finished members or automatically archived. A pending question still reads Needs you. Manual archive,
Stop, Force work and the daemon's existing reset/fresh-reading resume policy remain unchanged; aggregate
usage alone never establishes this state.

## Sidebar

The sidebar answers "what needs me" before "where is it". From the top: Home (with compose), the Inbox (with the
attention badge), then the project selector ("All projects" or one project) heading the scoped list, and a focused
project's Overview as its first row. Archived chats, search (⌘F) and project folders (New Folder…, Move to folder)
live in the selector's menu; folders are headings there and on Home, never a sidebar scope.

Control is retired. There is no fixed Control row, Go menu destination, palette page or live composer.
Existing conversations are archived on their source host and open as bounded read-only history, never as
a new agent. No Project coordinator replaces Control. Home and the Inbox retain their existing roles.

Both scopes use the same order: Missions, then chats grouped only by urgency (Pinned, Needs you, Ready to
merge, Working, Recent). All projects names each row's project; a focused project leaves it out. Missions never sit in
the chat groups and their rows do not expand: clicking opens the mission, hover reveals its coordinator and new chat.
Mission chats sit in the chat groups like any chat, their mission on the second line; a coordinator's line starts
with "Coordinator". A pinned chat is listed only under Pinned, and its corner still shows its state. Rows are a title
and one metadata line. Time, pin and mission marks appear under the pointer. Quiet chats fold past the first few,
and the footer appears only while pilotd is unreachable or something needs setting up.
While searching (⌘F), matching archived chats follow in their own Archived group, newest archive first.

A row's metadata line is a `RowLine`: whole segments in a fixed order (project, Ask or Coordinator, reason, PRs,
mission, branch) with a dot only between shown segments. When they do not fit, the line fades out before the
corner instead of truncating each segment or widening the row; the tooltip and VoiceOver keep every segment.
Home, Inbox and Overview rows use the same line and may wrap it once.
An unsent composer draft replaces the segments after the project with a pencil and the draft's first line, in
muted text. It is the user's own work, so it never colours, badges or regroups the row.

The ⌘K command palette is one search field over one list grouped by kind, with the top match selected and arrow
keys, Return and Escape throughout. Rows are hairline-divided, show their menu shortcut as a key cap, and chat rows
keep their sidebar line and corner. The palette's only colour is the amber of Needs you: working and ready-to-merge
corners turn grey there (`ditherCorner(_:monochrome:)`).
Archived chats are never suggested; a search finds them after active ones, marked "Archived".
The palette is for jumping to places first: with an empty field, pages and resources lead and only a few recent
chats follow. When a search matches a resource and a chat equally well, the resource leads; an exact chat title
stays first. The highlighted list row's actions sit in their own labeled group, after the places.

Keyboard navigation (`KeyboardNavigation.swift`) has one owner at a time. The window has four regions: sidebar,
page, composer and inspector, skipping those not on screen; ⌘L and ⌘K's Focus entries move between them. A region
marks itself with
`keyboardRegion(_:onFocus:)`, and a page's main list takes the page's focus with `keyboardFocusHandler`.
There are no plain-letter shortcuts, key sequences or pending-key modes: letters, digits and IME input always reach
the focused view, and destinations live in the Go menu and ⌘K. `KeyboardInputGuard` reads the AppKit first
responder to tell text, terminal and web content from browsing. Only ⌘L, plus ⌘K and ⌘J from a terminal or
artifact, are read before the focused view; they are also the way out of embedded content. Every other
shortcut is a menu key equivalent, so a focused view keeps its own first. Highlight, focus and editing stay
distinct: moving through a list never opens, edits or submits, and row actions such as editing a title or message
are buttons, context menus and ⌘K entries, not letters.
Long pages use `keyboardList()` on their column and `keyboardListItem(_:target:activate:)` on rows (`KeyboardList.swift`):
one focus stop, Return for the row's click action, and the highlight kept by row id through refreshes (the nearest
row takes over when it leaves). Arrowing through sidebar chats keeps focus in the sidebar; the composer of the chat
it opens waits for ⌘L or a click.
Keyboard targets are shown only while the keyboard navigates (`KeyboardCue.swift`): the highlighted list row or
transcript message gets `Theme.keyboardHighlight`, a very faint neutral fill with no outline, and list rows reveal
their hover actions. Navigation keys outside text, and Tab or Escape out of a field turn it on; typing never
does. Any click hides it, including when focus arrives later, while the target, selection and ⌘K actions stay.
Chat rows are the exception: their highlight is a selection and keeps the grey `Theme.selected` fill after clicks.

The menu bar follows the same urgency order (Needs you, Ready to merge, Working, Recent) under a one-line heading such
as "1 needs you · 2 working". pilotd's controls sit in their own submenu.

### Pilot Next sidebar

Pilot Next keeps the sidebar's job, finding your chat, but not Swift's urgency grouping, because rows that jump
sections whenever an agent changes state are hard to find again. The Swift sidebar above is unchanged.

- **Sections:** Drafts, Pinned, Chats and, with the Archived filter, Archived (newest archive first). There are no
  Needs you, Ready to merge or Working groups and no Needs you strip: the Inbox and its badge own attention.
- **Your order, not the agents'.** Chats are ordered by your own activity. A chat's place comes from its last user
  message (else its creation) when the app first sees it; afterwards it moves only when you send to it from this
  app. Agent work, results, automatic notices and state changes never move a row. This order is kept on this
  machine only.
- **Mission threads, one level.** A mission's coordinator chat is the parent row, titled with the mission name
  (Compass and name in the accent) with its state on the right. Its members follow as one-line rows (title, then
  state word and mark) in creation order, joined to the Compass by a faint stem with a short rounded branch to each
  member; the stem ends at the last member. Quiet members you have already seen fold into "+N finished";
  revealing them keeps them below unfinished members, in creation order within each group. The
  chevron in the row's leading gutter, before the Compass, or Left collapses a thread, and its second line then
  rolls up its members' marks and new replies; Right
  expands it, and opening a member expands its thread. A thread whose coordinator chat is not listed keeps a
  parent that opens the mission.
- **Missions are not sidebar rows.** The sidebar lists chats; missions live in the Missions view, reached by its
  one sidebar entry. Search results, Pinned, Archived, the Inbox and ⌘K list chats flat with their mission caption.

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
  buttons `rowButtonStyle`, neither of which draws a focus outline; `QuietIconButtonStyle` is for standalone
  toolbar and composer buttons.
  Sidebar chat selection stays neutral grey whether or not the list has focus, keeping the normal text and
  status colours. Focus never adds a blue ring: rows keep their neutral selection, text controls keep their caret,
  and native focus effects are disabled at every scene root with `quietFocus()`. Keyboard navigation stays enabled.
- Follow existing layouts, terminology and visual hierarchy. Pages such as missions and projects share one
  reading column, section headers and hairline rows (`PageComponents.swift`).
- Settings pages use the same reading column: `SettingsSection` (heading, explanation above the rows) and
  `SettingsRow` hairline rows with native controls trailing (`Settings.swift`), never grouped forms. Selection is
  soft grey, never system blue. Pages that need an explicit Save show it (with Revert) only once something changed,
  and destructive actions such as Remove Project sit at the end as a red outline button with one explaining line.
- Pages, sheets and panes share their chrome (`PageComponents.swift`): `PageHeader` for page titles,
  `InspectorPaneHeader` for inspector panes (no per-pane close button), `EmptyStateView` for empty or failed
  panes, `DisclosureChevron`, `ListToggle` ("Show all N" / "Show fewer") and `MetaText` for quiet metadata
  instead of capsule tags.
- Nested rows go one level deep, as Linear sub-issues do (`LinearSubIssues.swift`): children indent one icon column
  under their parent, joined by a hairline through its icon column, and the parent carries a quiet "N sub-issues"
  that collapses them. A parent the list does not hold leads as a read-only header: identifier, title and link only.
- Errors use `InlineProblem` (a `Theme.error` triangle, muted text and "Retry") beside what failed. Amber stays
  for things the user can act on, so errors never use `warning`, `blocked` or orange.
- Times use `RelativeDate`: "3d ago" in rows, "3 minutes ago" in sentences, "Today 9:00 AM" for upcoming times,
  with the exact date in the tooltip.
- The UI says "chat", never "session", and "Needs you" for anything waiting on the user.

## Chats

A chat reads as a conversation, not a log.

- **History paints before it grows.** Open with the latest 40 historical rows and the live tail, using measured
  rather than estimated heights. Show earlier messages reveals prepared pages before fetching older stored
  entries. Each explicit request adds a page without hiding messages already displayed or changing agent context.
  New replies extend the displayed window rather than evicting its oldest message.

- **A turn folds.** Thinking, notes and tool calls between the user's message and the answer fold into one line
  ("Worked for 3 min · read 3 files, edited 1, ran 2 commands"). It stays open while the turn runs with the latest
  step visible, folds when the turn ends and stays open on a failed step. Steps read as sentences; finished steps
  show no checkmark. A running step's title shimmers (a light band sweeps across it) until the tool finishes, and an
  opened step appears at its full height at once, uncovered from the top, so the transcript never animates height.
- **Automatic items are one-line events** (`ChatEventRow`): GitHub actions ("Agent pushed fix/x", "Agent opened PR
  #441") where they happened, mission updates, compaction and reset, Stopped, job results, subagent answers,
  coordinator messages, PR follow-ups and answered questions. They are written for the user, expand to the full text
  on Show, and only real failures get a red mark. No cards, separators or ISO times.
- **User bubbles** use `Theme.muted` with no border, hold their attachments, and show time, copy and rewind on hover.
  They render Markdown like agent replies and hug short text; code blocks and tables widen the bubble. Folded long
  messages preview the raw text.
  Scheduled messages wait at the end as dashed outline bubbles saying when they send; queued follow-ups stay in the
  composer tray.
- **The composer tray** holds the chat's tasks and subagents above the editor. Each has a summary line ("Tasks 1 of
  3", "4 subagents · 1 working · 3 done") that opens one row per item, up to four before scrolling: tasks open while
  some remain, subagents when one starts working. Rows lead with their state (working dots, green check, red failure)
  and running items sort first; a subagent row opens its transcript. A finished subagent is just done: its answer goes
  to the parent chat, so it never asks for the user's attention.
- **The working line** ("Working… · 2 jobs", "Waiting on 2 jobs…") carries live work and opens the jobs panel when
  jobs run. It sits directly above the composer, not at the transcript's end, so it stays still while replies stream
  and the transcript scrolls behind it; a pause notice takes its place. Nothing else stacks above the composer except
  a subscription notice, shown only past 80% or when limited. The context gauge lives in the composer bar.

## Sheets

Every sheet uses `SheetScaffold`: a sentence-case title ("Edit schedule", "Rename chat") with an optional subtitle
and accessory, the content, an inline error slot, and a footer pinned to the bottom with Cancel and the primary action
on the right (a sheet with nothing to confirm has a single Done). Esc cancels. Return confirms a form of single-line
fields; a form with a multi-line editor confirms with Command-Return, because Return inserts a newline there, and its
button shows ⌘↩.
- Check every change with long content and with loading, empty, error and disabled states. Keep keyboard access
  and readable contrast.

## Overview pages

A project's Overview is a single reading column with a one-sentence summary, then sections in order of urgency (Up
next, Working now, Pull requests, Missions, Scheduled, Current cycle, Slack, Memory, Recent), at most five rows each.
Up next leads with the project's top Inbox rows (Needs you, then Ready to merge) and links to the Inbox filtered to
the project; Pull requests then lists only those still waiting on checks, review or a fix, so each chat appears once.
A mission's Overview has the same shape: its goal, one meta line, the task progress bar with its
legend, then Needs you (hidden when empty), Working now, Linear tickets (hidden when the mission manages none) and
Links. Its title row carries a Compass icon action that opens the mission's own coordinator chat, the chat people
open most from a mission; it is disabled when that chat can't be opened here and absent when no coordinator is
assigned. Both share the Inbox's rows and words (Needs you rows, Ready to merge). Sections added later follow the same
rules. A managed ticket nests its contributing tasks one level deep, like sub-issues, and says only in words which
links count toward it ("Counts toward ENG-123") and which are references ("Referenced by #7 · not counted"); Links
holds every other link, so a ticket appears once. Its Linear update line is muted while up to date, amber with
Resume when paused for review and an `InlineProblem` with Retry when an update failed. A canceled ticket's tasks read
Dropped, never done.

Progress bars (`SegmentedProgressBar`) are one plain 6 pt capsule with no gaps, dither or animation. Task bars use the
row colours: green done, amber in review, indigo in progress, red blocked, and the faint track for to do. Where there is
room (a mission's Overview, Tasks and inspector) a legend of counts with matching dots follows (`ProgressLegend`,
zero counts omitted); compact rows keep the bar plus "9 of 18".

## UI review checklist

- Looks calm and polished, checked by eye (attach a SwiftUI artifact for new layouts).
- Long content, and loading, empty, error and disabled states.
- Narrow and wide windows.
- Light and dark appearances.
- Keyboard access, readable contrast, reduced motion, and VoiceOver labels (color is never the only signal).
- No layout shift from live updates, and nothing slows scrolling or typing.
