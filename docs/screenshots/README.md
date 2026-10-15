# UI screenshots

## Main README

The main README uses three captures rendered from the current production SwiftUI views with synthetic
fixtures, without connecting to a daemon or using live conversations:

- `readme-build.png`: a Build chat, its task checklist and the Changes inspector.
- `readme-ask.png`: a read-only Ask chat with an implementation plan.
- `readme-mission.png`: a mission's Tasks page in the native window.

The chat captures use the snapshot renderer's stand-in window header. The mission capture includes the
real native toolbar. These are view-layout snapshots, not end-to-end agent or scrolling tests.

Regenerate on macOS from the repository root:

```sh
apps/macos/scripts/build.sh
captures="$(mktemp -d /tmp/pilot-readme-screenshots.XXXXXX)"
fixture_home="$(mktemp -d /tmp/pilot-readme-home.XXXXXX)"
HOME="$fixture_home" CFFIXED_USER_HOME="$fixture_home" apps/macos/.build/debug/Pilot --snapshot "$captures"
HOME="$fixture_home" CFFIXED_USER_HOME="$fixture_home" apps/macos/.build/debug/Pilot --snapshot "$captures" --missions-only
cp "$captures/session-changes.png" docs/screenshots/readme-build.png
cp "$captures/ask-chat.png" docs/screenshots/readme-ask.png
cp "$captures/mission-window-tasks-1360.png" docs/screenshots/readme-mission.png
```

Inspect all three images before publishing. Copy only these demo captures, never a live window capture
containing private projects, conversations or credentials.

## Mission task phases

The mission Tasks tab groups tasks by phase (a task's milestone), from synthetic fixtures:

- `mission-tasks-phases.png`: a finished phase folded, active work before done work in each phase, tasks
  without a milestone last under "No phase", and dropped tasks behind "Show dropped".
- `mission-tasks-phases-reveal.png`: "Show task" on a dropped task in the folded phase, which unfolds it, shows
  dropped tasks and highlights the row.
- `mission-tasks-flat.png`: a mission without milestones, shown as one flat list.

Regenerate on macOS:

```sh
apps/macos/scripts/build.sh
apps/macos/.build/debug/Pilot --snapshot /tmp/pilot-phases --missions-only
cp /tmp/pilot-phases/mission-tasks-{phases,phases-reveal,flat}.png docs/screenshots/
```

## Long chat messages

Render the production message views with synthetic crash-report and assistant fixtures:

```sh
apps/macos/scripts/build.sh
apps/macos/.build/debug/Pilot --snapshot /tmp/pilot-long-messages --long-messages-only
```

`long-messages-400.png` and `long-messages-760.png` show the soft fade/shadow and expansion chevron
at narrow and wide widths, without an ellipsis or a separate "Show full message" action row.
`long-message-expanded.png` shows the full selectable user bubble and its collapse control.
These native fixture screenshots verify message layout, not live transcript scrolling.

## Remote base branch selector

`branch-default.png` and `branch-selected.png` show the actual new-task composer with deterministic
origin branch fixtures, defaulting to `main` and explicitly selecting `feat/billing`. Only
private-clone projects offer the selector. Regenerate without a live daemon:

```sh
apps/macos/scripts/build.sh
apps/macos/.build/debug/Pilot --snapshot /tmp/pilot-branch-screenshots --branches-only
cp /tmp/pilot-branch-screenshots/branch-{default,selected}.png docs/screenshots/
```

## Session debugging

- `session-debug-button.png`: the bug button at the top right of a session.
- `session-debug-draft.png`: the new task in `pilot`, prefilled with the source session path
  and an example issue description, before submitting.

Both use fixture data, not live conversations. As with the other chat snapshots, the window
toolbar is represented by the snapshot renderer's stand-in header.

Regenerate on macOS:

```sh
apps/macos/scripts/build.sh
apps/macos/.build/debug/Pilot --snapshot /tmp/pilot-debug-screenshots
cp /tmp/pilot-debug-screenshots/session-debug-{button,draft}.png docs/screenshots/
```

## Agent status icons

`status-icons.png` shows all six colored agent states in the sidebar: working, done,
needs your input, failed, idle and stopped. Working uses a normal-text-color braille spinner
(a single animation frame in the screenshot). Reduce Motion keeps it static.
Unread dots remain separate. The image
uses deterministic fixture sessions, not live conversations.

Regenerate on macOS:

```sh
apps/macos/scripts/build.sh
apps/macos/.build/debug/Pilot --snapshot /tmp/pilot-status-screenshots
cp /tmp/pilot-status-screenshots/status-icons.png docs/screenshots/
```

## PR status

`pr-sidebar-icons.png` shows the shared three-node Git branch glyph for open PRs in the sidebar.
Green color and PR numbers are preserved; draft, merged, closed and stale indicators remain distinct.
Regenerate with `Pilot --snapshot /tmp/pilot-pr-icons --pr-icons-only`, then copy the image here.

These screenshots use deterministic fixture data, not live session conversations.
They show PR state separately from agent outcome and unread indicators.

- `pr-open.png`: an active session with an open PR, showing PR state independently of agent progress.
- `pr-merged.png`: a completed session with a merged PR.
- `pr-dashboard.png`: Open, Merged, Draft and Closed states in the sidebar and dashboard.
- `pr-stale.png`: cached PR status after a GitHub lookup failure.

Regenerate on macOS:

```sh
apps/macos/scripts/build.sh
apps/macos/.build/debug/Pilot --snapshot /tmp/pilot-pr-screenshots
cp /tmp/pilot-pr-screenshots/pr-{open,merged,dashboard,stale}.png docs/screenshots/
```

The PR description embeds these private-repository assets at a pinned commit.

## Chat tasks

`tasks-chat.png` shows the live Tasks checklist above the composer, with current work first,
pending tasks, completed items, and a completion count and progress bar. It also uses
deterministic fixture data, not a live conversation.

Regenerate on macOS:

```sh
apps/macos/scripts/build.sh
apps/macos/.build/debug/Pilot --snapshot /tmp/pilot-todos-screenshots
cp /tmp/pilot-todos-screenshots/session.png docs/screenshots/tasks-chat.png
```

## Chat usage screenshots

- `usage-composer.png`: the model picker and the context gauge in the composer bar.
- `usage-composer-narrow.png`: the controls row wrapping in a narrow chat column.
- `usage-indicators.png`: the subscription line above the composer (past 80% and limited), context gauges, and
  Home's subscription bars.

These also use deterministic fixtures. Regenerate with the snapshot command above, then copy
the `usage-*.png` images from its output directory.

## Project artifact browser

`artifacts-sidebar.png` shows the compact artifact browser button beside Archive in each
project header, replacing the separate Browse artifacts row. It is cropped from the
deterministic home-screen fixture.

Regenerate on macOS (with ImageMagick installed):

```sh
apps/macos/scripts/build.sh
apps/macos/.build/debug/Pilot --snapshot /tmp/pilot-artifacts-screenshots
magick /tmp/pilot-artifacts-screenshots/home.png -crop 280x430+0+0 +repage docs/screenshots/artifacts-sidebar.png
```
