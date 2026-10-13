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
- **Check it by eye.** Beauty is reviewed, not assumed. Look at the real result in light and dark, with real
  and long content, before calling a UI change done.

## Attention budget

Only things that need the user may interrupt: notifications, sidebar and menu bar badges, and colored status.
Failed chats, unreviewed results, mission questions and failed scheduled items qualify. Working, finished and
merged things do not, they wait on the page. When lists mix states, sort by urgency: failed, question, scheduled
failure, unread, then the rest.

## State vocabulary

Each state has one label and one icon and color token in `Theme`, used the same way in the sidebar, Home and
the project page. Do not restyle a state for a single screen.

| State | Meaning | Interrupts |
| --- | --- | --- |
| Working | An agent is running | No |
| Needs you | Failed, unreviewed result, mission question, scheduled item that could not start | Yes |
| Ready to merge | Open PR with no blockers (Pilot never merges) | Optional notification |
| Blocked or pending | PR waiting on checks, reviews or conflicts | No |
| Done | Finished and reviewed | No |

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
