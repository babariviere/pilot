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
  follow-up, Shift-Return adds a line.
- **Models.** The model picker lists your pi scope (`enabledModels`, resolved by pi's model runtime for the
  project's directory) grouped by provider, plus the project's or pi's default (`GET /api/models`).
- **Terminal.** ⌘J toggles a libghostty terminal on the right, in the session's working directory, via
  [libghostty-spm](https://github.com/Lakr233/libghostty-spm). Terminals stay alive while you switch
  sessions. The app owns these PTYs, so they end with the app.
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
- Terminals are app-owned. Daemon-owned PTYs (streamed to libghostty's in-memory backend) are planned in M2.
