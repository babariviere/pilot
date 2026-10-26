# Explicit Local mission update

Open a mission's Activity, then **Post an update…**. The contextual native
textarea has one primary **Submit** action (also Cmd-Enter); ordinary Enter
edits. Close/Escape retains text and delivery state and restores mounted
activity focus. New update clears a confirmed form only by explicit intent.
No health/handoff, actor, coordinator, task or agent-start controls are added.

## Existing contract and attribution

Swift `PilotClient.postMissionEvent` and `MissionEventWrite` use
`POST /api/missions/:id/events`. The daemon's `server.ts::missionRoute` calls
`MissionStore.log` with its default `USER = {}` actor. The new client sends
only `{text, kind: "update"}`. There is no fabricated actor field or agent
session ID. This is a user-authored update because a user explicitly submits
it through that supported UI contract, not because arbitrary historical
no-session events prove user authorship.

`log` validates a nonblank ECMAScript-trimmed string, with an 8,000 UTF-16-unit
limit on the raw input. It inserts an update event with `is_user_note=1`, updates
the mission timestamp, commits its transaction and publishes change listeners.
It does not supply `wake`, create/assign/start a chat, change membership or
write health. Existing transaction phase/Linear reconciliation and change
observers (mission context/PR/catalog refresh) remain unchanged. No new backend
restriction or race-free state check is claimed. Existing archived/done mission
semantics are retained.

Historical event responses still expose no durable actor-role field. A missing
`sessionId` can mean user **or daemon**, and a present ID is recorded source,
not proof of agent authorship. The read timeline and its ambiguity copy are
unchanged; the new ACK does not relabel fetched history.

## Identity and delivery

A submission captures an immutable operation UUID, canonical Local daemon/home
and mission key, and exact native text. Before the one POST, the worker checks
pinned Local hello and canonical catalog provenance. There is no redirect,
proxy, retry, host fallback, readback matching or replay. This read preflight
is not atomic with the write. The operation UUID is local correlation, not a
backend idempotency key and is not sent as invented API authority.

Only a complete HTTP201 with a valid event ID, exact normalized text,
`kind:update`, finite nonnegative timestamp and no session/task/health values
acknowledges the operation. A provably pre-POST failure is Not sent. Any failure
after POST admission, including HTTP400/409/500, redirect, lost/truncated/
oversized/malformed/mismatched ACK, is Delivery unknown. Publication can fail
after COMMIT. Unknown and Pending cannot be retried or cleared by Refresh,
matching events, navigation or reopening. Text can be copied for inspection.

The current daemon installs `acknowledgeWhenDurable` for mutation responses:
`res.end` is held until `store.durable()` resolves, or the connection is destroyed
on durability failure. A complete valid201 is therefore the daemon's supported
ACK behind that barrier. The event JSON exposes no independent fsync receipt;
the UI says acknowledged, not independently verified durable storage. Headers,
an event seen in a GET, or a lost response are never treated as that ACK.

The bounded shelf retains at most eight source/options-qualified forms in the
window. It never evicts drafts, Pending or Unknown to make room. Text, receipts
and uncertainty are memory-only, not promised across process restart, which is
disclosed beside the field. Native edits beyond the UTF-16 cap are rejected in
full, retaining the prior text (and resetting undo history). Workers/channels
and reply bodies are bounded. Hidden exact completions update only their own
operation, never text, visibility or focus. The native marked-editor capture
fences sibling mouse-down before blur; the additive Browser marked guard feeds
existing root navigation/keyboard guards without replacing other forms.
