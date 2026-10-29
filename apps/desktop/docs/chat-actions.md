# Exact chat-row actions

Right-click a canonical Local chat row, including one that is not selected, or
Tab to its **Chat actions** (ellipsis) button and press Return. The native Kit
menu reads that exact chat before offering **Archive**, **Restore** and
**Make a mission…**. Opening, Escape and dismissal do not select/open a chat,
send input or mutate the daemon. Draft-only rows have no server chat actions.

Archive follows Swift's visible working guard. It never stops a chat first.
Restore is offered for archived non-retained history. Retired Control history
stays read-only. The daemon remains authoritative about work not represented in
the received summary, concurrent sends, startup and workspace transitions.

The source is captured as the Local endpoint plus daemon/storage-lineage home,
canonical session and project IDs and received row metadata. Reordering and
recycling do not retarget commands. Removal, changed row/project metadata,
offline state, another open confirmation, or native preedit fails closed.
The worker repeats hello/source/eligibility checks before the sole POST.
No title, list index, cwd guess or selected-chat fallback chooses a target.

**Make a mission…** opens the existing `MissionForm`, not another conversion
implementation. It captures the clicked source without selecting it. Review
title, goal, coordinator and drafting choices, then explicitly confirm. Drafting
may send a follow-up/start a reply only when chosen and confirmed. Opening or
Cancel never creates anything. An open/pending form is never replaced by a
different target. The existing guarded capability, source membership check,
private attempt reservation and non-replayable conversion receipts remain in
`mission_transport.rs` and the existing writer. A 201 does not independently
confirm delivery of the optional drafting message.

Closing while a conversion is pending keeps its original source owner. Other
row/header conversion entries remain unavailable until that exact request
finishes. A late matching completion is processed even while closed, without
changing text or focus; a different target/request cannot clear the busy owner.

**Copy session path** and **Copy session link** follow Swift's
`SessionClipboardActions` in the row menu and the header's More (…) menu, which
names the selected chat. They only write the clipboard, from the received
summary, without waiting for the action check. The path is the daemon-reported
absolute `sessionPath`, never derived from cwd, project or title. The link is
`pilot://chat/<id>` for canonical lowercase UUID IDs only, so the copied ID is
exact. A missing value shows the item disabled as *(Unavailable)*. Drafts are not
sessions and get neither.

## Archive contract and truthful outcomes

Audited source:

- Swift `Sidebar.swift:579`, `ArchiveView.swift:233`, `MissionModel.swift:197`,
  `AppModel.swift:1221`, `PilotCore/Protocol.swift:166,209,226`.
- Daemon `server.ts:1505–1506`, `sessions.ts:3418–3433,3480–3598,9133–9243`.

The existing method/path is an empty-body `POST /api/sessions/:id/archive` or
`POST /api/sessions/:id/restore`, returning HTTP 200 `SessionSummary`. This UI
requires that response's exact ID/project and requested archive state. Nothing
optimistically changes the selected transcript, reader anchor or draft.

This is not delete, Stop or mission membership movement. History and workspace
are retained under the existing daemon's archive/reclamation policy. Archive
clears MCP attention and removes transient session scratch after saving. Restore
may restore an already reclaimed workspace and clears prune/reset metadata.
These are the existing Swift/daemon side effects, not newly added cleanup.

The archive patch is staged through the metadata save queue; after write+rename,
the committed in-memory archive flag changes. **This route does not request
`durable=true`**: the file/parent-directory fsync branch of `save` is not used.
An acknowledged 200 is not a stronger crash/power-loss durability promise.
Scratch cleanup or emit/response failures can occur after the save. Consequently
every lost/malformed/mismatched/non-200 response after POST dispatch stays
**Unconfirmed**, not safely rejected and not automatically retried. A later GET
or WebSocket summary describes current state, never settles that missing ACK.

An actual matching 200 is shown as **Confirmed** for the original target. The
per-window report keeps request identity, known ACK and unknown outcome
independent of current selection. Late/duplicate completions cannot overwrite a
terminal result. New actions are serialized; unknown targets are blocked from
automatic or repeated mutation. Reports are in memory, not promised across
process restart; no retained command is replayed on startup. Existing private
conversion attempts remain independently durable in their original store.

An inspection can release a known archive ACK's temporary editor fence only
when that same ACK/report ID was already known **at GET admission**, and the
qualified source/operation still matches on completion. A delayed pre-ACK GET,
an older operation or Unknown cannot release it. This reads current permission
after a known ACK, never converts an observation into a mutation receipt.

## Archived chat composer

When the chat list shows the selected chat archived, its composer slot shows
*This chat is archived* with a **Restore** button instead of the editor, as in
Swift's `ArchivedComposer`. The transcript stays mounted and readable. The
editor, queue, send/stop and attachments are unmounted, not
disabled; the `ChatEditor` entity keeps the draft, and a composition the input
method can no longer finish ends as typed and is saved. Typing or navigating
never restores.

Restore reads the exact selected chat (GET, as the row menu does), then submits
the shared non-replayable request. Navigating away while that read runs submits
nothing. Pending shows *Restoring…*; a refusal before the POST is an error with
Restore offered again; Unknown or another pending action disables it with the
reason. An ACK shows *Restored* until the list shows the chat open: only then
does the composer return, focused if focus was on the notice. The notice shows
the selected chat's status, so the sidebar status omits it. Retained Control
history refuses after the read. Code: `archived_composer.rs`,
`Actions::restore_view`.

## Ownership and bounds

`chat_actions.rs` owns targeting/evidence/report policy;
`chat_actions_worker.rs` owns the pinned HTTP worker; `chat_actions_view.rs` owns
per-window status and operation ownership. `chat_actions_navigation.rs` is the
small LocalViewer/menu/form seam. Production `ChatList::render_item` uses the
same callbacks for right-click and the keyboard-reachable shared icon button.

Acknowledged Archive/Restore reports stay in the operation owner without a
success notice, title/ID dump or replacement toast. Pending, rejected, Unknown
and local errors remain visible. Hiding success does not release ACK fences.

One off-UI worker has one in-flight request and one bounded queued command.
There are no retries, idle polling, environment/disk reads in render or per-row
timers. Requests/responses use bounded channels; HTTP has 2-second connect and
5-second request deadlines, redirects/proxies/retries disabled, 256 KiB response
admission and 64 KiB retained action-metadata admission. Pending text and job
content are not retained in evidence, only counts. Reports retain the latest
operation per target without a distinct-chat lifetime admission limit. Completed
actions never exhaust capacity; pending and Unknown evidence and exact ACK editor
fences are not evicted to admit other targets. Worker exit closes its command lane, and teardown never joins
HTTP on the UI thread.

## Scoped verification

From `apps/desktop`, using the normal shared CPU2/4GiB admission and private
target/incremental output:

```sh
python3 scripts/check-scoped.py --unit chat_actions --test chat_actions --lint
python3 -m unittest scripts.test_ci.CiTests.test_native_supported_runs_entire_compiled_probe_list scripts.test_ci.CiSystemBashTests.test_native_supported_runs_entire_compiled_probe_list
```

Policy/faux tests cover exact IDs/metadata/home, working/retained/delegated/linked
eligibility, immutable completions, GET-only opening, exact empty-body POST
method/path, identity refusal before POST, post-commit error/lost/mismatched ACK,
readback without settlement or replay and delayed completion.

The capacity regression executes 40 distinct acknowledged/rejected pairs and
same-chat repeats, checks single-pending admission, then retains an Unknown
through 20 further acknowledged targets. It also checks exact ACK inspection,
editor fences and updater restart safety. Unit coverage rejects old completions
and inspections against a newer operation.

The native target mounts the actual production LocalViewer rows, real Kit
menus, existing MissionForm and private writer against owned synthetic HTTP.
It checks narrow/wide (680/1100), light/dark, unselected right-click, Escape,
Tab-to-real-button/Return, preedit-before-blur guard, reorder, stale/offline
action refusal, nonselected Archive+Restore, conversion Cancel then confirmed
exact-source submission and the mounted selected working chat's draft/reader/
Stop preservation. Captures are actual offscreen GPUI, not SwiftUI mock images.
One additional 1100-point native case seeds a real private Unknown delivery for
the selected chat, performs the other row's Archive/Restore and conversion
Cancel, then drains/reopens the store and compares every serialized operation
field. It sends no pending delivery, Stop, or chat-open command. Disabled menu
items are tested by real pointer/keyboard refusal, not a missing Kit AX flag.
One selected idle-chat journey checks real input gating while Archive is
pending, after ACK without a stream update, after Restore and during Unknown,
with the same draft/editor/reader. To rerun only this case:

```sh
PILOT_NEXT_CHAT_ACTIONS_CASE=selected-archive python3 scripts/check-scoped.py --test chat_actions
```

The archived composer journey (`archived-composer`) runs at 680/1100 in light
and dark: composition and draft retention when the list archives the chat,
transcript scroll, no restore on typing, Tab to Restore, keyboard (light) and
pointer (dark) restore confirmed by the list with focus return, and at 1100
light stale navigation, refused inspection with retry, and a lost Unknown that
is never repeated.

`PILOT_NEXT_CHAT_ACTIONS_CASE=review` selects the wide-light delayed conversion
and selected-idle journey together; default CI retains all layout and pending
cases. Unknown case names fail, never produce a zero-test pass.
They do not prove OS IME, visible smoothness, macOS release acceptance, live
daemon mutations, Linux/Wayland or full Swift parity. No full desktop, Swift,
profiling or remote-CI wait was run for this slice.

Remaining Rename, Pin/Unpin, Copy canonical link/path, Go to project and linked
mission actions are inventoried in the parent checklist, not enabled stubs and
not part of this feature. No browser/terminal/updater/backend/permission expansion.
