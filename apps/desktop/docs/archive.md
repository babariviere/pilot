# Archive

Open **Archive** from the existing project selector. It is a dedicated native
inventory, not the sidebar's optional “Include archived” view. Opening the page
does not change the selected chat, project scope, draft or transcript owner.
The page retains its own search, project/mission filters, selection and scroll
while navigating away and Back. Escape first dismisses a menu or clears search,
then returns through the ordinary navigation history.

## Coverage, audited against current source

- `packages/daemon/src/server.ts`: the control socket sends
  `sessions.list({ archived: "all" })` as its full baseline. The existing
  `GET /api/sessions?archived=all` returns the same unpaginated summary array.
- `packages/daemon/src/sessions.ts`, `list`: enumerates the daemon's registered
  metadata map, without a count limit or page cursor. Project filtering compares
  `projectId`; mission filtering uses returned membership, not names or project
  inference. Neither contract enumerates deleted, unknown or unregistered data.
- `apps/macos/Sources/Pilot/{ArchiveView,ArchiveBrowserState}.swift`: the original
  browser uses this existing archived-summary contract, project and mission
  filters, newest archive first, and exact-ID chat navigation.

Next reuses the shared **full** Local baseline, not the bounded Inbox or sidebar
projection. It shows all registered archived chat summaries, with no display
cap, sorted newest archive first and then exact ID. Search is literal,
case-insensitive over title and reported project/mission/location metadata,
not transcript content. Projects have distinct **All projects**, **No project**
and exact project-ID choices. A mission filter includes its returned coordinator
and members, including cross-project members when All projects is selected.
An archived chat does not imply its mission is archived. This page lists chats,
not mission lifecycle records. Missing project/mission names fall back to the
reported ID; unknown membership never matches a mission filter.
Malformed/unobserved project metadata is **Project unavailable**, not **No project**.
The inventory includes retained archived history; special Restore eligibility is
still checked by the existing handler, not inferred from inventory presence.

The normal source follows the already-open shared control socket. **Refresh**
uses the passive summary GET, pinned by hello identity before and after. It is
single-flight, does not reconnect the chat, and cannot overwrite a newer streamed
summary. A malformed/error response retains the previous rows. Connected full
inventory, refreshing, failed refresh, initial loading and offline/stale retained
summaries are visibly distinct. The offline snapshot is window/process memory,
not a persisted offline archive database. A fresh baseline is not an atomic
filesystem snapshot or a promise about previously deleted data.

## Passive opening and existing Restore

Ordinary chat sockets call `sessions.subscribe`, which can start pending work
after a concurrent restore. Archive opening therefore does **not** use a chat
socket, even when the cached archive flag has become stale. `Command::OpenArchive`
uses only the existing `GET /api/sessions/:id/history?before=9007199254740991&limit=24`,
with hello checks before/after. `SessionManager.history` and the kernel's
`readEarlierEntries` read committed storage without starting a worker. IDs come
only from returned summaries; there is no title routing, guessed ID, filesystem
fallback, subscription, restore, model read or provider call. Reconnect keeps
this passive admission even if the summary now says restored.

The existing transcript owner renders the returned entries with canonical entry
keys. Top-scroll loads older 24-entry pages through the same passive GET. The
legacy 256-entry live-window cap does not truncate this paged reader. Existing
Find can request all older pages; errors remain errors, not complete coverage.
Late results are generation/revision-fenced. Inventory refresh leaves transcript
generation, rows, cursor, selection and scroll untouched.

Archived chats retain the existing archived-composer notice. **Restore** still
routes the unchanged guarded handler and its exact preflight/ACK/Unknown rules
in [chat-actions.md](chat-actions.md). No new mutation protocol or automatic
restore is introduced. Restored rows leave Archive on the returned summary,
not by title or optimistic removal.

**Precise contract residual:** the passive legacy history GET returns
`entries/more`, not the socket's immutable `TranscriptContext`. Pages are
committed reads of the current conversation, not one pinned multi-page snapshot
across a concurrent restore/reset. It also has no artifact catalogue/live tail.
Archive inventory completeness is supported for registered summaries; atomic
passive transcript-context capture and live/archive-artifact parity are not
claimed. They require a separately approved existing-contract audit or narrow
backend change, not an interactive subscription workaround.

## Scoped verification

```sh
python3 scripts/check-scoped.py --unit archive --test archive --lint
bash scripts/cargo.sh build --locked -p pilot-desktop
python3 -m unittest scripts.test_ci.CiTests.test_native_supported_runs_entire_compiled_probe_list scripts.test_ci.CiSystemBashTests.test_native_supported_runs_entire_compiled_probe_list
```

Source-shaped fake HTTP/control-stream tests cover full inventory, exact IDs,
same-title routing, passive paging/reconnect after restore, a late target switch,
single-flight held refresh and rejection of older GET data after newer streamed
summaries. Model tests cover projectless/all and exact mission relationships,
1,500-row inventory, and 1,000-entry lazy history without the legacy cap.
Hidden real GPUI cases use 680/1100-point windows in light/dark, injected actions
and summaries only. They exercise Archive/search/filter/open/Back/Escape/keyboard,
empty/offline/error/held refresh, late target switch, restored-row transition,
composition and unrelated draft/history retention. These are source fixtures,
not OS IME, visible smoothness, live account/data, Linux/Wayland or release
acceptance. No Swift or broad suite is run for this slice.
