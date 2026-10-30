# Mission phases and the Tasks tab

A mission page has two tabs, **Overview** and **Tasks N** (N counts open work:
not done, not dropped), in one full-width row with the Missions back action, so
neither moves when Tasks widens the page. A different mission opens on Overview.

Overview shows progress by phase, as Swift's `MissionPhaseProgressList`: one row
per phase with counted tasks, in phase order, then "No phase", each with its bar
and done/total. The first phase with unfinished work is current (semibold). A
mission without phases, or with only unphased work, keeps the single bar and
legend. Rows, Working now, Needs you tasks and All tasks open the Tasks tab;
task rows select their exact ID there.

The Tasks tab fills the page: progress, Refresh and New task, then a retained
virtual Kit List grouped into phase sections ("Build 3/4 done") with every task,
dropped included; empty phases have no section. Each row shows its status and
the first line of its description. Up/Down cross sections, Return or a pointer
selects the exact ID, and Escape clears it; nothing opens below the list. The
highlighted or hovered row shows a "…" button (a Tab stop on the highlighted
row), and right-clicking any row opens the same menu: Change status, Edit title
and description, Preferred model and Copy task, each for that exact row. Status,
edit, model and New task open as Kit dialogs. No form occupies space below the list.
New task retains its draft per mission and pinned connection. Close or Escape
returns focus to the list without clearing text or cancelling a pending creation;
marked text prevents dismissal. Clicking outside never closes the popup. Only
Create task (or ⌘Enter) sends a request, and an unconfirmed result cannot be retried.
Leaving the tab keeps the snapshot, selection and drafts; IME composition fences
leaving it.

Phases come from the same detail GET (`phases`, task `phaseId`), ordered by
order then ID; an older daemon without `phases` uses task milestones in first
appearance order (`src/mission_phases.rs`). Counts use work status and exclude
dropped tasks. Nothing here moves tasks between phases or changes gating.

Copy task includes its number, full admitted title, status, exact ID, phase and
other context and literal Unicode description. Descriptions are selectable plain
text; Markdown images, links and scripts are not executed.

## Contract and limits

Content limits apply to supplied write fields, not persisted reads. Shared
protocol interfaces are read shapes, and the store/API/tool serializers return
legacy content unchanged. Native read decoders must not reuse write-capture
validation or clip stored title/body, brief, decision or metadata text. Identity,
type and transport validation remain separate; reading never rewrites data or
permits resubmitting oversized content as a new write. Partial mutations validate
only their supplied text fields, not unrelated legacy content.

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
  then JSON decoding off the UI thread. The detail carries every task, so it has
  no byte or row ceiling; a mission with hundreds or thousands of tasks loads whole.
- `src/mission_tasks.rs` admits every received row and exact legacy title/body text
  without applying current write limits. Malformed/duplicate/foreign data
  rejects the snapshot, never silently truncates a description or pretends a
  partial list is complete. Empty means no tasks received, not a loading state.
- The virtual list keeps every received task reachable by wheel and Up/Down;
  selecting or revealing a task (including from the overview) scrolls its row
  into view. No client paging: the single GET already supplies every task.
- One bounded worker lane coalesces reads. Mission change/close cancels work;
  exact mission key plus generation fences late success and error. Refresh is
  explicit, read-only and local to this pane. Failed refresh retains the last
  usable snapshot/selection with a visible stale error. Nothing polls.

Swift references: `apps/macos/Sources/Pilot/MissionTabs.swift::MissionTasksTab`,
`MissionTaskRow` and `MissionTaskDescription`. Only browsing/details are adopted.
Explicit creation is documented in [mission-task-creation.md](mission-task-creation.md).
Task title/body editing, delete, status, ownership, models, dependencies,
phases and task starts remain separate work. No enabled mutation stubs, new
endpoint/backend changes, automatic agent starts or live automated actions.

## Design and ownership

The mission title/status stay in the parent header. The Tasks tab replaces the
old disclosure inside Overview; task identity and context are
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
Its forms-capacity journey covers 20 creation targets and 40 status targets at
680/1100 in light/dark, preserving each target's draft and Pending/Unknown state.
The creation probe additionally checks the real Kit dialog, guarded dismissal,
unchanged list geometry, focus return, explicit-only POST and late ACK handling.

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
