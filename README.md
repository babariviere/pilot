# Pilot

Autopilot for your backlog. Pilot runs background [pi](https://github.com/earendil-works/pi) agents on
[pi-durable](https://www.npmjs.com/package/@earendil-works/pi-durable) sessions, so work survives restarts,
and gives you a native macOS app to spawn, steer and stop them, with a libghostty terminal per session.

Sessions load your pi configuration from `~/.pi/agent` (settings, packages, extensions, skills, MCP),
so packages such as [pi-extensions](https://github.com/babariviere/pi-extensions) work by default.

Agents can create **Artifacts**: interactive HTML/JavaScript or React/JSX previews, including diagrams,
graphs and animations. Revisions persist with their originating session and project. Chat cards open
the revision published there; the session sidebar opens the latest. Previews run offline in an isolated
WebKit view, with bundled React, Mermaid, ECharts and Motion (D3 and Three.js are opt-in).
The `artifact` tool (actions: `create`, `update`, `get`, `list`, `preview`)
documents the available libraries and authoring examples. For agent-side screenshots and runtime
diagnostics, install the optional preview browser once with `npm run artifacts:browser`.

The chat footer shows the session's context-window estimate. With pi-extensions' `usage` extension
enabled, it also shows Claude or Codex subscription windows. Hover for reset times and snapshot freshness.
Subscription data uses the extension's existing OAuth polling; Pilot does not read credentials or poll
usage endpoints separately. Without that extension or subscription credentials, only context is shown.

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

## Private releases and updates

GitHub Actions can build self-contained Apple Silicon releases on `main`. Pilot authenticates private
downloads using local `gh` authentication (with a Keychain token fallback) and installs Sparkle-signed
updates when agents are idle.
No Apple developer membership is required (personal builds are ad-hoc signed, not notarized).
See [the one-time setup](apps/macos/UPDATES.md) for signing keys, GitHub access and initial installation.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PILOT_HOME` | `~/.local/share/pilot` | Session metadata and durable storage |
| `PILOT_PORT` | `4319` | Daemon port |
| `PILOT_AGENT_DIR` | pi's agent dir | Pi settings, packages and auth to load |

## Caveats

- Native tools are replay-unsafe. A crash mid-tool yields an interrupted result instead of a rerun.
- Extensions that start their own model loop or replace the SDK session are unsupported, the same as
  pi-extensions subagents. Extension messages that would start a native turn (for example subagent answer
  notifications) are not bridged into the Harness yet. The `subagent` tool loads, with its storage anchored
  in the session directory, but this path is untested; read answers with `status`.
- Project-local `.pi` resources load only for directories pi already trusts (or `defaultProjectTrust: always`).
