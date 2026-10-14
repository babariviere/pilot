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
  at home on macOS, in light and dark appearance, and at any window size.
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
- **Check it by eye.** Beauty is reviewed, not assumed. Look at the real result in light and dark, with real
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
| Needs you | Failed, unreviewed result, agent or mission question, scheduled item that could not start. A viewed result stays until answered, archived or removed | Yes |
| Ready to merge | Open PR with no blockers (Pilot never merges) | Optional notification |
| Blocked or pending | PR waiting on checks, reviews or conflicts | No |
| Done | Finished and reviewed | No |

In the sidebar, a chat's state is its dithered corner (`DitherCorner`), not an icon column: an ordered dither
growing from the row's bottom-right corner in the state's tint. Working is a soft indigo ripple, needs you an amber
breath, failed a steady dense red, ready to merge a steady light green. Done and other quiet chats draw nothing.
Density and motion differ per state, so color is never the only signal, and VoiceOver reads the state. Changes
dissolve cell by cell, the corner leans toward the pointer, and Reduce Motion keeps it still.

## Sidebar

The sidebar answers "what needs me" before "where is it". One header row holds the scope switcher, Home (badged with
what needs the user) and compose; archived chats, search (⌘F) and grouping live in the switcher's menu. All
projects groups chats by urgency (Needs you, Working, Recent) with each row naming its project; a focused project
lists its own missions and chats. Rows are a title and one metadata line. Time, pin and mission marks, and project
header actions, appear under the pointer. Quiet chats fold past the first few, and the footer appears only while
pilotd is unreachable.

## Consistency

- Reuse shared components and `Theme` tokens (color, type, spacing, radius, motion). Add missing tokens or
  components centrally instead of styling a screen on its own.
- Follow existing layouts, terminology and visual hierarchy. Pages such as missions and projects share one
  reading column, section headers and hairline rows (`PageComponents.swift`).
- Check every change with long content and with loading, empty, error and disabled states. Keep keyboard access
  and readable contrast.

## Project page

The project page follows these principles: a single reading column with a one-sentence summary, then sections in
order of urgency (Needs you, Working now, Pull requests, Missions, Scheduled, Tracked, Recent), at most five rows
each. Sections added later follow the same rules.

## UI review checklist

- Looks calm and polished in light and dark, checked by eye (attach a SwiftUI artifact for new layouts).
- Long content, and loading, empty, error and disabled states.
- Narrow and wide windows.
- Keyboard access, readable contrast, reduced motion, and VoiceOver labels (color is never the only signal).
- No layout shift from live updates, and nothing slows scrolling or typing.
