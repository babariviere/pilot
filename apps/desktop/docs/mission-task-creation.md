# Explicit Local task creation

Open a canonical Local mission, choose **New task…**, enter a title and optional
description, then choose **Create task** (⌘Enter). Ordinary Enter edits text;
opening, closing, reading and navigating never submit. Creation does not assign
or start a chat. Editing, deleting, status, ownership, model, phase and dependency
changes remain separate work.

The production task pane retains one source-immutable form per Local home,
mission and pinned connection (at most 16, no eviction). Both native text editors
survive navigation, closing the disclosure and errors. These are in-process
drafts, **not restart-durable storage**, as stated beside the form. Pending and
unconfirmed submissions retain their original text and identity. Close returns
focus to the mounted task disclosure. Marked text prevents submission, dismissal
and navigation; a paint-scoped capture fence blocks outside mouse-down before
preedit can blur, while the marked editor itself remains interactive.

## Audited contract

- Swift `MissionTabs.swift::MissionTasksTab.add` explicitly captures the mission
  ID and calls `PilotClient.createMissionTask`, which POSTs to
  `/api/missions/:id/tasks`. Swift's inline control sends title and next order.
  This form sends only supported `title` and `body`; daemon ordering/defaults
  apply. It does not expose the other optional `MissionTaskWrite` fields.
- `packages/daemon/src/server.ts::missionRoute` returns HTTP 201 with the
  actual `MissionTask` from `MissionService.addTask`. `missions.ts::insertTask`
  generates the ID and per-mission number, defaults to todo/unassigned, and
  `taskFields` validates body. Limits are 200/8,000 raw UTF-16 units, checked
  before ECMAScript trim. The form uses the existing ECMAScript trim helper,
  preserving U+0085 and removing U+FEFF as the daemon does.
- `MissionTask` has **no missionId field**. Membership comes from the qualified,
  immutable canonical POST route. Actual ID and number come exclusively from
  the validated 201 response, never from a title match or a GET. Validation
  requires normalized captured title/body, supported default state, finite
  order/timestamps and no unexpected assignment/phase/dependencies. Any supplied
  foreign missionId is rejected rather than trusted.
- Before POST the worker verifies the existing pinned hello identity and exact
  canonical Local catalog entry. There are no proxy, redirect, transport retry,
  credential or alternate-host fallbacks. Connect/request deadlines are 2/5s;
  response JSON is bounded to 64 KiB declared and streamed, off the UI thread.
- A valid exact 201 is an ACK, not a claim of new fsync guarantees. Post-COMMIT
  `changed()`/publication errors can yield a generic HTTP error. Once POST is
  dispatched, any error/loss/malformed/oversized response stays **unconfirmed**.
  No status code, body string, later GET or matching title settles a lost ACK.
  The form retains text and offers Copy, not retry. Only a proven pre-dispatch
  failure permits a fresh explicit submission. A confirmed form offers an
  explicit **Another task** reset; it never silently clears text or resends.

## Design and verification

The task form answers one question: what task should be added to this exact
mission? Title/body and explicit submit are primary; supported management fields
are deliberately absent. Scope and any error/uncertainty remain adjacent. Shared
`ui` typography/actions/notices and Kit native editors supply light/dark styling,
keyboard interaction and sizing. Browser retains the mission scroll and existing
activity/brief/task browsing; no composer/layout files are changed.

`mission_task_create_tests` covers raw UTF-16/ECMAScript validation, response
identity/defaults and immutable pending/late/unknown state. Transport tests use
an owned temporary loopback server for exact method/path/body, identity refusal,
missing canonical evidence, lost/malformed/error/redirect/oversized ACKs and
single-POST assertions. The native probe mounts the actual Browser and form at
680/1100 in light/dark, covering native paste, ordinary Enter, marked-text guards,
per-mission drafts, delayed ACK across navigation, uncertainty after an error,
no refresh/reopen retry, Copy and focus. No live automated write is run.

```sh
python3 apps/desktop/scripts/check-scoped.py --unit mission_task_create \
  --test mission_task_create --native-probes --lint --report /tmp/fresh-create.json
```

`PILOT_NEXT_TASK_CREATE_DIR` optionally saves actual offscreen GPUI PNGs. These
are static synthetic captures, not OS IME/AX, motion, runtime performance,
Linux/Wayland or user acceptance evidence. Use the existing shared slot,
CPU2/4GiB admission and private outputs, not a routine full desktop sweep.

For an isolated regression, `PILOT_NEXT_TASK_CREATE_CASE` selects `680-light`,
`680-dark`, `1100-light`, `1100-dark` or `root-ime`. Unknown and empty selections
fail; omitting it runs the four component layouts and actual Root journey.
