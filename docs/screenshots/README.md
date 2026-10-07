# UI screenshots

## Agent status icons

`status-icons.png` shows all six colored agent states in the sidebar: working, done,
needs your input, failed, idle and stopped. Unread dots remain separate. The image
uses deterministic fixture sessions, not live conversations.

Regenerate on macOS:

```sh
swift build --package-path apps/macos
apps/macos/.build/debug/Pilot --snapshot /tmp/pilot-status-screenshots
cp /tmp/pilot-status-screenshots/status-icons.png docs/screenshots/
```

## PR status

These screenshots use deterministic fixture data, not live session conversations.
They show PR state separately from agent outcome and unread indicators.

- `pr-open.png`: an active session with an open PR, showing PR state independently of agent progress.
- `pr-merged.png`: a completed session with a merged PR.
- `pr-dashboard.png`: Open, Merged, Draft and Closed states in the sidebar and dashboard.
- `pr-stale.png`: cached PR status after a GitHub lookup failure.

Regenerate on macOS:

```sh
swift build --package-path apps/macos
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
swift build --package-path apps/macos
apps/macos/.build/debug/Pilot --snapshot /tmp/pilot-todos-screenshots
cp /tmp/pilot-todos-screenshots/session.png docs/screenshots/tasks-chat.png
```

## Chat usage screenshots

- `usage-composer.png`: the subtle model picker, context, 5h and weekly gauges below the chat box.
- `usage-composer-narrow.png`: the controls row wrapping in a narrow chat column.
- `usage-footers.png`: Claude/Codex usage windows, refresh errors, and missing-snapshot states.
- `usage-footer-narrow.png`: the compact usage indicators in a narrow column.

These also use deterministic fixtures. Regenerate with the snapshot command above, then copy
the `usage-*.png` images from its output directory.

## Project artifact browser

`artifacts-sidebar.png` shows the compact artifact browser button beside Archive in each
project header, replacing the separate Browse artifacts row. It is cropped from the
deterministic home-screen fixture.

Regenerate on macOS (with ImageMagick installed):

```sh
swift build --package-path apps/macos
apps/macos/.build/debug/Pilot --snapshot /tmp/pilot-artifacts-screenshots
magick /tmp/pilot-artifacts-screenshots/home.png -crop 280x430+0+0 +repage docs/screenshots/artifacts-sidebar.png
```
