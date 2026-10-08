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
  **Require PR** defaults to on, including for older projects. Disabling it permits direct pushes to the
  default branch. Saved PR policy changes apply when a session worker next starts.
- **Sidebar folders.** Use the sidebar **+** menu to create a folder, then right-click a project and
  choose **Move to Folder**. Folder headers expand/collapse and offer Rename/Delete via their context
  menu. Deleting a folder ungroups its projects. Grouping and folder collapse state persist locally
  across app restarts, without moving repositories or changing sessions. Search reveals matches in
  collapsed folders automatically.
- **Chat.** Native transcript fed by pilotd's agent event stream: block Markdown (headings, lists, code
  blocks with copy), collapsible thinking, grouped tool rows with summaries ("Ran command npm test"),
  live output and stop. Return steers the current run (or sends when idle), Option-Return queues a
  follow-up, Shift-Return adds a line. All queued messages appear above the composer, with their delivery
  mode and full text; steering appears before follow-ups, with FIFO order within each mode. Long queues
  scroll and survive reconnects. Edit queued messages inline with Edit or Option-Up/Option-Down.
  Return saves, Escape cancels, and Shift-Return adds a line. Arrow navigation retains unsaved drafts;
  saving preserves queue position and delivery mode. Use Remove on any queued row to withdraw it
  without stopping the active run, or press Command-Delete (⌘⌫) while its inline editor is focused.
  Consumed messages cannot be edited or removed.
- **Inline diagrams.** Completed `svg` and `mermaid` Markdown fences render directly in chat, with
  source/copy controls and source fallback for errors. Unclosed streaming fences stay as code.
  Previews fit the chat width and release their renderer offscreen. SVG scripts and external resources
  are disabled; Mermaid uses the bundled library with strict security. Sources are capped at 512 KiB.
- **Archives.** Archive an idle chat from its toolbar or sidebar context menu. Stop starting/working
  sessions first. The sidebar's **Archived chats** control browses all archives; each project's
  archive icon opens its archives, and the browser's project selector changes scope. Archived chats
  remain readable with history and workspaces intact, but the composer is read-only until **Restore**.
  Archives do not appear in normal sidebar, dashboard, home, or menu bar session lists/counts.
- **Usage footer.** Above the composer, the optional session usage snapshot shows a context-window
  estimate (percent and tokens/window) and Claude (orange) or Codex (blue) subscription windows.
  Hover for reset times, snapshot fetch time, and provider errors. Missing measurements stay unknown;
  absent usage hides the footer. Providerless empty snapshots silently clear old subscription limits.
  The app only renders daemon session updates, with no new provider requests or polling.
  Subscription values are the latest fetched snapshot, not live measurements.
- **Models.** The model picker lists your pi scope (`enabledModels`, resolved by pi's model runtime for the
  project's directory) grouped by provider, plus the project's or pi's default (`GET /api/models`).
  Chats have a separate Thinking selector offering only the selected model's supported levels.
  Model and thinking changes require an idle chat with no queued messages; both persist across reopening.
  Thinking is disabled when the model has only one level or no reported levels.
- **Artifacts.** Structured artifact tool results show a pinned-revision card with an opt-in inline
  preview and expanded viewer. Durable publication entries also show artifacts published inside
  codemode without duplicating direct tool cards. The right-hand inspector's Artifacts tab lists all
  artifacts in the selected chat, updates live, and opens the latest revision. Use the cube toolbar
  button or View > Toggle Artifacts to show it. Each project retains a Browse artifacts button in
  the navigation sidebar across its sessions.
  Both views offer Source and loading/error states. Offscreen inline previews are disposed.
  Each renderer uses an isolated, nonpersistent WebKit store, a restrictive CSP and a fail-closed
  request blocker. Only declared, allowlisted `pilot-artifact://library/<name>` script resources can
  load through read-only native HTTP requests. There is no JavaScript/native bridge, external
  navigation, popup, file picker, media capture, shell access or event sending. All-frame, page-world
  document-start guards lock WebRTC and WebTransport constructors to undefined, blocking UDP APIs
  outside WebKit's request blocker. Data/blob images and media, and data fonts remain supported.
- **Terminal.** ⌘J toggles a libghostty terminal on the right, via
  [libghostty-spm](https://github.com/Lakr233/libghostty-spm)'s in-memory backend. The shell is a PTY owned
  by pilotd in the session's working directory, so it keeps running when Pilot quits; reopening reattaches
  and replays its scrollback. Exiting the shell leaves a "Shell exited" placeholder with Restart.
- **Settings (⌘,).** Chat and code fonts and sizes, terminal font family and size (live, on top of your
  `~/.config/ghostty/config`, which can be turned off), and projects.
- **Menu bar.** Daemon status, recent sessions, open, restart/stop pilotd, open the log. The icon is the app
  icon's plane, with its contrail while agents are working.
- **Results.** Color-only status dots are separate from lifecycle: blue for Working, green for Done,
  orange for Needs your input, red for Failed, and gray for Stopped/Idle. Hover for the status label;
  screen readers announce it too.
  Chats show the working indicator, but no settled status icon or outcome-reason footer.
  Unread result dots persist until the loaded transcript end is visible in an active chat, or you choose
  "Mark as reviewed" in the sidebar. Reviewing never answers a question or clears Needs your input.
- **Pull requests.** Browser links in the sidebar, session header, dashboard, context menu and menu bar
  show only a colored state icon and PR number, independently of results and unread dots.
  Hover for Draft, Open, Merged or Closed without merging, the title and last lookup time.
  Failed lookups retain a warning-marked cached icon, or show a warning icon if no cached PR exists.
  Links accept HTTP(S), including GitHub Enterprise hosts, and never merge or close a PR.
- **Notifications.** New completion versions (bundled app only), deduplicated across reconnects.

## Layout

| Path | Contents |
| --- | --- |
| `Sources/PilotCore` | Protocol models, JSON, transcript reducer (no UI, unit-tested) |
| `Sources/PilotCore` | Also: Markdown block parser, chat rows and tool summaries |
| `Sources/Pilot` | SwiftUI app, pilotd client, launchd management, terminals |
| `Tests/PilotCoreTests` | Swift Testing tests for the reducer |
| `Resources/AppIcon.svg` | App icon source; `scripts/icon.sh` regenerates the committed `AppIcon.icns` |
| `Vendor/libghostty-spm` | Fetched by `scripts/vendor-ghostty.sh` (gitignored) |

## Build

Requires macOS 14+ and Swift 6.2+. Command Line Tools are enough:

```sh
scripts/bundle.sh            # -> build/Pilot.app (also: npm run app:macos from the repo root)
scripts/check-app.sh build/Pilot.app  # relocated app: packaged resources and terminal initialization
scripts/test.sh              # PilotCore tests
.build/debug/Pilot --queue-edit-test  # native queue editing/removal keys, focus, drafts, failed/stale requests
swift run Pilot              # unbundled dev run (no notifications)
.build/debug/Pilot --snapshot /tmp/pilot-snap   # home, session, changes, settings, needs-input-unread, done-unread PNGs
                             # also usage-footers.png and usage-footer-narrow.png: limits and fallback
                             # also session-queued.png, session-long-queue.png and queued-message-editor.png
                             # and menubar-idle.png / menubar-working.png: the menu bar plane glyph
                             # also pr-open.png, pr-merged.png, pr-stale.png and pr-dashboard.png
                             # also sidebar-folders.png, sidebar-folders-collapsed.png and sidebar-folders-search.png
                             # add --sidebar-folders-only to stop after the folder previews
PILOT_PORT=… PILOT_TEST_SESSION=<id> .build/debug/Pilot --terminal-exit-test /tmp/out
                             # against a running pilotd: type, reattach/replay, exit, restart
# Run from the repository root, after building:
apps/macos/.build/debug/Pilot --artifact-render-test /tmp/pilot-artifact-test
                             # no daemon: real ECharts/animations and data/blob SVGs, sandbox probes,
                             # immutable RTC/WebTransport guards in main/about:blank realms, PNGs
                             # optional PILOT_ARTIFACT_TEST_LIBRARY=/absolute/path/to/echarts.min.js
                             # also inline SVG/Mermaid, invalid/hostile source, responsive heights, PNGs
                             # optional PILOT_ARTIFACT_TEST_MERMAID=/absolute/path/to/bundled-mermaid.js
                             # optional PILOT_ARTIFACT_TEST_REACT=/absolute/path/to/prepared-react.html
                             # React fixture: "Native React 7", button increments to "Native React 8";
                             # Motion #native-react-counter reaches opacity 1 after 300ms, or optionally
                             # sets window.nativeMotionDone=false then true on animation completion
```

Command Line Tools quirks handled here: libghostty-spm's `.xcstrings` catalog needs Xcode's
`xcstringstool`, so the vendoring script drops it; SwiftUI's `@State` macro plugin is missing, so views keep
local state in small `ObservableObject`s; Ghostty's resource lookup is patched to use the signed app's
`Contents/Resources` (native SwiftPM's generated accessor only checks the app root and build directory);
every bundle build smoke-tests terminal initialization from a temporary location without a daemon.
Swift Testing's macro plugin lives outside the default plugin
path, so `scripts/test.sh` passes it explicitly.

Development bundles run `node src/main.ts` (Node's native TypeScript stripping, no loader) from this checkout's
`packages/daemon`. Release
bundles include Node and pilotd in `Contents/Resources/runtime` and do not require this checkout. GUI apps get
a minimal PATH, so the installer asks your login shell (nushell, fish, zsh or bash) for its PATH and falls
back to mise shims and Homebrew. pilotd logs to `~/Library/Logs/Pilot/pilotd.log`.

### Optional artifact screenshot browser

Native artifact previews use WebKit and need no browser installation. The agent's optional
`artifact({action: "preview", ...})` screenshot tool uses Playwright Chromium. Pilot never downloads that browser
automatically. If you want screenshots, explicitly run this in Terminal (it downloads Chromium
into your user cache; adjust the app path if needed):

```sh
runtime="/Applications/Pilot.app/Contents/Resources/runtime"
"$runtime/node/bin/node" "$runtime/node_modules/playwright/cli.js" install chromium
```

Release runtimes include Node and Playwright but not npm, so use this bundled CLI rather than
`npm` or `npx`. Artifact rendering remains isolated and screenshot browser installation is opt-in.

## Automatic builds and private updates

[UPDATES.md](UPDATES.md) covers the one-time GitHub signing-key setup, first installation and the
local `gh` authentication, with a Keychain-backed token fallback in Settings > Updates.
Release Please maintains semantic-version release PRs on `main`. Merging one publishes a stable
Apple Silicon release (`vX.Y.Z`) with generated release notes, after all checks and signing succeed.
Other main commits produce SHA-named GitHub dev prereleases. Each build includes a drag-and-drop
DMG installer and the signed update ZIP. Dev prereleases do not replace stable automatic updates.
Sparkle downloads and installs verified updates when agents are idle. Installation restarts pilotd
and closes terminal shells. No Apple developer membership is needed; builds are not notarized.

## Caveats

- libghostty's embedding API is not a stable ABI; the vendored package is pinned to an exact release.
- Development apps run the daemon from this checkout. Personal release builds bundle pilotd and Node,
  but still use the existing per-user launchd plist, not `SMAppService`.
- Shells live as long as pilotd: a daemon restart ends them (sessions themselves resume).
