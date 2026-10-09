# Pilot

Autopilot for your backlog. Pilot runs background [pi](https://github.com/earendil-works/pi) agents on
[pi-durable](https://www.npmjs.com/package/@earendil-works/pi-durable) sessions, so work survives restarts,
and gives you a native macOS app to spawn, steer and stop them, with a libghostty terminal per Build session.

Sessions load your pi configuration from `~/.pi/agent` (settings, packages, extensions, skills, MCP),
so packages such as [pi-extensions](https://github.com/babariviere/pi-extensions) work by default.

New chats default to **Build**. Choose **Ask** to explore code without creating a clone or granting
write access. The existing branch picker offers **Current checkout** (including local changes) or
an origin branch's committed snapshot. Branch snapshots are pinned for the chat and never switch
your checkout. Ask loads only Pilot's read/search and session-local artifact tools, not user extensions,
MCP, shell tools or repository-write tools. It can create, update and preview its own artifacts while
the repository stays read-only. To implement an idea, use **Start a Build chat** to carry the discussion
into a separate chat. Build keeps the project's workspace default, with an optional per-chat override.

New isolated **Build** sessions for jj projects (jj 0.46+ and Git 2.42+) use separate working copies of a shared repository in
`$PILOT_HOME/repositories`. Workspace edits leave your own checkout untouched, but repository history
and bookmarks are shared with sibling sessions. Agents use task-specific bookmarks for PR delivery,
do not rewrite other sessions or run repository-wide undo/operation restore, and push only the chosen
bookmark with `--bookmark`, never a broad `--all` push or rebase. Projects with **Require PR** disabled
keep direct default-branch delivery after reconciling upstream, without force-pushing. Existing private
clones, Git-only projects, direct checkouts, and Ask sessions keep their current behavior.

Archiving retains chat history, not a guarantee that its working directory stays on disk. Archived
shared jj workspaces are eligible for cleanup after 30 days, configurable with
`PILOT_WORKSPACE_RETENTION_DAYS` (`0` disables cleanup). Safe cleanup pins the exact commit and change
IDs plus the base for recovery, preserves the known ignored mise local configs (`mise.local.toml`,
`.mise.local.toml`, `mise/config.local.toml`, `.mise/config.local.toml`) and bounded `.pi/todos` files,
and blocks deletion when unknown files would be lost. Live workers/subprocesses, viewers, terminals,
open/draft pull requests, non-default sparse checkouts and submodules prevent reclamation. Ignored
dependency/build output is regenerated rather than backed up. Resuming restores a reclaimed workspace
from its recoverable jj snapshot without fetching origin.

Agents can create **Artifacts**: plain images or interactive HTML/JavaScript and React/JSX previews,
including diagrams, graphs and animations. Revisions persist with their originating session and project.
Chat cards open the revision published there; the session sidebar opens the latest. Expanded previews
fill most of the screen. Previews run offline in an isolated
WebKit view, with bundled React, Mermaid, ECharts and Motion (D3 and Three.js are opt-in).
The `artifact` tool (actions: `create`, `update`, `get`, `list`, `preview`) has a compact description and
an `artifacts` namespace that remains visible in codemode even when its full declaration does not fit.
Pilot supplies the bundled `pilot-artifacts` skill for detailed libraries, examples and authoring rules,
loaded only when needed, including in Ask. Use `describeTool("artifact")` for an omitted schema.
For agent-side screenshots and runtime diagnostics, install the optional preview browser once with
`npm run artifacts:browser`. A missing preview renderer does not prevent HTML, React or image publication.

The chat footer shows the session's context-window estimate. With pi-extensions' `usage` extension
enabled, it also shows Claude or Codex subscription windows. Hover for reset times and snapshot freshness.
Subscription data uses the extension's existing OAuth polling; Pilot does not read credentials or poll
usage endpoints separately. Without that extension or subscription credentials, only context is shown.

For PRs an agent opens from its private Build workspace, Pilot uses local `gh` authentication to check
failed CI, unresolved current review threads and merge conflicts. It sends one combined follow-up only
when the agent is idle with no queued messages. Automatic follow-ups share a persistent limit of three
per session, with a five-minute cooldown after each run finishes. Sending a user message resets that
limit. Agents investigate flaky CI rather than blindly retrying it and report blocked or declined work
in Pilot, never in GitHub comments or reviews. Ask and direct-workspace chats are not monitored for
automatic PR work.

Merged and closed PRs are no longer polled. When an agent later becomes idle, an explicit refresh can
discover a reopened or new PR. Merged chats still archive after 24 hours using the saved merge time,
without another GitHub request.

See [PLAN.md](PLAN.md) for the spec and milestones (GitHub, Slack and Linear triggers, human-in-the-loop
specs, hosting).

In the task and chat composers, press Tab while typing a path to complete files or folders. Relative
paths use the selected project or session's working directory (home if no project is selected).
Absolute paths and `~/` are supported. For multiple matches, use the path picker's arrow keys and
Tab or Return to choose, or Escape to dismiss. Quote paths containing spaces or escape the spaces with `\`.

## Architecture

```text
 Pilot.app (apps/macos) ──HTTP/WS──▶ pilotd (packages/daemon, launchd agent)
                                       │ fork + IPC, one per session
                                       ▼
                              kernel worker (packages/kernel)
                              ├─ pi-durable Harness (SQLite, model loop, tasks)
                              └─ native Pi SDK kernel (extensions, tools, prompts, auth)
```

- The Harness owns the transcript and the model loop. The native kernel provides tools, the system prompt,
  extension hooks and provider authentication (adapter ported from pi-extensions `subagents`).
- One worker process per session isolates extension globals, sandbox state and crashes.
- pilotd runs as a per-user launchd agent installed by the app. Closing or quitting the app leaves agents
  running.
- Session data lives in `$PILOT_HOME` (default `~/.local/share/pilot`), one directory per session.
- pilotd listens on `127.0.0.1:4319` and rejects browser requests (any `Origin` header). There is no
  authentication yet, so do not expose it.

## Development

```sh
npm install
npm run app:macos            # builds apps/macos/build/Pilot.app (Command Line Tools are enough)
open apps/macos/build/Pilot.app
```

Daemon only, in the foreground: `npm run dev:daemon`. Checks: `npm run typecheck`, `npm test`,
`apps/macos/scripts/test.sh`.

Offline transcript-opening regression (cached history, session switches, width changes, and delayed snapshots):
`apps/macos/.build/debug/Pilot --transcript-opening-check /tmp/pilot-opening-check`.
Add `--transcript-fixture <snapshot.json>` to replay a saved snapshot without connecting to the daemon.

## Private releases and updates

GitHub Actions can build self-contained Apple Silicon releases on `main`. Pilot authenticates private
downloads using local `gh` authentication (with a Keychain token fallback) and installs Sparkle-signed
updates when agents are idle.
No Apple developer membership is required (personal builds are ad-hoc signed, not notarized).
See [the one-time setup](apps/macos/UPDATES.md) for signing keys, GitHub access and initial installation.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PILOT_HOME` | `~/.local/share/pilot` | Session metadata and durable storage |
| `PILOT_WORKSPACE_RETENTION_DAYS` | `30` | Archived shared jj workspace retention; `0` disables cleanup |
| `PILOT_PORT` | `4319` | Daemon port |
| `PILOT_AGENT_DIR` | pi's agent dir | Pi settings, packages and auth to load |

## Caveats

- Native tools are replay-unsafe. A crash mid-tool yields an interrupted result instead of a rerun.
- Extensions that start their own model loop or replace the SDK session are unsupported, the same as
  pi-extensions subagents. Extension messages that start a turn (`sendMessage` with `triggerTurn`, or
  `sendUserMessage`) become durable Harness input, so subagent answers wake the parent chat as follow-ups.
  Custom messages without `triggerTurn` stay native-only and are not added to the durable transcript.
  Subagent display and controls need a pi-extensions version with the `subagents:*` host events.
- Project-local `.pi` resources load only for directories pi already trusts (or `defaultProjectTrust: always`).
