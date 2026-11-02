# Automations page

The **Automations** sidebar entry (below Missions, ⌘4, Go → Automations) opens
one page for what Pilot does on its own, across all projects and chats. It
replaces the old read-only Settings → Scheduled messages roster (D41).

```text
Automations                                              [↻]
2 scheduled · 1 needs attention

Needs attention 1
  [▲] New chat in Docs                  Yesterday at 14:00   Dismiss  ⌄
      Investigate the failing deploy         Couldn’t send
One-time 2
  [▭] Design review                      Tomorrow at 08:00            ⌄
      Check the new tokens
  [✎] New chat in Pilot                  Fri at 09:00                 ⌄
      Run the weekly check
```

Sections hide when empty: **Needs attention**, **Recurring** (recurring rules,
later), **One-time** and **Hooks** ([automation-hooks.md](automation-hooks.md)). The header's single primary action
slot is reserved for **New automation**, which arrives with the editor sheet
for recurring rules. Until then the page has no creation action (see
[schedule-creation.md](schedule-creation.md)).

## Rows

Calm list pattern (title + one meta line, at most one action per row, chevron
details). Each section is a hairline-bordered group (white in light, the tray
color in dark) of inset rows that highlight on hover and while open. A row has a
glyph tile, the target over a muted one-line preview of the message, and the
time over its status on the right.

- The glyph says what will happen: a chat-bubble tile for a follow-up in an
  existing chat, a new-chat tile for a new chat, a red alert tile for a failure.
- **One-time** lists pending and sending one-time messages by due time. The
  title is the target chat's current title or "New chat in <project>". A
  message to a chat the shell doesn't list says "Unlisted chat"; titles never
  select a target.
- **Needs attention** lists failed one-time messages, newest first, with a red
  mark and "Couldn’t send". Recurring notices (missed, skipped, late) join it later.
- Sent and cancelled records are history and stay off the page. Recurring rules
  (`trigger: "recurring"`) are left for the Recurring section.
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

## Reads

Opening the page and the refresh button issue `GET /api/schedules` through a
bounded, cancel-on-replacement reader with hello daemon/lineage checks before
and after, no redirects or retries, an 8 MiB wire cap and generation fencing.
Malformed, oversized or duplicate reports are rejected whole, never shown
partially. A failed refresh keeps the last report with a quiet "Showing the
last report from Local." note. Leaving the page closes the reader and ignores
late results; coming back reads again. There is no polling and no schedule
WebSocket subscription. A GET is an observation, never a dispatch receipt.

## Cancel and Dismiss

The only writes. **Cancel** (pending rows) and **Dismiss** (failed rows) use
`DELETE /api/schedules/:id?expectedRevision=N`, which marks a pending record cancelled
and removes any other non-dispatching record. Each press:

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
read budgets, replacement cancellation, and Cancel/Dismiss: revision/state
precondition, exactly one DELETE, refusals and unconfirmed outcomes, against
owned faux HTTP only.

The hidden `automations` native probe drives the real LocalViewer at 680/1100
in light and dark (theme asserted after window-open appearance): sidebar
navigation and ⌘4, loading, sections and hidden history, bounds, row and
keyboard chevron disclosure, Details, Unicode selection/copy, Cancel with one
DELETE and a re-read, a refused Cancel, stale error, empty state, and leaving
the page cancelling an in-flight read. Screenshots
(`PILOT_NEXT_AUTOMATIONS_DIR`) are synthetic fixtures, not production acceptance.
