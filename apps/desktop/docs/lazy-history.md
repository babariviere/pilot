# Lazy Local history

Fresh conversations open at the live tail. Older messages wait until the user
scrolls near the top or chooses Load earlier messages from More. Find explicitly
labels partial coverage and offers Load full history, which pages sequentially
until exhausted or stopped. Merely opening Find does not fetch older pages.
Search stays literal, case-sensitive committed message source, not tool-output
or artifact-source search. The existing 1,000-match display limit is disclosed;
row and source-byte scan ceilings no longer hide an older unique match.

Returning to a retained reading position automatically pages back to its canonical
entry/model/block or tool-call key, keeping the saved pixel offset. Normal page
absence is loading, not an error. The header quietly says Restoring reading
position while a page is pending. Restoration stops as soon as the key is found,
or its entry range is covered without that projection (genuinely unavailable).
The current contract supports contiguous 24-entry pages, not an exact-anchor
lookup. Tool-call keys lack an entry bound and may require paging to exhaustion.
No backend or stored-history changes are needed. Loaded rows accumulate as usual;
this is bounded per-page work, not constant total memory or projection time.

Scroll, selection/navigation input and explicit Latest supersede restoration.
Stream/snapshot replacement cancels its page chain without applying a late anchor;
the original token remains retained for a fresh visit. Page failures preserve it
and use the existing Retry earlier action, without an automatic retry loop.

## Opt-in contract

`/api/sessions/:id/ws?history=paged-v1` asks for an authoritative recent snapshot,
not a provisional tail followed by a full prefix. Legacy subscriptions are
unchanged. The stream cannot resume across different history modes.

`snapshot.history` supplies `context`, `more`, and `before` when older rows remain.
The immutable context contains conversationId, tail, and optional current head
marker identity/start. Its question boundary is current metadata, separate from
historical questions. Loading an old page cannot resurrect a pending question.
Run/generation, tools, compactions, inbox, queue, TODOs and audit events retain
their existing complete contracts. Page loading is not incomplete live readiness
and is never a mutation, delivery ACK or compaction event.

An older read uses the existing `/history?before=N&limit=24` with a JSON `view`
query containing that exact context. The response echoes context and before,
supplies more and nextBefore, and reads the captured conversation even if a new
attempt becomes active. Entries below the captured tail are immutable. The
current marker appears once; superseded markers within the active range remain
suppressed as in legacy snapshots. Earlier retained history remains pageable.
Missing initial storage/conversation or captured storage/conversation/tail is an
error, not false exhaustion. An existing empty store still produces an empty
complete page. Live and cold snapshots honor the durable cleared-question state,
including a Stop with no subsequent user entry.

Next accepts pages only for the selected navigation generation, captured snapshot
revision and cursor. Disconnects, replacement streams and snapshots invalidate
in-flight reads. A validated same-stream resume retains loaded history; a new
snapshot replaces it rather than merging old pages by a coincidentally equal
head. Canonical entry/model/block keys deduplicate boundaries and preserve the
existing native reading anchor, selection/copy, focus and IME owners. No JS or
mutation replay is introduced.

Historical tool calls first discovered in a snapshot, legacy prefix or older page
start as Status unknown unless a retained result or explicit running-tool record
establishes their outcome. Historical admission settles only newly discovered
call IDs, never unrelated live Pending/Running calls. Later results still supply
their exact output and success/failure. Reducer equivalence tests project rows
only at matching boundaries: `rows()` allocates presentation IDs and work groups.

## What is actually bounded

Cold reads scan the recent range directly through indexed storage, before
provenance decoration, structured cloning or serialization. The initial page has
at most 60 ordinary entries, plus its current head marker. Older pages request
24. The soft 256 KiB stop is between entries, not a truncation: one oversized
entry and a head marker may exceed it. SQLite's scan API also decodes its small
lookahead; this is not a strict allocation bound on arbitrary entry sizes.

Remaining full-store costs are explicit:

- InputOrigins can still scan all submission provenance, including ancestors.
- Legacy question metadata without an explicit cleared hold can scan backward
  to the latest question/user boundary, potentially the whole active range.
- Document materialization may replay its retained document changes. Cold
  compaction decoration can still load the existing SDK token estimator.
- Live workers still own the SDK's shared full conversation view for execution
  and status. Their recent snapshot is selected before decoration/IPC, but its
  SDK hydration/retention is not eliminated. Stored history and agent context
  are unchanged.
- Loaded native rows, text parsers and tool previews accumulate as the user
  reads. Paging is not a client total-memory limit or an LRU parser design.
- Old installed daemons ignore this opt-in and retain the legacy compatibility
  path. No live upgrade, install or restart is part of this source change.

## Reproducible measurements

`node packages/kernel/bench/paged-history.ts` creates and deletes its own SQLite
fixture, 6,000 approximately 2 KiB bodies and 1,500 input submissions. Five
alternating full/recent reads use fresh worker threads against warm OS caches.
There is no compaction marker, live generation or large tool output in this
fixture. Median observations on this macOS host:

| Stage | Full | Recent |
| --- | ---: | ---: |
| Worker preparation | 22.731 ms | 5.145 ms |
| Worker JSON encoding | 8.396 ms | 0.105 ms |
| Worker startup + preparation + transfer + exit | 205.425 ms | 160.213 ms |
| IPC JSON-equivalent bytes | 12,602,798 | 126,417 |
| ChatStreams frame encoding | 21.952 ms | 0.264 ms |
| Frame bytes, all initial frames | 12,603,098 | 126,577 |

These measure actual storage preparation, structured-clone receipt and frame
encoding/bytes, not physical network transit, app open latency or visible GPU
performance. Initial client reducer readiness and hidden native mount/first-frame
CPU observations are reported separately by the `paged_snapshot_is_ready...`
unit and `PILOT_NEXT_HISTORY_CASE=paged` history target. Native anchor/error/retry
and full-history Find checks remain separate from these backend measurements.

On the composed source, four hidden 680/1100 light/dark mounts observed 60-row
projection at 0.701 to 2.334 ms, then mount plus first CPU frame at 87.3 to
124.0 ms. These separate native observations include real GPUI layout/paint,
not backend transport or renderer readback, and have no matched legacy GUI
baseline. They do not qualify visible smoothness, GPU latency or OS IME.
