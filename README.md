# Pilot

**Background coding agents. A native macOS app. You stay in control.**

Pilot runs [pi](https://github.com/earendil-works/pi) agents in the background, with durable chats and
isolated Build workspaces. Start a task, steer it when needed, and review the result as a
code diff, pull request or artifact. Agents keep working when you close the app.

Pilot is local-first. It uses your existing pi models, authentication and configuration, with a local
daemon managing sessions independently of the SwiftUI app.

Chat uses the SwiftUI transcript. The AppKit transcript transition has been reverted.

[Get started](#get-started) · [Working with Pilot](#working-with-pilot) · [Development](#development)

![A Build chat with grouped tool activity, task progress and code changes side by side](docs/screenshots/readme-build.png)

*Screenshots are rendered from native views with demo data, not live conversations. Chat captures use a
stand-in window header; Build and mission captures are cropped to their working areas.
See [screenshot notes](docs/screenshots/README.md) to regenerate them.*

## What you can do

Critical code review is not available yet. The disabled [review foundation](docs/critical-review-foundation.md)
has separate storage, transport contracts and a synthetic-only committed-history capture seam;
it does not change chat-result read tracking or enable review entry points.

The native [Local usage dashboard](docs/usage-dashboard.md) is available in the sidebar, Go menu and command
palette. It shows observed Local token/cache usage and catalog estimates, not billing. Breakdowns show
chat/mission names and sort by cost, tokens, requests or duration. Composer usage is
unchanged; outstanding accounting memory and release verification is documented separately.

In Pilot Next, open a project's overview and choose **Memory…** to browse its
stored notes and summary ranges in a separate read-only window. Text remains
selectable; forgetting, editing and other memory writes are not offered.
Its case-sensitive literal filter searches only text loaded in the current range,
not unopened notes or the full project, and typing never issues reads.
See the [Local memory browser contract](apps/desktop/docs/project-memory.md).

Settings → **MCP connections** shows Local’s last reported global Pi MCP status,
with read-only details and explicit stale/unavailable states. Refresh only reads
the daemon report; check, sign-in and setup actions are not included. See the
[MCP observation contract](apps/desktop/docs/mcp-status.md).

- **Run several agents at once.** Follow progress across projects, send follow-ups, queue messages or stop
  a run. Every session has its own worker process.
- **Finish a mission explicitly in Pilot Next.** Mission detail offers **Mark done** when all remaining
  tasks are done (dropped tasks excluded, at least one done task required). Done or archived missions archive
  their coordinator after current work finishes. Archiving a coordinator archives its mission. Member chats
  and history stay intact. See [mission lifecycle](apps/desktop/docs/mission-lifecycle.md).
- **Choose pi’s scoped models.** Settings → Scoped models has a searchable multi-select and an All option.
  Save changes pi’s global model list on this Mac, with conflict detection and exact readback.
  Project overrides, sign-ins, default models and running chats are unchanged. Advanced literal patterns
  and unavailable models are preserved.
- **Save a failed chat's next model in Pilot Next.** Supported Local failed chats can save model/thinking
  preferences without retrying work or clearing the failure. Applying the choice requires a separate explicit
  recovery. Older daemons fail closed. See [the passive contract](apps/desktop/docs/failed-chat-model.md).
- **Work locally.** Chats, projects and setup run on this Mac. Remote devboxes are retired.
  Existing cached remote history and unsent drafts are retained without reconnecting or moving work.
  See [retained remote data](docs/devboxes.md).
- **See what needs you first.** Home shows how every project is doing. The Inbox is the one place to act: chats
  that need you (each with a short reason), pull requests ready to merge, and Linear and Slack items, across
  projects or filtered to one. Each project has an Overview that starts with what is next for it.
  Right-click a chat and choose **Go to project** to open its project's Overview. Chat menus also copy the
  authoritative session storage path or a canonical Pilot chat link as separate actions, including from cached
  archived and devbox rows when that metadata is available.
- **Jump anywhere from the keyboard.** ⌘K opens a command palette that leads with places: pages, Slack triage and
  the Linear queue, missions, tasks and projects, then a few recent chats. It searches chats, archived ones
  included (by title, branch, project or pull request number), pages, missions and tasks (`#25`), project scopes,
  Settings pages, every keyboard shortcut, Linear Inbox items,
  Slack reports in triage (by summary, channel or message text, newest first, resolved ones included), and actions
  such as new chat, pin, archive, stop, retry, opening the pull request on GitHub or **Merge PR…** for the open chat
  (also available after searching a PR number). Merging asks you to confirm the fresh PR head, target branch and a
  merge method allowed by the repository. GitHub enforces permissions and branch protection; Pilot never enables
  auto-merge or deletes the branch. Agents remain unable to merge. ⌘⇧M opens the merge confirmation for the open
  chat's latest open PR. ⌘⇧P opens the open chat's latest pull request (the newest open one, else the newest). Paste
  a Slack message link to find its report, or to add it to a project's Slack triage: Pilot reads and sorts the
  message, then opens triage on it. ⌘? (Command-Shift-/ on a US keyboard) opens the keyboard-shortcuts reference,
  also available from **Help → Keyboard Shortcuts** or by searching for shortcuts in ⌘K. ⌘← and ⌘→ go back
  and forward through visited chats and pages, restoring their sidebar scope.
  ⌘L focuses the composer (or the open question), including from the terminal or an artifact, and ⌘K's "Focus
  sidebar", "Focus page" and "Focus inspector" move focus to the other parts of the window. Plain letters are
  never taken as
  shortcuts, so typing, IME input and list type-select behave as in any Mac app. The **Go** menu and ⌘K reach
  Home, Inbox, the focused project's Overview, the current mission's Overview, Tasks or Brief, Archive, Slack
  triage and the Linear queue. Slack triage and the Linear queue open
  the board or queue of the project in view (or the only project tracking it); otherwise ⌘K lists one "Slack
  triage" or "Linear queue" per project ("Linear triage" finds it too). The Linear queue is the project's Linear
  list in Pilot, not the Linear app. Home, Overview, Inbox and Archive each have one keyboard list: a Go
  destination (or Escape from the composer) focuses it, arrows move the highlight, Return opens the row as a click
  would, and ⌘K lists the
  highlighted chat's actions under its name.
  ⌘[ and ⌘] go Back and Forward too, and lists return to the row you had highlighted.
  A highlighted chat keeps its grey selection. Other highlighted rows and messages show a faint grey fill only
  while you navigate with the keyboard; a click hides it and the next arrow brings it back.
  In a composer, ⌘K also finds its controls by name (model, thinking, Build/Ask, project, folder, base branch,
  workspace, send later, attach image from the clipboard); choosing one never sends the draft. ⌘. stops the open
  chat's agent while it works. Escape, after closing any picker or queued-message edit, leaves the composer for the
  page with the draft kept.
  Slash commands also open controls: `/model` (the palette's model choices, `/model opus` to filter), `/mode`
  (Build or Ask, before a chat starts), `/terminal`, `/changes`, `/artifacts` and `/help`. They run in the app,
  keep the rest of the draft, and are never sent, queued or scheduled. A session prompt or skill with the same name
  keeps it.
  In a chat, Escape from the composer moves into the transcript: arrows move between messages, Return folds or
  unfolds work and long
  messages, ⌘C copies a message, moving past the top loads earlier history, and Escape returns to the composer. A
  sent message's Edit button and context menu edit it. The inspector's Changes, Links, Artifacts and Agents lists
  and the running-jobs panel work the same way; closing the inspector returns focus to the composer.
  Terminal and artifact content keep every key (Escape, Tab, ⌃⇥, ⌃C, ⌃D, letters) except the reserved ⌘L, ⌘K
  and ⌘J. ⌘J closes the terminal back to the composer. In an artifact viewer, ⌘L leaves the page so its Close
  button and Escape work again.
  On a mission's Tasks tab, the list takes focus like other pages: Return opens the task's chat (or the start
  sheet), ⌥↑/⌥↓ reorders it within its phase, and ⌘K lists its title edit (Return saves, Escape cancels), status,
  phase, model, dependency and link actions. The highlighted row shows its status and actions menus without
  hovering. Chats and Artifacts tabs are keyboard lists too, and ⌘K reaches every mission tab.
  Settings opens with its sidebar focused: arrows move between pages and projects. ⌘K also opens any
  Settings page by name ("Energy settings", "Project settings"). Controls inside a page follow macOS: Tab reaches
  text fields, and toggles, pickers and buttons too when **Keyboard navigation** is on in System Settings.
  Keyboard focus never draws a blue outline; neutral row selections and text carets remain.
  The composer's task and subagent lists, "Send later: At a time…", Start chat or mission on Linear and Slack rows,
  and the selected Slack triage message's type, label, dismiss and start actions are all in ⌘K as well.
  Slack triage and Memory take the page's focus from the Go menu like other pages and keep their own keys
  (arrows and Return). Typing in their search fields never triggers those keys, and Escape in the memory search
  clears it, then returns to the tree.
- **Let the display rest while agents work.** Keep the Mac awake without keeping the display on.
  A 60-second grace period after work finishes lets completion notices start coordinator follow-ups.
  Optional closed-lid work requires power and Wi-Fi; without both, agents pause and resume on the next
  full wake with connectivity. Screen locking is left to macOS. See [agent-aware sleep](docs/agent-sleep.md) for
  authorization and interruption limits.
- **Answer questions quickly.** When an agent needs a decision, its question replaces the message box with
  suggested answers. Pick one with the number keys and Return, or reply in your own words. The chat shows as
  needing you until you answer. Automatic job, mission and agent inputs wait durably while the question is open,
  then run in arrival order after your reply. Stop keeps them held until you explicitly resume or send another message.
  `await tools.ask_user(...)` suspends the calling script and returns your answer in that same script. Stop or a
  script deadline cancels the wait. A worker replacement keeps the question, but never replays the interrupted
  script; your answer then starts a fresh turn. Safe update drains wait for an answer or cancellation, rather
  than interrupting a script's other effects. Database-access approvals keep their separate turn-ending flow.
- **Explore before implementing.** Ask chats can read code and produce artifacts without repository write
  access. Move the discussion into a separate Build chat when you're ready to make changes.
- **Review work in context.** Build chats include a diff inspector, a [libghostty](https://github.com/Lakr233/libghostty-spm)
  terminal in the session workspace, task progress and pull request status. Attach a pull request in Changes
  using its GitHub link or just its number (`123` or `#123`) in the project's GitHub repository.
  Chats open with recent messages; **Show earlier messages** reveals older pages without changing agent context.
- **Coordinate bigger goals.** Missions group chats around a shared brief, decisions, tasks, dependencies,
  artifacts and activity, with an optional coordinator agent. One logical mission list stays visible regardless
  of a chat's stored execution identity. Synced mission evidence retains its canonical identity; disconnected or
  replica-only summaries remain read-only until current details can be loaded from the mission's home.
  Coordinators track work through mission tasks, without a separate chat todo tool. Other chats retain their todos.
  New opted-in missions (`planningVersion: 1`) support coordinator-selected explorer, builder and reviewer
  responsibilities. Explorers reuse Ask's read-only source/search/web and session-local artifact tools;
  they report findings and propose planning changes, never write product code. Reviewer is metadata only.
  Existing missions are unchanged and are not adopted automatically. See [role admission](docs/mission-roles.md).
  Pilot Next's mission **Review** tab can browse already retained worker comparisons with exact layer/stack
  revisions, native unified/split diffs and retained source. New eligible mission builders save exact committed
  layers at worker checkpoints, separately from task acceptance. Opening Review never captures live work or
  submits approvals. Existing legacy work isn't enrolled or backfilled. See [native Review](docs/mission-native-review.md).
  Members deliver with one structured `mission complete` record (landed commit, checks with rationale,
  open issues), readable through `mission get` with the task ID. Members may self-claim two additional
  tasks over a chat lifetime, excluding starting assignments. Completion, release and deletion do not
  reset this allowance. Delivered members may claim follow-ups they create, but not unrelated work,
  and stay in the chat list until archived. A user can explicitly assign with
  `overrideRetirement: true`; new tasks normally start fresh chats. Legacy task records remain unchanged.
  Agent tool writes allow 1000 Unicode code points for decision text, 200 for task titles, 4000 for
  task bodies and 12000 for briefs (including whitespace). Oversize writes must be summarized with
  links to supporting material. Existing content stays readable; unrelated edits preserve legacy fields.
  Routine comments batch for 30 seconds, including when idle. ACK-only and explicitly informational
  comments do not wake the coordinator. Blockers, needs-you, failures and structured task delivery
  bypass settlement; coordinator self-writes never wake it. Notices retain durable retry identities.
- **Keep useful context.** Build agents can save lasting decisions, preferences and lessons in project
  memory for later chats, rather than task status or secrets. A note can replace an outdated one, and
  duplicates are refused. Background summaries use byte-validated submissions, never hard truncation;
  unsuccessful compaction retries without discarding source notes. Each project's Memory page shows the
  notes and their summaries as a searchable tree. Pi skills, prompt templates, packages and compatible
  extensions are available in Build sessions.
- **Get more than text back.** Agents can publish images, interactive HTML and React previews, diagrams,
  animated GLSL shaders and static SwiftUI renders. Artifacts stay attached to their chat and can be linked to
  missions and tasks.
  Pilot Next can preview supported inline images already stored in loaded Local conversations, with
  bounded decoding and explicit unsupported/over-limit states. This does not add attachment creation;
  see [stored conversation images](apps/desktop/docs/conversation-images.md).
- **Query your databases.** Give a project's chats read-only or read-write Postgres access per environment,
  granted up front or when you answer the agent's request. See [Databases](#databases).
- **Bring work into Pilot.** Track Linear issues and Slack messages from configured sources, triage Slack
  messages by type, label and severity, see what waits on you across projects in one Inbox, then start a chat or
  mission from an item. A chat started from a Slack message shows that message's status in its toolbar (and ⌘K),
  where you mark it In progress, Waiting or Done. Schedule work for later or for wake, online and time triggers.
- **Light or dark.** Pilot follows the macOS appearance; **Settings → Appearance** can pin light or dark.
  Home pairs dithered daytime clouds with a separate evening seascape in dark mode. Artifacts stay light documents
  in both.

## Get started

### Install a release

New releases contain the Rust GPUI desktop, with `Pilot-Next-macos-arm64.zip` for macOS 15+
and `Pilot-Next-linux-x64.zip` for Wayland Linux. See [Pilot Next](apps/desktop/README.md).
Pilot Next uses the native macOS menu bar for application, editing and navigation commands.
With a paged-history daemon, chats open on recent messages and load older history on scroll.
Find can explicitly load the full history. See [lazy Local history](apps/desktop/docs/lazy-history.md).
Pilot Next supports explicit [source-pinned UI iteration updates](apps/desktop/docs/ui-iteration.md),
preserving durable drafts and the running daemon, including externally managed connections.
The legacy Swift app is no longer built or published by CI. Its source and existing releases remain available.

For the last legacy Swift release, download `Pilot-arm64.zip` from
[v1.84.0](https://github.com/babariviere/pilot/releases/tag/v1.84.0),
unzip it and move `Pilot.app` to Applications.

- Released builds target **Apple Silicon Macs running macOS 14 or later**.
- Releases bundle Node and the daemon, so you don't need a source checkout or a separate Node installation.
- Set up a model provider in [pi](https://github.com/earendil-works/pi) first. Pilot uses your pi agent directory
  (normally `~/.pi/agent`), including provider authentication.
- **File → Import GitHub Project** clones onto this Mac and previews an editable destination under
  your Home directory before cloning. GitHub authorization and existing-checkout reuse require explicit approval.
- Install and authenticate [GitHub CLI](https://cli.github.com/) (`gh auth login`) if you want agents to create
  pull requests or Pilot to monitor them.
- The daemon authenticates Git with your host credentials and never prompts for them: a missing credential
  fails the workspace fetch with a plain message instead of asking for a username or password. It trusts the
  project's own tool configuration (`mise.toml`) inside the workspaces it manages, so the host tool manager can
  run the project's tools there without a separate trust step.
- Install [Jujutsu](https://jj-vcs.github.io/jj/) **0.46+** and **Git 2.42+** for shared, isolated jj workspaces.
  Git-only projects use private clones instead.

These personal builds are ad-hoc signed, not notarized. If macOS blocks the first launch, verify the
release source, then remove the download quarantine flag:

```sh
xattr -d com.apple.quarantine /Applications/Pilot.app
```

**System Settings → Privacy & Security → Open Anyway** also works.
[Release and update setup](apps/macos/UPDATES.md) explains signing, packaging and automatic updates.
Updates pause agents after active tool calls finish, update the app and daemon, then resume unfinished
chats and subagents automatically. They do not wait for entire conversations to finish.
Chats with working subagents stay Working, even when the parent has finished its current reply.
Pending child work also reopens automatically after a daemon restart or a sleep pause.

The experimental Rust desktop in `apps/desktop` also implements guarded bundled
Local startup for x86-64 Wayland Linux. Its [runtime contract and qualification
boundaries](apps/desktop/docs/linux-local-runtime.md) are separate from Swift and
from Linux installer, updater and native visual confinement qualification.
Pilot Next's initial packaged connection is read-only. After durable GUI startup,
macOS checks the verified managed daemon and upgrades an older runtime at safe tool
boundaries, without delaying the GUI app swap. Equal/newer runtimes stay running;
failures remain visible for recovery. First registration/login enablement is explicit;
launchd executes one verified runtime copy independently of GUI lifetime
(Linux retains its separate runtime). Separately confirmed [daemon upgrades](apps/desktop/docs/daemon-upgrades.md)
can replace a proven Swift launch agent while preserving its label, profile and PilotPower.
Active jobs or failed inspection defer the switch; GUI installation itself never pauses agents.
Drained, job-free subagents checkpoint and exit before the daemon switch, then resume their
unfinished work without replaying completed tools. Unknown child processes still block it.
macOS updates swap the GUI, then upgrade its managed daemon on the next startup.
Old runtime files and release allowlists are not prerequisites. The daemon keeps one
active runtime copy so a GUI swap cannot change files under running jobs. Only one
candidate is staged during replacement. One interrupted-update record and the exchanged
app remain until the new GUI and daemon are verified, then obsolete update files are
cleaned up instead of accumulating history.
An explicit [stopped legacy service migration](apps/desktop/docs/daemon-upgrades.md#stopped-legacy-service-migration)
can also select Next's runtime when the old Swift app is gone, without moving chat data.
To install it on Linux, follow [Install Pilot Next on Linux](apps/desktop/docs/linux-install.md).

### Headless Linux runtime (development)

The daemon and session workers can also run without a Mac app on **Linux x86-64**, using Node 24+
and a native dependency install on that host (`pnpm install --frozen-lockfile`, then `pnpm start`).
Compatibility depends on the available runtime, shell and native module ABIs, not a distribution name
or OS release. Linux CI executes the selected PTY, SQLite and artifact compiler dependencies and a real
headless daemon/kernel smoke test. [Production Linux packaging](scripts/linux/README.md) provides a
signed manifest, private Node/jj runtime and an explicitly provisioned persistent systemd user service.
Linux packaging and headless runtime checks remain available for development. The macOS app no longer
provisions, connects to or updates remote daemons. Previously accepted remote work is not stopped or
migrated by retiring app support. See [retained remote data](docs/devboxes.md).

`GET /api/hello` returns a stable data-home `daemonId`, application `daemonVersion`, an independently
versioned protocol range (`minimumClientProtocolVersion` through `protocolVersion`, currently 1),
platform/architecture and explicit capabilities. Clients must pin the identity when pairing and verify
it, protocol compatibility and required capabilities before opening streams or sending mutations.
Changing the data home creates another identity; damaged identity files fail startup rather than silently
re-pairing. The unauthenticated API remains bound to `127.0.0.1` only.

Linux omits Mac energy/system-events helpers. Its agents and daemon-owned processes do not depend on a
client connection, and disconnecting a client does not stop them.
Pilot Next Linux GUI runtimes include a separate daemon-owned KDE Wayland power helper,
with the same 60-second idle grace. It requests automatic-suspend inhibition only, not display,
manual-sleep or lid blockers. Its behavior remains explicitly **unqualified on real KDE hardware**;
see [Linux power support and limits](docs/agent-sleep.md#linux-kde-wayland).
HTML, React and image artifact authoring remain available; SwiftUI rendering requires macOS.
Linux coordinators require a root-owned, non-setuid
`bubblewrap` installation (`dnf install bubblewrap`, or the equivalent package-manager command) and working
unprivileged user, mount, PID and IPC namespaces, including nested-user-namespace disabling. The daemon
executes real write/chmod and descendant checks before advertising `coordinatorIsolation`; each fresh
coordinator repeats its boundary checks before loading worker code. Tool presence alone is not support.
Run `node packages/daemon/src/linux-coordinator-probe.ts` under the actual service user's security policy
for actionable diagnostics. AppArmor, SELinux, seccomp or service restrictions can prohibit namespaces;
correct the narrowly scoped policy, not global host security. There is no unrestricted or chmod fallback.

The coordinator sees a read-only host filesystem, including repository aliases and symlink targets, with
only private session scratch, durable storage and artifacts writable. It cannot create
nested user namespaces, acquire capabilities or see host processes through `/proc`. Pre-existing hardlinks
or shared writable private-state roots, including pre-existing nested bind mounts, are rejected. Normal network access remains available for model
providers and integrations; this is process/filesystem isolation, not a network or credential trust boundary.
Authentication uses a same-host canonical credential broker, not per-session copies. Each live worker and
its descendants receive a revocable capability for a private Unix socket. Operations are bounded, fixed
Pi/MCP auth reads and serialized transactions, never arbitrary paths, executable configuration writes or
an HTTP proxy. SDK OAuth exchanges remain in the caller process and sandbox; current canonical credentials
are read under the shared auth lock and updates are atomically persisted. Login/logout generations fence
stale results. A durable uncertainty marker blocks replay after a failed exchange, lost worker or broker
restart until an explicit new sign-in or changed canonical credential resolves it. Unavailable brokerage
fails closed. Native parents, subagents, Ask, model catalogs, MCP status/tracking and connection sign-in
helpers use the same authority. Existing Pi file/refresh locks are honored; unrelated external programs
are not retrofitted with the broker's crash journal. Nothing copies credentials between hosts.

The [pre-chat setup API and host-qualified client helpers](docs/credential-setup.md) report independent
host readiness and run a trusted, bounded setup PTY without an existing chat or working model. Audited
Codex device and Anthropic manual-code login use that host's canonical broker. Other provider flows and
cross-host MCP browser callbacks are explicitly unsupported, not silently relayed or copied. These are
same-host integration APIs, not a remote setup workflow.

Read-only workers use the SDK settings-storage seam to read existing canonical configuration without
creating adjacent lock directories. Live writer locks, malformed, oversized or changing files fail closed;
configuration writes remain denied. Fixed trusted preloads install the same adapters before immutable
child SDK runtimes are constructed, after the Linux boundary has been validated.

Host-qualified references, durable operation receipts and legacy sharing records remain readable for
compatibility and data preservation. The live app has no remote setup, host picker, SSH reconnect,
automatic remote update or cross-host courier. The daemon does not enable sharing or remote Control
transport routes, recover delegated work, or import replicas into ordinary Local missions/memory.
Legacy execution ownership stays fenced, not released or reassigned. Technical documents describing
these retired transports are historical, not enabled product capabilities.

### Start your first chat

Control has been retired. Pilot no longer creates or runs a global coordinator chat, and there is no
replacement Project coordinator. Start work directly in a chat or use a mission for a scoped objective.

Existing Control conversations are archived once on their original host and remain readable from the
archive or a host-qualified link. Their transcript, queued input, memory, grants and audit are retained,
but the conversation cannot be restored or resumed. Legacy watches and follow-through are frozen,
without replay or background compaction. Ordinary chats already started by Control keep their admitted
permissions and continue independently; mission coordinators are unchanged.

Mission discovery uses the cached, read-only `GET /api/mission-catalog` endpoint.
Legacy Control databases remain on disk, but their runtime, tools, APIs and compaction are removed.

Mission coordinators default to bounded summary-tree memory, including safe adoption by existing
coordinators at normal compaction boundaries. Ordinary chats keep their existing compaction by default,
with experimental automatic handoff available in **Settings → Chats**. Internal
summaries use provider-matched Luna 6 or Haiku 5.5 only when authenticated and available; otherwise
existing compaction remains in place. Originals and `history_recall` are preserved. See
[coordinator memory](docs/coordinator-memory.md) for model identities, safety and evidence limits.

Build chats support local changes, verification, task-branch pushes and opening/updating PRs under
the normal project delivery policy, without a second publishing approval. Ask and Diagnostics remain
read-only. Credentials, remote access, branch protections and destructive-action safeguards still apply.
Agents never merge; merges require confirmation in the app.

Chat messages render Linear, Slack and GitHub URLs as compact links with the service mark and a short name.
Names come from Markdown labels or the URL, without fetching private pages. Bare `#123` references stay literal
so mission task numbers are never mistaken for GitHub issues. Copying preserves the original text and URLs.

1. Open Pilot and **Add Project** to select a local repository.
2. Create a chat, choose **Build** or **Ask**, select a model and describe the task.
3. Let the agent work. Send a follow-up to steer it, or stop it if the direction is wrong.
4. Review its response, artifacts and, for Build chats, the changes and pull request. You decide what to merge.

Chats keep a readable placeholder title until the first agent turn finishes, then generate a title from
bounded conversation excerpts. Manual renames always win, and later turns do not automatically retitle the chat.

The app installs `pilotd` as a per-user launchd agent. Closing or quitting Pilot does not stop running
agents. Chat history is stored locally using [pi-durable](https://www.npmjs.com/package/@earendil-works/pi-durable).

If a chat's worker fails to start, fix the reported configuration or extension dependency problem and
choose **Retry Startup** below the error. Pilot reloads the worker with the original queued messages,
keeping its history and workspace. Saved messages remain readable even while startup is failing.
Workspace preparation failures cannot use this action.
You can also archive a failed startup without discarding its queued messages. Restore it before retrying.
Saved subagent activity never hides these recovery controls. **Stop Chat** cancels failed recovery and its
subagents without signing in or restarting the worker, clears the failure, and keeps history and workspace files.
It stays stopped across viewing, sleep and daemon restart. Your next explicit message starts fresh work;
the previous run is cancelled before it can recover.

Pilot Next shows the selected chat's reported failure reason in a contextual header region,
with selectable multiline details and **Copy reason**. Missing detail says **No failure reason was reported**.
Historical and disconnected reports are labeled rather than presented as a new failure. This read-only
view does not retry or repair anything. See the [public failure-report contract](apps/desktop/docs/session-failure.md).

## Working with Pilot

### Home, Inbox and Overview

The sidebar starts with **Home**, the **Inbox** and the project selector. Home covers every project: a short
summary, subscription usage (with extra-usage spend when the provider reports it), projects (under their folders),
work in progress, missions and recent activity.
The new-chat project picker also offers **Home (~)** for chats in your home folder without a project.
Pilot remembers this choice for later chats, including after restarting. You can still choose a project or **Other Folder…**.
The Inbox carries the badge and lists, most urgent first, what **Needs you**, what is **Ready to merge**, and your
Linear and Slack items. Its toolbar filters it to one project. Use **Open on GitHub** in a project's Overview
actions menu or the ⌘K command palette to open its repository in your browser. Pilot resolves the repository
on demand using GitHub CLI on the project's host, so its remotes and GitHub CLI sign-in must be configured.
Focusing a project adds its **Overview**, which
leads with Up next, then work in progress, pull requests, missions, schedules, the current Linear cycle, Slack,
memory and recent chats. Project folders are managed from the project selector's menu.

Below, chats are grouped by urgency in every scope: Missions first, then **Pinned**, **Needs you**, **Ready to
merge**, **Working** and **Recent**. Every Needs you row says why ("Failed: …", "Asks: …", "Long job: …",
"Limit reached · resumes 18:00"). It clears itself: a read result leaves once you leave its chat, failures stay
until retried and questions until answered. Lists show the PR, branch and reason, not diff counts.
Idle Build chats with known workspace changes but no pull request stay in **Needs you** with **No PR created**,
even after reading them. Creating or attaching a PR, or removing the changes, clears that reason. Pushing alone does not.

A chat whose agent is idle while its background jobs run stays **Working**, with a quieter animation. Its working
line ("Waiting on 2 jobs…") opens a panel of running jobs with Stop on each. A job still running after an hour
moves the chat to Needs you.

In a chat, each turn's thinking and tool calls fold into one line ("Worked for 3 min · read 3 files, ran 2
commands"). Automatic items (pushes and pull requests, job results, subagent answers, mission updates, compaction
and stops) appear as one-line events where they happened, expanding on **Show**.
Legacy Control deliveries and current coordinator deliveries are system events, not user turns. New coordinator deliveries include the
sending chat's identity. Authorship comes from saved delivery provenance, never from words such as "From the
Global coordinator". Old entries without that provenance are left unchanged. Agents use the supported send
tools, not the user-message HTTP endpoint; unsupported cross-mission sends must be reported rather than sent as you.

The **Agents** tab opens each subagent's live transcript, with its model and thinking level visible beneath
the header. Unreported thinking levels are labelled as such rather than inferred from the parent chat.

Pilot Next's contextual **Queued (n)** header opens a separate retained popup for
queued user messages. Save preserves the original delivery mode unless explicitly
changed; Remove asks for confirmation. Safe editing requires a daemon advertising
captured-row queue guards. Missing/changed messages never become new sends, and
uncertain writes cannot be retried automatically. Structured/image-bearing messages
remain intact and cannot be edited as text. See [queued messages](apps/desktop/docs/queued-messages.md).

Pilot Next's **Changes** inspector can open a row's current workspace file in a
bounded, read-only native detail. Refresh is explicit; capped previews offer
**Copy shown portion**, not whole-file copy. Binary/unsupported files and server
refusals remain explicit, with no filesystem fallback. See the
[file viewer contract](apps/desktop/docs/session-file-view.md).

### Stopping and system messages

Stop ends the current run and returns your undelivered queued messages to the composer. System messages
from background jobs, PR follow-ups and other chats stay held, without restarting the chat. Use **Send now**
to start one run with them, **Discard** to remove all or an individual held message, or send your next
message to carry them along. Waiting system messages are read-only.
Stop also works during a sleep pause. Cancellation is saved without waking other chats and drains
before the paused run can recover at the next eligible wake.

Paused chats show a quiet line inside the conversation explaining the hold: sleep, lost connectivity
or a usage limit. The line replaces the working indicator and clears when work resumes.

If internet connectivity is lost, chats show **Paused offline** rather than exhausting model retries
into a failure, and resume automatically when connectivity returns, even with the app closed. Pilot
pauses only on evidence: macOS reports no network for a few seconds, or a model request fails with a
network error and a check fails too. The check tries independent public hosts and the provider's own
server, so a network that blocks the public hosts is still seen as online. A failed check alone never pauses
chats, a stream still receiving data keeps running, and a stream that goes silent triggers a check.
Chats resume when the network returns, a check passes, or any chat receives model data. Pilot sends
no periodic checks while things work.
Queued messages and unfinished requests survive restarts. Running native tools finish their current
round, including every nested call in an active codemode script. The chat stays working until the call
finishes; tools are never killed or replayed for an outage. Sleep, update, subscription and manual Stop
holds remain independent. Authentication, quota and provider errors are not treated as offline.

### Subscription limits

Chats pause new model requests and tool calls at **99%** of any subscription window. Active tools finish
safely, including nested calls in an active codemode script, before the chat shows as paused. Subagents
respect their own provider's limits, even when it differs from the parent chat.
Work resumes automatically when the blocked windows reset or a fresh usage reading drops below 99%.
Known pauses survive restarts and unavailable readings. Usage comes from pi's shared cache, without
additional provider polling; unknown usage cannot predict a limit, and in-flight requests may still use tokens.

Pilot Next labels a usage-held chat **Paused**, with **Usage limit reached** in its details.
It stays unfinished, outside finished-member folding and automatic archiving. Manual archive and Stop
remain available where ordinarily allowed; a pending question still takes Needs you precedence.

In Pilot Next, **Refresh limits** on Home or Usage explicitly asks Local to refresh Claude and Codex
subscription reports, without starting an agent or reading credentials in the GUI. It uses canonical Pi
OAuth only and shares Pi's one-minute usage cache, request lock and provider backoff. A cache hit keeps
its original report time; unavailable or failed refreshes retain the last report. Account identity is
not reported by the current cache. **Refresh history** is separate and only rereads retained token totals.
There is no new automatic provider polling. The legacy Swift app still displays forwarded cached reports.

If the provider reports a subscription usage limit before the cache catches up, the pending model request
pauses instead of failing the chat. Completed tool results stay saved and are never replayed. The pause
uses a known reset time when available; otherwise it waits for a fresh lower reading or **Force work**.
Transient rate limits, authentication and billing errors retain their normal error/retry behavior.

Beside the usage warning, **Force work** lets that chat and its subagents continue past the current
limit, including windows that cross or move later. The override ends once all of the chat's windows reset or
clear, or when the provider itself rejects a request. **Pause at limit** restores the guard early.

**Settings → Chats → Automatic handoff (experimental)** replaces automatic compaction in ordinary chats
with a fresh model context. It is off by default. When on, Pilot prepares a tool-free handoff using the chat's
current model at the next safe model-request boundary above 100k context tokens or 70% of the model's
window, whichever is lower (small windows reserve additional room). It saves the handoff before replacing
processed history. Unconsumed inputs and unseen tool-image rounds keep their original entries. The conversation,
workspace, full history, artifacts and mission membership stay the same;
mission coordinators keep their OptChat-inspired memory. A handoff already underway may finish after you turn
the setting off. An invalid or interrupted handoff preserves the original context and reports a failure instead
of silently falling back or replaying an uncertain request. See [automatic handoff](docs/auto-handoff.md).

With automatic handoff off, when you message a long chat (context at 40% of the window or 100k tokens,
whichever is lower) after the provider's prompt cache has expired (5 minutes for Anthropic, 10 for OpenAI,
longer with
`PI_CACHE_RETENTION=long`), Pilot compacts it first and your message waits behind the summary. Every model
request in the turn then reads the short summary instead of rereading the whole history at full price.
A warm cache is never discarded, and automatic messages don't trigger it.

With `PILOT_DETERMINISTIC_COMPACTION=1` set for pilotd (opt-in until validated with real providers), ordinary
chats also compact during a turn, at any model request boundary (including between tool calls),
once total input passes 100k tokens, or earlier when a smaller model window needs the room. Compaction
is deterministic and makes no model call: Pilot keeps about 20k tokens of recent context verbatim and replaces
the rest with a digest of about 5k tokens, rebuilt each time from the original transcript. The digest keeps
the goal, near-verbatim directives and corrections (marking superseded ones), decisions, open questions,
changed files, commits, test results, unresolved failures and key tool output, each with its source entry.
If a digest would not shrink the context enough, Pilot keeps the context and waits for more growth. Manual
compaction with your own instructions still uses the model summary. Without the setting, ordinary chats keep the
Harness defaults and model summaries. Legacy Control files are left untouched.

Compaction never deletes the transcript. Ordinary chats have a `history_recall` tool that searches (ranked by
relevance, or newest first) and reads the chat's own earlier messages and tool output, including parts compacted
out of context. Results and digests are bounded, redacted, linked to their source entries and labeled as
untrusted quotes. Historical grants are never restated, and permissions and pending questions stay in Pilot's
own state. See [context compaction](docs/context-compaction.md) for the policy, safeguards, instrumentation and
the offline benchmark.

Changing an idle chat's model keeps its existing context when the provider stays the same. When a different
provider cannot use its compacted context, Pilot automatically creates a new conversation attempt from the
durable transcript, including messages hidden by compaction. It replays plain messages if they fit the new
window, otherwise builds a plain-text summary with the selected model. The previous attempt stays restorable
in the attempt menu. Workspace files are not reverted, and a failed rebuild leaves the previous attempt active.

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

Built-in shell tool calls have a 120-second execution deadline. Set `timeout` (seconds) explicitly
for intentionally longer commands, or use session-owned `jobs` for long-running work. A command
still running after 30 seconds reports elapsed time and its deadline; silence alone never cancels it.
Stop and deadlines use the SDK's process-group cleanup, and deadline expiry is recorded as `timeout`,
separately from an ordinary nonzero exit. Pilot does not automatically retry or replay a failed shell
call. These limits apply to the built-in shell tools, not custom extension shell implementations or jobs.
| Repository writes | No | Yes |
| Diff inspector and terminal | No | Yes |

Ask can inspect the current checkout, including local changes, without switching branches. An
origin-branch snapshot stays pinned for that chat. **Start a Build chat** carries the discussion into a
new implementation chat; it does not give the existing Ask chat write access.

Ask and Build include first-party `code_search`, `code_symbols`, `code_call_paths` and `code_impact` tools through Pi, including
codemode. They rank literal matches and find parsed TS/TSX/JS/JSX declaration candidates with source
spans, snippets and content hashes. Each query reads its own current workspace (including uncommitted
edits), or Ask's explicitly pinned snapshot. Other text is lexical-only; these are not semantic
reference or complete-impact queries. Call paths explore source-inferred lexical callers/callees, with explicit
resolution provenance and unknown dispatch/imports, never observed runtime stacks or impact proof.
Static impact batches up to eight exact callables through the same graph and returns deduplicated
possible callers with shortest source-edge witnesses. Opaque observed-content revision receipts fence
navigation without claiming an atomic live snapshot. General value/type references and other-language
relationships remain unsupported. Coverage, exclusions, failures and bounded pagination are reported, and edits
invalidate page cursors. No project activation, external CLI, runtime install or persistent index is
required. See [the exploration contract](docs/code-exploration.md) for limits and freshness guarantees.

![An Ask chat exploring durable session resume without repository write access](docs/screenshots/readme-ask.png)

### Workspaces and pull requests

Isolated Build workspaces keep file edits out of your own checkout. For jj projects, sessions use
separate working copies of a shared repository. **History and bookmarks are shared**, so agents must keep
rewrites and pushes scoped to their own task. Git-only projects use private clones. Direct-checkout mode
is also available, but edits there affect your checkout.

New opted-in mission builder workspaces also record internal durable jj creator attribution.
This does not adopt existing work. New eligible builder bindings also queue exact committed layers for
retained Review at quiescent worker checkpoints, without claiming checks, landing or acceptance.
See the [ledger contract](docs/jj-ownership.md) and [capture limits](docs/review-snapshots.md).

Project policy controls delivery. With **Require PR** enabled, agents deliver on a task branch for review.
Disabling it permits direct default-branch delivery. Pilot never auto-merges pull requests.

A Build chat picks up a branch only when its agent writes one: commits, describes or squashes, creates or moves
a bookmark or branch, or pushes. Checking out another branch just to look at it does not attach it. A pull
request shows in a chat only when its agent opened it with `gh pr create` or you attached it, never just
because it was opened from one of the chat's branches. When Pilot cannot confirm creation from the command's
result (for example, piped output or a PR link followed by a failing command), it attaches an open PR on the
chat's own branch only if GitHub created it within minutes of that command and no other chat owns it.
In Changes, **Detach from This Chat** stops tracking a branch that has no pull request; the branch itself
stays unchanged.

A chat with a ready-to-merge PR goes straight to **Ready to merge**, even if its result is not reviewed
or its chat is still open. Failures, unanswered questions and other actionable problems stay in **Needs you**.
Scheduling a follow-up message on such a chat takes it out of **Needs you** until the message is sent; cancelling the
schedule brings it back. A long job or an MCP sign-in still needs you.

Pilot monitors agent-owned PRs from isolated Build sessions for failed CI, unresolved review threads and
merge conflicts, including earlier PRs in a stack. It sends follow-up work only when the agent is idle
and no user messages are queued, and waits for running CI checks to finish so one follow-up carries the
complete results (a check still queued or running after an hour no longer holds it back). When a stacked
PR no longer contains its lower PR branch, eligible jj
workspaces try a safe, conflict-free restack, once per PR/base commit. A successful restack waits for
fresh CI without spending a follow-up attempt; new review feedback still goes to the agent once that CI finishes.
Advancing main (or another stack root base) does not trigger a rebase. Failed CI alone does not either.
Actual conflicts go to the agent, preserving stack boundaries and other sessions' work. After pushing
or rebasing, agents report and finish without waiting for remote CI. Pilot monitors fresh results;
agents must not start background jobs or polling loops to wait for CI. Long local verification checks
still run as background jobs.
An unresolved thread is reported only once per latest-comment version, even across restarts and user
messages. Declined or already-addressed feedback need not be resolved on GitHub to stop repeat prompts.
New threads, replies or edits to the latest comment can trigger another follow-up; CI and conflict
retries remain independent. Pilot does not resolve review threads automatically. After pushing a fix
for a review thread, the agent adds a +1 reaction to its latest comment, the only GitHub write it may make.
Unsafe or conflicting rebases go to the agent instead. Automatic follow-ups are limited to three per
session, with a five-minute cooldown; sending a user message resets the limit. A second or third follow-up is sent only
if the agent attempted a push (including a failed one) after the previous follow-up, or if new review feedback arrived;
without a push, it carries only that feedback. Results and blockers come back to Pilot,
not GitHub comments or reviews. Ask and direct-checkout sessions do not receive automatic PR follow-ups.
Owned PRs still blocked by conflicts, failing checks, unresolved review threads or a diverged stack after
three attempts, after a follow-up without a push attempt (or without an automatic follow-up route) appear in Needs you once the chat is idle and
the cooldown has ended. Fixing the problem clears the reason; sending a message resets the follow-up budget.

GitHub writes are attributed to the chat in its activity and, for mission members, in mission activity.
The audit records a sanitized operation, PR or branch target when available, time and exit status, not
tokens, request bodies or command output. It retains the latest 200 actions per chat and 1,000 GitHub
events per mission. Compound commands and background starts show an unknown per-command exit status
rather than an inferred success.

Archiving keeps the conversation, but not necessarily its working directory. Pilot deletes generated build and
dependency output (such as `node_modules` and Rust `target`) from an archived chat's workspace right away. After
the retention period, it can reclaim safe archived jj workspaces and restore them from a saved snapshot on resume.
Dependencies may need reinstalling after either. Once a day, while none of its chats is working, each shared
repository also runs `jj util gc`, which packs Git objects with `git gc`.
Separate Git-only main-view stores receive daily `git gc` too, without immediate pruning.
Archived build-output pruning is revisited daily, including recognized outputs under ignored parent
directories. Live work, terminals and viewers still block workspace cleanup. Unexpected extra checkouts
in archived session directories are reported as cleanup errors for review, not deleted automatically.
Ignored content does not block jj workspace reclamation and is discarded, except for bounded regular
mise local configs saved for recovery. Track any other files you need to retain.

Reproducible project environments (toolchains pinned with mise, a built-in Postgres database per chat workspace
on any host, copied local files such as `.env` and reviewed setup scripts, set up when a workspace is created or
restored) are a design proposal, not yet implemented: see
[project environment setup](docs/environment-setup.md).

### Automations

Personal automations around a chat's workspace and runs are a design proposal, not yet implemented. Each is a
trigger, conditions and an action, stored in Pilot's project settings (never in the repository) and run by the
daemon of the host that runs the chat:

- **Setup** runs your commands when a workspace is created and again after an archived workspace is restored.
  The first turn waits for it, up to 10 minutes. There is no teardown.
- **Checks** run lint or tests after a run that changed files, and send failures back to the agent.
- **Continue** asks the agent to keep going when the chat finishes with open todos.

Commands are bounded by timeouts and output caps, stop with **Stop** and archive, and wait during sleep and
update pauses. Messages to the agent follow the PR follow-up rules: idle only, at most three per chat until you
send a message, and only after the agent made progress. Results show as one-line events in the chat; failures
and exhausted attempts appear in **Needs you**. See [automations](docs/automations.md).

### Missions

Use a mission when one goal needs several chats. Its shared brief and decisions give agents a common
starting point, while tasks record ownership, dependencies and progress. You can coordinate the work
yourself or use a coordinator chat, and review linked pull requests and artifacts in one place.
The mission's Overview shows a compact progress bar for each phase, or one overall bar for work without phases.
The mission icon in any mission chat's toolbar opens the mission's Overview.
Going the other way, the compass button beside a mission's title opens its coordinator chat.
Coordinators can link to member chats in their replies. Click a chat's name to open it inside Pilot,
including archived chats, without starting or restoring them.
Archiving a mission also archives its coordinator chat. If the coordinator is still working, it finishes
first, including running children and background-job follow-ups. Other member chats are left unchanged.
Chat inspector panes open at a compact width, leaving the conversation most of the space. Drag the
divider to widen a terminal, diff or preview when needed.

The brief is the spec; tasks track progress and blockers; decisions record agreed choices.
Comments hold actionable discussion. Agents check existing discussions before posting and resolve
addressed comments after saving any lasting outcome. Unanswered questions stay open.

The API can opt a **new** mission into coordinator-owned planning with `planningVersion: 1` on
creation. Omission keeps legacy behavior; existing missions are never adopted automatically and
cannot change this field. In opted-in missions, the coordinator/user owns briefs, new decisions,
task definitions, dependencies, decision pins, assignments and completion. Existing recorded decisions
remain user-edit-only. Workers can report their own execution status, log findings/evidence, and
propose planning changes through comments. `in_review` still means PR review, not a generic submission
status. For no-PR work, workers log a handoff without inventing review state; the coordinator's `task`
action or the user's task PATCH can mark it done. This does not attest review, authorize a merge,
retire a worker or delete its workspace. PR merge/canceled-ticket observations no longer automatically
complete/drop these tasks.

Opted-in tasks may carry a coordinator-owned `assignment` with `version: 1`, `intent`, `scope` and
`criteria` (1–20 items). Writes replace the whole assignment with `expectedRevision` (0 when absent);
reads return its `revision`. Stale revisions and unsupported write versions fail. The task's existing
body remains planning text, while logs/comments retain execution reports. Agent task summaries carry
the assignment revision; `get` with a task ID returns its full assignment. Decision context still uses
existing audiences and explicit task pins. This foundation does not add brief/policy approval,
build admission, immutable evidence acceptance or a general context-revision engine.

Assignments can also carry an optional version-1 `classification`: separate effort, difficulty, risk,
uncertainty, scope, role intent and declared delivery kind. Only coordinator/user planning writes can
replace or clear it. Supply `expectedRevision` and `expectedDefinitionRevision` (the existing task
definition fence returned by task `get`, or 0 on creation). Changes invalidate revision-bound evidence.
Old clients omitting classification preserve it on unchanged intent/scope/criteria, otherwise clear it
to unknown. Legacy absence stays unknown. Expanded scope calls for rescoping, not permission to expand;
role labels grant no capabilities, and research is not proof of code-free work.

Host-only model advice reuses the current task-start catalog (scope, authentication and price cap).
It explains Balanced review baselines and model needs using attributed per-call suitability assessments,
not fixed model mappings. Provider observations have provenance and expiry; catalog membership or usage
does not prove availability. User/task preferences never silently fall back or establish suitability.
Unknown effort alone does not raise scrutiny. Review/check gates never weaken for a weaker or unavailable
model. This foundation does not write preferences, change chats, start workers or activate delivery.

Planning authorization uses the session identity bound by worker IPC, never an actor supplied in tool
arguments. The loopback REST API remains the existing trusted user/daemon path, not an authenticated
agent surface. This is not isolation against a full-access shell calling local REST or modifying local
storage; app authentication/capabilities need a separate design before making that security claim.
Read limits remain unchanged, including legacy content and unknown stored planning versions. Unknown
versions are inspectable but cannot be mutated through supported planning writes.

Task status icons fill clockwise from the top: empty for To do, one third for In progress and two thirds
for In review. Task status menus list the statuses as plain text.

Tasks can belong to ordered phases, each with a name and optional goal. The Tasks tab groups tasks by
phase, folds finished phases, and lets you add, edit, reorder and delete phases. Drag tasks to reorder them
or move them between phases, and edit a task's dependencies from its menu.
The Overview shows one progress bar per phase with the current phase highlighted, and the sidebar names
the current phase and its progress. The coordinator tool manages phases too. Existing milestone names
migrate automatically. Phases complete when every task is done or dropped, reopen with unfinished work,
and record those transitions in activity. Empty phases are complete. Optional phase gating (Edit Mission)
is off by default; enabling it holds claims and starts in later phases until earlier phases finish, and
those tasks say which phase they wait for. You can still assign or start them yourself, which overrides
the gate; chats cannot.

Linear links default to read-only references, including existing links. The resources API can explicitly
manage a mission-level ticket and associate task contributions (`linearRole`: `managed` or `contribution`).
Only one mission can manage a ticket. Detach contributions before removing their manager.
Existing references require an explicit role upgrade using PATCH;
the coordinator's `updateLink` action uses that same explicit upgrade. `link` can associate existing tasks
as references or contributions, and `split` creates up to 20 local contributing tasks for a managed ticket
in one transaction. Exact retries reuse those tasks; possible title matches need clarification rather
than duplicate work. No Linear sub-issues are created. Attached tickets notify the coordinator. Agents
receive bounded ticket links and can read up to 8,000 description characters on demand with `ticket`;
external ticket text is untrusted context, not instructions or authorization.
References never change task or Linear status, and
migration preserves tasks already marked Delegated.

The daemon synchronizes managed tickets from their contributing tasks: started work targets the team's
In progress mapping, all unfinished contributors in review targets In review, and all contributors Done
targets Merged, never Deployed. Empty sets, references and link removal alone never complete a ticket.
Dropped contributors block completion until explicitly excluded. Deployed, Canceled and Duplicated
tickets are preserved. Observed cancellation or duplication drops unfinished contributing tasks, except
tasks still needed by another active managed ticket; Done tasks and reference links stay unchanged.
Manual Linear changes, reopened tasks and edits to an observed contribution set pause synchronization
for review. Managed resources expose `linearSync` status and actionable errors; the user can pause or
resume with `POST /api/missions/:id/resources/:resourceId/linear-sync` and `{action:"pause"|"resume"}`.
Paused or failed managed tickets count in the mission's Needs you summary, with a short reason.
Resume accepts the reviewed task scope and fresh remote baseline, and retries failed synchronization.
Writes use verified immutable issue IDs and actual-team mappings, durable fenced intents, bounded
retries and fresh reads before updates. Linear has no conditional status update, so a simultaneous
external edit between the final read and write remains an unavoidable remote race.
An already-matching verified status is a successful no-op. Uncertain writes are reconciled before
retrying. Ticket reads request only supported Linear fields and verify the selected status against
the issue's actual team workflow. Failures retain a sanitized stage and category in `linearSync.failure`;
successful background discovery cannot clear a mission ticket's warning or backoff, nor can a read-only
PR check clear an outstanding failed status update.
Read-only mission diagnostics also include a bounded page of managed-ticket sync records, requested
targets, attempt counts and retry times. Last verified observation and last failure times are retained
separately from record updates; older records keep unknown times until a new reconciliation records them.
These diagnostics read persisted state only and never refresh Linear or replay a status update.

For linked task PRs, `prGuidance` gives current ticket-specific wording: earlier contributors use
`Related to`, while the final contributor uses `Closes` only after every other contributor is Done
and live safeguards permit it. Daemon checks flag unsafe PR/commit directives and risky branch links
locally without editing GitHub. [Linear PR safety](docs/linear-pr-safety.md) explains check bounds and
the independent integration automations, which may target a different state than Merged.

In the app, a mission's Overview lists the tickets it manages under **Linear tickets**. Each ticket shows
its progress ("1 of 3 tasks done · 1 dropped") with its contributing tasks nested under it, which other
managed tickets a shared task also counts toward, and tasks that only reference it ("Referenced by #7 ·
not counted"). One line reports Pilot's Linear updates: paused updates offer **Resume**, failed ones
**Retry**, and both also appear in Needs you. A dropped contributor keeps the ticket open until you choose
**Exclude**, which keeps it as a reference. **Add link** manages a mission-level Linear issue by default and
can count a task link toward a ticket the mission manages; link menus change roles explicitly (Manage
Delivery in This Mission, Count Toward Ticket, Stop Counting Toward Ticket).

Open tasks contributing to a managed Linear issue become **Delegated** when someone else
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
It opens a small sheet with optional instructions, model and thinking (defaulting to the task's preferred
model), Build or Ask mode, base branch, and artifact or link references, validated like the coordinator's start.

Creating a mission with a new coordinator, or starting a coordinator later, has no separate prompt-length
cap. Its planning instructions are delivered in full; the API's general request-size limit still applies.

A task can have a preferred model and thinking level, set from the task's menu in the Tasks tab or by the
coordinator. It uses the same scoped, price-capped model list as coordinator starts. New chats for the task
start on it unless a start picks another model; the coordinator cannot change or override a preference you set.

Pilot Next offers **Preferred model…** in a task's details. Its explicit Save requires a daemon with passive
task-preference support: only future-chat preferences change, without task reconciliation or agent starts.
Default thinking follows the model configuration at start time. Pending or uncertain saves remain retained
in that window and are never retried automatically; a later matching read is not a save receipt.
See the [task preference contract](apps/desktop/docs/task-model.md) for scope and safety details.

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
with jobs counts as working: it is not reported as finished, and its jobs never create an update or wake
the coordinator. Pending updates become eligible as soon as all members are idle, without an additional
settlement delay. A 30-minute safety cap is measured from the oldest pending event. The coordinator's own
jobs do not hold updates back. Delivery still waits for an available coordinator and respects rate limits.
Pending updates are durable; running job processes belong to their live worker and do not survive orderly
shutdown or replacement.
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
Their native `read`, `find`, `grep`, `ls` and code-exploration tools obtain current source scope from
the daemon on every direct or nested call. `source_roots` lists exact main-view, member-workspace and
scratch paths. Current same-project mission membership includes explicitly joined and delivered chats
whose workspaces still exist; leaving or moving the chat revokes fresh admissions. Historical task,
completion and retirement records alone grant nothing. Already-admitted finite reads may drain their
original scope, without renewing it. These bounded tools never execute project code. They reject
repository metadata, observed symlinks and hardlinked source files, and revalidate path/inode identity
around reads and listings. Search uses Ask's bounded glob/literal readers. These checks are not an
atomic descriptor-anchored filesystem walk: concurrent ancestor replacement, especially a directory
swapped during open and restored before revalidation, remains a known limitation. Do not infer hostile
filesystem-race or content-provenance isolation from the native path scope.
Scratch, known artifact skill files/pasted images and the installed Pi documentation/examples have
separate read handling. Native reads also admit the resource loader's currently selected skill entry
files and references inside each portable skill bundle, with loader-time alias anchors rechecked on
each call. Standalone Markdown skills grant only their exact entry file; broad home/configuration
containers never become skill-reference roots. These are read-only resources, not search, write or
process grants. Paths mentioned in skill prose or user messages (for example, an image in Downloads)
do not grant arbitrary external-file access. No session-directory or shared repository-object-store
grant is implied.

This native-tool scope is not arbitrary-process or hostile-extension isolation. Shells, background jobs,
subagents and trusted extension callbacks do not inherit a native source grant. Existing OS write
protections remain, but do not establish unrelated-source read isolation or atomic live-process
revocation. In particular, member Git/jj metadata points into a shared object store, and a pathname
sandbox alone cannot prevent a hardlink in a mutable allowed tree from exposing an unrelated file.
These are unresolved process-isolation limits, not permissions to bypass the native readers.

They have no task bookmark, PR ownership or Changes pane, and delegate code changes and verification
to member chats. Their kernels and subprocesses cannot write to the source view. Tools start in a
per-chat scratch folder (also TMPDIR), retained across turns and removed on archive. Promoting a chat
unbinds its PRs and explains that they can be bound to a member chat. Demotion restores its isolated
workspace, but does not rebind those PRs automatically.

![A mission task list grouped by phase, with linked chats, pull requests and progress](docs/screenshots/readme-mission.png)

### Artifacts and integrations

Native visual artifacts use the chat's fonts and appearance, grow to their full content height and scroll
with the conversation, without a nested scroll area. Charts, canvases and shaders retain their explicit heights.
Other artifacts open in an isolated, offline WebKit viewer. HTML and React previews can use bundled libraries
such as Mermaid, ECharts and Motion, with D3 and Three.js available on request. Published revisions are
retained: a chat card opens the revision sent there, while the sidebar opens the latest version.
Inline `artifact://<id>` links open the latest revision directly in the artifact popup, with an artifact
icon beside the label. They work across chats, including archived artifact owners.
SwiftUI artifacts are static renders, not live app views.
Shader artifacts are Shadertoy-style GLSL, checked when published and animated only while visible.

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

Pilot Next shows these public chat todos in a compact, read-only strip above the composer.
Its explicit disclosure keeps the current chat's assignment first, reports bounded/partial coverage,
and labels retained snapshots when unavailable. It never edits tasks or infers mission tasks from tools.
See [the native task-strip contract](apps/desktop/docs/session-todos.md).

Lists hold at most 256 items, each with up to 64 KiB of Markdown, and at most 1 MiB in total. Writes
over these limits fail without losing existing items; delete obsolete items to make room. Historical
todo document versions are not retained. Existing `.pi/todos` files and `PI_TODO_PATH` are ignored,
never imported or changed, and ignored legacy files are no longer specially saved during reclamation.

Build sessions also load personal pi configuration from `~/.pi/agent`. Bundled capabilities take
precedence over duplicate package entries before those copies execute; unrelated extensions remain
available. Ask loads only its restricted tools and bundled web, never personal/project extension
factories. [pi-anthropic-auth](https://github.com/gotgenes/pi-anthropic-auth) is required in Build, Ask,
child workers and daemon model calls, without modifying personal settings.

**Settings → Connections** shows this Mac’s global Pi MCP servers, with connection/sign-in/error
state and recheck/cancellation controls. pilotd checks at startup and when Pi’s MCP files change,
never on a timer. OAuth uses the existing browser flow. Chats pick up new credentials on their next
turn. Errors stay short; use `pi mcp list` for details. Bundled Pi and the app coordinate writes;
older Pi installations and text editors must not edit the configuration concurrently.
A chat whose tool call reached for a server that needs sign-in (or fails to connect) moves to **Needs
you** with that server named, and shows a one-line notice above its composer with the same action. It
clears once the server works again, you write in the chat, or you archive it.

Linear and Slack tracking use the configured
pi MCP servers named `linear` and `slack` and their existing OAuth sign-in, not separate Pilot API tokens.
Configure sources in project settings. Tracking is not a blanket promise of autonomous fixes or replies.
Slack triage has a Refresh button in its toolbar to sync new messages on demand. It is disabled while syncing.

Linear sub-issues appear under their parent in the Inbox, the Overview's current cycle and the full list,
with a collapsible "N sub-issues" count on the parent, one level deep. When the parent is not one of your
tracked issues, its identifier, title and link (read with `get_issue`, cached and bounded) head the group
as a read-only row. Starting work on a sub-issue quotes its parent's identifier and title.

Each Slack channel can optionally track only new messages that mention you, directly or through one of
your groups. Add your own group handles in Tracking settings because the dedicated Slack MCP does not
expose memberships. Mention-only channels read the same channel history as other channels and keep
top-level messages that mention you; a mention only in a thread reply is not found. Matching threads are
classified with their usual bounded thread context and label effects. Existing items are unchanged.
Channel history shows a group mention only by its ID, so Pilot learns each handle's ID once with one
search scoped to that channel, choosing the group mentioned most often in the results, and stores it.
A handle it cannot resolve is searched again at most once a day.

Project settings provides per-team Linear state mappings for Todo, In progress, In review, Merged,
Deployed, Canceled and Duplicated, including separate choices for sub-teams. Managed ticket contributions
also use In review and Merged; Deployed/Canceled/Duplicated guard terminal states, not outbound actions.
In progress must map to a started-category state. Its Automatic option selects the state named
In progress, never the first state in workflow order. Other mappings may use any workflow state.
Managed-ticket synchronization verifies Started states for In review, Completed for Merged/Deployed,
and the corresponding terminal categories for Canceled/Duplicated before acting; invalid choices surface
an error without blocking local work.
If a target is missing, ambiguous or no longer a started state, Pilot leaves the ticket unchanged and shows
a quiet error. Starting work still proceeds. Saved choices are rechecked against the issue's actual team.
Confirming Start chat or Start mission moves an eligible Linear ticket to that state, or adds an `eyes`
reaction to a Slack thread's parent message as you. The Slack reaction is attempted once per item,
counts an existing reaction as success, and can be removed on Done through the opt-in route below. Failures never
block the work and appear quietly on the item. Managed ticket status synchronization is described above.
Tracking never sends Slack messages or replies.
Linear size classification suggests Quick fix, Needs planning or Unknown from a bounded title and description.
It runs once per issue update, at most eight attempts per poll and 200 per UTC day across projects, with the
cheapest scoped model and no tools or thinking. Descriptions are transient; failed attempts remain Unknown
until the issue changes. User size corrections survive sync and feed the shared guide. This never auto-starts
work. Open Linear rows in the Inbox, the Overview's current cycle and the full list show Quick fix or Needs
planning as a chip, which also corrects the size (or use the row's Size menu). Needs planning rows make
Start mission the hover action, marked Suggested; others keep Start chat. Chats started from a sized ticket
are told its size and asked to suggest a mission, not start one, if the work needs planning.

Slack common cases group classifier summaries and corrections, never raw thread text. The shared grooming run
uses the newest 200 bugs within 30 days, preserves case IDs and memberships, and computes counts, severity mix,
majority label and trend locally. Trend compares the newest 15 days with the preceding 15 days. Empty cases
retire after 30 days without a report. Names, merge and split edits are local corrections, fenced against stale
model runs. The cases API exposes the window limit and truncation, and dashboard data includes the top three.
Up to 100 case identities are retained per project. The shared groomer admits at most one attempt per
source/project every five minutes, up to 48 per UTC day, folding at most 64 new corrections per run.
Slack triage's Common cases layout lists them by count, then recency. Selecting a case filters the table and
board to its messages; the inspector shows its severity mix and trend, starts a mission from the quoted case
summary (reviewed in the new-mission sheet, with its messages left unlinked), and renames, merges or splits it.
The project Overview shows the top three cases under Slack.

Triage keeps up to 500 corrections per project across sources. A debounced, tool-free worker folds three new
corrections (or a day with new corrections) into a short read-only guide. Classifiers use that guide and five
recent examples. Guides contain rules and summaries, not Slack excerpts. Tracking guide APIs support reading
and queuing a rebuild. Project settings show each source's guide read-only above its recent corrections (Slack under
Slack labels, Linear under Linear sizes once a team is attached), with when it was last updated and Rebuild, which
queues a run; the rules update in place once pilotd saves the new guide.

Pilot stores a classifier summary for each Slack message, and keeps up to 8,000 characters of its thread text in
the local tracking database for search only: the API never returns it. Messages stored before search existed
match by summary and channel. The triage inspector reads and quotes the message from Slack when you select it,
without saving it. Searching in Slack triage or ⌘K also matches thread text and pasted Slack links.
A message added from a link can come from any channel your Slack account can read. It is classified like a
polled one (a failed classification is retried; without one, it is added untyped, titled by its first line), and
stays listed, with its reactions, even when its channel is not tracked.
Project labels can do nothing, hide messages from the Inbox, or close them locally. Close labels never replace a
status you chose. Show hidden in Slack triage includes label-closed messages; reopening one teaches the classifier.
Slack items become Done locally when every PR of a linked chat has merged, or a linked mission completes.
The row explains why, for example “Done · PR #42 merged”. Closed unmerged PRs change nothing. Already Done or
Dismissed items stay untouched, startup PR baselines do not close old items, and reopening is never undone by
the same merge or completion.
Slack shares a local budget of 100 classifications and checks per UTC hour across projects.
Use **Force sync (ignore hourly budget)** in Slack triage's actions menu, or **Force sync** beside a budget pause,
to bypass it for one bounded refresh. Forced work still counts toward usage; normal polling stays limited,
and Slack's own rate limits, cached classifications and per-refresh batch limits still apply.

A Slack message can also be **Waiting**, when someone outside Pilot (a CSM, the reporter) has to answer first.
A chat attached to the message (started from it, or linked to it) sets it with its `slack_status` tool and a short
reason, shown as “Waiting · CSM to confirm the org ID”. Only attached chats have that tool, and it appears or goes
away as you link or unlink them. You can also pick Waiting yourself. Waiting messages stay out of the
Inbox. On Slack refreshes, Pilot reads each waiting thread for new replies at most every ten minutes, sharing the
hourly Slack budget. A reply from anyone but you resumes the message's latest chat with the new replies, quoted
as context, and moves the message back to In progress; without a chat to resume, the message reopens. Your own
replies, including ones an agent posts as you, never end a wait. The same tool marks the message **Done** once
the request is resolved, with a short outcome shown as “Done · answered in thread”. It only changes a chat's own
messages while they are In progress or Waiting: Open, Done and Dismissed stay yours, so only you reopen a message.
During normal Slack refreshes, up to eight Open, In progress or Waiting parents are checked for a ✅ reaction, each
at most once an hour, sharing the hourly Slack budget. A spent budget pauses only these checks.
A ✅ from anyone marks the item Done with “Done · ✅ in Slack”. Reopening keeps it open while
that reaction remains present, even if its count changes. Removing it and adding it again is a new reaction.
When an item with a successful eyes reaction becomes Done (manually, from a merge, or from Slack), Pilot adds ✅
once. Already reacted counts as success; failures show a quiet row error without changing Done. Reopening never
writes reactions. Adding ✅ always uses the dedicated Slack server. That server has no remove-reaction tool.
To opt in to removing only the eyes reaction Pilot successfully added, create a local
`~/.config/pilot/tracking.json` (or `$XDG_CONFIG_HOME/pilot/tracking.json`) with an explicit MCP route:

```json
{
  "slackEyesRemoval": {
    "server": {
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer ${SLACK_REACTION_API_KEY}" }
    },
    "tool": "remove_reaction",
    "identityTool": "auth_test",
    "dispatcher": { "tool": "dispatch", "nameKey": "name", "argumentsKey": "arguments" }
  }
}
```

Names and URL above are placeholders. Use the exact tool names from your server; omit `dispatcher` for a direct
tool. The daemon owns this MCP-over-HTTP connection entirely from `tracking.json`: it never reads or
registers a removal server in pi's `mcp.json`, and the tools do not appear in agent tool listings. Your existing
general-purpose MCP connections and their permissions are unchanged.
Use an API key scoped only to the removal tool and its authenticated identity read. HTTPS is required,
except for loopback development servers.
Supply the variable to the daemon process, or use a header beginning with `!command` to read the complete
`Bearer <key>` value from a local secret store (using pi's existing header expansion). Never put keys in project
settings, committed files or chat messages. Only an explicit Authorization header is accepted; no OAuth store
is used. A revoked or rejected key fails without opening a browser or falling back to OAuth or another server.
Tool-scoped keys enforce access on the server, rather than just hiding tools from a model.
Set `slackEyesRemoval.enabled` to `false` to leave a prepared route inactive until its key is available.
The inner tool must accept `{channel, ts, name}` (`name` is always `eyes`, without colons) and return JSON
`{ok: true}` on success, via MCP structured content or one JSON text block. The configured server must use the
same Slack user as the dedicated server: Slack only lets users remove their own reactions. `identityTool`
(namespaced or dispatched like `tool`) must accept `{}` and return `{ok: true, user_id: "U…"}` for the
credential making the removal. Pilot records the authenticated user and original parent when adding eyes,
then verifies that user on the removal connection before writing. It never supplies a user selector to the
removal tool, so other users' eyes stay untouched. Unknown legacy ownership or a different identity fails
closed, without attempting removal. A missing `identityTool` also fails closed.
This local file is read afresh for each new Done attempt, never from a repository or replicated project settings.
An exact structured Slack `no_reaction` response is an idempotent success (eyes already absent).
Missing/invalid config, disabled routes, unreachable/missing tools, authorization and identity failures do not
affect ✅ or local Done. Completion-add and eyes-removal outcomes are saved independently; cleanup failures
show a quiet row error with permission/identity guidance, even when ✅ succeeded. There is no automatic retry or
fallback to another server. Each item is attempted once, including across restarts; configuring a route does not
replay old Done items. No Slack messages or replies are sent.
Slack messages and Linear issue or project links open in their desktop apps when installed, with a
browser fallback when the app is unavailable. Copied links remain web URLs.
Slack links without a workspace ID use Slack's active workspace.

### Databases

Build chats of a project can query Postgres databases you configure for that project. Chats of other projects,
Ask chats and subagents do not get the tool. In **Project Settings → Databases**, add an environment and its
read connection, write connection, or both. Enter the connection URL (including any password) in the secure field,
then choose **Save Databases**. New connections default to **Ask each chat**; enabling writes or automatic access
requires an explicit choice. Existing URLs and credential query parameters are never returned to the app. Leave
the replacement URL empty to keep them. Existing environment names are fixed; remove and add to rename one.

These settings belong to this Mac and are not replicated to other machines. Reload after a hand edit or a
revision conflict. Invalid, unreadable, oversized,
duplicate-project or insecure files disable editing instead of being replaced; Pilot does not repair permissions
automatically. Saving preserves other projects and existing chat grants and does not connect to Postgres.

You can also create or hand-edit `~/.config/pilot/database.json` (or
`$XDG_CONFIG_HOME/pilot/database.json`), readable only by you (`chmod 600`; Pilot refuses a file others can read):

```json
{
  "projects": {
    "~/src/github.com/acme/app": {
      "environments": {
        "local": {
          "read": { "url": "postgres://app_ro@localhost/app", "access": "allow" },
          "write": { "url": "postgres://app@localhost/app", "access": "allow" }
        },
        "staging": {
          "read": { "url": "postgres://app_ro:****@staging.example.com/app", "access": "allow" },
          "write": { "url": "postgres://app:****@staging.example.com/app", "access": "ask" }
        },
        "prod": {
          "read": { "url": "postgres://app_ro:****@prod.example.com/app", "access": "ask" }
        }
      }
    }
  }
}
```

Projects are keyed by the folder you added to Pilot. Each environment has a read connection, a write
connection, or both; leave one out to make that mode unavailable. `access` is `allow` (granted on first use)
or `ask` (the default): the agent asks with a question naming the environment and mode, and its turn ends. Picking
**Allow … access** in the app grants it; the app sends that decision to pilotd directly, and pilotd tells the agent.
Messages never grant access, even ones with the same words: typing a reply instead declines. Grants last for the rest
of the chat, and write access also covers reads. The file is read afresh for each call; new or removed projects apply
to the next chat start.

Access approval is permission, not a successful connectivity test. Configure TLS in each connection URL, for
example `?sslmode=verify-full`. For a private CA or client certificate, hand-edit the connection's optional `ssl`
field: `"ssl": { "ca": "<PEM contents>", "cert": "<PEM contents>", "key": "<PEM contents>" }`.
Omit unused fields. `ssl: true` also enables verified TLS; `ssl: false` explicitly selects plaintext for endpoints
that permit it. Without this field, URL and driver environment defaults apply. Object certificate options override
URL certificate options while retaining other URL TLS settings, and explicit TLS always verifies the certificate
and server name. Conflicting URL/object TLS enablement fails before connecting, with no plaintext fallback.
The object does not accept `rejectUnauthorized: false`. Certificate contents stay on the daemon host and are
preserved, but never returned, by the settings editor. A connection failure leaves access grants unchanged;
check both TLS configuration and the server's authentication rules rather than weakening certificate validation.
Connection errors retain SQLSTATE and distinguish certificate/negotiation failures, invalid passwords and explicit
server authentication-rule rejection without exposing server details. An otherwise ambiguous `28000` rejection
does not establish a TLS or credential fault; only an explicit server requirement is reported as requiring TLS.

The agent calls `db({ action: "access" })` to list environments and request access, and
`db({ action: "query", env, sql, params })` to run one statement. Read mode runs inside `BEGIN READ ONLY` with the
extended protocol (one statement, no `COMMIT` escape) and is rolled back; in write mode, `statements` run in one
transaction. Every call opens its own connection with a 30 s statement timeout, a 5 s lock timeout,
`application_name=pilot-<chat id>`, and capped rows (100 by default, at most 1,000) and result size.
Results are sent to the model provider, so only configure data you are comfortable sharing with it.

Give read connections a role that can only read: `BEGIN READ ONLY` guards against mistakes, while the role is
what Postgres enforces. Only pilotd reads this file and the agent sees environment names, not URLs or request ids.
Agent shells still run as you and can reach pilotd's local API, so this is a guardrail for a cooperating agent, not
a secret store or a hard boundary. With the bundled sandbox in
`workspace-write` or `read-only` mode, add the file to `denyRead` in `~/.pi/agent/sandbox.json` to keep shells
from reading it; with the sandbox off (the default), they can.

On startup, Pilot moves the old `pilot-databases.json` and `pilot-tracking.json` from pi's agent directory
(`PILOT_AGENT_DIR` when set) to these new locations, keeping their contents and permissions. Existing destination
files are never replaced; if both locations contain a file, the new one wins and the old one stays untouched.
These Pilot settings no longer follow `PILOT_AGENT_DIR` or `PILOT_HOME`. Update any sandbox `denyRead` entries
that refer to the old paths.

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

### Debug project-memory compaction

Each project's memory directory under `$PILOT_HOME/memory/<project-id>/` retains
`compaction-latest.json` and, after a failure, `compaction-failure.json`. The default home is
`~/.local/share/pilot` (or `$XDG_DATA_HOME/pilot`). Inspect locally, for example:

```sh
python3 -m json.tool "$HOME/.local/share/pilot/memory/PROJECT_ID/compaction-failure.json"
```

These owner-only files contain **private memory text**: the source prompt, up to three model requests
and responses (text and tool submissions, not reasoning), validation errors and exact UTF-8 byte counts,
model, timing, and outcome. Do not share them unredacted. Each file is capped at 128 KiB; clipped
diagnostic fields explicitly report `truncated` and their original byte count. A subsequent success
does not overwrite the last failed run. General daemon logs do not contain these payloads.
Requests are recorded before contacting the model, so a failed or stalled call is inspectable even
without a response. Each attempt records its start and, when available, finish time.
An interrupted process may leave the latest record marked `running`; completed failures use the
existing automatic retry/backoff. Deleting these diagnostic files does not delete project memory.

### Checks

```sh
pnpm fmt:check
pnpm typecheck
pnpm test:fast                    # quick unit and offline feedback
pnpm test                         # full gate, including integration and stress tests
apps/macos/scripts/lint.sh        # pinned SwiftLint correctness checks, no build needed
apps/macos/scripts/test.sh        # Swift tests
apps/macos/scripts/build.sh       # native app build
```

CI runs portable Node tests and typechecking on Linux, with a smaller macOS lane for native behavior
and packaging, on PRs (`pr.yaml`) and after merging (`main.yaml`). Tests never block a release:
`release.yaml` runs Release Please on every main push and, for a new stable draft, builds the macOS ZIP
and the macOS/Linux Rust GUI packages from the release tag, then signs and publishes those same artifacts.
Rust GUI signing/trust and native full-payload qualification are explicit publication prerequisites;
future releases no longer publish a standalone headless Linux runtime. Swift distribution is preserved.
See [Rust GUI releases](apps/desktop/docs/releases.md) for the required configuration and remaining gates.

See the [reliability roadmap](docs/reliability/roadmap.md) for current risks and verification plans.

See [testing](docs/testing.md) for suite selection and offline fixtures, and the
[CPU/memory](docs/performance-check.md) and [I/O](docs/io-performance-check.md) audits for measurement methods.
For agent-side artifact preview screenshots, install the optional renderer with `pnpm artifacts:browser`.
Publication still works without it.

### Dependency updates

[`renovate.json`](renovate.json) configures reviewed update PRs for pnpm and maintained Rust dependencies,
including required Anthropic auth. Pi SDK packages and workspace overrides update together; `pi-extensions` tracks upstream
`main` while remaining pinned to a full commit SHA. Its updates are paused until upstream `main` includes
Pilot's embedding exports; the current pin stays on the compatible embedding commit. The native npm
manager refreshes `pnpm-lock.yaml` with dependency updates, and Renovate reports artifact generation
success or failure on every update PR.
Automerge is disabled. Renovate PRs also check an isolated production runtime before and after ZIP
relocation in the macOS Node CI job. Review those checks and the existing tests before merging.

Cargo covers the GPUI desktop, visual worker and independent updater. Toolchains, source-patched GPUI,
the updater's parser-specific ZIP pin and experimental comparison baselines stay manual. See
[dependency update policy](docs/renovate.md) for the inventory and intentional exceptions.

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

The daemon owns shared model discovery for its host and agent directory. Concurrent worker startups
reuse one catalog pass, and later reads revalidate model definitions, cached catalogs, credentials and
revocation fences. Project scopes, extension providers, virtual routing and request authentication stay
in each worker. Catalog snapshots contain metadata and configuration checks, not credentials or proof
of successful provider authentication. Unchanged models are reused in place; endpoints, request headers
and other transport settings stay local. See [catalog tests and measurements](docs/testing.md#shared-model-discovery).

### Configuration and boundaries

See [tool access by role](docs/tool-access-by-role.md) and
[system prompts by role](docs/system-prompts-by-role.md) for capability boundaries and prompt composition.

Legacy event-watch records remain on disk but have no active service or API.
Production no longer starts their chat, PR, Linear or mission sources, reconciles targets, retries
follow-through or delivers notices. Saved instructions are retained as history, not executed.
Mission notices and ordinary chat PR tracking continue independently.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PILOT_HOME` | `~/.local/share/pilot` (or `$XDG_DATA_HOME/pilot`) | Local session data and managed repositories |
| `PILOT_PORT` | `4319` | Daemon port |
| `PILOT_AGENT_DIR` | pi's agent directory | Pi settings, packages and authentication |
| `XDG_CONFIG_HOME` | `~/.config` | Pilot settings in `pilot/database.json` and `pilot/tracking.json` |
| `PILOT_WORKSPACE_RETENTION_DAYS` | `1` | Archived workspace cleanup delay; `0` disables cleanup |
| `PILOT_PERF_TIMINGS` | enabled | Set to `0` to disable local, content-free request timing logs for new workers |

These are daemon environment variables. The app-managed daemon runs under launchd; exporting a variable
in your terminal does not change an already running daemon.

[Local request timings](docs/request-timings.md) separate preparation, provider waiting and streaming.
They stay outside the transcript, have bounded private storage, and are never exported.
[Local lifecycle diagnostics](docs/lifecycle-diagnostics.md) retain bounded, content-free startup, pause, quota,
connectivity, recovery and parking transitions without waking parked workers.
[Agent diagnostics](docs/agent-diagnostics.md) combine those records with request timings and daemon health in an
on-demand, runtime-restricted specialist and host-qualified read-only API that never wakes a parked worker. Use
**Diagnose this chat** from a chat's More menu, or **Ask about Pilot** from Help, to open
an explicit setup sheet and choose the specialist's model and thinking level. Both accept an optional
investigation reason or bug report (up to 8 KiB UTF-8). Ask about Pilot also offers a host-qualified chat selector,
defaulting to **No chat**. Without a selected chat it diagnoses Pilot on the
selected verified host through an explicit app scope, with no hidden Control row or chat target. The report becomes
only the specialist chat's bounded
opening user message, never telemetry, diagnostic evidence or target authority. The created chat is visibly labeled
**Diagnostics** in the sidebar and chat header, with its admitted app or host-qualified chat scope and read-only
boundary.

Pilot Next on macOS restores **Help → Ask about Pilot…** as a separate Local diagnostic draft.
Sending creates the existing read-only diagnostics role with exact host identity and the daemon's default model,
not a Build or coordinator chat. Existing app-scoped and chat-focused diagnostic conversations accept replies
and Stop again; archived/continued chats remain read-only. The composer identifies the role and refuses image
attachments and project-path completion. This first slice does not include Swift's focus/model setup or repair
confirmation UI. Settings → Diagnostics still reviews only Next's private numeric desktop capture, not daemon logs.
The specialist can inventory existing sanitized sources. Its **performance** context selector reads the existing
bounded daemon CPU/memory, event-loop and operation snapshot through sanitization, on that daemon only.
It does not gain Next's private tracing files, arbitrary filesystem/shell/MCP access or provider-refresh authority.

Diagnostics can also read opt-in, local-only daily feature-usage aggregates across chats, independently of remote
export. Settings → Diagnostics → Local feature usage explains its seven-day retention and clear/disable controls.
Missing, dropped or disabled observations remain unknown, not zero. See [feature evidence](docs/feature-adoption.md).
Structured [Slack/Linear refresh health](docs/refresh-health.md) also distinguishes actual progress, queued/backoff
work and per-channel coverage from old checkpoints, without contacting a provider to answer a diagnostic read.
It includes bounded background-job observations and private restart history, kept separate from current liveness
under local operational collection/clear controls. Historical data never restores a scheduler, queue or retry.
Its descriptive chat title remains independent and is generated through the normal
bounded title lifecycle: a submitted reason seeds the title, while a reasonless setup waits for the first substantive
specialist reply rather than naming the fixed diagnostic instruction. The readable fallback remains if title
generation is unavailable, and a user rename always wins. Titles and title context stay out of telemetry. Cancel
creates nothing, and unavailable,
missing or replaced selections fail without falling back to Local. A selected chat is focus, not an access gate.
Diagnostics always has bounded, sanitized app-wide read access to available chats and archived history, usage/cost/
informational budgets, failures, retained mission/tasks and local issue records. Ordinary Ask/Build stay isolated.
Trusted linked-host reads use already-connected verified native routing; offline/unsupported/partial evidence stays
explicitly unavailable. No chat means app-wide investigation, never a hidden Control target. Every specialist can inventory and search a fixed,
path-free catalogue of bounded sanitized Pilot daemon, worker, native report and admitted-target operational logs on
its selected host. App-scoped sessions expose host sources while marking target-only lifecycle, request-timing and
tool sources unavailable. Native Mac app event/error-code logs are privately bounded, and verified owned Linux
services expose bounded retained Pilot-only journal history. Missing or unsupported logs/reports remain explicit gaps, not proof
that no failure occurred. The reader rejects symbolic links and arbitrary files, uses opaque bounded continuations
and excerpts, never wakes or probes the target, and does not copy logs into telemetry or repair handoffs. Logs and
history stay local, are treated as untrusted data, and grant no attachment, child-session, shell or mutation access.
When no proposal exists, the diagnostics chat's fixed composer-adjacent **Suggest a repair** action sends one bounded,
host-qualified follow-up to the specialist. It reports requesting, queued and retry states, but never opens a manual
proposal form or starts work. Once the specialist publishes a bounded, cited proposal, the action becomes **Review
repair**, and after the turn settles the chat also shows the native review tray without displacing a live question or
stealing focus or replacing the composer. The action is outside transcript scrolling and remains reachable beside
the composer, including during a live question. Not now hides that exact proposal's summary, while **Review repair**
stays in the footer. Pending starts use that same action to check the original receipt; unavailable actions stay visible
but disabled. The context menu can also reopen review.
Publishing, viewing, reconnecting, dismissing or cancelling never starts work. Only explicit confirmation in the
review sheet sends the proposal to a separate private Build in the explicitly configured Pilot source project,
never the diagnosed/current project. Configure its verified host-qualified checkout in Diagnostics settings once;
missing, changed or unavailable bindings block starts without fallback or automatic cloning. App-wide proposals need
no fabricated chat target. Review includes an issue-specific title and model, and preserves the title without an
extra model request. That start uses one durable, host-qualified operation and per-proposal admission claim,
revalidates the proposal, subject, binding/path/origin at admission, and reconciles
an unknown response before any retry or replacement intent.
The review sheet also offers **Allow fresh read-only diagnostics**. When confirmed, the repair Build can read
bounded, sanitized evidence for the exact approved subject, shared Pilot logs on that host, and that chat's
history if the subject is a chat. App repairs do not gain chat-history access. This does not grant app-wide
discovery, other chats/hosts, target wake/restart/replay or mutation. Declined and older confirmations grant no
fresh diagnostic access; reopening or retrying an old intent never adds it.
[Tool-call diagnostics](docs/tool-call-diagnostics.md) add bounded in-flight and completed lifecycle evidence for
built-ins, MCP and nested `codemode` calls while keeping raw names, arguments, output and commands out of diagnostics
and opt-in telemetry. Liveness and useful progress remain separate observations; Pilot does not automatically retry,
restart or replay a suspected call. Conservative live **Needs you** attention distinguishes suspected no-progress,
worker-liveness and cancellation delay from explicit waits, background jobs and paused sessions.
Chats also expose durable, content-free AI usage accounting from committed provider reports, keeping token classes,
catalog estimates, billed-spend availability and subscription coverage semantically distinct. Observed context
headroom, cache denominators, compaction pairs, request retries and worker relaunch reasons help diagnose efficiency
without changing model, context, compaction, retry or restart behavior. Diagnostics settings can optionally compare
retained per-chat catalog estimates or authoritative billed spend with an explicitly entered USD budget. No budget
exists by default, missing or partial data is not zero-filled, and the result never gates or changes execution.
The separate [local usage-history store](docs/usage-history-contract.md) provides a bounded foundation for the usage
dashboard: private host-owned accounting, 30-day retention, replay-safe replacement identities and separate
non-additive legacy checkpoints. Kernel and delegated requests retain physical-model and already-observed virtual
selection provenance locally, including failed responses with reported usage. Unknown crash responses are not zero,
and deterministic compaction records activity without invented inference cost. It is not a billing source or
diagnostic export. Separate [background completions](docs/background-inference-accounting.md), including titles,
memory compaction (including historical Control usage), Slack classification and triage workers record observed usage before output validation
or application. Capture and dashboard projections remain partial; neither establishes complete historical coverage
or waives the dashboard performance/release gates. Pilot Next’s passive
[Local Usage overview](apps/desktop/docs/usage-overview.md) filters historical totals
and daily trends by exact ledger project or Unattributed records, with a bounded
project list. On-demand retained request pages expose exact selectable/copyable
records without deriving totals from pages. Subscription limits remain global
and independent of those filters.
[Native and devbox setup diagnostics](docs/native-diagnostics.md) use Apple's delayed MetricKit delivery for crash
and hang observations and a closed app-owned timeline for setup stages through verified remote handshake. They
retain only bounded content-free metadata locally. Pilot does not ingest stacks or report bodies into those
aggregates, SSH output, aliases or arbitrary errors; it does not upload these records or treat historical evidence as
a retry or restart signal. The separate on-demand log catalogue may return bounded sanitized Pilot report excerpts
inside a diagnostics specialist chat, never as aggregate evidence or telemetry.
The [diagnostics and telemetry contract](docs/telemetry-contract.md) defines the versioned privacy, identity,
correlation, retention and resource budgets for local diagnostics and opt-in OpenTelemetry export. Remote export and
product analytics are disabled by default, and no telemetry backend is selected by the repository.
[Node telemetry](docs/node-telemetry.md) documents the daemon/kernel OpenTelemetry helper, bounded OTLP behavior and
local in-flight hooks that keep useful progress separate from liveness heartbeats.
[Swift telemetry](docs/swift-telemetry.md) documents the native trace module, strict propagation, bounded background
export, sleep handling and packaged dependency notices.
[Feature-adoption catalog](docs/feature-adoption.md) defines the closed, content-free eligibility, exposure, attempt
and outcome events and the limits on funnel and repeat-use interpretation.
The [local OTLP Collector example](examples/otel-collector/README.md) and
[starter queries](docs/telemetry-starter-queries.md) provide bounded vendor-neutral evaluation without provisioning
a hosted backend or enabling upload automatically.
[Telemetry controls](docs/telemetry-settings.md) documents independent local, operational and analytics consent,
per-host OTLP endpoints, revocation and private pseudonymous identity.
[Telemetry verification](docs/telemetry-verification.md) maps the offline privacy, failure-isolation, bounds and
overhead fixtures used by the exact-head Node, macOS, Linux and packaging gates.
[Message send tracing](docs/message-send-tracing.md) explains the correlated app/daemon/kernel phases, thinking versus
visible text, and why queued, restarted or unobservable milestones are reported as unavailable rather than guessed.
[Chat-open tracing](docs/chat-open-tracing.md) covers warm and cold transcript latency, bounded history buckets,
WebSocket correlation and the distinction between model publication and an observed display frame.

- **Keep the daemon local.** It binds to `127.0.0.1`, rejects requests with an `Origin` header and has no
  authentication. Do not expose it to a network.
- **Durability is not tool replay.** If a native tool is interrupted by a crash, it is reported as
  interrupted rather than automatically rerun. After an unexpected kernel exit, interrupted chats reopen
  automatically with crash backoff. A slow but connected kernel is not treated as dead.
- **Extensions must fit the host.** Extensions that replace the SDK session or start their own model loop
  are unsupported. Subagent controls require a pi-extensions version with the `subagents:*` host events.
- **Project trust still applies.** Project-local `.pi` resources load only for directories pi trusts
  (or when `defaultProjectTrust` is set to `always`).
