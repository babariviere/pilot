# Read-only mission tasks

Open a canonical Local mission from Missions, then **Browse tasks**. The task
list is a retained virtual Kit List, not the old 24-row overview preview. Up/Down
and Return open a task's description; a pointer activates the exact rendered ID.
Close details (or Escape within details) returns to the list. Close tasks returns
focus to Browse tasks. Copy task includes its number, full admitted title, status,
exact ID, available context and literal Unicode description. Descriptions are
selectable plain text; Markdown images, links and scripts are not executed.

## Contract and limits

- `packages/daemon/src/server.ts::missionRoute` exposes task data only in
  `GET /api/missions/:id`, via `missions.ts::detail` and `tasks`. There is no
  HTTP GET task-list/detail subroute or task paging contract. The pane never
  invents a cursor, task endpoint or total. It says how many tasks were received
  and describes this as a snapshot, not proof of current completeness.
- `packages/protocol/src/index.ts::MissionTask` supplies IDs, number, title,
  body, status and optional owner/phase/model/dependency context. Display numbers
  and titles never replace canonical IDs. Same-title tasks remain independent.
- `src/mission_tasks_reader.rs` verifies the pinned Local daemon/lineage through
  the existing hello gate before each GET. Requests have no redirects, proxy,
  transport retries or host fallback. Bounds: 2-second connect / 5-second request,
  2 MiB declared and streamed response, then JSON decoding off the UI thread.
- `src/mission_tasks.rs` admits at most 256 rows, 128 KiB per description and
  800 bytes per title. Oversized/malformed/duplicate/foreign data rejects the
  snapshot, never silently truncates a description or pretends a partial list
  is complete. Empty means no tasks received, not a loading state.
- One bounded worker lane coalesces reads. Mission change/close cancels work;
  exact mission key plus generation fences late success and error. Refresh is
  explicit, read-only and local to this pane. Failed refresh retains the last
  usable snapshot/selection with a visible stale error. Nothing polls.

Swift references: `apps/macos/Sources/Pilot/MissionTabs.swift::MissionTasksTab`,
`MissionTaskRow` and `MissionTaskDescription`. Only browsing/details are adopted.
Task creation/title/body editing, delete, status, ownership, models, dependencies,
phases and task starts remain separate work. No enabled mutation stubs, new
endpoint/backend changes, automatic agent starts or live automated actions.

## Design and ownership

The mission title/status remain in the parent reading column. A single Browse
tasks disclosure replaces the truncated preview; task identity and context are
revealed in exact details rather than a wall of permanent metadata. Existing
`ui::heading`, `action`, `ResourceLabel`, `Notice` and theme tokens supply chrome.
The task pane owns its reader, selected ID and focus; Kit owns list navigation
and virtual scroll. Browser owns canonical navigation and the outer page scroll.
No composer/editor/store/interaction/question state is changed. Brief editing,
conversion and the existing companion inspector remain independent owners.

## Scoped verification

`mission_tasks_tests.rs` maps parsing/order/Unicode/duplicate/row/body bounds and
source/generation/error/selection transitions. `mission_tasks_reader_tests.rs`
maps exact existing GET paths, hello identity, redirect/error/malformed/declared
and chunked caps, cancellation and closed-worker refusal. `mission_tasks_probe.rs`
mounts the actual production Browser and pane over an owned GET-only faux daemon,
not a mock UI or a production client. It exercises same-title rows, native
pointer/keyboard, Unicode copy, stale refresh/retry, close and mission changes.

Run from `apps/desktop` through the shared serial slot and private Cargo output:

```sh
PILOT_NEXT_TASKS_CASE=1100-light python3 scripts/check-scoped.py \
  --unit mission_tasks --test mission_tasks --lint --report /tmp/fresh-tasks.json
```

Cases are `680-light`, `680-dark`, `1100-light`, `1100-dark`. Unknown cases and
zero cases fail. Omit the case only to exercise this feature's four layouts, not
other native targets. `PILOT_NEXT_TASKS_DIR` enables private native PNG captures.
Matching native registry checks remain in the broad existing CI; no full local
gate, Swift checks, runtime profiling or CI polling is required for this slice.
Native screenshots establish static layout, not motion/OS IME/AX/performance or
user acceptance. Exact verification receipts are recorded separately.
