# PR status screenshots

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
