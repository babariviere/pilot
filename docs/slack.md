# Slack triage

Connect the `slack` MCP server, then configure tracked channels in project settings.
Open the project's Slack triage to review reports; use **Refresh** to sync on demand.
Tracking never sends Slack messages or replies.

## Triage a report

Select a report to read its thread. Search by summary, channel, message text, or a
Slack message link. Adjust its type, label, or status from the inspector, then start
a chat or mission when work is needed. Starting work attempts an eyes reaction as you;
a failed reaction does not block the chat.

- **Open:** not yet being worked on.
- **In progress:** work is underway.
- **Waiting:** an outside reply is needed; record a short reason.
- **Done:** resolved locally.
- **Dismissed:** removed from your active queue.

Waiting items stay outside the Inbox. On refresh, a reply from someone other than
you can resume the linked chat or reopen the item. Your own replies do not end a wait.
Attached chats can report Waiting or Done, but only you reopen closed items.

Merged linked PRs, a completed linked mission, or a detected ✅ reaction can mark
an item Done. Reopening is respected. Completing an item may add ✅; removing
Pilot's eyes reaction needs a separate opt-in configuration.

## Labels and refresh limits

Labels can hide or locally close reports. Use **Show hidden** to include them.
Corrections help future classification. Common cases group related reports so you
can review recurring problems together.

Slack classification/check work shares a budget of 100 operations per UTC hour
across projects. **Force sync** bypasses that budget for one refresh, not Slack's
own rate limits. Mention-only channels detect top-level mentions, not mentions
appearing only in replies.
