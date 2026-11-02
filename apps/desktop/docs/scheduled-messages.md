# Automations page

The **Automations** sidebar entry (below Missions, ⌘4, Go → Automations) opens
one page for what Pilot does on its own, across all projects and chats. It
replaces the old read-only Settings → Scheduled messages roster (D41).

```text
Automations                                   [↻] [New automation]
3 recurring · 2 scheduled · 2 need attention

Needs attention 2
  [◇] Daily dependency check             Today 07:12        Dismiss  ⌄
      Skipped: the previous run is still working  Skipped
  [▲] New chat in Docs                   Yesterday at 14:00 Dismiss  ⌄
      Investigate the failing deploy     Couldn’t send
Recurring 3
  [◇] Weekly DB performance analysis     Next Mon at 09:00   [on]    ⌄
      Mondays at 09:00 · Pilot · New chat: Analyse…  ✓ Today 09:12, late
  [◇] Monthly cost report                Paused              [off]   ⌄
      Monthly on the 1st at 07:00 · Docs · New chat: Summarise costs
One-time 2
  [▭] Design review                      Tomorrow at 08:00            ⌄
      Check the new tokens
  [✎] New chat in Pilot                  Fri at 09:00                 ⌄
      Run the weekly check
```

Sections hide when empty: **Needs attention**, **Recurring**, **One-time** and
**Hooks** ([automation-hooks.md](automation-hooks.md)). The header's one primary
action is **New automation**, which opens the editor sheet for a recurring rule
or a one-time message.

## Rows

Calm list pattern (title + one meta line, at most one action per row, chevron
details). Each section is a hairline-bordered group (white in light, the tray
color in dark) of inset rows that highlight on hover and while open. A row has a
glyph tile, a title over a muted line, and a right-hand column (time over status).

- The glyph says what will happen: a chat-bubble tile for a follow-up in an
  existing chat, a new-chat tile for a new chat, the Automations glyph for a
  recurring rule, an amber or red tile for a run that needs a look.
- **One-time** lists pending and sending one-time messages by due time. The
  title is the target chat's current title or "New chat in <project>" over a
  preview of the message. A message to a chat the shell doesn't list says
  "Unlisted chat"; titles never select a target.
- **Needs attention** lists failed one-time messages ("Couldn’t send") and
  recurring rules whose last noteworthy run was skipped, missed or failed (the
  Inbox reason words under the name), newest first, each with **Dismiss**. A
  rule's Dismiss is a revision-checked PATCH (`dismissNotice`) that clears only
  the notice; the rule keeps running. Late successes are not listed here: the
  rule's row says "✓ Mon 09:12, late" and its details offer Dismiss.
- **Recurring** lists active rules by next run, paused rules last (name dimmed).
  The title is the rule's name over the schedule in words ("Mondays at 09:00",
  "Weekdays at 08:30", "Monthly on the 1st at 07:00", with the zone only when it
  isn't the computer's), the project and the action ("New chat: <first prompt
  line>", "Message to <chat>"). The right column is the next run (or "Paused")
  over the last result; the action slot holds the pause switch. Details show the
  saved prompt or message, up to five recent runs with links to their chats,
  **Edit** and **Delete**; technical fields (recurrence JSON, handled cursor,
  IDs) stay under Details.
- Sent and cancelled records are history and stay off the page.
- Right-hand status only when it matters: **Overdue** (pending past its time at
  the last read: Local hasn't sent it yet, which is not delivery), **Sending**
  (claimed, delivery not confirmed) or **Couldn’t send**.
- Times are local, in words: "Today at 18:00", "Tomorrow at 08:00", "Fri at
  09:00", "13 Nov at 09:00".
- **Cancel** shows on hover, on keyboard focus and while a row is open, so the
  list stays quiet; **Dismiss** always shows. A fixed action slot keeps the
  times aligned. The empty page shows the page glyph, "Nothing scheduled" and
  one line saying what appears here.

Clicking a row or its chevron opens the full local time, the exact message
(selectable) and any error. Technical fields (title, schedule and target IDs,
revision, state, trigger, exact UTC times, a new-chat request's JSON) stay
collapsed under **Details**. More than 200 rows in a section show the first
200 with a count.

## New automation and Edit

The editor sheet (`automation_editor.rs`) offers **Repeats** or **Once**, an
optional name, then:

- Repeats: Daily (with weekday toggles), Weekly (one weekday) or Monthly (day of
  the month; short months use their last day), a time and a time zone (the
  computer's by default).
- Once: a date and time on this computer.
- The action: **Start a new chat** (project, prompt) or **Send to a chat** (chat,
  message). Repeating messages need a chat in a project. An edit that keeps the
  project keeps the saved chat settings (model, thinking, mode).

A caption says when it runs: "Mondays at 09:00 (Europe/Paris). Next: Mon at
09:00." (Next only when the zone is this computer's; Local computes the real
one.) Values are read at Save. An edit sends only changed fields, so an
unchanged schedule keeps its handled cursor; nothing changed closes the sheet.
Cancel is disabled while a save is in flight, so its outcome is never lost.

## Reads

Opening the page and the refresh button issue `GET /api/schedules` through a
bounded, cancel-on-replacement reader with hello daemon/lineage checks before
and after, no redirects or retries, an 8 MiB wire cap and generation fencing.
Malformed, oversized or duplicate reports are rejected whole, never shown
partially. A failed refresh keeps the last report with a quiet "Showing the
last report from Local." note. Leaving the page closes the reader and ignores
late results; coming back reads again. While the page is open, Local's pushed
`schedules` change signal on the existing control stream triggers one passive
re-read; there is no polling. A GET is an observation, never a dispatch receipt.

The **Inbox** shows recurring notices from that same pushed index (validated
whole; a malformed index shows none), as rows in Needs you after the chats:
skipped and missed runs with the amber mark, failed runs with the red one, late
successes last with a faint circle. A row opens its run's chat when listed,
otherwise the rule's details on this page. Removed-project notices stay in the
global view.

## Writes

Every write is sent once and never retried; the list is re-read passively after.

- **Create** is `POST /api/schedules` with `expectedHome` (the checked daemon
  and lineage), so Local refuses a body meant for another home before writing.
- **Pause/Resume**, **Dismiss** on a rule and **Edit** are `PATCH` with the shown
  `expectedRevision` and `expectedHome`.
- Recurring creates and every rule PATCH carry the native host-action
  capability; without it nothing is sent. Local also requires the Automations
  setting (off: "Turn them on in Settings → Chats").
- 409/403/404/503 and a PATCH 400 are refusals that changed nothing. A create's
  400 can follow a committed row, so it is said as unconfirmed. Any other answer
  or a changed hello afterwards is unconfirmed; the editor then keeps the form
  but disables Save so a rule that may exist isn't created twice.

**Cancel** (pending one-time), **Dismiss** (failed one-time) and **Delete** (a
recurring rule's details) use `DELETE /api/schedules/:id?expectedRevision=N`,
which marks a pending record cancelled and removes any other non-dispatching
record. Each press:

1. checks hello identity, then `GET /api/schedules/:id` must still report the
   shown revision and state; otherwise nothing is sent ("This scheduled message
   changed");
2. sends one DELETE with the shown revision as `expectedRevision`; 409 (the
   record changed or is sending) and 404 are refusals that changed nothing; any
   other answer, a body other than `{"ok":true}` or a changed hello afterwards is
   **unconfirmed**, said on the row and never retried;
3. re-reads the list passively.

The daemon compares `expectedRevision` with the stored record atomically, so a
record that sent or changed between the GET and the DELETE is refused with 409
and kept. The parameter is optional on the daemon; clients that omit it keep the
old unconditional behaviour.

## Verification

`scheduled_messages_tests` covers local time words (including the offset
deciding the day), sections, statuses, actions, technical details, whole-report
validation, generation fencing, identity checks around reads and actions,
read budgets, replacement cancellation, Cancel/Dismiss (revision/state
precondition, exactly one DELETE, refusals and unconfirmed outcomes), recurring
sections and actions, the pushed index, and rule PATCH and POST fencing, native
authority, refusals and unconfirmed outcomes, against owned faux HTTP only.
`recurring_schedules` covers schedule words, zones, last results, notice reasons,
local instants and the editor's next-run preview. `automation_editor` covers
create bodies, validation and edit diffs.

The hidden `automations` native probe drives the real LocalViewer at 680/1100
in light and dark (theme asserted after window-open appearance): sidebar
navigation and ⌘4, loading, sections and hidden history, bounds, row and
keyboard chevron disclosure, Details, Unicode selection/copy, Cancel with one
DELETE and a re-read, a refused Cancel, stale error, empty state, and leaving
the page cancelling an in-flight read. Its recurring pass covers Inbox notice
rows and their order, a notice opening its rule, the three sections, row
bounds, the pause switch's single PATCH, Dismiss, Edit (only the changed time
sent) and New automation creating a one-time message. Screenshots
(`PILOT_NEXT_AUTOMATIONS_DIR`) are synthetic fixtures, not production acceptance.
