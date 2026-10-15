# Pilot

**Background coding agents. A native macOS app. You stay in control.**

Pilot runs [pi](https://github.com/earendil-works/pi) agents in the background, with durable chats and
isolated Build workspaces. Start a task, steer it when needed, and review the result as a
code diff, pull request or artifact. Agents keep working when you close the app.

Pilot is local-first. It uses your existing pi models, authentication and configuration, with a local
daemon managing sessions independently of the SwiftUI app.

[Get started](#get-started) · [Working with Pilot](#working-with-pilot) · [Development](#development)

![A Build chat with grouped tool activity, task progress and code changes side by side](docs/screenshots/readme-build.png)

*Screenshots are rendered from native views with demo data, not live conversations. Chat captures use a
stand-in window header; Build and mission captures are cropped to their working areas.
See [screenshot notes](docs/screenshots/README.md) to regenerate them.*

## What you can do

- **Run several agents at once.** Follow progress across projects, send follow-ups, queue messages or stop
  a run. Every session has its own worker process.
- **Jump anywhere from the keyboard.** ⌘K opens a command palette over chats (by title, branch, project or pull
  request number), pages, missions and tasks (`#25`), project scopes, Linear and Slack Inbox items, and actions such
  as new chat, pin, archive, stop, retry or opening the pull request on GitHub.
- **Let the display rest while agents work.** Keep the Mac awake without keeping the display on.
  Optional closed-lid work locks the Mac on lid closure and requires power and Wi-Fi; otherwise agents pause
  and resume on the next full wake with connectivity. See [agent-aware sleep](docs/agent-sleep.md) for
  authorization and interruption limits.
- **Answer questions quickly.** When an agent needs a decision, its question replaces the message box with
  suggested answers. Pick one with the number keys and Return, or reply in your own words. The chat shows as
  needing you until you answer.
- **Explore before implementing.** Ask chats can read code and produce artifacts without repository write
  access. Move the discussion into a separate Build chat when you're ready to make changes.
- **Review work in context.** Build chats include a diff inspector, a [libghostty](https://github.com/Lakr233/libghostty-spm)
  terminal in the session workspace, task progress and pull request status. Attach a pull request in Changes
  using its GitHub link or just its number (`123` or `#123`) in the project's GitHub repository.
- **Coordinate bigger goals.** Missions group chats around a shared brief, decisions, tasks, dependencies,
  artifacts and activity, with an optional coordinator agent.
- **Keep useful context.** Build agents can save lasting decisions, preferences and lessons in project
  memory for later chats, rather than task status or secrets. A note can replace an outdated one, and
  duplicates are refused. Pi skills, prompt templates, packages and compatible extensions are available in
  Build sessions.
- **Get more than text back.** Agents can publish images, interactive HTML and React previews, diagrams and
  static SwiftUI renders. Artifacts stay attached to their chat and can be linked to missions and tasks.
- **Bring work into Pilot.** Track Linear issues and Slack messages from configured sources, triage Slack
  messages by type, label and severity, see what waits on you across projects in one Inbox, then start a chat or
  mission from an item. Schedule work for later or for wake, online and time triggers.

## Get started

### Install a release

Download `Pilot-arm64.zip` from the [latest release](https://github.com/babariviere/pilot/releases/latest),
unzip it and move `Pilot.app` to Applications.

- Released builds target **Apple Silicon Macs running macOS 14 or later**.
- Releases bundle Node and the daemon, so you don't need a source checkout or a separate Node installation.
- Set up a model provider in [pi](https://github.com/earendil-works/pi) first. Pilot uses your pi agent directory
  (normally `~/.pi/agent`), including provider authentication.
- Install and authenticate [GitHub CLI](https://cli.github.com) (`gh auth login`) if you want agents to create
  pull requests or Pilot to monitor them.
- Install [Jujutsu](https://jj-vcs.github.io/jj/) **0.46+** and **Git 2.42+** for shared, isolated jj workspaces.
  Git-only projects use private clones instead.

These personal builds are ad-hoc signed, not notarized. If macOS blocks the first launch, verify the
release source before using **System Settings → Privacy & Security → Open Anyway**.
[Release and update setup](apps/macos/UPDATES.md) explains signing, packaging and automatic updates.
Updates pause agents after active tool calls finish, update the app and daemon, then resume unfinished
chats and subagents automatically. They do not wait for entire conversations to finish.
Chats with working subagents stay Working, even when the parent has finished its current reply.
Pending child work also reopens automatically after a daemon restart or a sleep pause.

### Start your first chat

Chat messages render Linear, Slack and GitHub URLs as compact links with the service mark and a short name.
Names come from Markdown labels or the URL, without fetching private pages. Bare `#123` references stay literal
so mission task numbers are never mistaken for GitHub issues. Copying preserves the original text and URLs.

1. Open Pilot and **Add Project** to select a local repository.
2. Create a chat, choose **Build** or **Ask**, select a model and describe the task.
3. Let the agent work. Send a follow-up to steer it, or stop it if the direction is wrong.
4. Review its response, artifacts and, for Build chats, the changes and pull request. You decide what to merge.

The app installs `pilotd` as a per-user launchd agent. Closing or quitting Pilot does not stop running
agents. Chat history is stored locally using [pi-durable](https://www.npmjs.com/package/@earendil-works/pi-durable).

If a chat's worker fails to start, fix the reported configuration or extension dependency problem and
choose **Retry Startup** below the error. Pilot reloads the worker with the original queued messages,
keeping its history and workspace. Workspace preparation failures cannot use this action.
You can also archive a failed startup without discarding its queued messages. Restore it before retrying.

## Working with Pilot

### Stopping and system messages

Stop ends the current run and returns your undelivered queued messages to the composer. System messages
from background jobs, PR follow-ups and other chats stay held, without restarting the chat. Use **Send now**
to start one run with them, **Discard** to remove all or an individual held message, or send your next
message to carry them along. Waiting system messages are read-only.

### Subscription limits

Chats pause new model requests and tool calls at **95%** of any subscription window. Active tools finish
safely, and subagents respect their own provider's limits, even when it differs from the parent chat.
Work resumes automatically when the blocked windows reset or a fresh usage reading drops below 95%.
Known pauses survive restarts and unavailable readings. Usage comes from pi's shared cache, without
additional provider polling; unknown usage cannot predict a limit, and in-flight requests may still use tokens.

Beside the usage warning, **Force work** lets that chat and its subagents continue past the current
windows. The override ends when those windows reset or clear. **Pause at limit** restores the guard early.

**Continue with another model…** explains the change before confirming. A model from the same provider
keeps this chat and compatible context, but does not bypass its subscription limit. A different provider
starts a linked chat with a bounded plain-text handoff, not provider-specific history or compaction. It
takes over the existing workspace, branch, PR ownership and mission task claims. The original remains
readable and never resumes automatically. Previous subagent tasks are handed off as text, not recovered
with their old provider context. New-model usage limits still apply.
Finish or stop background jobs and close live terminals before changing the model for paused work.

### Ask and Build

| | Ask | Build |
| --- | --- | --- |
| Purpose | Understand code, discuss options, plan | Implement, test and deliver changes |
| Code source | Current checkout or a pinned origin-branch snapshot | Project workspace setting, with a per-chat override |
| Tools | Pilot's read/search tools, bundled web and session-local artifacts | Pi tools, bundled capabilities, compatible extensions, MCP and shell tools |
| Repository writes | No | Yes |
| Diff inspector and terminal | No | Yes |

Ask can inspect the current checkout, including local changes, without switching branches. An
origin-branch snapshot stays pinned for that chat. **Start a Build chat** carries the discussion into a
new implementation chat; it does not give the existing Ask chat write access.

![An Ask chat exploring durable session resume without repository write access](docs/screenshots/readme-ask.png)

### Workspaces and pull requests

Isolated Build workspaces keep file edits out of your own checkout. For jj projects, sessions use
separate working copies of a shared repository. **History and bookmarks are shared**, so agents must keep
rewrites and pushes scoped to their own task. Git-only projects use private clones. Direct-checkout mode
is also available, but edits there affect your checkout.

Project policy controls delivery. With **Require PR** enabled, agents deliver on a task branch for review.
Disabling it permits direct default-branch delivery. Pilot never auto-merges pull requests.

Pilot monitors agent-owned PRs from isolated Build sessions for failed CI, unresolved review threads and
merge conflicts, including earlier PRs in a stack. It sends follow-up work only when the agent is idle
and no user messages are queued. Automatic follow-ups are limited to three per session, with a
five-minute cooldown; sending a user message resets the limit. Results and blockers come back to Pilot,
not GitHub comments or reviews. Ask and direct-checkout sessions do not receive automatic PR follow-ups.
Owned PRs still blocked by conflicts, failing checks, unresolved review threads or a diverged stack after
three attempts (or without an automatic follow-up route) appear in Needs you once the chat is idle and
the cooldown has ended. Fixing the problem clears the reason; sending a message resets the follow-up budget.

GitHub writes are attributed to the chat in its activity and, for mission members, in mission activity.
The audit records a sanitized operation, PR or branch target when available, time and exit status, not
tokens, request bodies or command output. It retains the latest 200 actions per chat and 1,000 GitHub
events per mission. Compound commands and background starts show an unknown per-command exit status
rather than an inferred success.

Archiving keeps the conversation, but not necessarily its working directory. After the retention period,
Pilot can reclaim safe archived jj workspaces and restore them from a saved snapshot on resume. It can
also prune generated build and dependency output from legacy clones. Dependencies may need reinstalling
after recovery.
Ignored content does not block jj workspace reclamation and is discarded, except for bounded regular
mise local configs saved for recovery. Track any other files you need to retain.

### Missions

Use a mission when one goal needs several chats. Its shared brief and decisions give agents a common
starting point, while tasks record ownership, dependencies and progress. You can coordinate the work
yourself or use a coordinator chat, and review linked pull requests and artifacts in one place.

Open tasks linked to a Linear issue become **Delegated** when someone else
is assigned in Linear. Returning the issue to you restores the previous status; unassignment changes
nothing. A manual status change wins until the assignment changes again. Delegated work is not done
and cannot start or satisfy dependencies. Existing chats keep running, and the coordinator is notified.
This uses read-only linked-issue checks on the Linear polling cadence, not writes to Linear.

The coordinator can start one chat on several tasks with `start` and `ids` (IDs, numbers or ranges).
Admission claims all tasks or none, ordering dependencies first and preserving the given order for ties.
Dependencies outside the selection must be done. Each task gets its own PR, based on the preceding PR's
head and linked as a stack. Supplied artifacts and links attach to every selected task. The whole opening
prompt, including all task bodies, instructions and references, must fit 4,000 characters; oversized
starts are rejected with the size, without truncation. The app's task Start chat action remains single-task.

Decisions have an audience: **All chats**, **Coordinator only**, or **Reference** (the default).
Choose it when recording or editing a decision, or change it from the row's context menu.
Decisions have stable numbers (D1, D2, …). The coordinator can propose edits or removals for the user
to accept, edit and accept, or reject. Until accepted, the original decision stays binding.
Reference decisions are available on request; pinning a decision to a task includes it in that task's chat.

Only the coordinating chat sees subscription windows in its status and start tool results: percent
used and reset time per provider, with readings over two minutes old marked stale and missing data
marked unknown. Reads use the daemon's shared cache without waiting for providers. Worker tool results
contain no subscription usage, and no account, billing or cost details are exposed.

Coordinator updates wait while member chats are working or have running background jobs. An idle chat
with jobs is reported as waiting, not finished. Updates settle for 30 seconds after activity stops,
with a 30-minute safety cap measured from the oldest pending event or a job's start, whichever is
earlier. A capped update names still-running jobs and their elapsed time. Pending updates are durable;
running job processes belong to their live worker and do not survive orderly shutdown or replacement.
A job still running after one hour moves its chat to **Needs you**, with its name and elapsed time.
This fixed threshold is user-only attention, including inside missions: it never wakes a coordinator
and clears when the job ends or is stopped.
With the durable jobs extension, handles and logs remain available on resume. Unfinished records after
a crash are marked `interrupted`, never automatically rerun; subprocesses may remain alive.

Merges and unmerged closures of owned chat PRs also queue updates, even after the chat finishes.
Merge updates include completed tasks, newly unblocked dependents and known open stacked PRs.
Reference-only PR links do not trigger these updates, and refreshes or restarts do not repeat them.
Eligible member chats refresh to a fresh empty change on current main just before their next idle input,
not after every merge while idle. One project watcher reuses the existing PR-refresh scheduler (including
projects with only settled PRs), coalesces refresh bursts, and stops when no active chats remain. Base
consumers share the same main-moved event and fetch, rather than polling per chat.
Busy chats, dirty workspaces, open PRs, selected non-main bases and unpushed bookmarks stay in place.
Routine refreshes do not add timeline messages or wake idle chats. The coordinator is excluded.

Coordinating chats read one shared, read-only main checkout per project, updated by that same watcher.
They have no task bookmark, PR ownership or Changes pane, and delegate code changes and verification
to member chats. Their kernels and subprocesses cannot write to the source view. Tools start in a
per-chat scratch folder (also TMPDIR), retained across turns and removed on archive. Promoting a chat
unbinds its PRs and explains that they can be bound to a member chat. Demotion restores its isolated
workspace, but does not rebind those PRs automatically.

![A mission task list grouped by phase, with linked chats, pull requests and progress](docs/screenshots/readme-mission.png)

### Artifacts and integrations

Artifacts open in an isolated, offline WebKit viewer. HTML and React previews can use bundled libraries
such as Mermaid, ECharts and Motion, with D3 and Three.js available on request. Published revisions are
retained: a chat card opens the revision sent there, while the sidebar opens the latest version.
SwiftUI artifacts are static renders, not live app views.

Pilot bundles a pinned subset of [pi-extensions](https://github.com/babariviere/pi-extensions): sandbox,
patch editing, web, browser, subscription usage, background jobs and persistent subagents.
No separate extension installation is needed. Children inherit sandbox, patch, web and browser,
but cannot launch jobs or recursive subagents. Browser and web services still need their own prerequisites
and credentials. Secrets, router and Clef remain optional personal extensions; terminal-only UI,
workspace automation, PR automation and night mode are not bundled.

Pilot owns the `todo` tool. Each Build chat has one durable list in its Harness SQLite storage, shared
with its subagents even when they use another working directory. Todos survive restarts, workspace
reclamation and restore, and remain shared across chat attempts. Claim/release assigns work to the
parent or an individual child agent, not to a workspace. Closing (`done` or `closed`, case-insensitive)
clears the assignment; every other status counts as unclosed. Progress updates are committed events,
not filesystem polling. The daemon receives an unclosed count without reading todo bodies.
Child assignments identify an agent instance; after child-worker replacement, use `force` to reclaim
or release an old assignment. Assignments are advisory and never prevent updates or closing work.

Lists hold at most 256 items, each with up to 64 KiB of Markdown, and at most 1 MiB in total. Writes
over these limits fail without losing existing items; delete obsolete items to make room. Historical
todo document versions are not retained. Existing `.pi/todos` files and `PI_TODO_PATH` are ignored,
never imported or changed, and ignored legacy files are no longer specially saved during reclamation.

Build sessions also load personal pi configuration from `~/.pi/agent`. Bundled capabilities take
precedence over duplicate package entries before those copies execute; unrelated extensions remain
available. Ask loads only its restricted tools and bundled web, never personal/project extension
factories. [pi-anthropic-auth](https://github.com/gotgenes/pi-anthropic-auth) is required in Build, Ask,
child workers and daemon model calls, without modifying personal settings.

Linear and Slack tracking use the configured
pi MCP servers named `linear` and `slack` and their existing OAuth sign-in, not separate Pilot API tokens.
Configure sources in project settings. Tracking is not a blanket promise of autonomous fixes or replies.
Confirming Start chat or Start mission moves an eligible Linear ticket to In progress, or adds an `eyes`
reaction to a Slack thread's parent message as you. The Slack reaction is attempted once per item,
counts an existing reaction as success, and is never removed automatically. Failures never block the
work and appear quietly on the item. These are the only tracking writes, never Slack messages or replies.
Pilot stores a classifier summary for each Slack message, not its text; the triage inspector reads and quotes the
message from Slack when you select it, without saving it.
Project labels can do nothing, hide messages from the Inbox, or close them locally. Close labels never replace a
status you chose. Show hidden in Slack triage includes label-closed messages; reopening one teaches the classifier.
Slack items become Done locally when every PR of a linked chat has merged, or a linked mission completes.
The row explains why, for example “Done · PR #42 merged”. Closed unmerged PRs change nothing. Already Done or
Dismissed items stay untouched, startup PR baselines do not close old items, and reopening is never undone by
the same merge or completion.
During normal Slack refreshes, up to eight Open/In progress parents are checked for a ✅ reaction, sharing the
daily Slack budget. A ✅ from anyone marks the item Done with “Done · ✅ in Slack”. Reopening keeps it open while
that reaction remains present, even if its count changes. Removing it and adding it again is a new reaction.
When an item with a successful eyes reaction becomes Done (manually, from a merge, or from Slack), Pilot adds ✅
once. Already reacted counts as success; failures show a quiet row error without changing Done. Reopening never
writes reactions. The dedicated Slack server has no remove-reaction tool, so eyes stays in place. No alternate
API, messages or replies are used.
Slack messages and Linear issue or project links open in their desktop apps when installed, with a
browser fallback when the app is unavailable. Copied links remain web URLs.
Slack links without a workspace ID use Slack's active workspace.

## Development

### Build from source

Use **Node 24+**, the pnpm version pinned in `package.json`, and **Swift 6.2+** on macOS. Xcode Command Line
Tools are sufficient with a compatible SDK. On SDKs where SwiftUI's `@State` requires an Xcode-only macro
plugin, the build scripts select an older installed SDK; install full Xcode if none is available.

```sh
git clone https://github.com/babariviere/pilot.git
cd pilot
pnpm install
pnpm app:macos
open apps/macos/build/Pilot.app
```

The development app uses the checkout and local Node runtime. To run only the daemon in the foreground:

```sh
pnpm dev:daemon
```

Don't start a second daemon on the same port as the app-managed one. Use a separate `PILOT_HOME` and
`PILOT_PORT` for isolated development state.

### Checks

```sh
pnpm fmt:check
pnpm typecheck
pnpm test:fast                    # quick unit and offline feedback
pnpm test                         # full gate, including integration and stress tests
apps/macos/scripts/test.sh        # Swift tests
apps/macos/scripts/build.sh       # native app build
```

See [testing](docs/testing.md) for suite selection and offline fixtures, and the
[CPU/memory](docs/performance-check.md) and [I/O](docs/io-performance-check.md) audits for measurement methods.
For agent-side artifact preview screenshots, install the optional renderer with `pnpm artifacts:browser`.
Publication still works without it.

### Dependency updates

[`renovate.json`](renovate.json) configures reviewed update PRs for pnpm dependencies, including required
Anthropic auth. Pi SDK packages and workspace overrides update together; `pi-extensions` tracks upstream
`main` while remaining pinned to a full commit SHA. Its updates are paused until upstream `main` includes
Pilot's embedding exports; the current pin stays on the compatible embedding commit. The native npm
manager refreshes `pnpm-lock.yaml` with dependency updates, and Renovate reports artifact generation
success or failure on every update PR.
Automerge is disabled. Renovate PRs also check an isolated production runtime before and after ZIP
relocation in the Node CI job. Review those checks and the existing tests before merging.

Renovate runs through the [Renovate GitHub App](https://github.com/apps/renovate). Re-enable the
`pi-extensions` package rule only after upstream `main` includes Pilot's embedding exports and the
production runtime checks pass.

### Architecture

```text
Pilot.app (SwiftUI + libghostty)
    │ HTTP / WebSocket on loopback
    ▼
pilotd (per-user launchd agent)
    │ fork + IPC, one worker per session
    ▼
Kernel worker
    ├── pi-durable Harness: SQLite history, tasks and model loop
    └── native pi SDK: tools, prompts, extensions and provider authentication
```

| Path | Responsibility |
| --- | --- |
| [`apps/macos`](apps/macos) | Native app, terminal, artifact viewer and `PilotCore` protocol mirror |
| [`packages/daemon`](packages/daemon) | HTTP/WebSocket API, sessions, workspaces and worker supervision |
| [`packages/kernel`](packages/kernel) | Durable agent worker and native pi SDK integration |
| [`packages/protocol`](packages/protocol) | Shared client/daemon types |
| [`packages/artifacts`](packages/artifacts) | Artifact storage, preview rendering and bundled libraries |

The Harness owns history and the model loop. The native SDK supplies tools and extensions, not a second
model loop. Keep protocol changes in sync with `apps/macos/Sources/PilotCore`.

### Configuration and boundaries

| Variable | Default | Purpose |
| --- | --- | --- |
| `PILOT_HOME` | `~/.local/share/pilot` (or `$XDG_DATA_HOME/pilot`) | Local session data and managed repositories |
| `PILOT_PORT` | `4319` | Daemon port |
| `PILOT_AGENT_DIR` | pi's agent directory | Pi settings, packages and authentication |
| `PILOT_WORKSPACE_RETENTION_DAYS` | `1` | Archived workspace cleanup delay; `0` disables cleanup |
| `PILOT_PERF_TIMINGS` | enabled | Set to `0` to disable local, content-free request timing logs for new workers |

These are daemon environment variables. The app-managed daemon runs under launchd; exporting a variable
in your terminal does not change an already running daemon.

Heavy repository checks also use `PILOT_HOME`: Python 3 coordinates one Swift build/test and two Node
suite runs across checkouts. See [shared verification slots](docs/testing.md#shared-heavy-verification-slots)
for machine-wide limits and queue diagnostics.

[Local request timings](docs/request-timings.md) separate preparation, provider waiting and streaming.
They stay outside the transcript, have bounded private storage, and are never exported.

- **Keep the daemon local.** It binds to `127.0.0.1`, rejects requests with an `Origin` header and has no
  authentication. Do not expose it to a network.
- **Durability is not tool replay.** If a native tool is interrupted by a crash, it is reported as
  interrupted rather than automatically rerun. After an unexpected kernel exit, interrupted chats reopen
  automatically with crash backoff. A slow but connected kernel is not treated as dead.
- **Extensions must fit the host.** Extensions that replace the SDK session or start their own model loop
  are unsupported. Subagent controls require a pi-extensions version with the `subagents:*` host events.
- **Project trust still applies.** Project-local `.pi` resources load only for directories pi trusts
  (or when `defaultProjectTrust` is set to `always`).
