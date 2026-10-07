# UI screenshots

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
