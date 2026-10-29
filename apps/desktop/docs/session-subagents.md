# Chat subagents

Pilot Next displays real children from `SessionSummary.subagents` on its
existing identity-pinned Local connection. Tool labels and mission worker
chats are never treated as subagents. The supported conversation identity is
the exact parent chat ID plus the exact child name, including case and Unicode.

Individual names and reported states appear directly under their owning
sidebar chat, expanded by default. The quiet count folds those rows. They are
not additional chat IDs, mission members or another mission-tree level, so
chat ordering, unread roll-ups and mission folds keep their existing meaning.
The composer also keeps a quiet subagent disclosure.

Selecting a child opens its conversation in the main pane, reusing the exact
same `ChatEditor` entity, textarea, input behavior and Send controls. Each child
has its own private draft key, including its parent/name/spawn fingerprint.
Back returns to the parent without replacing its draft or transcript. Parent
jobs, tasks, question, model controls and Stop never leak into the child.
No subagent start or stop action is added.

An idle child with no completed answer is Idle, not Done. Failed, retired,
paused and unknown states stay distinct. Offline rows retain names but show
unknown state; stale spawn identity disables Send. Duplicate names make the
report unavailable rather than selecting an arbitrary child.

Reads use the supported GET transcript endpoint, pinned by hello before and
after the request. These are snapshots, refreshed on selection, an accepted
user send, a reported completed answer, or explicit Refresh. No new socket or
polling loop is added. I/O and projection run off the UI thread, and stale
replies cannot replace a different child.

An explicit Send uses the existing POST messages endpoint with its immutable
request ID and captured steer/follow-up mode. The shared private draft store
journals the intent before POST. Only the request's 202 `{ok:true}` ACK clears
its captured draft revision. This endpoint has no courier receipt lookup:
a lost ACK stays Unknown, survives restart, and is never automatically or
manually replayed through the courier. Recovery can copy/discard the retained
message instead. An ACK is not independent proof of backend durability.

Synthetic unit/transport tests and the hidden native `session_subagents`
target cover exact identity, parent/child drafts, explicit Send, lost ACK,
offline/stale state, mission/standalone owners, folds, keyboard/IME and
680/1100 light/dark rendering. OS IME, visible smoothness and Wayland behavior
are not qualified by these offscreen checks.
