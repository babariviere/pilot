# Automations page

The **Automations** sidebar entry (below Missions, ⌘4, Go → Automations) opens
one page for what Pilot does on its own, across all projects and chats. It
replaces the old read-only Settings → Scheduled messages roster (D41).

```text
Automations                                              [↻]
All projects · 2 upcoming · 1 need attention

Needs attention
  ▲ Yesterday 14:00 → New chat in Docs        Couldn’t send  Dismiss  ⌄
One-time · 2
    Tomorrow at 08:00 → Design review                        Cancel   ⌄
    Fri at 09:00 → New chat in Pilot                         Cancel   ⌄
```

Sections hide when empty: **Needs attention**, **Recurring** (recurring rules,
later), **One-time** and **Hooks** (later). The header's single primary action
slot is reserved for **New automation**, which arrives with the editor sheet
for recurring rules. Until then the page has no creation action (see
[schedule-creation.md](schedule-creation.md)).

## Rows

Calm list pattern (title + one meta line, one-line rows, at most one action,
chevron details), the same as Settings → MCP connections.

- **One-time** lists pending and sending one-time messages by due time:
  local time in words, an arrow, then the target chat's current title or
  "New chat in <project>". A message to a chat the shell doesn't list says
  "a chat not listed here"; titles never select a target.
- **Needs attention** lists failed one-time messages, newest first, with a red
  mark and "Couldn’t send". Recurring notices (missed, skipped, late) join it later.
- Sent and cancelled records are history and stay off the page. Recurring rules
  (`trigger: "recurring"`) are left for the Recurring section.
- Right-hand status only when it matters: **Overdue** (pending past its time at
  the last read: Local hasn't sent it yet, which is not delivery), **Sending**
  (claimed, delivery not confirmed) or **Couldn’t send**.
- Times are local, in words: "Today at 18:00", "Tomorrow at 08:00", "Fri at
  09:00", "13 Nov at 09:00".

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

The only writes. **Cancel** (pending rows) and **Dismiss** (failed rows) use the
existing `DELETE /api/schedules/:id`, which marks a pending record cancelled
and removes any other non-dispatching record. Each press:

1. checks hello identity, then `GET /api/schedules/:id` must still report the
   shown revision and state; otherwise nothing is sent ("This scheduled message
   changed");
2. sends one DELETE; 409 (already sending) and 404 are refusals that changed
   nothing; any other answer, a body other than `{"ok":true}` or a changed
   hello afterwards is **unconfirmed**, said on the row and never retried;
3. re-reads the list passively.

The check narrows but cannot close the window between the GET and the DELETE:
the daemon's DELETE has no revision precondition. A record sent in between is
removed from history rather than cancelled.

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
