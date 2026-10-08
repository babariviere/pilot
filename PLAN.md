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
- Open chats show mode and workspace context in the top toolbar beside branch/source and PR metadata,
  not as a separate row above the composer. Ask source details include the pinned commit in the tooltip.
- Branch-specific Ask sessions fetch the selected origin head into a session-owned bare object store,
  fetch only the selected head's snapshot, pin its commit before starting the worker, and read/search
  that tree without creating a checkout.
  They never switch or modify the user's checkout, and reopening keeps the pinned revision. Branch
  snapshots exclude local changes. A refresh of the branch menu lists current origin heads; missing
  branches fail preparation rather than silently falling back to another source.
- Ask workers load only host-owned read/search tools and session-local artifact tools. User and project
  extensions, MCP, shell tools, jobs, and repository-write tools are not loaded, not merely hidden or
  blocked. Repository read-only access is a capability boundary, not a prompt convention. Ask sessions
  cannot open a terminal or publish repository changes. They can create, update and preview their own
  artifacts using the isolated offline renderers, without arbitrary image-file reads. Codemode can only
  call this restricted tool set; artifacts and completion reporting are session-local capabilities.
  Mode is immutable for a chat; implementation starts a separate Build draft with the conversation
  as context, preserving the Ask chat and its selected source.

- New isolated Build sessions for jj projects use session working copies backed by a shared repository
  in `$PILOT_HOME/repositories`. The working-copy change starts on the selected base. Workspace edits
  leave the user's own checkout untouched, but bookmarks and repository history are shared with sibling
  sessions. Existing clones are not migrated; Git-only projects, direct Build checkouts, and Ask remain unchanged.
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
  remains on disk. Archived shared jj workspaces are eligible for cleanup after 30 days, configurable
  with `PILOT_WORKSPACE_RETENTION_DAYS`; `0` disables cleanup. Legacy clones and direct/Ask sources are
  not reclaimed by this policy. Never delete while a PR is open.
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
- Kernel workers and their inherited build subprocesses run below normal scheduling priority when
  supported. macOS build/test helpers default to two Swift jobs (`PILOT_SWIFT_JOBS` overrides this;
  explicit test `--jobs` also overrides it), so concurrent agents leave capacity for the UI.

### 6.2 GitHub: PR follow-ups, CI failures and review comments (M3)

**Private-session automatic follow-ups.** The daemon's existing branch-linked PR poller checks failed CI,
unresolved non-outdated review threads, and confirmed merge conflicts on open (including draft) PRs
actually created by the agent in that session. PR ownership is recorded from successful agent creation
tools and retained durably, not inferred from a matching branch alone. Only an idle session with no
queued messages receives one combined follow-up; user input and fresh state win over in-flight lookups.
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
- The chat transcript shows an activity indicator while the agent is working, but no settled
  status icon or outcome-reason footer. Reaching the transcript end in the active window still
  marks the latest settled outcome as reviewed; status icons remain elsewhere in the app.
- Private-branch sessions show a linked colored PR icon and number independently of run outcome;
  open PRs share the three-node Git branch glyph with the base-branch selector, retaining their green color.
  Tooltips and accessibility labels distinguish Draft, Open, Merged or Closed without merging.
  Sidebar rows also show the changed-file count, added/deleted line totals since the session base,
  and the workspace branch after a middle-dot separator,
  including before a PR exists. Visible rows refresh lightweight repository summaries every ten seconds,
  with at most four sidebar requests in flight;
  failed lookups omit the count rather than showing zero, and long branches truncate with a full-name tooltip.
  The daemon discovers PRs by the exact workspace branch and
  repository, polls active PR status at startup and about once a minute until merged or closed,
  and explicitly refreshes after settled work. It persists the last successful status. Failed lookups
  retain the cache but label it as last known, never as a fresh merge result. Direct/shared-folder
  sessions are not auto-linked.
  A session can open several PRs: switching branches keeps earlier PRs linked, and private clones
  also check their other local branches, so PRs opened from several branches in one run are found.
  Shared jj workspaces only track branches the session was observed using. Rows show one badge per PR,
  the current branch's first. Polling continues while any linked PR is open, and merge archiving waits
  until every linked PR is merged or closed.
- Chat: markdown, diffs for edits and patches, tool cards, steer and follow-up, stop. Show all queued
  user messages above the composer until consumed, restoring them on reconnect. Display steering before
  follow-ups, preserving FIFO order within each mode. Edit queued messages inline, using Alt+Up/Alt+Down
  to navigate, Enter to save, and Escape to cancel. Preserve drafts while navigating and reject edits
  after consumption without resubmitting. Remove individual queued messages before delivery without
  stopping the active run; Command-Delete removes the selected row only from its focused inline
  editor. Reject removal once a message has been consumed.
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
- Chat footer: live context-window estimate and Claude/Codex subscription windows with reset times,
  supplied by the user's pi-extensions `usage` event bus (no duplicate polling or credential store).
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
  Chat previews are borderless embedded content, with artifact rows growing up to 1200 points wide
  while prose keeps its readable column. Preview height follows a 4:3 viewport, bounded to 360 to 720 points.
  Clicking opens images and diagrams at a larger size,
  or an interactive sandbox for apps. Source and revision controls live in the expanded viewer (diagram
  source is also available from its context menu). Expanded viewers use 90% of the display's usable area.
  Offscreen chat rows release their renderer; previews can also be hidden manually. An older running
  daemon without artifact routes prompts for a restart once agents are idle. Native WebKit renders isolated,
  offline previews, with no shell, filesystem, credential or daemon access. React, ReactDOM, Mermaid,
  ECharts and Motion are bundled; D3 and Three.js are opt-in bundled libraries. JSX compilation accepts
  only those libraries, not arbitrary package installs. Optional agent screenshots and console
  diagnostics use an isolated Playwright browser (`npm run artifacts:browser` installs Chromium).
  The preview action is exposed only when Chromium or the native Swift toolchain is installed at session startup, and is never
  required before publishing. Pilot-only system guidance encourages useful explanatory diagrams,
  preferring simple Mermaid, only while the artifact tool is available (including through codemode).
  SwiftUI artifacts define `ArtifactView` and compile/render in disposable macOS `sandbox-exec`
  processes using the installed Swift Command Line Tools. Source remains editable; publication embeds
  an 800x600 PNG for offline viewing without recompilation. Draft previews support custom dimensions
  and bounded compiler/runtime diagnostics, cancellation and a five-minute deadline. No network,
  workspace or credential access is granted. These are static, standalone previews, not project-aware
  or interactive views; agents use artifacts to show UI changes and label prototype limitations.
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

## 8. API additions

| Endpoint / message | Purpose |
| --- | --- |
| `/api/projects` (GET, POST), `/api/projects/:id` (GET, PATCH, DELETE), WS `projects` | Projects (done in M1); policies and bindings will attach to them |
| `GET /api/projects/:id/branches`, `SpawnRequest.baseBranch` | List origin's live branches and choose the base of a new private-clone session (done) |
| `SpawnRequest.mode`, `.workspace`; `SessionSummary.mode`, `.workspace`, `.sourceBranch`, `.sourceCommit` | Immutable Ask/Build mode, per-chat Build workspace policy and source identity |
| `GET /api/projects/:id/branches?mode=ask` or `?mode=build&workspace=clone` | List origin heads even for projects whose default Build policy is direct |
| `POST /api/update/prepare` | Atomically grant a bounded admission pause if agents and queued admissions are idle (`{ ready }`, done) |
| `PATCH /api/sessions/:id/queue/:submissionId`, `DELETE /api/sessions/:id/queue/:submissionId` | Edit or remove a still-queued user message without resubmitting or interrupting the active run (done) |
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
| `GET /api/sessions?archived=true&projectId=…` | Browse archives globally or per project; default lists exclude archives, `archived=all` includes both (done) |
| `SessionSummary.archivedAt`, WS `sessions` / `session` | Persist archive timestamp; WS includes active and archived chats for local filtering (done) |
| `SessionSummary.lastUserMessageAt` | Stable latest user-submission time for completion-aware session ordering and elapsed indicators (done) |
| `SessionSummary.workspaceStorage`, `.workspaceReclaimedAt`, `.workspaceCleanupError` | Shared jj storage marker (absent for legacy/direct), reclamation timestamp, and safe-cleanup failure metadata; Swift labels shared/reclaimed workspaces |
| `SessionSummary.sessionPath` | Daemon-provided session data directory for debug drafts, independent of the workspace path (done) |
| `GET /api/sources`, `POST /api/sources/:id/poll` | Trigger source status and manual poll |
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
