# Task preferred model

The task-detail **Preferred model…** popup configures future task chats only. It
does not change an assigned chat, start work, or edit title/body/status/ownership.
The task pane owns at most 16 retained forms, keyed by pinned Local home, mission,
exact task ID/number and endpoint. Forms retain choices and receipts through
navigation in this window, not app restart. They never replace task snapshots.

## Contract audit

- Read exact tasks from `GET /api/missions/:id`; there is no task-read endpoint
  or task cursor. Require canonical Local catalog provenance and its project.
- Read `GET /api/models?projectId=<canonical>&purpose=task-start`, not the general
  catalog or a guessed directory. Daemon `ModelCatalog.taskModels` uses one
  settings snapshot, including project scope/overrides, configured thinking and
  the existing price cap. IDs are opaque `provider/modelId` strings, not labels
  or client-expanded patterns. No scope/settings are written.
- Null model removes the task preference and thinking. Null thinking means no
  stored override, not `off`: future starts resolve/clamp configured thinking.
  Explicit thinking must appear in this model's returned levels, including
  `off` where supported. Changing model resets thinking to default. Existing
  unavailable preferences remain visible until the user changes or clears them.
- User changes keep `preferredModelSetBy=user`. The coordinator cannot replace
  a user preference. Unrelated task fields, assignment and running models stay
  untouched. Concurrent preference edits are last-write-wins, not CAS.

The legacy task PATCH can trigger phase/Linear reconciliation and assigned-chat
role callbacks, which can resume pending work. It is deliberately not used.
User-approved safety adds capability `passiveTaskModel` and an opt-in
`POST /api/missions/:mission/tasks/:exactTask/model` with exactly:

```text
operationId, home {daemonId,lineageId}, projectId,
preferredModel: string|null, preferredThinking: string|null
```

The store changes only preference fields and records activity, skips phase and
Linear reconciliation, and publishes a preference-only invalidation. Role work,
notice/compaction scheduling and Linear PR automation ignore that invalidation;
UI/catalog subscribers still receive it. Existing callers retain their behavior.
Previously scheduled independent work is not stopped or paused by a preference
save. This is loopback identity pinning, not authentication.

The server withholds the complete response until mission durability. The ACK
must match operation ID, home, mission, project, exact task ID/number and nullable
preferences. Operation ID only correlates that response, never authorizes replay.
Post-dispatch errors, malformed/mismatched ACKs and lost responses are Unknown.
No fallback PATCH, redirect, automatic retry or matching-GET settlement exists.
Pending/Unknown block another save. Only confirmed success offers Edit again.

## UI and verification

Reuse the shared native dialog, typography, actions and Kit selects. Selects are
non-searchable and mount no text editor/preedit sink. Existing parent/root IME
guards run before entry; Escape and Close preserve drafts and restore mounted
focus. Selection never submits. Completion records only the exact immutable
attempt, even after close/navigation, and never steals focus or closes a new form.

Mapped checks: `check-scoped.py --unit task_model --test task_model --test
task_edit --native-probes --lint` (set `PILOT_NEXT_TASK_EDIT_CASE=root-ime` for
the shared-root composition check). These cover pure state/ACK, owned faux HTTP,
native light/dark popup/select/draft/success/Unknown and existing pre-blur guards.
Backend parser/store/HTTP tests cover scope validation, durability, preserved
fields and suppressed automation. TypeScript typecheck and focused Swift mirror
syntax parsing supplement them. No live actions, app installation/restart,
provider calls, Linux qualification or OS IME acceptance are implied.
