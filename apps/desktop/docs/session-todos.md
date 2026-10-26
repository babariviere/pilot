# Read-only chat task progress

`session_todos.rs`, `session_todos_view.rs` and `session_todos_tray.rs` adapt
the compact progress/active-item hierarchy into an app-owned native tray strip.
The strip belongs above the existing composer, not inside its editor or model
controls. The existing76pt composer tray and34pt editor remain unchanged.
The only action is an explicit, keyboard-operable disclosure. It never starts,
stops, assigns, edits or completes anything, and does not infer mission tasks.

## Source audit

- `packages/protocol/src/index.ts::SessionTodo/TodosUpdateEvent`: id, title,
  arbitrary status string, createdAt, optional assignedToSession. Every
  `todos_update` replaces the public list. No Markdown body or revision token.
- `packages/kernel/src/todos.ts`: closed means **only** case-insensitive
  `closed`/`done`. Creation/update accepts arbitrary bounded statuses. Claims
  assign to the current agent; closed items release assignment. The progress
  projection is shared with subagents, not a mission task list. Store limit256,
  title1024UTF8bytes, status64bytes. No `completed`/`cancelled` aliases.
- `packages/kernel/src/session.ts::subscribe`, `snapshot.ts`, daemon
  `sessions.ts::subscribe` and `chat-streams.ts`: initial subscription includes
  public progress; updates follow committed document changes. Ask snapshots
  can explicitly report an empty list. The selected `/api/sessions/:id/ws`
  uses `chat.stream`, exact sessionId and monotonically contiguous seq batches.
  Resumed hello has **no replay-complete watermark**. Retained todos therefore
  remain labeled retained until a replacement `todos_update` arrives.
- `packages/daemon/src/server.ts`: GET `/api/sessions/:id` is SessionSummary,
  not a todo snapshot. History is a bounded conversation-entry page. There is
  no separate public todo GET endpoint. This feature adds no GET, subscription,
  polling, fanout, backend code or host capability. It consumes only the
  existing exact selected chat socket after the current Local hello/home gate.
- Swift `PilotCore/Todos.swift`, `Transcript.swift` and `TasksStrip.swift`:
  self-assigned nonclosed items lead as Working; foreign assignments are
  Assigned elsewhere. Other statuses remain literal. The native adaptation
  preserves this vocabulary but deliberately rejects Swift's automatic
  completion folding: user intent survives all progress/stream replacements.
- Next `local_client.rs` already pins hello daemon/lineage/protocol, checks
  native-home identity, validates socket owner/stream/seq, and rejects stale
  connection epochs and chat generations. Todo state adds an independent source
  fence and bounded replacement projection; no raw tool inference is imported.

## Reuse and attribution

Upstream `hardbeat920/monocode` was inspected locally at exact commit
`26465c620977f3951d0a532a0f7db32c3c179007`:

- `src/features/sessions/ui/TaskListPreview.tsx`: compact Tasks/progress header,
  strongest current task, quiet completed rows and per-item textual state.
- `src/features/sessions/model/taskList.ts`: progress-label concept only.
  **Not reused:** raw-tool parsing, status aliases, legacy transcript inference,
  cancelled-item denominator, tool/runtime controls, React/Tauri/WebView.
- Root LICENSE: MIT, Copyright(c)2026 Nick, retained exactly in
  [`../licenses/MONOCODE.txt`](../licenses/MONOCODE.txt).
- Root NOTICE reviewed: no agent-vendor affiliation; provider trademarks remain
  with their owners. This component introduces no provider logos or affiliation.

## Truth and limits

Loading/absent feeds mount no scaffold. A valid empty replacement is distinct
and reads “No tasks reported”. Unavailable without a snapshot says so. Invalid
replacements/disconnection preserve the last snapshot with visible retained
provenance, even when collapsed. Never call retained data current.

Inspect at most256 rows, count only that inspected portion, retain/render the
first32 in display order, scroll at four28pt rows. Titles are bounded to240
Unicode scalar values with a visible shortened-title notice; the public source
has no body to disclose. A longer source list explicitly marks partial counts.
Malformed/duplicate rows refuse replacement rather than silently reducing the
denominator. Unknown statuses never become Completed. Completion means
closed/done only, including when a status literally says completed/cancelled.

The component has no clock, entrance animation, automatic expansion/folding,
per-row entity, editor replacement or transport action. Per-chat disclosure
intent is bounded to128 window-local identities, not persisted across restart.
Pointer activation is guarded before sibling preedit blur. Native Kit Button
owns Tab/Space/Enter; no parent Escape hook can close an IME composition.

## Focused verification

`--unit session_todos --test session_todos --lint` selects bounded parser/state
and native production tray tests. Native cases mount light/dark680/1100 windows
with zero, unknown/cancelled/completed/in_progress, closed, self/foreign-assigned,
long/capped, error/retained and source-switch fixtures. Geometry, disclosure,
draft/focus/IME, reader and control placement assertions cover the changed
surface; full suites remain CI's responsibility. Captures are actual GPUI
rendering, not a SwiftUI approximation, OS IME, performance or Linux proof.

Verified on the `9f972faf` composition:8 focused parser/state/loopback cases,
all4 native light/dark680/1100 flows, matching strict Clippy and the ordinary
production `pilot-desktop` build.68 CI/scoped-runner Python cases passed,
including additive registration/discovery. The registration check exposed an
already-missing `transcript_find` CI entry; it is retained additively alongside
the new target, not removed or weakened. Changed Rust files pass scoped rustfmt.
The existing dependency `block0.1.6` future-incompatibility warning remains.

28 final native captures cover seven states in each theme/width. The final
native-only assertion addition proves identical composer/model/thinking/Context/
Send widths, heights and positions across todo replacements; production inputs
were identical to the preceding successful build.297 frozen source/manifest/
registration inputs were checked unchanged during that final native/Clippy run.
Failed intermediate fixture receipts were preserved: they caught pointer-focus
assumptions, insertion-vs-replacement cleanup, lexical-ID ordering, and faux
publications omitting rows that the UI drains. Final reader assertions use real
retained canonical rows, not an empty transcript.
