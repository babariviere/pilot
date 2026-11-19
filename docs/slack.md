# Slack triage

Connect the `slack` MCP server, then configure tracked channels in project settings.
Open the project's Slack triage to review reports; use **Refresh** to sync on demand.
Tracking never sends Slack messages or replies.

## Native Pilot intake

In Day, open **Settings → Slack intake** for the displayed project. Enter chosen
channel names or IDs, choose **All messages** or **Mentions only** for each,
and save tracking. Optional group handles extend mention filtering. Clearing the
channels stops tracking, not saved messages.

New channels start seven days back. Catch-up reads one small history page per
turn. Settings shows each channel's last page, remaining pages and failures,
plus source delays. This is incomplete coverage, not a complete Slack history.
Mention-only intake checks top-level messages. Automatic discovery of mentions
found only in replies remains deferred; use a message link for those threads.

Use **Import a message** in the same settings section for any channel your Slack
account can read. It works with tracking off and does not add a channel. Saved
imports remain on Today after tracking changes. Opening Settings or restoring a
draft never imports. An uncertain import offers **Check status**, which only
reads its receipt and never sends it again.
If it stays Unknown, **Set aside Unknown** checks once more and unlocks Settings.
It does not cancel or retry the action, which may already have saved a message.

## Reports in Day

Open **Slack reports** for the window's project from Command+K. A Slack request's card on
Today offers **Open in Slack**, which shows that message in your browser. Each report has
separate client organization, Slack author, original reporter and issue fields.
Missing information says **Not identified**. Evidence appears below each extracted
field; **Source message** opens the exact saved Slack link. **Correct details…**
saves project-local corrections. It does not rename or move a manual group.

**Edit group…** supports rename, merge and split. These manual choices stay put as
suggestions improve. Labels organize or hide reports, never complete them.
**Show hidden labels** and **Show tackled** include those reports again. The list
shows at most 200 saved reports per page. **Previous reports** and **Next reports**
reach older saved reports without keeping the entire history on screen.

**Start work…** opens the existing explicit start controls for that report. It never marks a
report tackled. **Mark tackled** is a separate user action; **Mark open** reverses
it. Only the start reaction is sent to Slack. Older automatic done records remain
readable as **Previously marked done**, not as your tackled decision.

The remaining sections describe the existing desktop triage. Its local status
names differ from Day, but the same user-only completion rules apply.

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

## Open or add a message from a link

Paste a Slack message link in the Command Palette (⌘K). A message already in triage
opens there as it is, even when hidden or dismissed. Otherwise choose **Add to Slack
triage** for a project: Pilot reads and sorts the message, then selects it. Pasting
alone never adds anything.

Waiting items stay outside the Inbox. On refresh, a reply from someone other than
you can resume only still-approved waiting work with a live eligible agent and no
other hold. The item keeps waiting when work is held or no live agent is available.
Your own replies do not end a wait. Attached agents can report Waiting or In progress,
but only you mark tackled. PR merges, mission completion and Slack reactions never do.
Pilot sends no completion reaction and does not remove the start reaction.

## Labels and refresh limits

Labels can organize or hide reports. Older close-label settings now hide only.
Use **Show hidden** or **Show dismissed**
(the **Filters** menu in Pilot Next) to include them.
Corrections help future classification. Common cases group related reports so you
can review recurring problems together.

Slack refreshes use bounded pages, batches, concurrency and recheck intervals,
without a local hourly operation cap. Provider AI allowances and Slack retry delays
still apply, including on forced refreshes. Explicit imports work without tracked
channels and stay available after channel tracking stops. Mention-only channels detect top-level mentions, not mentions
appearing only in replies.
