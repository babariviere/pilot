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
  team), Copy link, More (Start another chat when linked, Dismiss or Restore) and Close.
  Below the selectable title, triage values are a quiet label/value
  list (Status, Severity, Type, Label), like an issue sidebar: each value is plain text
  that shows a chevron on hover and opens a checked menu. The Label menu offers No label
  and names each label's effect (hidden from Inbox, closes it). Reasons, the done-reaction note,
  which fields the user changed and the save state follow as captions. Then the message's
  one action: **Start chat**, or **Open chat** once a listed chat is linked (Cmd-Return
  does the same from the board, list or inspector). The **thread** comes last: every
  message, parent first, with author, age and selectable text.

The toolbar carries the status tabs (list) or the message count (board), the Board/List
switch (wide windows), a Filters menu (Show hidden (N), Show dismissed) and Sync when a
single project is in scope. Wide windows label the menu and, while a filter is on, name
it (Hidden, Dismissed or both); narrow ones keep the icon beside the status tabs, which
scroll rather than run under it. An active filter keeps the control selected.

## Command Palette links

Pasting a Slack message link (`https://<workspace>.slack.com/archives/<channel>/p<ts>`,
with an optional `thread_ts`, read exactly as pilotd's `parseSlackMessageLink`) into the
Command Palette runs one passive lookup: `GET /api/projects` and the local-only
`GET /api/tracking/slack/search?query=<link>`, gated by the pinned daemon identity before
and after. Lookalike hosts, other schemes, ports, credentials and other paths are not
looked up. Only items whose source key is this message (thread, then message) count.

- **Open:** each project already holding the message gets a row that opens its Inbox
  triage with that exact item selected in the inspector. The filters that show it turn
  on (Show hidden for a hiding or closing label, Show dismissed for a dismissed item); the
  item keeps its status, and stays on the board while the scope is unchanged even past
  the loaded pages. Nothing is written.
- **Add to Slack triage in <project>:** one row per other Slack-tracking project,
  projects tracking the message's channel first, then the focused project, then pilotd's
  order. Only activating it sends `POST /api/tracking/slack/messages` with the link as
  pasted (trimmed); pilotd reads and sorts the message. One add runs at a time; a second
  activation while it runs sends nothing. A 200 reply naming this message in this project
  selects it. pilotd's refusals (400/404/409/503) keep its reason with Try again, a new
  explicit request. Anything else, including a lost reply, is Unknown: never resent; the
  board rereads and selects the message if it did land.

The palette's All/project choice follows Swift: All projects stays All, another project
gives way to the message's. No project, account or team is guessed.

## Start chat

As in Swift (`TrackedItemRequests.startChat`, `AppModel.startChat(from:)`), Start chat
opens an ordinary new Build draft in the message's project, never another one, with
Swift's first message: what to do, then the title, type, severity and pilotd's exact link
as single-line quoted context. The draft names its message ("#support · Atlas") and its
project is fixed; Don't link to Slack keeps the text and frees the project. Nothing is
sent until the user sends the draft through the normal composer, model and delivery
path. A message whose project this app no longer has starts nothing.

The creation request is the unchanged chat-create operation; it never carries the
message. The draft's message is saved with it, and when pilotd accepts the creation the
draft courier saves the link in the same private write, then sends pilotd's existing
`PATCH /api/tracked-items/:id {"sessionId": <chat>, "start": true}`, as Swift does after a
confirmed start. pilotd links each chat once and runs its start effects (In progress,
and Slack's eyes reaction for tracked channels) only for a new link, once per item, so a
lost reply keeps the link and resends it (after 10 s, the next courier pass or a restart),
and never to another daemon. A 200 reply listing the chat, or a 400/404 (the message is
gone), settles it.

Start chat again on the same message returns to its draft (edited, sending or created) or
its chat, never a second draft. Start another chat (More, when linked) is the explicit way
to add one.

## Existing contracts, plus one read

| Need | Route | Notes |
| --- | --- | --- |
| Projects, labels, channels | `GET /api/projects` | Labels and their hide/close effect come from `tracking`; settings own them. |
| Source health | `GET /api/sources?projectId=` | Sync, sign-in, hourly budget and errors. |
| Messages | `GET /api/tracked-items?projectId=&kind=slack` | Pages of 100, at most 500 per project (Swift's bound), plus dismissed rows: all with Show dismissed, else only label-closed ones for Show hidden. |
| Thread | `GET /api/tracked-items/:id/thread` | New, read-only (user approved). pilotd reads the parent and up to 100 replies through the same Slack read path and single latest-wins slot as the excerpt; each message plain text, at most 4000 characters and 200 lines. Never stored or broadcast. 40 threads kept in memory. |
| Triage change | `PATCH /api/tracked-items/:id` `{"slack":{field}}` | One field: status, type, severity or label (`null` clears). |
| Chat link | `PATCH /api/tracked-items/:id` `{"sessionId","start":true}` | Only after pilotd accepted the chat's creation; Swift's confirmed start. |
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

Overrides stay in Pilot. pilotd itself adds an eyes reaction when a sent chat starts work
on a message in a tracked channel, and may add a done reaction when such a message is
marked Done; the inspector says so for those messages. Sync is an ordinary source poll
within the local hourly budget. No message is posted, a pasted link is added only by an
explicit Add, and no credentials are read.

## Not in this slice

Starting a mission from a message, common cases, word search of message text and Force
sync stay in Swift for now. The board does not virtualize its cards (each project holds
at most 500 messages).

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
  refusal with the stale report. Then Command Palette links: lookalikes and words
  unsearched, a tracked dismissed link opened exactly without writes, ranked explicit
  adds with pending/double activation, a refusal with pointer Try again, Unknown not
  resent (reconciled when it landed), identity refusal and the composer draft kept.
  Then Start chat: the editable draft in the message's project with nothing sent, edits
  kept and the same draft on a second (keyboard) activation, one explicit send carrying
  the message, no duplicate while it sends, Open chat and Start another chat for a linked
  message, Don't link to Slack, and refusal for a removed project.
- `interaction::links::tests`: link only after accepted creation, never in the create
  request; lost reply kept, resent after restart only to the same daemon; gone item
  dropped; Close not held by a slow link. `delivery_store::tests`: the link is saved
  with the acceptance, survives reopen and retirement, is fixed while sending, and is
  refused for another project.

Static captures are appearance evidence, not motion, OS IME/AX or performance
acceptance. No real Slack, account or settings were used.
