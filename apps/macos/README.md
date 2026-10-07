# Pilot for macOS

Native SwiftUI client for pilotd, with a libghostty terminal per session.

- **Background daemon.** The app installs pilotd as a launchd agent
  (`~/Library/LaunchAgents/com.babariviere.pilot.daemon.plist`, `RunAtLoad` + `KeepAlive`).
  Closing the window keeps Pilot in the menu bar; quitting Pilot leaves pilotd and its agents running.
  "Stop pilotd" in the menu unloads the agent (sessions pause durably) until the next app launch or login.
- **Design.** Light theme after [Berth](https://github.com/sean-brydon/berthd)'s palette: white surfaces, a
  neutral-50 sidebar, hairline borders, dark primary buttons. Home has a procedural dithered sky band, the
  task composer and a dashboard (working now, activity, recent sessions, projects).
- **Projects.** Named folders stored by pilotd (`/api/projects`). The sidebar groups sessions by project;
  new sessions pick a project (or another folder) and inherit its default model. Manage them in Settings.
- **Chat.** Native transcript fed by pilotd's agent event stream: block Markdown (headings, lists, code
  blocks with copy), collapsible thinking, grouped tool rows with summaries ("Ran command npm test"),
  live output and stop. Return steers the current run (or sends when idle), Option-Return queues a
  follow-up, Shift-Return adds a line. All queued messages appear above the composer, with their delivery
  mode and full text; steering appears before follow-ups, with FIFO order within each mode. Long queues
  scroll and survive reconnects. Each queued message has an Edit action
  with Save and Cancel. Saving preserves its position and delivery mode; consumed messages cannot be edited.
- **Usage footer.** Above the composer, the optional session usage snapshot shows a context-window
  estimate (percent and tokens/window) and Claude (orange) or Codex (blue) subscription windows.
  Hover for reset times, snapshot fetch time, and provider errors. Missing measurements stay unknown;
  absent usage hides the footer. Providerless empty snapshots silently clear old subscription limits.
  The app only renders daemon session updates, with no new provider requests or polling.
  Subscription values are the latest fetched snapshot, not live measurements.
- **Models.** The model picker lists your pi scope (`enabledModels`, resolved by pi's model runtime for the
  project's directory) grouped by provider, plus the project's or pi's default (`GET /api/models`).
- **Terminal.** ⌘J toggles a libghostty terminal on the right, via
  [libghostty-spm](https://github.com/Lakr233/libghostty-spm)'s in-memory backend. The shell is a PTY owned
  by pilotd in the session's working directory, so it keeps running when Pilot quits; reopening reattaches
  and replays its scrollback. Exiting the shell leaves a "Shell exited" placeholder with Restart.
- **Settings (⌘,).** Chat and code fonts and sizes, terminal font family and size (live, on top of your
  `~/.config/ghostty/config`, which can be turned off), and projects.
- **Menu bar.** Daemon status, recent sessions, open, restart/stop pilotd, open the log.
- **Notifications.** When a session finishes or fails (bundled app only).

## Layout

| Path | Contents |
| --- | --- |
| `Sources/PilotCore` | Protocol models, JSON, transcript reducer (no UI, unit-tested) |
| `Sources/PilotCore` | Also: Markdown block parser, chat rows and tool summaries |
| `Sources/Pilot` | SwiftUI app, pilotd client, launchd management, terminals |
| `Tests/PilotCoreTests` | Swift Testing tests for the reducer |
| `Vendor/libghostty-spm` | Fetched by `scripts/vendor-ghostty.sh` (gitignored) |

## Build

Requires macOS 14+ and Swift 6.2+. Command Line Tools are enough:

```sh
scripts/bundle.sh            # -> build/Pilot.app (also: npm run app:macos from the repo root)
scripts/test.sh              # PilotCore tests
swift run Pilot              # unbundled dev run (no notifications)
.build/debug/Pilot --snapshot /tmp/pilot-snap   # render home, session and settings with fixtures to PNGs
                             # also usage-footers.png and usage-footer-narrow.png: limits and fallback
PILOT_PORT=… PILOT_TEST_SESSION=<id> .build/debug/Pilot --terminal-exit-test /tmp/out
                             # against a running pilotd: type, reattach/replay, exit, restart
```

Command Line Tools quirks handled here: libghostty-spm's `.xcstrings` catalog needs Xcode's
`xcstringstool`, so the vendoring script drops it; SwiftUI's `@State` macro plugin is missing, so views keep
local state in small `ObservableObject`s; Swift Testing's macro plugin lives outside the default plugin
path, so `scripts/test.sh` passes it explicitly.

The launch agent runs `node --import tsx src/main.ts` from this checkout's `packages/daemon`. GUI apps get
a minimal PATH, so the installer asks your login shell (nushell, fish, zsh or bash) for its PATH and falls
back to mise shims and Homebrew. pilotd logs to `~/Library/Logs/Pilot/pilotd.log`.

## Caveats

- libghostty's embedding API is not a stable ABI; the vendored package is pinned to an exact release.
- The daemon runs from this source checkout. A distributable app would bundle pilotd and Node, and register
  the agent with `SMAppService`.
- Shells live as long as pilotd: a daemon restart ends them (sessions themselves resume).
