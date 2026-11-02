# Slack triage in the Inbox

The Inbox has two tabs: **Chats** (needs you, ready to merge, paused) and **Slack**,
the classified Slack messages of the projects in scope. It replaces Swift's
`SlackTriage.swift` table and board for everyday triage; it is not a separate page.
The Inbox project filter is the scope: All projects lists every project with Slack
channels, a project lists only its own.

## Existing contracts only

| Need | Route | Notes |
| --- | --- | --- |
| Projects, labels, channels | `GET /api/projects` | Labels and their hide/close effect come from `tracking`; settings own them. |
| Source health | `GET /api/sources?projectId=` | Sync, sign-in, hourly budget and errors. |
| Messages | `GET /api/tracked-items?projectId=&kind=slack` | Pages of 100, at most 500 per project (Swift's bound), plus dismissed rows: all with Show dismissed, else only label-closed ones for Show hidden. |
| Excerpt | `GET /api/tracked-items/:id/excerpt` | pilotd reads the thread's first message on demand, latest wins. Never stored; 40 kept in memory. |
| Triage change | `PATCH /api/tracked-items/:id` `{"slack":{field}}` | One field: status, type, severity or label (`null` clears). |
| Sync | `POST /api/sources/:projectId:slack/poll` | Empty body: ordinary admission. Never forced past the hourly budget. |

Reads run when the tab opens, the scope or Show dismissed changes, pilotd signals a
change (`tracked.changed` or `sources` on the control stream, coalesced by 300 ms)
or the user asks again. Each read checks the pinned daemon identity before and after;
a different daemon's reply is refused and the last report stays, marked stale. A new
scope never shows another scope's messages.

Opening the tab reads no Slack message. The excerpt is read only while a message's
detail shows: after the selection settles (250 ms) in the wide list, or when the
message is opened. pilotd supersedes an in-flight excerpt read with a newer one.

## Writes

Every write is an explicit action on one message: the Status, Type, Severity and
Label menus and Dismiss/Restore. A choice equal to the current value sends nothing.
One change per message at a time; its controls are disabled while it saves. Only a
200 reply carrying the same message (ID and project) with the change applied counts
as saved, and replaces that message on the board. Anything else, including a lost
reply, is **Unknown**: shown beside the message, never resent, followed by a fresh
read that shows what pilotd reports. A refused daemon identity sends nothing.

Overrides stay in Pilot. pilotd itself may add a done reaction in Slack when a
message whose work Pilot started is marked Done; the detail says so for those
messages. Sync is an ordinary source poll within the local hourly budget; it is
offered only when one project is in scope. No message is posted, no link is
ingested from pasted text and no credentials are read.

Manual corrections and label effects are pilotd's: the board shows the effective
values, notes which fields the user changed and shows Closed/Waiting/Done reasons.
Hidden-label and label-closed messages stay behind **Show hidden (N)**, dismissed
ones behind **Show dismissed**, both in the status filter menu.

## Presentation

Calm Inbox hierarchy: one toolbar (status filter, List/Board when wide, message
count, Sync), notices only when they say something, then the messages. Rows reuse
`ResourceLabel`: title, one meta line (project when several, channel, type,
severity, age, replies) and a trailing severity dot for critical (danger) and high
(warning) only; words always carry the severity.

- **List**: Kit List sections by status (Open, In progress, Waiting, Done, and
  Dismissed when shown); empty sections are omitted.
- **Board** (window at least 960 pt wide): one Kit List per status column.
- **Detail**: title and meta, the excerpt, the four triage menus, reasons, save
  state, then Open in Slack (exact pilotd link, desktop app when it recognises the
  team), Copy link (exact text), Open chat (the latest linked chat, when loaded) and
  Dismiss/Restore. Wide List shows it beside the list; narrow windows and the
  board open it in place with Back.

Keyboard: up/down move within the list or a column (Kit List), left/right cross
board columns, Return opens the detail (or focuses it beside the list), Escape
closes it. Pointer activation is pinned to the rendered message ID.

## Not in this slice

Starting a chat or mission from a message, common cases, adding a message from a
pasted link, search and Force sync stay in Swift for now. Linked-chat status in rows
and per-row context menus are also deferred.

## Verification

- `slack_triage::tests`: parsing, Swift-equivalent filters/sorting/hidden counts,
  keyboard moves and successors, narrow override bodies, bounded excerpts.
- `slack_triage_transport::tests`: scoped GET-only reads, foreign identity and
  malformed replies refused whole, one narrow PATCH confirmed by its echo,
  unconfirmed/lost/foreign replies Unknown and sent once, excerpt and poll reasons,
  unforced polls.
- Native `slack_triage` (hidden, production LocalViewer root, faux pilotd) at
  680/1100 in light and dark: no reads on the Chats tab, loading, sections and order,
  status/hidden filters, keyboard selection, excerpt only with a visible detail,
  exact link open/copy, status change, exact chat navigation, Unknown without resend,
  board columns with left/right (wide), Escape (narrow), project scope, unforced sync
  and identity refusal with the stale report.

Static captures are appearance evidence, not motion, OS IME/AX or performance
acceptance. No real Slack, account or settings were used.
