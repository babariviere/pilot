# Slack triage in the Inbox

The Inbox has two tabs: **Chats** (needs you, ready to merge, paused) and **Slack**,
the classified Slack messages of the projects in scope. The Inbox project filter is
the scope: All projects lists every project with Slack channels, a project only its own.
The Slack tab uses the pane's full width; the Chats tab keeps the reading column.

## Layout

- **Board** (default, windows at least 960 pt wide): Swift's kanban. One column per
  status (Open, In progress, Waiting, Done, and Dismissed when shown) on the tray
  surface, each a scrolling stack of cards: severity dot, type and severity, label tag,
  a two-line title, then channel, age and replies (project first when several are in
  scope) and any Waiting/Done/Closed reason. Dragging a card onto another column changes
  its status. Arrow keys move between cards and columns, Return opens the inspector,
  Escape closes it.
- **List**: one tab per status with its count, then that status's rows (title and one
  meta line, severity dot for critical and high). Narrow windows always use the list.
- **Inspector**: opens on click or Return, beside the board or list in wide windows and
  in their place (with Back) in narrow ones. Its header holds the context line and icon
  actions: Open in Slack (pilotd's exact link, the desktop app when it recognises the
  team), Copy link, Open chat (the latest linked chat, when loaded), More (Dismiss or
  Restore) and Close. Below the selectable title, triage values are a quiet label/value
  list (Status, Severity, Type, Label), like an issue sidebar: each value is plain text
  that shows a chevron on hover and opens a checked menu. The Label menu offers No label
  and names each label's effect (hidden from Inbox, closes it). Reasons, the done-reaction note,
  which fields the user changed and the save state follow as captions. The **thread**
  comes last: every message, parent first, with author, age and selectable text.

The toolbar carries the status tabs (list) or the message count (board), the Board/List
switch (wide windows), a Filters menu (Show hidden (N), Show dismissed) and Sync when a
single project is in scope.

## Existing contracts, plus one read

| Need | Route | Notes |
| --- | --- | --- |
| Projects, labels, channels | `GET /api/projects` | Labels and their hide/close effect come from `tracking`; settings own them. |
| Source health | `GET /api/sources?projectId=` | Sync, sign-in, hourly budget and errors. |
| Messages | `GET /api/tracked-items?projectId=&kind=slack` | Pages of 100, at most 500 per project (Swift's bound), plus dismissed rows: all with Show dismissed, else only label-closed ones for Show hidden. |
| Thread | `GET /api/tracked-items/:id/thread` | New, read-only (user approved). pilotd reads the parent and up to 100 replies through the same Slack read path and single latest-wins slot as the excerpt; each message plain text, at most 4000 characters and 200 lines. Never stored or broadcast. 40 threads kept in memory. |
| Triage change | `PATCH /api/tracked-items/:id` `{"slack":{field}}` | One field: status, type, severity or label (`null` clears). |
| Sync | `POST /api/sources/:projectId:slack/poll` | Empty body: ordinary admission. Never forced past the hourly budget. |

Reads run when the tab opens, the scope or Show dismissed changes, pilotd signals a
change (`tracked.changed` or `sources` on the control stream, coalesced by 300 ms)
or the user asks again. Each read checks the pinned daemon identity before and after;
a different daemon's reply is refused and the last report stays, marked stale. A new
scope never shows another scope's messages.

Opening the tab or moving the selection reads no thread. A thread is read only while
the inspector shows its message: at once when opened, after the selection settles
(250 ms) when the arrow keys move it. pilotd supersedes an in-flight read with a newer one.

## Writes

Every write is an explicit action on one message: a choice in a property menu, Dismiss
or Restore, or dropping a card on another column. A choice equal to the current value
sends nothing. One change per message at a time; its controls are disabled while it
saves. Only a 200 reply carrying the same message (ID and project) with the change
applied counts as saved, and replaces that message on the board. Anything else,
including a lost reply, is **Unknown**: shown in the inspector, never resent, followed
by a fresh read that shows what pilotd reports. A refused daemon identity sends nothing.

Overrides stay in Pilot. pilotd itself may add a done reaction in Slack when a message
whose work Pilot started is marked Done; the inspector says so for those messages. Sync
is an ordinary source poll within the local hourly budget. No message is posted, no
link is ingested from pasted text and no credentials are read.

## Not in this slice

Starting a chat or mission from a message, common cases, adding a message from a pasted
link, search and Force sync stay in Swift for now. The board does not virtualize its
cards (each project holds at most 500 messages).

## Verification

- `slack-source.test.ts`: the thread read returns parent and replies with authors,
  supersedes an excerpt in flight, uses the bounded reply limit, stores nothing and
  refuses removed channels. `tracking-server.test.ts`: Slack-only, unknown item 404.
- `slack_triage::tests` and `slack_triage_transport::tests`: parsing, Swift
  filters/sorting/hidden counts, columns, keyboard moves and successors, narrow override
  bodies, bounded thread cache, thread identity, GET-only scoped reads, identity and
  malformed-reply refusal, echo-confirmed PATCH, Unknown sent once, unforced polls.
- Native `slack_triage` (hidden, production LocalViewer root, faux pilotd) at 680/1100
  in light and dark: board default and columns (wide) or status tabs (narrow), hidden
  filter, arrow keys, thread read only on open, exact link open/copy, property menu
  changes, drag to a column (wide), exact chat navigation, Unknown without resend, list
  layout and Close (wide), Escape (narrow), project scope, unforced sync and identity
  refusal with the stale report.

Static captures are appearance evidence, not motion, OS IME/AX or performance
acceptance. No real Slack, account or settings were used.
