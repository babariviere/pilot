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
- Give every session a real terminal (libghostty) in its working copy.
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
- **kernel** (`packages/kernel`): one process per session. pi-durable owns the transcript and model loop;
  the native pi kernel provides tools, prompts, extension hooks and provider auth from `~/.pi/agent`.
- **Pilot.app** (`apps/macos`): session list, native chat, per-session terminal, menu bar, notifications.
  Installs and supervises the launch agent. Closing or quitting the app never stops agents.
- **protocol** (`packages/protocol`, mirrored in `PilotCore`): HTTP commands and WS event streams.

## 4. Core concepts

| Concept | Definition |
| --- | --- |
| **Session** | One durable pi conversation with its working copy, origin, policy and state. |
| **Origin** | What created the session: `manual`, `github.ci`, `github.review`, `slack.bug`, `linear.spec`, `schedule`. |
| **Binding** | Link between a session and an external thread (PR, check suite, Slack thread, Linear issue). Unique per thread, so new events steer the same session instead of spawning duplicates. |
| **Trigger source** | Adapter that turns external events into admissions: `spawn(origin, binding, brief)` or `send(session, message)`. Polling or webhooks. |
| **Policy** | Per-origin permissions: repositories, branches it may push, sandbox floor, tools, budget, auto-reply rights. |
| **Workspace** | Isolated working copy per session (jj workspace or private clone), created by pilotd, never by the agent. |
| **Human gate** | A durable pause where the agent waits for a human answer or approval (`waiting` state). |
| **Outcome** | Structured end of a run: `fixed` (with PR/commit), `declined` (with reason), `needs-human`, `failed`. |

### Session states

`parked → starting → working ⇄ waiting → idle`, plus `failed`. `waiting` is new: the run is parked on a
human gate and costs nothing until answered.

For manual sessions today, lifecycle (`parked`, `starting`, `working`, `idle`, `failed`) is separate from
the latest settled-run outcome (`done`, `needs_input`, `failed`, `stopped`). The replay-safe
`pilot_report_status` tool explicitly reports blocking questions, approvals or missing information
before the final response, including design discussions awaiting a decision or permission to implement.
Agents report `done` only when the requested work is complete, not merely when a reply ends.
Fully answered standalone questions can be done; optional offers after completed work are not blockers.
An otherwise successful run defaults to `done`; errors and aborts override reported status.
This is not the suspended `ask_human` gate yet:
the run ends normally, costs nothing while idle, and an ordinary user message resumes work.
Outcomes and their stable completion version survive worker and daemon restarts.

## 5. Shared machinery

### 5.1 Human gate (`ask_human` tool)

A durable pilot tool available to every session:

- `ask_human({ questions: [{ id, text, options? }], blocking: boolean })`.
- The tool commits the questions, publishes them to the binding's channel (app, PR comment, Slack thread,
  Linear comment) and parks as a waiting task. No model tokens are spent while waiting.
- Answers arrive from any channel through `POST /api/sessions/:id/answers` (or a trigger source) and
  complete the task; the tool returns the answers to the model.
- Replay-safe: question IDs and channel message IDs are stored, so a restart never double-posts.
- Timeouts per policy: remind, then end with `needs-human`.

### 5.2 Triage step

Every automated origin starts with a cheap, read-only triage turn that must produce one of
`proceed`, `decline(reason)`, `ask(questions)`. Only `proceed` unlocks write tools for that run.

### 5.3 Outcome reporter

A checkpointed task posts the outcome back to the binding (exactly one report per outcome ID) and records
it in the session. Reuses the reporter pattern from pi-extensions subagents.

### 5.4 Workspaces

Decided: **every session gets its own private clone** (done for manual sessions).

- The clone lives in the session directory (`$PILOT_HOME/sessions/<id>/workspace`), cloned from the project's
  checkout (hardlinked objects), with `origin` pointed at the project's real remote and fetched. Only committed
  history and ignored mise local configuration files (`mise.local.toml`, `.mise.local.toml`,
  `mise/config.local.toml`, `.mise/config.local.toml`) are copied; other uncommitted work, dependencies
  and build output stay behind. Copied local configuration stays ignored, and the user's checkout is never touched.
- Start private clones detached from the remote default branch. When a PR is required, new agent-chosen
  branches and bookmarks use `<type>/<short-description>` with a conventional task prefix
  (`feat/`, `fix/`, `docs/`, etc.), never `pilot/`. Existing branch and bookmark names are preserved;
  PR sessions check out and keep the PR head instead.
- jj projects get a colocated jj repository in the clone. The clone inherits the project's pi trust.
- Projects can opt out (`workspace: "direct"`) to run in the folder itself.
- Projects independently configure **Require PR** (`requirePullRequest`, default true). Turning it off
  permits direct pushes to the remote default branch without a PR. It does not change workspace isolation
  or run an after-push command. The policy is read when a session worker starts (new sessions or kernel restart).
- Archiving retains the workspace and transcript so old chats can be viewed and restored. Workspace
  cleanup is deferred; never delete while a PR is open.

### 5.5 Policy and safety

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

### 6.2 GitHub: CI failures and review comments (M3)

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

- Sidebar grouped by origin and state; badges for `waiting` sessions (they need you).
- Manual sessions show a text-colored animated braille spinner while working, and colored status icons
  (done checkmark, needs-input raised hand, failed warning triangle, stopped stop symbol, idle sleeping moon),
  with the status
  in tooltips and accessibility labels, separately from worker lifecycle. Unread completion dots persist
  until reviewed, independently of the outcome:
  reading a question does not answer it. Native macOS notifications distinguish results, blocking
  requests and failures, and deduplicate completion versions across reconnects.
- The chat transcript shows an activity indicator while the agent is working, but no settled
  status icon or outcome-reason footer. Reaching the transcript end in the active window still
  marks the latest settled outcome as reviewed; status icons remain elsewhere in the app.
- Private-branch sessions show a linked colored PR icon and number independently of run outcome;
  tooltips and accessibility labels distinguish Draft, Open, Merged or Closed without merging.
  Sidebar rows also show the changed-file count, added/deleted line totals since the session base,
  and the workspace branch after a middle-dot separator,
  including before a PR exists. Visible rows refresh lightweight repository summaries every ten seconds,
  with at most four sidebar requests in flight;
  failed lookups omit the count rather than showing zero, and long branches truncate with a full-name tooltip.
  The daemon discovers PRs by the exact workspace branch and
  repository, checks GitHub at startup, after settled work and about once a minute while idle,
  and persists the last successful status. Failed lookups retain the cache but label it as last
  known, never as a fresh merge result. Direct/shared-folder sessions are not auto-linked.
- Chat: markdown, diffs for edits and patches, tool cards, steer and follow-up, stop. Show all queued
  user messages above the composer until consumed, restoring them on reconnect. Display steering before
  follow-ups, preserving FIFO order within each mode. Edit queued messages inline, using Alt+Up/Alt+Down
  to navigate, Enter to save, and Escape to cancel. Preserve drafts while navigating and reject edits
  after consumption without resubmitting. Remove individual queued messages before delivery without
  stopping the active run; Command-Delete removes the selected row only from its focused inline
  editor. Reject removal once a message has been consumed.
- Inline diagrams: completed `svg` and `mermaid` Markdown fences render in chat; unclosed streaming
  fences remain code. Previews fit the chat width, with source/copy controls and source fallback on
  errors. Offscreen rows release their renderer. Nonce-CSP WebKit sandboxes display SVG only as inactive
  data images, with strict bundled Mermaid rendering, no external resources, and a 512 KiB source limit.
- Archive inactive chats without deleting their history or workspace. Browse archived chats globally
  or per project, search them, and restore them to continue the conversation. Stop running chats first.
  The daemon checks once a minute to automatically archive chats after one week without activity,
  skipping running chats and pending admissions. Restoration grants another week, including across
  daemon restarts, without changing chat ordering. Fresh GitHub merge checks automatically archive
  inactive linked chats no earlier than 24 hours after GitHub's merge timestamp. Failed lookups and
  closed, unmerged PRs never trigger merge-based archiving. Restoring a merge-archived chat keeps it
  active for that PR, including after daemon restarts (the one-week inactivity rule still applies).
- Debug a session from the top-right bug button, including failed and archived chats. Open the new-task
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
  Abandoned unsent drafts clean up their files; submission attempts retain files even if the response
  is lost. Accept up to eight raster images per message, 32 MiB and 24 megapixels each.
- Chat footer: live context-window estimate and Claude/Codex subscription windows with reset times,
  supplied by the user's pi-extensions `usage` event bus (no duplicate polling or credential store).
  A subtle controls row below the message box combines a model picker with labeled context, 5h,
  and weekly usage gauges. Models can be changed while idle and are pinned across reopening.
  Click subscription usage for snapshot details and reset times. Concrete Claude/Codex models show
  an explicit unavailable state when no snapshot arrives, never a fabricated zero measurement.
- Chat TODO panel: read-only live view of pi-extensions' file-backed TODO store (`.pi/todos`, or
  `PI_TODO_PATH`), with this session's claimed open tasks first, titles/statuses visible above the
  composer, and expansion for the full list. Poll only while subscribed, including during codemode
  work; reconnects reload files without modifying extension-owned state.
- Responsiveness: decode conversation snapshots and prepare transcript rows/tool summaries off the UI
  actor, preserve stream ordering, and publish prepared rows once per batch. Long tool groups render
  lazily; loading and startup have visible progress. Procedural home artwork renders off main as well.
- Questions panel: answer `ask_human` gates inline.
- Artifacts: durable images, HTML/JS or React/JSX documents owned by a session and its project. Agent tools
  create, update, list, read and preview them. Each publication saves an immutable revision; chat
  previews are shown by default and pin that revision, while sidebar access opens the latest.
  Plain PNG, JPEG, GIF and WebP files (or data URLs) are embedded with their revisions, up to 16 MiB.
  Expanded viewers use 90% of the display's usable area.
  Offscreen chat rows release their renderer; previews can also be hidden manually. An older running
  daemon without artifact routes prompts for a restart once agents are idle. Native WebKit renders isolated,
  offline previews, with no shell, filesystem, credential or daemon access. React, ReactDOM, Mermaid,
  ECharts and Motion are bundled; D3 and Three.js are opt-in bundled libraries. JSX compilation accepts
  only those libraries, not arbitrary package installs. Optional agent screenshots and console
  diagnostics use an isolated Playwright browser (`npm run artifacts:browser` installs Chromium).
- Terminal: libghostty per session (⌘J), on a pilotd-owned PTY streamed over the WebSocket, so it survives app
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
| `POST /api/update/prepare` | Atomically grant a bounded admission pause if agents and queued admissions are idle (`{ ready }`, done) |
| `PATCH /api/sessions/:id/queue/:submissionId`, `DELETE /api/sessions/:id/queue/:submissionId` | Edit or remove a still-queued user message without resubmitting or interrupting the active run (done) |
| `GET /api/sessions/:id/artifacts`, `GET /api/projects/:id/artifacts` | Session and project artifact indexes |
| `GET /api/sessions/:id/artifacts/:artifactId?revision=N` | Read a pinned revision (latest when omitted) |
| `GET /api/artifact-libraries/:name`, WS `artifacts` | Read-only offline library assets and live session artifact indexes |
| `SessionSummary.origin`, `.binding`, `.outcome`, `state: "waiting"` | Origin-aware lists and badges |
| `SessionSummary.pullRequest`, `.pullRequestError` | Branch-linked GitHub PR status and cached-lookup errors (done for private manual sessions) |
| `GET /api/sessions/:id/changes/summary` | Lightweight base, branch, changed-file count and added/deleted line totals for sidebar rows, without generating patches (done) |
| `GET /api/sessions/:id/questions`, `POST /api/sessions/:id/answers` | Human gates from the app |
| `POST /api/sessions/:id/archive`, `POST /api/sessions/:id/restore` | Archive inactive chats or restore them, retaining history and workspace (done) |
| `GET /api/sessions?archived=true&projectId=…` | Browse archives globally or per project; default lists exclude archives, `archived=all` includes both (done) |
| `SessionSummary.archivedAt`, WS `sessions` / `session` | Persist archive timestamp; WS includes active and archived chats for local filtering (done) |
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

1. ~~Workspace source of truth~~ Decided: a private clone per session (§5.4).
2. ~~Identity~~ Decided for GitHub: never posts; opens PRs as the user (§5.5). Slack and Linear identity open.
3. ~~Replies to declined review comments~~ Decided: only a note in the app.
4. Where do specs live: Linear documents, the issue description, or a repo file linked from the issue?
5. Hosted tenancy: one daemon per user, or a shared scheduler with per-tenant workers?
