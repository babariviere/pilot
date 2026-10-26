# Exact Local chat Rename

The existing native row context menu and keyboard-reachable Chat actions button
open **Rename…** for the clicked canonical Local chat, not the current selection.
The dialog retains that target's home, endpoint, ID and metadata and a bounded
native input. Opening/canceling does not select a chat, send, stop, archive or
change its permissions/project/mission membership. Composer preedit blocks the
menu/open path; title preedit blocks Rename/Cancel/Escape. Focus returns to the
mounted chat navigation after closing. This is a focused follow-up to the existing
[chat actions](chat-actions.md), not a new browser or backend contract.

## Existing contract audit

Swift `SessionRename.swift` captures `SessionRenameTarget` from the row and calls
`AppModel.renameSession`, then `PilotClient.rename`. The supported operation is
`POST /api/sessions/:id/title` with `{title: string}`, returning `SessionSummary`.
`server.ts` validates nonblank text. `Sessions.rename` in `sessions.ts` trims and
collapses ECMAScript whitespace, slices to 200 UTF-16 units, rejects retained
Control history, cancels generated-title replacement, saves and emits without
changing activity. It also calls the existing mission coordinator-title hook.
That existing side effect is not a membership move or a new backend action.

The GPUI input atomically rejects edits beyond 200 UTF-16 units (and 800 bytes),
so normalization never requires splitting a surrogate pair. Empty/unchanged
normalized titles disable Rename. The input's native Unicode/grapheme editing,
clipboard and IME engine remain authoritative. Normal Enter submits only from
that focused title field; Escape and Cancel close unless title composition is
active. No queued input-event submission can outlive a canceled dialog.

## Delivery and bounds

A fresh identity-pinned hello and exact-chat GET revalidate the captured source
before dispatch. Failure here is **not submitted**, retaining the original title
and draft for an explicit user decision. There is no optimistic list title write.
The sole POST uses the existing no-proxy, no-redirect, never-retry client with
2-second connect/5-second per-request deadlines. The response body is bounded to
256 KiB. Only HTTP200 with the exact ID/normalized title and summary fields is
**confirmed**, not a claim of fsync durability. The daemon can mutate title or its
coordinator before save/emit fails, so every post-dispatch error, lost connection,
wrong identity/title or invalid body is **unconfirmed**, never safe to replay.

A retained form processes the exact pending request completion even if the dialog
closed. One Rename may be pending per window. At most16 per-chat forms/reports
are retained; an unconfirmed one cannot be overwritten, cleared by GET/WS/title
visibility or resubmitted by reopening. Passive pending/error/receipt information
remains beside existing chat-action status after closing. These records are
window-memory only, not crash-durable operation receipts. No automatic retry or
GET/title-based reconciliation is implemented. Swift remains available for
manual investigation, not as a claimed receipt source for this request.

## Focused synthetic verification

`python3 scripts/check-scoped.py --unit chat_rename --test chat_rename --lint`
selects normalization/transport tests plus the offscreen production LocalViewer,
row menu, real input/dialog and private draft writer against a temporary synthetic
HTTP service. CPU2/4GiB/private outputs and the shared check slot are unchanged.
The helper-free registration reflects this feature's lack of visual-worker use;
broad CI remains unchanged. Optional `PILOT_NEXT_CHAT_RENAME_DIR` saves actual
native light/dark screenshots at680/1100pt. None of these tests rename a live
chat, launch the visible app, or prove OS IME/motion/Wayland acceptance.

After additive caller/registry integration, set `PILOT_NEXT_CHAT_RENAME_CASE=routing`
with `scripts/check-scoped.py --test chat_rename --lint` to run only the1100pt
light successful menu-to-form journey, including retained conversation/stream,
IME, exact target and private draft assertions. Unknown selector names fail.
The default remains all6 cases; this selector does not replace broad CI or claim
new light/dark qualification when prior unchanged coverage is reused.
