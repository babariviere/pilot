# Pilot plan

Status: draft. Owner: babariviere. This document is the product and technical spec for Pilot, and the
milestone plan that gets it to background-agents.com.

## 1. Vision

Pilot runs pi agents in the background on durable sessions, and brings work to them from where it
happens: GitHub, Slack and Linear, plus anything you start yourself. Agents fix what they can, ask when
they cannot decide, and hand back reviewable results (pull requests, specs, replies). You supervise from a
native macOS app, or from wherever the work came from.

### Goals

- Start, steer and stop regular pi agents from a native app, with your pi setup (pi-extensions) by default.
- Fix CI failures and review comments on pull requests, when the fix makes sense.
- Fix bug reports posted in Slack, when they can be reproduced and fixed.
- Spec Linear tickets in a loop with a human: the agent asks questions, the human answers, the spec converges.
- Give every Build session a real terminal (libghostty) in its working copy.
- Survive restarts and crashes without losing or duplicating work.

### Non-goals (for now)

- Auto-merging anything. Pilot proposes; humans merge.
- Replacing CI, code review or the issue tracker. Pilot works inside them.
- Cross-platform desktop apps. macOS first; the daemon stays portable.

## 2. Principles

1. **Durable by default.** Every admission, answer and external effect is committed before it is shown or
   acted on (pi-durable). Restarts resume work; retries are idempotent by request ID.
2. **Bring the conversation to the human.** Questions and results go back to the source thread (PR,
   Slack thread, Linear issue). The app is the cockpit, not the only door.
3. **Decline is a valid outcome.** Every automated trigger starts with triage, and "this does not make
   sense, here is why" is a first-class result.
4. **Least privilege per trigger.** External text is untrusted input. Permissions come from the trigger's
   policy, never from the prompt.
5. **Local first, hostable later.** One daemon model for a laptop and a server. Hosting adds auth,
   tenancy and webhooks, not a second architecture.

## 3. Architecture

```text
 Pilot.app (SwiftUI, libghostty)        GitHub   Slack   Linear   schedule
        │ HTTP + WS (loopback)              │       │       │        │
        ▼                                   ▼       ▼       ▼        ▼
 ┌──────────────────────────── pilotd (launchd agent) ──────────────────────────┐
 │ API · session registry · trigger sources · policy · workspaces · notifier    │
 └──────────────┬───────────────────────────────────────────────────────────────┘
                │ fork + IPC, one worker per session
                ▼
        kernel worker: pi-durable Harness (SQLite) + native pi kernel (extensions, tools, auth)
```

- **pilotd** (`packages/daemon`): owns sessions, trigger sources and policies. Runs as a per-user launchd
  agent, independent of the app.
- **kernel** (`packages/kernel`): one process per open session. Kernels idle and unwatched for 10 minutes
  (`PILOT_IDLE_PARK_MS`), with no work subprocesses such as background jobs, are closed and reopen on demand.
  Exact SDK-owned MCP transports are exempt only while they have no outstanding requests or unowned descendants;
  unknown children still prevent parking. One pre-forked spare with its modules loaded keeps reopening fast.
  pi-durable owns the transcript and model loop;
  the native pi kernel provides tools, prompts, extension hooks and provider auth from `~/.pi/agent`.
  Native extension idle checks and current run state share the commit-consistent activity monitor,
  not independent working flags or the dormant SDK loop. It includes runs, compactions and queued
  continuations, without loading history. `agent_settled` is delivered only for a committed busy-to-idle
  boundary that is still idle; coalescing retains the boundary counter, not obsolete frames.
  Jobs finishing during a run stay pending for the extension's grouped notification. Queued end/start
  boundaries do not settle.
- **Pilot.app** (`apps/macos`): session list, native chat, per-session terminal, menu bar, notifications.
  Installs and supervises the launch agent. Closing or quitting the app never stops agents.
  Terminal rendering retains the visible surface plus five inactive surfaces, detaching without killing
  daemon shells. Draft writes are debounced off-main, with window/deactivation/quit durability flushes.
- **protocol** (`packages/protocol`, mirrored in `PilotCore`): HTTP commands and WS event streams.

## 4. Core concepts

| Concept | Definition |
| --- | --- |
| **Session** | One durable pi conversation with its code source, mode, origin, policy and state. |
| **Origin** | What created the session: `manual`, `github.ci`, `github.review`, `slack.bug`, `linear.spec`, `schedule`. |
| **Binding** | Link between a session and an external thread (PR, check suite, Slack thread, Linear issue). Unique per thread, so new events steer the same session instead of spawning duplicates. |
| **Trigger source** | Adapter that turns external events into admissions: `spawn(origin, binding, brief)` or `send(session, message)`. Polling or webhooks. |
| **Policy** | Per-origin permissions: repositories, branches it may push, sandbox floor, tools, budget, auto-reply rights. |
| **Workspace** | Daemon-owned Build working copy (shared jj workspace, legacy/Git private clone, or project checkout). Ask uses a read-only checkout or pinned snapshot instead. |
| **Human gate** | A durable pause where the agent waits for a human answer or approval (`waiting` state). |
| **Mission** | A goal spanning several chats of one project, with a shared versioned brief, tasks, artifact and resource links and an activity log (§5.7). |
| **Outcome** | Structured end of a run: `fixed` (with PR/commit), `declined` (with reason), `failed`, `stopped`. |

### Session states

`parked → starting → working ⇄ waiting → idle`, plus `failed`. `waiting` is new: the run is parked on a
human gate and costs nothing until answered.

For manual sessions today, lifecycle (`parked`, `starting`, `working`, `idle`, `failed`) is separate from
the latest settled-run outcome (`done`, `failed`, `stopped`). Outcomes are derived automatically
from the run: a successful response settles as `done`, including questions or proposals; errors
and aborts settle as `failed` or `stopped`. Agents do not report a separate status or human-attention
outcome. Follow progress and questions through the transcript, live activity updates and unread
completion indicators. A settled run costs nothing while idle, and an ordinary user message resumes
work. This is not the suspended `ask_human` gate yet. Outcomes and their stable completion version
survive worker and daemon restarts. Older human-attention outcomes are read as `done`, retaining their
completion version without an obsolete attention reason in current daemon/kernel normalization. The
native client's compatibility decoder maps older-daemon outcomes to `done` while retaining any legacy
reason as notification context.

## 5. Shared machinery

### 5.1 Human gate (`ask_human` tool)

A durable pilot tool available to every session:

- `ask_human({ questions: [{ id, text, options? }], blocking: boolean })`.
- The tool commits the questions, publishes them to the binding's channel (app, PR comment, Slack thread,
  Linear comment) and parks as a waiting task. No model tokens are spent while waiting.
- Answers arrive from any channel through `POST /api/sessions/:id/answers` (or a trigger source) and
  complete the task; the tool returns the answers to the model.
- Replay-safe: question IDs and channel message IDs are stored, so a restart never double-posts.
- Timeouts per policy: remind, then end with `stopped`.

### 5.2 Triage step

Every automated origin starts with a cheap, read-only triage turn that must produce one of
`proceed`, `decline(reason)`, `ask(questions)`. Only `proceed` unlocks write tools for that run.

### 5.3 Outcome reporter

A checkpointed task posts the outcome back to the binding (exactly one report per outcome ID) and records
it in the session. Reuses the reporter pattern from pi-extensions subagents.

### 5.4 Workspaces

Decided: **Build sessions use the project's workspace policy; Ask sessions are read-only**.

- New chats default to **Build**. A per-chat workspace override does not change the project default.
  **Ask** uses the current checkout without cloning, including local changes, or an explicitly
  selected origin branch. The existing branch chip beside the project picker selects the source.
- Open chats show the project and branch/source in the window subtitle. Build workspace details and PR
  links live above the Changes file list, not in the toolbar or above the composer. Ask keeps a read-only
  mode badge in the toolbar because it has no Changes pane; its tooltip includes the pinned commit.
- Branch-specific Ask sessions fetch the selected origin head into a session-owned bare object store,
  fetch only the selected head's snapshot, pin its commit before starting the worker, and read/search
  that tree without creating a checkout.
  They never switch or modify the user's checkout, and reopening keeps the pinned revision. Branch
  snapshots exclude local changes. A refresh of the branch menu lists current origin heads; missing
  branches fail preparation rather than silently falling back to another source.
- Ask workers load only host-owned read/search tools, session-local artifact tools and the `web` tool
  borrowed from the user's own pi extensions. To find `web`, Ask evaluates user-level packages and
  extensions (never project ones, explicit paths or inline factories) and keeps only that tool definition;
  extension hooks, commands and other tools are never attached. Web search and fetch (including its
  clone and browser fallbacks) are allowed in every Ask chat. MCP, shell tools, jobs, and
  repository-write tools are not loaded, not merely hidden or blocked. Repository read-only access is a
  capability boundary, not a prompt convention. Ask sessions
  cannot open a terminal or publish repository changes. They can create, update and preview their own
  artifacts using the isolated offline renderers, without arbitrary image-file reads. Codemode can only
  call this restricted tool set; artifacts and completion reporting are session-local capabilities.
  Mode is immutable for a chat; implementation starts a separate Build draft with the conversation
  as context, preserving the Ask chat and its selected source.

- New isolated Build sessions for jj projects use session working copies backed by a shared repository
  in `$PILOT_HOME/repositories`. The working-copy change starts on the selected base. Workspace edits
  leave the user's own checkout untouched, but bookmarks and repository history are shared with sibling
  sessions. Existing clones are not migrated; Git-only projects, direct Build checkouts, and Ask remain unchanged.
- Shared workspace launch fetches into daemon-only `refs/pilot/*`, never agent-owned Git heads or origin refs.
  A local `pilot-base` import remote indexes only the selected immutable base hash through a filtered jj fetch,
  with abandonment and synthetic rewrites disabled. An empty non-colocated control workspace creates children
  with one checkout, avoiding the default workspace's automatic Git import. The new child is materialized
  before enabling colocation; existing workspaces are never relocated.
  Normal agent jj commands retain Git synchronization semantics; launching a chat is not repository-wide sync.
- Legacy and Git-only private clones live in the session directory (`$PILOT_HOME/sessions/<id>/workspace`), cloned from the project's
  checkout, with `origin` pointed at the project's real remote and fetched. The clone first borrows the
  checkout's objects through Git alternates (no copying or hardlinking, which takes minutes for a jj checkout with
  tens of thousands of loose objects), then pilotd repacks the reachable objects into the clone in the background
  and drops the alternate. Only committed
  history and ignored mise local configuration files (`mise.local.toml`, `.mise.local.toml`,
  `mise/config.local.toml`, `.mise/config.local.toml`) are copied; other uncommitted work, dependencies
  and build output stay behind. Copied local configuration stays ignored, and the user's checkout is never touched.
- The new-task composer offers a Base branch selector for isolated Build projects, listing only real
  branches advertised by `origin` (no local branches or HEAD pseudoref). The remote default remains
  the default; an explicit selection is persisted through startup/recovery and must still exist remotely.
  Starting from an existing branch does not change that branch or the user's checkout.
- Start Git private clones detached from the selected remote branch, or the remote default when none is
  selected. Shared jj workspaces start a working-copy change on that base, not a detached clone. When a PR is required, new agent-chosen
  branches and bookmarks use `<type>/<short-description>` with a conventional task prefix
  (`feat/`, `fix/`, `docs/`, etc.), never `pilot/`. Existing branch and bookmark names are preserved;
  PR sessions check out and keep the PR head instead.
- Shared jj workspaces and legacy clones inherit the project's pi trust.
- Projects can opt out (`workspace: "direct"`) to run Build sessions in the folder itself. Ask source
  selection is independent of this project setting. Folder-only Ask sessions use the current folder.
- Projects independently configure **Require PR** (`requirePullRequest`, default true). Turning it off
  permits direct pushes to the remote default branch without a PR, including shared jj workspaces.
  Shared jj sessions identify the remote default branch, reconcile upstream, then move only its bookmark
  to their own completed, verified change and push it explicitly with `--bookmark`, without force-pushing.
  PR delivery uses task-specific bookmarks. It does not change workspace isolation
  or run an after-push command. The policy is read when a session worker starts (new sessions or kernel restart).
- Archiving retains history with recoverable jj snapshots, not a guarantee that the working directory
  remains on disk. Archived shared jj workspaces are eligible for cleanup after 1 day, configurable
  with `PILOT_WORKSPACE_RETENTION_DAYS`; `0` disables cleanup. Legacy private clones have no restore
  recipe, so after the same retention they are pruned in place instead: only ignored, untracked regenerable
  dependency and build directories are deleted, never history, tracked or other ignored files, and a later
  archival may prune again. Direct/Ask sources are never touched. Never delete while a PR is open.
- After restoration or pruning, the next kernel's Pilot prompt says the workspace was reset (with the
  restored jj change and commit, when recreated) and that dependencies and build output must be rebuilt.
  The notice clears on the next archival.
- Safe cleanup pins the exact commit and change IDs plus the base before removing a workspace. Preserve
  the known ignored mise configs (`mise.local.toml`, `.mise.local.toml`, `mise/config.local.toml`,
  `.mise/config.local.toml`) and bounded `.pi/todos` files for restoration, with content-addressed
  backups for repeated cleanup. Block deletion on unknown files that would be lost, live work,
  subprocesses, viewers or terminals, sparse checkouts and submodules. Ignored regenerable dependency
  and build directories are discarded. jj 0.46+ and Git 2.42+ are required for shared colocation.
  Resume restores the pinned jj snapshot, not a moving bookmark or the current remote head. Cleanup
  failures are protocol metadata and appear in the existing workspace badge tooltip, without another screen.

### 5.5 Policy and safety

- Shared jj agents own their working copy, not the repository: do not rewrite sibling sessions' changes
  or task bookmarks, use repository-wide `jj undo`/`jj op restore`, or run broad rebases or `--all` pushes.
  PR delivery uses task-specific bookmarks and pushes only the chosen bookmark with `--bookmark`.
  Configured no-PR delivery may move and explicitly push the default bookmark for the session's own
  completed change after reconciling upstream; this does not permit rewriting other sessions' work.
- **GitHub identity (decided):** Pilot never posts on GitHub: no comments, reviews, replies, merges or closes.
  It acts as the user only to push branches and open pull requests (`gh pr create`, the user's credentials).
  Enforced by a kernel tool hook (also inside codemode scripts) and stated in the session prompt; results,
  questions and declined items go to the app (and later Slack).
- External text (CI logs, review comments, Slack messages, Linear issues) is framed as untrusted data in
  the brief, never as instructions with authority.
- Sandbox floor per origin (pi-extensions `sandbox`): writes only inside the workspace; network allowlist.
- Push rules: only to the session's own branch or the PR branch under review, except projects explicitly
  disabling Require PR may push directly to the remote default branch;
  never force-push others' commits; never merge.
- Allowlists: repositories, Slack channels, Linear teams, GitHub authors whose events may trigger work.
- Loop prevention: ignore events authored by Pilot's own identity; cap fix attempts per PR and per day.
- Budgets: token and wall-clock limits per session and per origin per day; stop and report when exceeded.
- Secrets via fnox (pi-extensions `secrets`); credentials never enter transcripts.
- Audit log: every external write (push, comment, message) with session, policy and timestamp.

### 5.6 Configuration

`~/.config/pilot/config.toml` (hot-reloaded): repositories, sources, policies, budgets, identities.
Credentials resolve through fnox references.

### 5.7 Missions

A **mission** groups chats that pursue one goal over days, sharing a brief, tasks, artifacts, links and
an activity log. It replaces running one very long chat. "Project" stays the repository; a mission
belongs to exactly one project.

**Model (daemon-owned).** Mission state lives in pilotd's own storage, never in a workspace: isolated
Build workspaces each have their own `.pi/todos`, so files cannot be shared between chats. Exporting
the brief into the repository is an explicit user action.

- **Mission**: title, goal, project, status (`active`, `done`, `archived`), optional coordinator chat
  and an Autopilot flag. Completing every task only suggests marking the mission done.
- **Brief**: one markdown document (the spec), versioned. The user and every mission chat edit it
  directly; each save is an immutable revision with its author, diffable and revertible. Writes carry
  the expected revision and stale writes are rejected (HTTP 409), so concurrent edits never overwrite.
- **Decisions**: short binding statements shown above the brief. Agents may record decisions; only the
  user edits or removes them, and user decisions override the brief.
- **Comments**: user or agent annotations anchored to a brief excerpt, optionally addressed to one chat.
  Open comments are part of the context agents read; any mission chat can resolve them. Unaddressed
  comments go to the coordinator, or to Needs you when there is none.
- **Tasks**: ordered, with status `todo`, `in_progress`, `blocked`, `in_review`, `done` or `dropped`,
  optional body, milestone and dependencies. A task is owned by at most one chat; claiming is atomic
  and rejects a task owned by another chat. A chat can claim several tasks with `ids` (IDs, numbers
  or inclusive ascending ranges such as `1-5`, at most 1000 expanded references). Batch claims return
  `claimed` and `skipped` with reasons, leaving other chats' claims untouched. The single `id` form
  keeps its task result and conflict error; a range or comma-separated list in `id` uses batch results.
  The coordinator can permanently remove a task with `delete`, reorder it with the `task` action's
  numeric `order` sort key (lower first, ties by task number), and atomically set or clear milestones
  on several tasks with `group` (`ids` selectors and `milestone`, empty to clear). Only the coordinator
  sees these controls; the daemon checks the current role on every call. Other chats retire work with
  status `dropped`. Deletion removes dependency references and preserves links at mission level.
  Chats claim the requested tasks, work through them one at a time in dependency order, keep queued
  tasks `todo` and each working/review/blocked status current, and skip or report unfinished dependencies.
  Open dependency PRs can support dependent work as a stack: one PR per task, based on the dependency's
  bookmark before editing, linked bottom-to-top with `gh stack link` using existing PR URLs only
  (branch arguments push implicitly). Never push or rewrite a dependency owned by another chat.
  Workers detect github/gh-stack locally at open. Missing extensions or repository rejection use
  plain dependent-base PRs, without installation or branch-pushing stack commands.
- **Artifacts**: links to artifacts that stay owned by their session, optionally pinned to a revision.
- **Resources**: external links (Linear project or issue, GitHub issue or PR, Slack thread, any URL).
  Links optionally belong to a task, appear on its row and in agent task views, and can be added or
  removed there. Deleting a task keeps its links at mission level. A chat's newly opened PR is linked
  to its unfinished claimed tasks automatically.
  Task-linked GitHub PRs use the daemon's existing serial PR tracker, including links added by hand
  and PRs unrelated to the owning chat. An open or draft PR moves a task to in_review. It becomes
  done when every linked PR has a known terminal state and at least one merged; closed-unmerged
  PRs are ignored. Automatic transitions are recorded in activity. Closed tasks never reopen, and
  moving a task backward by hand permanently disables automatic PR status changes for that task.
  The kind and external ID are parsed when saved so later automation needs no migration.
  PR lookups include nullable GraphQL stack membership (number, one-based bottom-to-top position,
  size and ultimate base), cached with the PR and shown on task links. The existing bounded batched
  tracker fetches these scalar fields without extra processes or stack-entry pagination. Servers
  without the preview schema retry without stack fields and remember that capability until restart.
- **Activity**: append-only events: handoffs, status updates (optional health), claims, task changes,
  brief revisions, decisions, links and membership changes.
  The Activity composer lets the user post updates and handoffs for agents to read. Agent `get`
  results include the latest 15 user-authored updates and handoffs in `recentUserNotes` (newest first,
  with health when present), independently of the latest 15 events in `recentActivity`. Automatic
  events and agent logs cannot push user notes out of this separate window. Posting does not send
  a chat message; agents read these notes on their next `get`.

**Membership.** A session has at most one mission and must belong to the mission's project; attaching
a chat from another project is rejected. Chats join through **Make a mission…** (the chat drafts the
mission from its conversation), **Add to mission…**, or **Start chat** on a task (which also claims the
task). **Remove from mission** releases its tasks. Archiving keeps mission membership: the mission's
Chats tab filters active, archived or all chats, and the archive browser can narrow to one mission. Chats
of an active mission are exempt from inactivity auto-archiving. Its coordinator is also exempt from
merge-based archiving and terminal-PR presentation (ordering, suppressed unread/notifications and done
indicators) until the mission is done/archived or the role moves. Other members retain merge-based rules.

**Make a mission.** From any chat's overflow or sidebar context menu. A sheet takes the title (prefilled
from the chat) and an optional goal; nothing exists until confirmed. The source chat joins and becomes
coordinator by default (a checkbox opts out). By default pilotd then sends that chat a visible follow-up
asking it to draft the goal, brief, decisions and initial tasks with the `mission` tool, without starting
implementation. The chat already holds the context and its prompt cache, so the draft is better and
cheaper than an out-of-band summary of the transcript; the user reviews and edits the result on the
mission page, where every brief change is a revision.

**New mission.** Mission control offers **Start a coordinator chat**, on by default, with scoped,
price-capped model and thinking choices and optional context, links and constraints. The daemon uses
the task-start spawn path, joins and promotes the chat before its first turn, and sends the same draft
request plus the goal and context. The app opens that chat. Opting out keeps title-and-goal creation.
Without a coordinator, the header offers **Start a coordinator** with the same controls, alongside
**Make coordinator** shortcuts for member chats. Failed admission removes any saved chat metadata
and leaves no coordinator; the created mission remains available for retry from its page.

**Coordinator.** An optional role held by one mission chat (Build or Ask); **Make coordinator** moves it.
The user is the coordinator when no chat holds the role. The coordinator can start chats for tasks and
message member chats; it is woken with a batched, durable notice when a member settles, fails or waits on
the user. Without Autopilot it starts chats only when asked; with Autopilot it may start chats for
unblocked tasks on its own.

Wake-ups are pending events in `missions.sqlite`: member completions (done, failed, stopped), tasks
becoming blocked and comments addressed to the coordinator or nobody. Self-caused events never wake
the coordinator. Pending events accumulate while any other member of that mission is working or
starting. Once all members are inactive (idle, parked, failed or archived), delivery waits 30 seconds
to settle; an immediate resume resets that window. The coordinator's state and chats outside the
mission do not affect member activity. A single 30-minute safety cap, `NOTICE_MAX_DELAY_MS`, measured
from the oldest pending event allows delivery even when members remain busy.
Delivery still waits for the coordinator to be idle (including an empty durable inbox), with an atomic
kernel idle guard, and uses an ordinary follow-up with request ID `mission-notice:<lastEventId>`.
The cutoff and short event-summary payload are frozen before delivery, so a lost acknowledgement
retries the same notice once.
Completion versions and semantic state fingerprints are durable: startup does not announce outcomes
predating membership, unchanged successful states are suppressed, and later outcomes omit old merges. Events
stay pending while the mission is inactive, lacks a coordinator, or its coordinator is archived.
Each mission has a rolling cap of 20 notices per hour; excess events wait for the next window.
Notices group by task, or chat for unassigned work: only the latest state is shown, superseded failures
are omitted, and repeated failures carry a count. Comments collapse to the latest note per author.
Each backlog produces one notice with at most 100 one-line summaries (500 characters each), plus an
overflow count linking readers to activity for additional groups. All raw events remain in activity.
Waiting-on-user triggers remain deferred until that lifecycle signal exists. Autopilot is not enabled.

An active coordinator's shared jj workspace refreshes from its current base branch before each new
turn (including queued user inputs and notices), at most once per ten minutes, and after a linked PR
merges. A merge during work waits for a safe boundary; idle chats have no refresh timer. Fetching uses
the private shared-repository base import. Only this chat's proven changes are rebased, after an
unintegrated trial confirms no conflicts or changes to another chat's history or bookmarks. Identical
file/blob transitions already merged upstream are not replayed, including squash merges. Otherwise
the working copy stays behind and a mission comment explains why. Refresh also clears a stale working
copy. Promotion detaches the old task bookmark association without deleting the bookmark. Chat details
show the current base and refresh age; the next system prompt uses that base. Other chats do not refresh.

Every wake-up adds to the coordinator's context, so pilotd compacts it while idle. After five minutes
idle (the prompt-cache lifetime, before the ten-minute park), it queues a manual compaction when the
context is at least 40% of the window or 100k tokens, whichever is lower. It skips chats with a pending
wake-up, chats that are archived, parked or not safely idle, and chats whose usage is unknown. It tries
at most once per idle stretch. Summary instructions keep open requests, commitments, started chats and
unrecorded agreements, and leave out what the mission already records. History from before the
compaction stays viewable in the app.

**Agent tool.** One `mission({ action, ... })` tool, registered only for chats in a mission (including Ask
chats and codemode), following the `artifact`/`todo`/`subagent` pattern:

| Action | Purpose |
| --- | --- |
| `get` | Goal, decisions, own tasks, open tasks, open comments, recent user updates and handoffs, recent activity and the brief's revision and outline |
| `brief` | Read the brief (optionally a revision), or replace it with `markdown` and `expectedRevision` |
| `tasks`, `task`, `claim` | List tasks; create or update one; claim one (`id`) or several (`ids`, including ranges) for this chat |
| `decide`, `comment`, `resolve` | Record a decision; add or resolve a comment |
| `attach`, `link` | Link an artifact; link an external resource |
| `log` | Post a handoff or status update |
| `update` | Change the mission title or goal |
| `start`, `send`, `status` | Coordinator only: start a chat for an unclaimed task (`id`, optional `message`, `model`, `thinking`, `artifacts: [{artifactId, revision?}]`, `links: [{url, title?}]`), send a follow-up to a member (`targetSessionId`, `message`), summarise all member states (including archived chats) |

The tool is registered for every Build and Ask chat but declared to the model only while the chat is a
member, so other chats pay no prompt cost. pilotd pushes membership and context changes to a live
kernel, which applies them from the next model request; tool calls travel over the worker's IPC channel
and pilotd checks membership on every call and the current coordinator role for these three actions.
These three actions and their guidance are declared only to the coordinator. Changes to membership
or coordinator role refresh the tool in place, including codemode discovery. `start` reuses Start chat
and requires an active mission. Start model choices use the project's `ModelCatalog.list` scope,
capped at the highest scoped Claude Opus 5.5 or GPT-6.1 Sol input plus output price per million tokens.
The reference model IDs live in one constant. If neither reference is scoped, starts use the scope
without a cap and log the fallback. The omitted model uses the project default, which is validated
too; thinking must be supported by the selected model. Omitted thinking follows scope, per-model
and project defaults, clamped to supported levels. Validation errors list allowed models, prices and
thinking levels. Coordinator guidance prefers cheaper models for small tasks and the strongest
allowed for hard ones. Start activity records the model and thinking level. `send` queues a follow-up
if the member is busy and requires restoring an archived chat first. `status` reads summaries without waking workers,
including lifecycle state, latest outcome, archive status and assigned tasks. Start chat works
with task-scoped references saved before spawning: artifacts must already be linked to the mission
or owned by a member chat, and links use the normal resource parser. Artifact links can have a `taskId`
(one artifact may be referenced by several tasks). Task rows and `get`/`tasks` include these references,
and later chats for the task inherit them. Deleting a task preserves its artifact references at mission
level, without overwriting an existing mission-level pin. Opening messages list title, kind and ID/URL, without pasting
content, and reject messages over 4,000 characters including the task body and reference list. Durable
context belongs in the brief, decisions or task links, not only in the opening message. Scoped artifact
unlinking uses `DELETE /api/missions/:id/artifacts/:artifactId?taskId=…`; omission unlinks the mission-level
reference. `artifact get` falls back from the caller's local store to read-only linked mission/task sources.
The daemon validates current membership, project and persisted links on every read, including after async
I/O. Omitted revision uses a link's pin, or latest for unpinned links; conflicting links require an explicit
revision. Pinned-only links cannot read unlinked revisions. Ownership, update and list stay session-local,
and opening messages never copy source content. Mission chats receive a compact mission header in Pilot's prompt section (goal, coordinator,
own open tasks, decisions and how
to use the tool), not the whole brief. The header only changes when those fields change, preserving
prompt caching.

**New chat.** The Chats tab and sidebar mission group open the new-chat composer with the mission
preselected and its project locked, without attaching a task. `SpawnRequest.missionId` validates an
active mission, resolves its project and joins before kernel startup, so the header and tool are present
on the first turn. Unknown, done or archived missions, other projects and cwd overrides are rejected.
“Add existing chat…” remains a secondary menu action.

**No mission references in deliverables.** Missions are internal coordination. The mission header
forbids mentioning the mission, its tasks, coordinator or Pilot in commit messages, bookmarks, PR
titles and bodies; external tracker references such as Linear issue IDs remain allowed so trackers can
link and close them. A kernel hook checks commands that publish names or descriptions (`gh pr
create`/`edit`, jj `describe`/`commit`/`new`/bookmark changes, `git commit` and branch creation)
for the mission title and coordination phrases ("this mission", "mission task", "mission brief",
"coordinator chat") and rejects the command before anything is published, asking the agent to rewrite.
The bare word "mission" is allowed so work on mission features themselves stays possible.

**Phases.**
1. Missions, brief with revisions, decisions, comments, tasks with claiming, artifact and resource links,
   activity, the `mission` tool, Make a mission, Add to mission, Start chat, Overview with Needs you, and
   the deliverable guard.
2. Coordinator role, wake-ups and Autopilot; handoff to a new chat; task dependencies and milestones;
   tasks moving to `in_review`/`done` with their chat's PR state.
3. Resource automation: `tracks` links that close Linear projects or epics on completion after user
   confirmation, task-level Linear issues closed on merge, importing an epic's issues as tasks, and
   posting mission updates to Linear. Validation step per milestone.

### 5.8 Project memory

Daemon foundation implemented. Each project has an OptMem-style append-only log and a rebuildable
aligned power-of-two summary tree under `PILOT_HOME/memory/<project-id>`. Notes are one line, at most
280 UTF-8 bytes, with a stable UUID, device UUID, timestamp and origin chat. Only explicit agent notes
write memory. No automatic outcome or handoff notes, and no multi-device sync yet.

Records are 2048-byte checksummed JSON slots (including padding for worst-case JSON escaping), so log
entries and summary nodes use direct positional reads without indexes. Appends and truncations fsync.
Startup repairs partial or checksum-invalid crash tails; cache parents whose children were lost are
invalidated. A per-project SQLite exclusive transaction is the advisory ownership lock, released by
the OS even on process death. All storage, repair and fsync work runs in a dedicated worker thread;
the daemon's RPC queue is capped at 64. The log is the only memory source of truth.

Wake uses OptMem's age-weighted cover (default 96 memory lines, maximum 256). Missing summaries fall
back to available finer nodes and raw entries within the budget; an omitted older prefix is explicit
in both `omittedBefore` and the rendered text. Wake and zoom perform O(output lines) disk seeks, not
log scans. Zoom opens an inclusive aligned `lo-hi` block into its two halves, reporting missing
summaries as pending. Recall streams a snapshot in 64-record batches, retains only newest matches
(default 96, maximum 256, also capped at 20 KB), and reports the full match count. Regex matching runs
in separate workers, at most two concurrently, terminated after five seconds so pathological searches
cannot stall writes, wake, or the daemon event loop.

The background compactor uses existing model plumbing with authenticated `openai-codex/gpt-6-luna`,
thinking off and no tools. It builds dense level prefixes smallest first, from raw notes for blocks
up to 16 entries and from the two child summaries above that. One call per project, at most two
globally; notes coalesce work, failures back off from 30 seconds to 30 minutes, calls have a 60-second
deadline, and shutdown cancels work. Notes and wake never await compaction. Forget truncates a
summary level's suffix and every ancestor suffix, ancestors first, leaving the log unchanged;
generation checks discard compactions begun before forget. Background rebuilding resumes on restart.
Removing a project cancels its background work and releases its file descriptors and advisory lock;
the durable memory log is retained.

Protocol and PilotCore mirror the memory APIs and optional `ProjectDashboard.memory` provider (count,
five recent entries, pending/running/backoff/error status). Changes flow through existing dashboard
subscriptions, without app polling. Kernel tools/wake injection and the project-page browser remain
separate consumers of this foundation.

## 6. Integrations

### 6.1 Manual sessions (M1)

Start from the app with a directory, optional model, and task. Chat, steer, follow up, stop, terminal.
Chat titles are generated asynchronously by the cheapest model in the project's pi model scope
(uncached input plus output price), with thinking off and no tools. Explicit titles are preserved;
failed title requests keep the first-line fallback and never block the main agent.

Task creation durably records its initial input and returns a `starting` session before workspace
preparation and kernel startup complete. Interrupted preparation resumes after a daemon restart;
startup failures remain visible in the session. Workspace tools and terminals are unavailable until
the isolated working copy is ready.

#### Chat responsiveness

- Opening parked or archived history reads a committed, read-only durable snapshot. It does not
  acquire the writer lease, initialize the native SDK or extensions, or resume agent execution.
  A later execution request attaches existing viewers to a fresh live snapshot; generation checks
  prevent a stale disk read from replacing live state. Preparing/recovering active sessions still
  follow the execution startup path.
- The native app retains a bounded LRU of prepared transcripts (8 conversations, approximately
  16 MiB). Returning to a chat paints cached rows while resynchronizing. Cached queue/status never
  authorizes actions or acknowledges an unread result before a fresh snapshot arrives.
- Draft edits and editor-height updates are observed only by the editor and send controls.
  Model/usage controls wrap through a single view tree, and unchanged usage labels/tooltips are cached.
  Height measurements are coalesced and bounded by the editor's visible line cap.
- Markdown/inline styling and syntax highlighting are prepared off the UI actor in bounded caches.
  Fenced-code parsing and entry deduplication are linear; metadata-only/ignored batches reuse rows,
  and streamed text reuses committed history. JSON trees decode directly without a second encode/parse.
- Repository reads are short-lived, coalesced and bounded. Hidden changes tabs stop polling, cancelled
  sidebar requests leave the admission queue promptly, and unchanged metadata is not republished.
  Diff collection bounds subprocess output, rather than generating an unlimited patch before clipping.
- Model-catalog settings use asynchronous file reads and SDK-compatible lock waits, without busy-spinning
  the daemon. The SDK retains ownership of settings parsing, migrations and global/project merging.
- Slow WebSocket clients are disconnected explicitly and resynchronize from snapshots, never silently
  lose arbitrary deltas. Internal worker activity watches project only run/inbox state, not history.
- pilotd never spawns Git, jj or gh on its event loop. `spawn` blocks its thread until the child starts
  (hundreds of milliseconds on a saturated machine), so a small bounded worker-thread pool
  (`packages/daemon/src/subprocess.ts`) owns these processes and keeps admission, kernel IPC and
  WebSocket delivery responsive while sidebar summaries and PR syncs run.
- Kernel workers and their build subprocesses run at normal scheduling priority, so a chat starts
  promptly on a busy machine. macOS build/test helpers default to two Swift jobs (`PILOT_SWIFT_JOBS` overrides this;
  explicit test `--jobs` also overrides it), so concurrent agents leave capacity for the UI.

### 6.2 GitHub: PR follow-ups, CI failures and review comments (M3)

**Private-session automatic follow-ups.** The daemon's existing branch-linked PR poller checks failed CI,
unresolved non-outdated review threads, and confirmed merge conflicts on open (including draft) PRs
owned by that session. Each PR has at most one owner, retained durably: the session whose agent created
it, or else the first non-archived, non-Ask private-workspace session to discover it on its branch (an
unrecognized creation, or a PR the session was asked to take over). A PR owned by another session,
archived or not, is never claimed again. Only an idle session with no
queued messages receives one combined follow-up; user input and fresh state win over in-flight lookups.
Each fresh owned head is checked against its own branch, including earlier stack heads when the current
PR is closed or merged. Actionable problems across those heads share one notification and reservation;
a failed health lookup on one head does not hide actionable evidence from another. Creation recognition
accepts ordinary semicolon/newline-separated commit/bookmark/push prefixes when `gh pr create` is the
final executed command, and double-quoted `$(printf|echo|cat ...)` arguments without redirections or
operators (common for PR bodies). It still rejects other substitutions, `--web`, trailing commands, shell
controls, lookups and ambiguous results as creation proof; discovery then claims such PRs instead.
The kernel rechecks idle/inbox state before admission, including after reopening a parked session.

Each session has one persisted budget of three automatic follow-ups total, shared across PRs and all
problem types. At three, polling continues for display but automatic work stops. A user message resets
the budget to zero; automatic messages, new commits and PR changes do not. Each follow-up waits for the
previous run to finish and a five-minute cooldown before fetching fresh health status. Pending CI,
unknown mergeability, resolved/outdated comments, and failed GitHub lookups do not trigger work. The
agent investigates flaky/infra failures instead of blindly rerunning CI, triages feedback, verifies
in-scope fixes, and reports blocked or declined work in Pilot. No GitHub comments, replies, reviews,
merges, or closing actions are permitted.

Merged and closed PRs stop all periodic GitHub polling, including after daemon restarts. Explicit
agent-idle refreshes remain available to discover reopened PRs or a new PR in the same session. The
observed merge timestamp is persisted, so the local archive sweep can enforce the 24-hour deadline
without polling terminal PRs again.

**PR sync architecture.** One daemon-owned scheduler (`PullRequestSync`) owns all GitHub PR state:
session discovery, mission-linked PRs and health for follow-ups. Every session and linked PR has a due
time. Events (an agent turn settling, a PR created by the agent, a client opening a chat or returning to
the foreground with the `focus` message) mark entries urgent so they run next instead of waiting behind a
sweep. A small fixed pool (3 jobs) runs batches: the most urgent entry plus other entries of the same
repository due soon. A batch inspects workspaces locally (git/jj), sends one GraphQL request per
repository for every head and linked PR number, and one more for the health of PRs eligible for a
follow-up. Results apply serially per session. An entry never runs twice at once. Follow-up delivery runs
detached, so starting a parked kernel never delays other sessions' PR checks. The cadence adapts: open PRs
with pending checks every 30 seconds, other open PRs every 2 minutes, sessions without a PR every minute
while recently active, then every 5 or 30 minutes, settled PRs never. Failures back off exponentially up
to 30 minutes, and a nearly exhausted GraphQL budget pauses the host until its reset.

Local inspection (git/jj) is skipped while a process-free fingerprint of the repository (jj operation
heads, or git HEAD and local branch refs) and the session's inputs are unchanged. Shared-workspace bookmark
discovery reads only operations newer than the last one seen. Heads with a known open PR are looked up by PR
number; only when that PR settles or moves is the head searched again. The kernel also sends a
`refs.changed` hint when the agent runs a branch, bookmark, push or `gh pr` command, so a new or pushed
branch is checked right away. The hint only triggers a read-only check; PR ownership still comes only
from recognized `gh pr create` results.

**Triggers**

- `check_suite` / `workflow_run` concluded `failure` on a PR in an allowlisted repository.
- Review comments and reviews with `changes_requested` on a PR, from allowlisted authors, optionally only
  when mentioning `@pilot` or labelled `pilot`.

**Sources.** Local: poll with `gh api` (ETag-aware) every N minutes. Hosted: GitHub App webhooks.

**Flow**

1. Bind to the PR (`owner/repo#number`). Existing binding: steer the same session with the new event.
2. Workspace on the PR head.
3. Triage: CI failure caused by this PR? flaky? infra? Review comment actionable, correct, in scope?
4. Fix, run the relevant checks locally, push one focused commit to the PR branch.
5. Report in the app, never on GitHub: what changed per comment (with commit links), what was declined and
   why, and CI fixes. The pushed commits are the only GitHub-visible output.

**Reuse.** pi-extensions `pr` (`/review-comments`, `/autofix`) logic and prompts.

**Done when.** A failing PR gets a fix commit or an explanation in the app within one poll interval plus run
time; no duplicate sessions or pushes across restarts; Pilot never reacts to its own commits.

### 6.3 Slack: bug reports (M5)

**Tracking foundation (implemented).** Opt-in project settings hold `tracking.slackChannels: string[]`
and `tracking.linearTeam?: string`. Empty settings fetch nothing. The daemon stores external items
in `tracked-items.sqlite`, shared by Linear and Slack, deduped by project/kind/external id. Refreshes
preserve dismissals and linked chat/mission IDs, ignore older versions, and commit a bounded page with
its incremental checkpoint atomically. External text is data, never instructions or an automatic chat start.

`SourceRegistry.register(kind, poller)` supplies adapters with config, cursor, cancellation and a
logical-tool MCP caller. Manual polls are single-flight per project/source, with at most two in flight
globally and no request backlog. Config changes and shutdown cancel obsolete work. Source status is
independent per project, including idle, syncing, error and sign-in required. SQLite and MCP config/auth
work run on workers, not the daemon event loop; dashboard reads use five cached lightweight rows and
counts per source through `DashboardProviders.tracked`. RPC queues and page sizes are bounded (64
requests, 100 items/256 KiB per poll page, 512 KiB MCP result). Socket changes are coalesced and retain
last data on error. There is no background polling yet.

**Access.** Reuse pi's user `mcp.json` and locked `mcp-auth.json`, including OAuth refreshes and
`pi mcp login <server>`; no new API tokens or browser sign-in from the daemon. SDK 1.0.4 exports
`createMcpExtension`, but not standalone config/auth/connection helpers, so the small daemon client
isolates the pinned internal compatibility boundary in `source-mcp-worker.ts` (covered by a real
local MCP/OAuth fixture). It connects only the selected server per call and closes it afterward.
Repository-local MCP files are not loaded by tracking. Disabled/hidden servers/tools are not called.
Tracking connects only the dedicated servers named `linear` and `slack`, with fixed tools:
`list_issues`, `slack_read_channel` and `slack_read_thread`. There are no server/tool overrides,
dispatchers, fallback servers or auto-detection. Project settings accept only Slack channels and
a Linear team. Legacy project MCP overrides are discarded on load while preserving those settings;
checkpoint fingerprints change so old cursors are not reused.

**Payload verification (2026-10-13, read-only).** Dedicated `linear/list_issues` returns JSON
`issues`, `hasNextPage`, `cursor` and requested fields. Dedicated
`slack/slack_read_channel` and `slack_read_thread`: channel history returns a JSON envelope with
formatted `messages` text (message TS and thread delimiters) and `pagination_info`, not structured
message rows. Public search similarly wraps formatted `results` text. Slack normalization must
explicitly validate/parse that format; the framework JSON decoder deliberately does not invent
structured records from markdown.
Actual Linear polling and Slack parsing/classification, scheduling and inbox actions remain follow-up
work; the framework ships no source pollers and reports an unavailable adapter on manual poll until
one is registered. It never posts to Linear or Slack.

**Verification.** Store/restart/dedupe/action tests, config/cursor/cancellation/concurrency tests, HTTP/WS
dashboard integration, a local real MCP fixture (stored OAuth, required sign-in, fixed tools, write-tool
refusal and cancellation), and Swift decoding/editor tests cover the foundation. A 10,000-item disk
run (100 pages, ~700 bytes metadata/item) took 2.923 s, with 127.8 ms p95 commit RPC latency and
12.67 ms daemon event-loop p99; an idle baseline under concurrent builds measured 19.91 ms p99
(noisy measurements, not a speedup claim). Dashboard state remained five rows plus the full count.
Real remote adapter throughput and app scrolling during live source traffic remain unverified until
the pollers and inbox are implemented.

**Triggers.** Messages in allowlisted channels that mention `@pilot`, or a `:pilot:` reaction on a message.

**Source.** Socket Mode (works locally, no public URL); Events API when hosted.

**Flow**

1. Bind to the thread (`channel/thread_ts`). Replies in the thread steer the session.
2. Triage: is this a bug? which repository? enough information to reproduce? Otherwise `ask_human` in
   the thread.
3. Reproduce (test or script), fix in a workspace branch, open a draft PR.
4. Report in the thread: root cause, PR link, how it was verified. Or `declined` with what is missing.

**Done when.** A reported bug yields a reproduction plus draft PR, a precise question, or a decline, in the
same thread; a thread never spawns two sessions.

### 6.4 Linear: spec loop (M4)

**Triggers.** Issue assigned to the Pilot user, or labelled `pilot:spec`, in allowlisted teams.

**Source.** Linear webhooks when hosted; polling the Linear API locally.

**Flow**

1. Bind to the issue. Read the issue, linked issues, relevant code (read-only workspace).
2. Draft a spec as a Linear document (or a section in the description): problem, scope, non-goals,
   approach, acceptance criteria, risks, open questions.
3. `ask_human` with the open questions as a Linear comment (numbered, with options when possible).
4. Human replies in comments; each reply resumes the session, which updates the spec and asks follow-ups.
5. Converges when no blocking questions remain: mark the spec ready, move the issue to the configured
   state, optionally propose sub-issues (created only after approval).
6. Optional handoff: an "implement" label starts an implementation session bound to the same issue.

**Done when.** A labelled issue gets a spec draft and questions; answers update the spec without losing
earlier decisions; the loop survives days of waiting with zero idle cost.

### 6.5 Scheduled and night runs (later)

Cron-like schedules and night-mode style batches (reuse the pi-extensions `night-mode` ledger and
reports), producing a morning summary in the app and Slack.

## 7. App (macOS)

- New-chat composer: Build/Ask mode switch, defaulting to Build, with the existing project, branch and
  model chips. Ask adds Current checkout to the branch menu and labels read-only/no-clone access;
  committed branch sources show their pinned revision in the chat. Build exposes a per-chat workspace
  choice. Ask chats hide terminal/change actions and offer an explicit Start a Build chat handoff.
- Sidebar grouped by origin and state; badges for `waiting` sessions (they need you).
- Project page: clicking a project name in the sidebar (the chevron still folds its chats) or on the Home
  Projects card opens a calm status page for that project, built like the mission Overview. The toolbar
  carries the project name and path, New chat (New mission in its menu) and an actions menu (project
  settings, Finder, archived chats, artifacts). The body is one reading column: a headline sentence and
  meta line, then Needs you (always shown), Working now, Pull requests (readiness when pilotd reports it,
  otherwise plain Open or Draft), Missions with task progress and Recent, each at most 5 rows plus
  "Show all N". Selecting it opens a full-list destination backed by a one-time bounded dashboard read
  (up to 100 rows); live updates on the page remain on the WebSocket, with no polling. First open shows a spinner; a lost connection or failed Retry keeps the last
  data under a banner. Until review marks reach pilotd, the app's own review state hides results the user
  has already reviewed. Scheduled and Tracked sections are added with those features.
- Sidebar scope: a switcher at the top of the sidebar lists every project ("All projects", the default) or
  focuses on one project (View menu, ⌘0 for all and ⌘1…⌘9 for the first nine projects in sidebar order). The
  switcher shows working and needs-you counts per project from `dashboard.counts` (no polling), and its
  compose button starts a chat in the current scope (New mission in its menu). Below it, Home opens today's
  Home with every project, or the project page as "Project home" when focused; its badge counts what needs
  the user in that scope. Focused, the sidebar lists only that project's missions and chats without project
  headers, archived chats are filtered to it, and an "Elsewhere: N working · N need you" line appears when
  other projects have activity (clicking it opens the switcher). Notifications stay global: opening a chat
  from another project returns to All projects. Each scope remembers its last selection, and the live app
  reopens in the last scope. In All projects, clicking a project name still opens its page without
  changing scope.
- Projects can be grouped into user-created, collapsible sidebar folders. Create, rename and delete
  folders, and move projects via their context menu. Ungrouped projects remain visible; deleting a
  folder only ungroups its projects. Folder membership and collapse state are local app preferences
  retained across restarts, never filesystem moves or daemon project changes. Search temporarily
  expands matching folders and projects without changing saved collapse state.
- Manual sessions show a text-colored animated braille spinner while working, and colored status icons
  (done checkmark, failed warning triangle, stopped stop symbol, idle sleeping moon),
  with the status
  in tooltips and accessibility labels, separately from worker lifecycle. Unread completion dots persist
  until reviewed, independently of the outcome:
  reading a question does not answer it. Native macOS notifications distinguish settled runs,
  stops and failures, and deduplicate completion versions across reconnects.
- Pin or unpin chats from the sidebar context menu. Pinned chats show a pin indicator and sort first
  in their project, ahead of PR state and activity ordering. Pins persist across restarts and sync to
  connected clients. Multiple pins retain the normal ordering within the pinned group.
- Session lists put unpinned chats with closed or merged PRs below chats with open/draft/no PRs, even if the
  terminal PR chat is still working. Within each group, newest meaningful activity comes first.
  A newly finished turn moves to the top of its group and resets the compact elapsed indicator to
  `now` (the first minute), using its stable completion timestamp rather than generic metadata updates.
  Settled chats use the later of completion and latest user submission; working chats retain live activity
  ordering. Active session lists share this ordering; archives retain their archive-date order.
  Closed/merged PR chats have no unread indicators or completion notifications. Suppressed completion
  versions are still observed, so reopening a PR cannot replay old notifications (unreviewed results
  may become unread again on reopening). Last-known terminal PR states obey the same rule.
  An active mission's coordinator is exempt: it sorts with active work, keeps unread indicators and
  completion notifications, and shows the coordinator indicator rather than a done state.
- Chats whose isolated workspace holds work no PR carries stay active: uncommitted edits, commits or
  bookmarks without a PR, and new commits after a merge (`unpublishedWork`). They are exempt from
  inactivity and merge archiving and from terminal-PR presentation until the work is published or
  discarded. A commit is published when it is an ancestor of the base, the default branch or a linked
  PR's head (local or origin bookmark/branch); empty jj changes are ignored. The daemon checks idle
  chats only, because jj snapshots the working copy: after a finished turn and on PR settlement when
  every linked PR is merged or closed, and before an automatic archive (at most every 30 minutes per
  blocked chat). Failed checks keep the last known result.
- The chat transcript shows an activity indicator while the agent is working, but no settled
  status icon or outcome-reason footer. Reaching the transcript end in the active window still
  marks the latest settled outcome as reviewed; status icons remain elsewhere in the app.
  Explicit and visible reviews persist locally and forward to `POST /api/reviews`. After the first
  connection snapshot per app launch, the newest local marks are backfilled in one request (at most
  1000). Delivery is serial and coalesced; failed marks retry on the next review or reconnect, without
  polling. Project Needs you and sidebar scope counts use daemon state, without local subtraction.
- Private-branch sessions show a linked colored PR icon and number independently of run outcome;
  open PRs share the three-node Git branch glyph with the base-branch selector, retaining their green color.
  Tooltips and accessibility labels distinguish Draft, Open, Merged or Closed without merging.
  Sidebar rows also show the changed-file count, added/deleted line totals since the session base,
  and the workspace branch after a middle-dot separator,
  including before a PR exists. Visible rows refresh lightweight repository summaries every ten seconds,
  with at most four sidebar requests in flight;
  failed lookups omit the count rather than showing zero, and long branches truncate with a full-name tooltip.
  The daemon discovers PRs by the exact workspace branch and
  repository, polls active PR status at startup and on an adaptive cadence until merged or closed (§6.2),
  and refreshes immediately after settled work, PR creation and when a chat is opened. It persists the last successful status. Failed lookups
  retain the cache but label it as last known, never as a fresh merge result. Direct/shared-folder
  sessions are not auto-linked.
  A session can open several PRs: switching branches keeps earlier PRs linked, and private clones
  also check their other local branches, so PRs opened from several branches in one run are found.
  Shared jj workspaces only track branches the session was observed using. Rows show one badge per PR,
  the current branch's first. Polling continues while any linked PR is open, and merge archiving waits
  until every linked PR is merged or closed.
- Chat: markdown, diffs for edits and patches, tool cards, steer and follow-up, stop. Show all queued
  user messages as compact one-line rows at the top of the composer tray until consumed, restoring
  them on reconnect. Background job
  completion notifications still reach the agent but do not appear in the composer queue. Display steering before
  follow-ups, preserving FIFO order within each mode. Edit queued messages inline, using Alt+Up/Alt+Down
  to navigate, Enter to save as steering, Option-Enter to save as a follow-up, and Escape to cancel.
  Saving keeps the message's queue position. Preserve drafts while navigating and reject edits
  after consumption without resubmitting. Remove individual queued messages before delivery without
  stopping the active run; clearing an inline edit and submitting it removes the selected row.
  Command-Delete keeps normal text-editing behavior. Reject removal once a message has been consumed.
  Removal errors are dismissible inline warnings that clear after five seconds or when leaving the
  chat, without changing drafts.
- Message times: user bubbles and assistant text reveal a muted date/time footer only on click.
  Click again or elsewhere in the window to dismiss. Use the original pi-ai epoch-millisecond
  timestamp in local time, with exact date, seconds and timezone in the tooltip and accessibility
  label. Missing or invalid legacy timestamps stay hidden. Native text selection and message
  controls remain usable; revealing a footer pauses bottom-follow like expanding a message.
- Keep unsent text, image attachments and queued-message edits per chat when navigating between
  chats, Home and archives or reopening the window. Keep the new-task form and its base-branch
  selection too. Save drafts atomically to a private local JSON file in
  `~/Library/Application Support/Pilot/Drafts/drafts.json`, restoring text, attachments, queued edits
  and new-task selections across app restarts. Missing images do not prevent text restoration;
  unreadable or unsupported draft files are preserved and reported rather than overwritten.
  Navigation never sends or clears drafts. Sending clears the submitted draft, and an explicit debug prefill
  replaces the new-task draft without being erased by an older pending spawn.
- Inline diagrams: completed `svg` and `mermaid` Markdown fences render in chat; unclosed streaming
  fences remain code. Borderless previews fit the chat width and expand on click, with source/copy
  controls in the expanded viewer and context menu, and source fallback on errors. Offscreen rows
  release their renderer. Nonce-CSP WebKit sandboxes display SVG only as inactive
  data images, with strict bundled Mermaid rendering, no external resources, and a 512 KiB source limit.
- Archive inactive chats without deleting their history. Shared jj working directories may be reclaimed
  after the retention period, with recoverable snapshots restored on resume (§5.4). Browse archived chats globally
  or per project, search them, and restore them to continue the conversation. Stop running chats first.
  The daemon checks once a minute to automatically archive chats after one week without activity,
  skipping running chats and pending admissions. Restoration grants another week, including across
  daemon restarts, without changing chat ordering. Observed GitHub merges automatically archive
  inactive linked chats no earlier than 24 hours after GitHub's merge timestamp. The observed merge
  time persists and the local archive sweep enforces that deadline without polling merged PRs again.
  Failed lookups and closed, unmerged PRs never trigger merge-based archiving. Restoring a merge-archived
  chat keeps it active for that PR, including after daemon restarts (the one-week inactivity rule still applies).
  Pinned chats are exempt from both inactivity and merge-based automatic archiving until unpinned;
  manual archiving remains available and preserves the pin on restore.
- The compact session header keeps title and project/model on the left. Branch and linked PR metadata
  sit immediately left of the top-right inspector toggles, outside their shared button background;
  branch labels use the three-node Git glyph and truncate in the middle with a full-name tooltip.
  Changes, Terminal and Artifacts remain visible; Archive/Restore and Debug live in the overflow menu.
  There is no Finder button or extra metadata row.
- Debug a session from the top-right overflow menu, including failed and archived chats. Open the new-task
  composer in the project named `pilot`, prefilled with the source session ID, daemon-provided data path
  and working directory. The user adds an issue/reason before submitting; opening the draft never starts
  an agent or changes the source session. Missing or ambiguous `pilot` projects surface an actionable error.
- Task and chat composers complete local file and folder paths on Tab, relative to the selected project
  or session working directory; absolute paths and `~/` work too. A compact floating path picker shows
  file and folder icons with keyboard hints at the bottom, without a header or redundant metadata.
- Typing `/` at the start of a chat message opens a slash command menu in the same floating picker style:
  Pilot's built-in `/compact [instructions]`, then the session's prompt templates (`/name`) and skills
  (`/skill:name`). Tab completes, Return runs (a template with an `argument-hint` is completed instead).
  Templates and skills are sent as ordinary messages and expanded by the kernel on admission. `/compact`
  is handled by Pilot (`POST /api/sessions/:id/compact`): it queues a durable manual compaction that runs
  alongside work and shows "Compacting context…" until the summary is placed. The list
  (`GET /api/sessions/:id/commands`) is loaded the first time the menu opens and cached by pilotd from
  each kernel's ready packet, so it reopens a parked chat at most once. Extension commands and the
  new-task composer are not covered yet.
- Compaction and reset hide older entries from the snapshot, but storage keeps them. A compacted chat
  shows "Show earlier messages" at the top of its transcript, which loads them a page at a time
  (`GET /api/sessions/:id/history?before=<entryId>`, 100 entries by default, cut short past 4 MiB). pilotd
  reads pages on its snapshot reader threads, never waking a parked kernel; the app reduces each page in
  order with the live stream, and scroll anchoring keeps the visible rows in place. Loaded pages survive
  reconnect snapshots for the same compaction and are dropped when the chat is closed.
  Anchored native row markers observe their own and ancestor frame/bounds changes, excluding the
  clip view's user-scroll offsets. Observation ends when a marker is unanchored or detached;
  recapture preserves subscriptions for overlapping visible rows, without polling or forced layout.
- Conversation attempts let a chat continue from an earlier point without losing what happened after it.
  The durable conversation is never truncated: Pilot forks it (pi-durable `fork`) and switches the session to
  the fork, recorded in a session-scoped `pilot.attempts` document that kernels, cold views and history read.
  Every action first stops the current run (queued input is withdrawn), asking for confirmation while work is
  running. Workspace files are never reverted, and the latest model and thinking choice carries over.
  - Retry: a small Retry button on the error row of the last turn, only when that turn failed and the chat is
    idle. It forks just before the user message that started the turn and resends it, so the new run gets the
    harness's usual bounded automatic retries (3, with backoff). It is always manual and never loops, and it
    is offered for non-retryable errors too (quota, auth), since the user may have switched model or fixed them.
  - Edit and Resend (user message context menu): forks just before the message and puts its text in the
    composer to change and send. Editing the first message starts an empty conversation.
  - Restore to Here (agent reply context menu): forks at the end of that turn, before the next user message,
    so no tool call is left without its result.
  - A toolbar chip ("Attempt 2 of 3") lists the original and every attempt, and switches between them. An attempt
    that holds nothing but failed or stopped turns is hidden once left, so repeated retries of an overloaded
    provider do not pile up. The list is bounded.
  - pilotd holds the configuration lock throughout, then replaces the retired kernel with one that opens the new
    attempt and reattaches every viewer. The left attempt's outcome and errors are cleared.
- Task and chat composers accept native clipboard images with Command-V, showing removable previews
  above the text input. Save app-owned PNG copies in Application Support and include their absolute
  paths in the message for pi's read tool. Image-only messages are supported; sent files are retained
  for queued delivery and later reads, and failed sends keep the attachments available for retry.
  Removing unsent attachments cleans up their files; persisted drafts retain their images across app
  shutdown, and submission attempts retain files even if the response
  is lost. Delete persisted images only after saving a snapshot without them. Write a `.submitted`
  sidecar before sending images so a stale draft snapshot cannot later delete history's files;
  an image-retention failure prevents submission. Accept up to eight raster images per message,
  32 MiB and 24 megapixels each.
- Chat footer: live context-window estimate and Claude/Codex subscription windows with reset times.
  Subscription quotas are account-wide: pilotd reads pi-extensions' shared usage cache
  (`<agentDir>/cache/usage-status/<provider>/cache.json`), whose single elected poller may be any pi
  process, including Pilot's kernels. pilotd never polls or reads credentials. Every session, parked or
  live, shows its provider's snapshot; kernels report only context and the physical provider (resolving
  virtual routers). Snapshots older than ten minutes stay visible, marked as not recent.
  A subtle controls row below the message box combines model and thinking-level selectors with labeled
  context, 5h, and weekly usage gauges. Both can be changed while idle with no queued messages and are
  pinned per chat across reopening. Thinking choices follow the selected model's supported levels.
  Click subscription usage for snapshot details and reset times. Concrete Claude/Codex models show
  an explicit unavailable state when no snapshot arrives, never a fabricated zero measurement.
- Chat TODO panel: read-only live view of pi-extensions' file-backed TODO store (`.pi/todos`, or
  `PI_TODO_PATH`), with this session's claimed open tasks first, titles/statuses visible above the
  composer, and expansion for the full list. Poll only while subscribed, including during codemode
  work; reconnects reload files without modifying extension-owned state.
- Subagents: pi-extensions `subagents` reports named background subagents over the extension event bus
  (`subagents:snapshot`); the kernel forwards them and pilotd keeps the latest list in session metadata,
  so parked sessions still show them. Clients get name, state, task, model, cwd, answer identity and
  error, never storage paths. A chip strip above the composer shows each subagent's state (working,
  new answer, failed, idle) and opens a popover with recent activity, Stop and "Open transcript". The
  inspector's Agents tab lists them with the selected subagent's full read-only transcript (read from its
  private `runs.sqlite`, never waking a parked kernel), plus Steer, Queue and Stop. Answers delivered
  to the parent render as compact answer cards. Unread answers are tracked locally per answer ID.
  Transcripts stream over `subagent.subscribe`: pilotd runs one long-lived reader thread per watched
  subagent (at most 8), shared by all viewers. It polls only the size and mtime of `runs.sqlite` and its
  WAL every 250 ms (about 1 ms of CPU per second when idle) and, on a change, reads just the new entries
  in a short read transaction, so it never pins the child's WAL. A moved head marker (compaction)
  sends a fresh snapshot. `GET …/transcript` supports `?after=<entryId>` and an ETag for one-off reads.
  Extension messages that start a turn (`sendMessage` with `triggerTurn`, `sendUserMessage`) become
  durable Harness input, so subagent answers wake the parent; identical notifications are admitted once.
- Responsiveness: decode conversation snapshots and prepare transcript rows/tool summaries off the UI
  actor, preserve stream ordering, and publish prepared rows once per batch. Long tool groups render
  lazily; loading and startup have visible progress. Procedural home artwork renders off main as well.
- Questions panel: answer `ask_human` gates inline.
- Artifacts: durable images, HTML/JS, React/JSX or standalone SwiftUI documents owned by a session and its project. Agent tools
  create, update, list, read and preview them. Each publication saves an immutable revision; chat
  previews are shown by default and pin that revision, while sidebar access opens the latest.
  The right-hand inspector's Artifacts tab lists every artifact in the current chat, updates live,
  and opens the latest revision on click. Project-wide browsing remains in the navigation sidebar.
  Plain PNG, JPEG, GIF and WebP files (or data URLs) are embedded with their revisions, up to 16 MiB.
  Chat previews are borderless, transparent embedded content in the same readable column as prose,
  aligned to its leading edge. Loading placeholders begin at 360 to 720 points tall, then measured
  previews shrink or grow to their content height, between 48 and 1600 points. Small images keep
  their natural size, aligned left;
  page-shell backgrounds and padding are removed inline, but authored inner surfaces are preserved.
  Image previews use intrinsic aspect ratio; HTML/React measurements update
  after rendering, responsive reflow and asynchronous content changes. Viewport-relative CSS cannot
  cause unbounded resize feedback. Expanded viewers start at 90% of
  the usable screen and can grow for content to a 16-point screen margin, without going offscreen.
  Clicking opens images and diagrams at a larger size,
  or an interactive sandbox for apps. Expanded artifact viewers always show the preview, with no
  Preview/Source switch. Their Share menu copies file content, materializes a pinned source/image file
  locally to copy its full path or reveal it in Finder, saves the original source/image with Save As,
  and copies or exports a PNG of the full preview, including content scrolled out of view and
  interactive state (capped at 8192 points on the longest side). Local files live
  in the app's artifact export cache, not the daemon's private store.
  The single viewer header has a close icon on the left, artifact type beside the revision label,
  and Share on the top right, without a repeated compact revision badge.
  Images and SwiftUI screenshots fit the viewport without enlargement beyond their natural size,
  including previously saved revisions.
  Markdown diagram source remains available from its context menu; its expanded viewer uses 90% of the display's usable area.
  Offscreen chat rows release their renderer; previews can also be hidden manually. An older running
  daemon without artifact routes prompts for a restart once agents are idle.
  Library bundles are prebuilt for releases, served with ETags, and kept in one shared, revalidated
  in-app copy that survives brief daemon restarts. React artifacts load the shared React scripts instead
  of embedding React. The content blocker is compiled once per app run, idle previews measure size less
  often, and a crashed WebKit renderer reloads once. Pinned revisions cached for scrolled-away rows are
  bounded by bytes as well as count. Native WebKit renders isolated,
  offline previews, with no shell, filesystem, credential or daemon access. React, ReactDOM, Mermaid,
  ECharts and Motion are bundled; D3 and Three.js are opt-in bundled libraries. JSX compilation accepts
  only those libraries, not arbitrary package installs. Optional agent screenshots and console
  diagnostics use an isolated Playwright browser (`npm run artifacts:browser` installs Chromium).
  The preview action is exposed only when Chromium or the native Swift toolchain is installed at session startup, and is never
  required before publishing. Pilot-only system guidance encourages useful explanatory diagrams,
  preferring simple Mermaid, only while the artifact tool is available (including through codemode).
  The compact tool lives in an `artifacts` namespace, whose summary remains visible even when codemode's
  description budget omits the full schema. Detailed authoring rules and examples live in the bundled
  `pilot-artifacts` skill, advertised on session open/reopen and read on demand. Ask loads only this host
  skill (not user/project skills); its reader permits the exact bundled document, never sibling files.
  SwiftUI artifacts define `ArtifactView` and compile/render in disposable macOS `sandbox-exec`
  processes using the installed Swift toolchain (Command Line Tools or Xcode). SDK aliases are resolved
  before sandboxing; full Xcode compilation also permits its selected llbuild framework, not the whole
  application bundle. Source remains editable; publication embeds
  a content-sized, transparent PNG at 2x density for offline viewing without recompilation. Layout
  defaults to at most 760 points wide and 1600 points tall; smaller content hugs its natural size.
  Saved HTML carries the logical image dimensions and density, while older revisions retain their
  legacy viewport sizing. Draft preview width/height are layout ceilings, not a forced canvas;
  bitmap dimensions are physical pixels and content height is logical points. Width changes require
  re-rendering to reflow native content, not merely scaling the static bitmap. Draft previews support custom bounds
  and bounded compiler/runtime diagnostics, cancellation and a five-minute deadline. No network,
  workspace or credential access is granted. These are static, standalone previews, not project-aware
  or interactive views; agents use artifacts to show UI changes and label prototype limitations.
  Compiles run in two locked slot directories with private APFS clones of a trusted, prewarmed SDK
  module cache (about 1.5 seconds instead of about 35), and identical renders are reused in memory.
  Browser previews share a warm Chromium with a fresh context each; HTML/React publications return
  page errors as non-blocking warnings, as do updates without expectedRevision. Revision files are
  fsynced, unreadable entries are skipped when listing, image bytes are stored once, and revisions
  record their library versions.
- Missions (§5.7): a Missions sidebar section above Projects lists active missions with a Needs you
  count and their chats. Mission summaries carry `needsYouCount` (blocked tasks plus open, unaddressed
  agent comments when the user coordinates); the app adds locally unread member-chat results. Only
  visible detail views subscribe to full mission detail, not sidebar badges.
  Each active mission's coordinator chat comes first, ahead of pins, PR state and activity,
  with a gold star and tooltip shared with the Chats tab and mission header. Mission chats also stay
  under their project with a mission chip. The mission
  page has Overview (progress, tasks, Needs you, recent activity, resources), Brief (editor, revisions,
  decisions, comments), Tasks (grouped by status or milestone, reorder, Start chat), Chats (including
  archived), Artifacts and Activity tabs. The chat inspector gains a Mission tab with the chat's task,
  the brief and other tasks. Needs you collects member chats waiting on the user, PRs ready for review,
  blocked tasks, comments for the user and pending external closes.
- Terminal: libghostty per Build session (⌘J), on a pilotd-owned PTY streamed over the WebSocket, so it survives app
  restarts and works against remote daemons.
- **Private releases and updates (implemented):** Release Please generates semantic-version release
  PRs and changelogs on `main`; metadata-only PRs skip workflows and need no workflow approval.
  CI publishes only when Release Please creates a stable `vX.Y.Z` arm64 macOS release or an existing
  stable draft is explicitly retried. Drafts stay unpublished until the signed `Pilot-arm64.zip` and
  `appcast.xml` are complete, with retries
  against tagged application source using current packaging helpers, with semantic and Sparkle
  build-order safeguards. App versions follow
  root `package.json`; build numbers remain
  monotonic workflow numbers for Sparkle. Ordinary main pushes do not publish dev prereleases;
  existing dev releases remain untouched. ZIP is the default first-time installer. The manual
  **macOS DMG installer** workflow (`.github/workflows/macos-dmg.yml`) takes no tag input, captures the
  latest published stable tag once, downloads its ZIP, extracts the built app, verifies codesign,
  and attaches a DMG to that same release without rebuilding, signing, or changing appcast/latest.
  An existing DMG errors rather than being overwritten. Self-contained Node
  and pilotd runtime, with source maps and TypeScript declarations removed in isolated staging before
  signing. Ad-hoc signing without Apple membership, Sparkle Ed25519-signed archives in private
  GitHub Releases. Authentication first reuses local `gh auth token`; if unavailable or denied, the app
  asks for a repository-read GitHub token and saves that manual fallback in Keychain. CLI credentials
  remain in memory and are refreshed each check. Hourly checks while the app
  runs; installation waits for idle agents and queued work, acquires a bounded admission pause via
  `POST /api/update/prepare`, stops the launch agent, installs and relaunches. Terminal shells close,
  durable history remains. One-time key configuration and initial installation: [UPDATES.md](apps/macos/UPDATES.md).

### Scheduled chats and follow-ups (store and dispatch implemented)

- `pilotd` owns `schedules.sqlite`. A new-chat target retains the complete `SpawnRequest`;
  a message target retains its chat ID and follow-up text. Triggers are `at` (epoch milliseconds),
  `on_wake`, `on_online` (next offline-to-online edge), and default `on_back` ("When I'm back":
  next wake, then network reachable). `at` defers while offline and catches up when online.
- Pending items can be edited or cancelled. A revision/state compare-and-swap commits a
  `dispatching` claim before any session effect, so racing triggers, edits and cancellation have
  one winner. Dispatch is serial and follow-ups use the durable input key `schedule:<id>`.
  Success records the created/target chat; admission errors (including deleted/archived targets)
  become failures under the project's Needs you section. Fired means admitted, not agent completion.
- Restarts retain pending items and the wake-observed latch. An interrupted claim becomes an
  explicit uncertain-delivery failure, never an automatic replay: users should check chats before
  rescheduling. This guarantees one dispatch attempt, not transactionally exactly-once delivery
  across the scheduler and session stores. Terminal records can be dismissed with DELETE.
- SQLite/WAL and fsync run in a dedicated worker. The index is bounded to 1000 items and 4 MiB of
  target payloads (16 KiB per target); RPC and trigger queues cap at 64. Dashboard projections and
  timer/trigger candidate scans do not copy prompts. Large HTTP/WS indexes are serialized in the
  worker, not on the event loop; updates coalesce at 250 ms. One nearest-deadline
  timer runs only while online; all timers/subscriptions stop on shutdown, and detectors get an
  active/inactive hint so they can suspend probes when no pending items remain.
- `ScheduleTriggerSource` injects initial reachability and wake/online events; `ScheduleClock`
  provides fake-clock testing. OS wake and network detection is still a separate implementation.
  Until a detector is registered in `daemon.ts`, reachability is unknown and network-gated items
  stay pending. Composer/list UI and fired notifications remain separate work.
- The server registers `DashboardProviders.scheduled` and its change subscription, so pending
  items populate Scheduled and failures populate Needs you without app polling. Protocol and
  PilotCore mirror CRUD payloads, targets, lifecycle and WS snapshots; the app retains the index
  for the later scheduling UI.

## 8. API additions

| Endpoint / message | Purpose |
| --- | --- |
| `GET/POST /api/schedules`, `GET/PATCH/DELETE /api/schedules/:id`, WS `schedules` | Bounded durable index (optional `projectId` GET filter), create, pending-only edit (optional `expectedRevision`), cancel pending or dismiss terminal items. In-flight dispatch returns 409 on edit/delete. WS sends the full index on connect and coalesced changes. One-shot `at`, `on_wake`, `on_online`, default `on_back`; new chats retain a full spawn request and messages dispatch as follow-ups |
| `/api/projects` (GET, POST), `/api/projects/:id` (GET, PATCH, DELETE), WS `projects` | Projects (done in M1); policies and bindings will attach to them |
| `GET /api/projects/:id/branches`, `SpawnRequest.baseBranch` | List origin's live branches and choose the base of a new private-clone session (done) |
| `SpawnRequest.mode`, `.workspace`; `SessionSummary.mode`, `.workspace`, `.sourceBranch`, `.sourceCommit` | Immutable Ask/Build mode, per-chat Build workspace policy and source identity |
| `GET /api/projects/:id/branches?mode=ask` or `?mode=build&workspace=clone` | List origin heads even for projects whose default Build policy is direct |
| `POST /api/update/prepare` | Atomically grant a bounded admission pause if agents and queued admissions are idle (`{ ready }`, done) |
| `PATCH /api/sessions/:id/queue/:submissionId`, `DELETE /api/sessions/:id/queue/:submissionId` | Edit or remove a still-queued user message without resubmitting or interrupting the active run (done) |
| `POST /api/sessions/:id/rewind`, `POST /api/sessions/:id/attempts/:attemptId/activate`, `SessionSummary.attempts` | Retry, edit or restore into a new conversation attempt, and switch attempts; stops current work first and never reverts files (done) |
| `GET /api/sessions/:id/artifacts`, `GET /api/projects/:id/artifacts` | Session and project artifact indexes |
| `GET /api/sessions/:id/artifacts/:artifactId?revision=N` | Read a pinned revision (latest when omitted) |
| `GET /api/artifact-libraries/:name`, WS `artifacts` | Read-only offline library assets and live session artifact indexes |
| `SessionSummary.origin`, `.binding`, `.outcome`, `state: "waiting"` | Origin-aware lists and badges |
| `SessionSummary.pullRequest`, `.pullRequests`, `.pullRequestError` | Branch-linked GitHub PR status (current branch, and every PR the session opened) and cached-lookup errors (done for private manual sessions) |
| `GET /api/sessions/:id/changes/summary` | Lightweight base, branch, changed-file count and added/deleted line totals for sidebar rows, without generating patches (done) |
| `GET /api/sessions/:id/questions`, `POST /api/sessions/:id/answers` | Human gates from the app |
| `POST /api/sessions/:id/archive`, `POST /api/sessions/:id/restore` | Archive inactive chats or restore them, retaining history with recoverable jj snapshots (done) |
| `POST /api/sessions/:id/pin`, `POST /api/sessions/:id/unpin`, `SessionSummary.pinned` | Persist a user pin, sort pinned chats first, and prevent automatic archival until unpinned (done) |
| `POST /api/sessions/:id/reclaim-workspace` | Manually reclaim an eligible archived shared jj workspace using the same snapshot/config preservation and unknown-file safety checks |
| `GET /api/sessions?archived=true&projectId=…&missionId=…` | Browse archives globally, per project or per mission (done); default lists exclude archives, `archived=all` includes both |
| `SessionSummary.archivedAt`, WS `sessions` / `session` | Persist archive timestamp; WS includes active and archived chats for local filtering (done) |
| `SessionSummary.lastUserMessageAt` | Stable latest user-submission time for completion-aware session ordering and elapsed indicators (done) |
| `SessionSummary.workspaceStorage`, `.workspaceReclaimedAt`, `.workspaceCleanupError` | Shared jj storage marker (absent for legacy/direct), reclamation timestamp, and safe-cleanup failure metadata; Swift labels shared/reclaimed workspaces |
| `SessionSummary.sessionPath` | Daemon-provided session data directory for debug drafts, independent of the workspace path (done) |
| `GET/POST /api/missions?projectId=…`, `GET/PATCH/DELETE /api/missions/:id`, WS `missions` | Mission index and settings (status, coordinator, Autopilot); clients subscribe with `mission.subscribe` for `MissionDetail` |
| `GET/PUT /api/missions/:id/brief?revision=N`, `GET /api/missions/:id/brief/revisions` | Versioned brief; PUT requires `expectedRevision` and returns 409 when stale |
| `/api/missions/:id/tasks` (POST), `/tasks/:taskId` (PATCH, DELETE), `/tasks/:taskId/claim`, `/tasks/:taskId/start` | Tasks, atomic claims and Start chat (returns the new session) |
| `/api/missions/:id/decisions`, `/comments`, `/resources`, `/artifacts` (POST, PATCH/DELETE by id), `/events` (GET, POST) | Decisions, anchored comments, external links, artifact links and activity |
| `PUT/DELETE /api/sessions/:id/mission`, `SessionSummary.missionId`; `CreateMissionRequest.fromSessionId`, `.coordinator`, `.draft` | Join or leave a mission (same project only); Make a mission from a chat, which then drafts it |
| `GET /api/sources?projectId=...`, `POST /api/sources/:id/poll` | Project-scoped tracking status and single-flight manual poll; id is `<projectId>:linear/slack`; WS `sources` sends status on connection/change |
| `GET /api/tracked-items?projectId=...&kind=...&dismissed=true&limit=...&offset=...`, `PATCH /api/tracked-items/:id` | Bounded tracked inbox (100 maximum, default non-dismissed); patch dismissal or linked chat/mission (null clears). Links must belong to the same project. WS `tracked.changed` invalidates the list without broadcasting external bodies |
| `GET /api/projects/:id/dashboard`, WS `dashboard.subscribe` / `dashboard`, `ProjectDashboard` | Project page aggregate: Needs you (failed or unreviewed chats, mission questions, failed scheduled items), Working now, open PRs (Ready to merge first once readiness exists), active missions with done/total, working and needs-you counts, Scheduled, Tracked (one group per source with status) and Recent finished chats. Each section carries at most 5 rows plus its full `total`, and `summary` feeds the headline sentence. Read from sessions, missions and the PR tracker already in memory; no polling. Scheduled and tracked data come from optional `DashboardProviders` (empty until the scheduler and tracking sources register) |
| `GET /api/dashboard/counts`, WS `dashboard.counts` | Working and needs-you counts per project for the sidebar scope switcher, sent on connect and when they change |
| `GET /api/projects/:id/memory`, `POST .../memory/note` (`{ text, sessionId }`) | Memory summary; append one explicit note from a chat belonging to the project, returns the durable entry |
| `GET .../memory/wake?lines=96`, `GET .../memory/recall?regex=…&lines=96` | Bounded wake view (nodes and prompt text), streamed newest-match recall (entries, matches, truncated); no model dependency |
| `GET .../memory/zoom?lo=0&hi=31`, `POST .../memory/forget` (`{ lo, hi }`) | Inclusive aligned power-of-two range. Zoom returns two children; forget drops cache suffixes and ancestors, returning `{ ok: true }` |
| `POST /api/reviews` (`{ marks: [{ sessionId, outcomeAt }] }`) | Daemon-side record of reviewed chat results (`reviews.json`, marks only move forward, at most 1000 per request), so "unread" in the dashboard and counts matches what the user has seen. Clients forward their reviews, and may backfill their local marks once |
| `GET /api/audit` | External effects log |
| WS `questions` | Push new questions to clients |

## 9. Milestones

| Milestone | Scope | Definition of done |
| --- | --- | --- |
| **M1 Spawn and chat** | Daemon, kernel, native app with chat, projects, launchd agent, notifications | Spawn, steer, stop from the app; sessions survive daemon restarts; app quit leaves agents running |
| **M2 Terminal** | libghostty pane backed by daemon-owned PTYs (done) | Terminal per session in its workspace; reattach with scrollback after app restart |
| **M3 Foundations + GitHub** | Workspaces and GitHub posting policy (done); origins, bindings, triage, outcome reporter, audit log, config file; GitHub source | §6.2 done-when, with a dry-run mode that pushes nothing |
| **M4 Linear spec loop** | `ask_human`, `waiting` state, questions panel; Linear source | §6.4 done-when |
| **M5 Slack bugs** | Slack Socket Mode source | §6.3 done-when |
| **Missions** | §5.7 phase 1, then coordinator (phase 2) and Linear resource automation (phase 3) | A goal is split across chats that share brief, tasks and artifacts, tracked from one mission page, with no mission references in PRs |
| **M6 Hosted** | Authenticated remote daemon, GitHub App, webhooks, multi-user tenancy, server workspaces | background-agents.com runs the same flows for a team |

## 10. Risks

- **Prompt injection from external text.** Mitigated by triage gating, policy-only permissions, sandbox
  floors and push rules. Needs adversarial tests per origin.
- **Noise.** Pilot never comments on GitHub; in Slack and Linear, default to fewer, denser messages; dry-run first.
- **libghostty ABI churn.** Pinned release, vendored; audit each bump.
- **pi SDK coupling.** The native adapter mirrors pi internals (ported from pi-extensions subagents).
  Track pi releases; keep the adapter small and tested.
- **Replay-unsafe tools.** A crash mid-tool yields an interrupted result; external effects go through the
  outcome reporter, which is idempotent.

## 11. Open questions

1. ~~Workspace source of truth~~ Decided: daemon-owned Build workspaces and read-only Ask sources (§5.4).
2. ~~Identity~~ Decided for GitHub: never posts; opens PRs as the user (§5.5). Slack and Linear identity open.
3. ~~Replies to declined review comments~~ Decided: only a note in the app.
4. Where do specs live: Linear documents, the issue description, or a repo file linked from the issue?
5. Hosted tenancy: one daemon per user, or a shared scheduler with per-tenant workers?
