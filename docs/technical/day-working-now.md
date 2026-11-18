# Today working chats

Today reads `workingNow` from the existing authenticated project Day overview.
The daemon owns activity: explicit `SessionSummary.working`, current holds,
active mission membership and saved in-progress/review task titles. No task or purpose
is guessed from a chat title or report. A missing purpose is null. Old services
without this field show unavailable activity, not an empty list.

The native scope read reuses each selected project's overview. It adds no chat
subscriptions, workers, service connections or per-chat reads. Project catalog
checks still fence access changes during the read. The existing WebSocket
invalidations trigger coalesced reads. Invalidation makes activity earlier.
Completed same-scope reads still advance rows during continuous streaming, but
stay explicitly earlier when a later event crossed them. Only the newest read
generation can publish, and only an uncrossed successful read restores live
status. Identity/access failure purges the cached activity so later notices
cannot revive it. Failed/disconnected reads hide activity rows. Confirmed empty requires
a complete catalog and live working reads from every selected project.

`WorkingNow.tsx` renders the selected hairline layout below Needs you. Four rows
show initially; Show all keeps its choice through Back. `OpenChatAction.tsx`
owns the shared chat-bubbles action with a caller-owned accessible name. Named
chat rows use the icon and an Open chat tooltip. Other destinations show explicit
labels, such as Open coordinator chat or Open triage chat. Opening uses the
existing read-only chat page. Native chat reads check the chat's project against
the accessible catalog before and after history I/O, without changing the
window's project, draft, subscriptions or execution. Access loss clears old chat
history on the next read.
The status line and header retry slot keep their geometry during refreshes,
so ordinary status aging does not move the sections below.

## Verification and qualification

- Daemon behavior: `project-dashboard-server.test.ts` covers mission and standalone
  activity, explicit purposes, holds, waiting, archived/foreign chats, task changes
  and stops. Existing dashboard tests remain unchanged.
- Native behavior: `today_scope_tests.rs` covers authenticated cross-project
  projection, complete/unavailable/disconnected reads and denied projects.
  `native/tests/working_chat.rs` opens an exact foreign-project chat through the
  JSON bridge, removes project access, checks history removal and verifies no
  session creation or operation writes. Automatic profile revocation also
  clears the open history when project refresh fails before its chat read.
- Connected lifecycle: the existing `connected` core journey starts an actual
  forked faux-provider Build worker, holds its first response, observes Today,
  changes the saved task, opens its exact chat and returns without writes,
  then releases the response and checks that the finished worker leaves Today.
  Its original lost-start-ACK, Check and reopen assertions remain.
- UI behavior: `Working.test.tsx` exercises the real Today and chat views over
  scripted sources: loading, empty, stale, disconnected, failed, duplicate/late
  reads, access loss, starts/stops/task changes, focus, Show all and drafts/Back.
- Native input/rendering: `WorkingNative.test.tsx --target macos` checks real
  rendering in both appearances, chat-bubbles labels, Return after Back and
  typing through an activity update. Captures are fixture data in real views,
  not a connected packaged-app or human screen-reader acceptance.
- Performance: 10,000-chat daemon projection, 50 warmed runs on this Mac:
  median 0.81 ms, p95 1.10 ms. This measures added projection cost only, not
  complete HTTP latency or native large-session scrolling.

Mac daily-use qualification must repeat this with the packaged app and live
faux-provider starts/stops alongside an unsent Today reply and long names.
Physical KDE Plasma Wayland qualification runs `WorkingNative.test.tsx
--target linux` plus real service disconnect, permission loss and reconnect.
Fuller accessibility qualification walks headings, project/task/status text,
chat-bubbles labels/tooltips, Tab/Shift-Tab, Enter/Space and Back with VoiceOver
and Orca, including a removed focused row and reduced motion. These physical
Linux, screen-reader and packaged daily-use checks remain pending; headless
tests and Mac rendering do not substitute for them.
