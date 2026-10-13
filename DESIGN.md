# Design

Pilot's app should feel calm. It runs agents in the background so the user does not have to watch them. The
interface reports what matters and otherwise stays out of the way. [AGENTS.md](AGENTS.md) holds the working
rules, `apps/macos/Sources/Pilot/Theme.swift` the shared tokens. This file records the intent behind them.

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
