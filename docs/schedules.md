# Scheduled messages

Open **Automations** in the sidebar, then **New automation**.

1. Choose **Once** or **Repeats**.
2. Set a date and time, or a daily, weekly, or monthly rule with its time zone.
3. Choose **Start a new chat** in a project or **Send to a chat**.
4. Review the prompt and destination, then save.

Recurring rule changes require **Settings → Chats → Automations** to be enabled.
Repeating messages target a chat in a project. Monthly dates beyond the end of a
short month use its last day.

## Manage runs

Open a rule to inspect its message, recent runs, and linked chats, or to edit/delete it.
Use its switch to pause or resume. One-time messages can be cancelled before dispatch.

After downtime, recurring rules catch up once while the missed occurrence's period
is still current. Multiple misses do not create a burst of chats. Runs need network
connectivity, not external power. If the previous run is still working, the next
occurrence is skipped rather than overlapped.

Skipped, missed, and failed runs appear under **Needs attention** and in the Inbox.
Late successes are visible without adding to the attention badge. Dismissing a
notice does not pause or delete its recurring rule.

An overdue or sending row is not proof of delivery. If a save is unconfirmed, inspect
the current list instead of creating the same rule again.

For workspace setup and post-run commands, see [project hooks](automations.md).
