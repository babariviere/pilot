# Local memory browser

Open a project's overview, then **Memory…**. A separate passive reading window
preserves the current chat, draft and navigation. Each window owns one immutable
canonical project ID and captured Local daemon/lineage. Other projects never
reuse its rows. Memory here is agent-written knowledge, not sidebar read/fold state.

The native page uses the app's reading column, tokens, Kit buttons and selectable
literal text. **Open notes** drills into a summary, **Back** returns to its parent,
and **Refresh** explicitly rereads the current range. Tab and Enter reach these
same controls (Refresh's accessible name is **Refresh current memory range**).
Refresh retains the selected range, parent path, loaded-text query and Details
disclosure; it does not reset to root or recreate the search editor. While a
refresh is pending or fails, retained rows are labeled a previous observation,
not a current snapshot. If Local no longer admits the selected range, the page
keeps that exact range and shows an error with explicit **Back** navigation,
never silently substituting root. Details discloses exact note/device/origin IDs and stored shared
provenance, without guessing a source-chat link or account identity. Pending
summaries remain navigable. Replaced notes remain inspectable and labeled.

## Existing contract audit

Only `GET /api/projects/:id/memory/tree?depth=1[&lo=N&hi=N]` is used, with the
existing Local hello check before and after every read. This is loopback identity
pinning, not authentication. The server requires the canonical project; there is
no path-, title-, shared-home-, filesystem- or network-host fallback.

`packages/protocol/src/memory.ts`, `packages/daemon/src/server.ts`,
`project-memory.ts`, `memory-worker.ts` and `memory-disk.ts` define the contract.
Historical Swift `MemoryPage.swift` / `MemoryPageModel.swift` use the same tree.
The top level tiles the log in aligned powers of two, newest first. A summary
above16 notes opens into two halves; one at/below16 opens into individual notes.
The existing tree limit is1024 nodes, depth1–64, reveal at most64 notes, with
2048-byte checksummed records and280-byte note/summary text. Depth-one browsing
therefore returns at most53 root blocks or16 child notes, without a new UI cap
or whole-log materialization. The streamed wire guard derives from the existing
1024-node/record bound plus envelope overhead. Partial, malformed, unexpected
range or truncated depth-one responses fail explicitly, never masquerade as empty.

The base `GET /memory` calls `load()` and can schedule provider compaction, so
the browser does **not** use it. Tree calls do not schedule compaction. Like
existing Swift reads, a first access may initialize the daemon-owned disk store,
acquire its lease and recover existing journals/torn tails. This is the current
service's internal behavior, not a new client repair capability or a claim of
filesystem-pure reading. No note, forget, import/export, provider, settings or
other mutation endpoint is exposed or called.

Requests and responses carry the exact range and a monotonically increasing
window generation. New navigation cancels obsolete HTTP; closing drops the reader.
A changed range immediately clears old rows. A failed refresh may retain only
the same window/range's last successful content, clearly labeled stale.
Unavailable/offline, refusal, loading and confirmed empty remain distinct.
The contract has no summary revision pin: successive reads may see changed
summaries, and the UI does not claim one atomic whole-tree snapshot.

## Verification

`project_memory_tests` covers exact tree shape/note identity, origin preservation,
generation/range fences, retained failure, malformed/partial/refused reads and
replacement cancellation over an owned faux Local server. `project_memory`
mounts the production page in hidden GPUI windows at680/1100, light/dark, and
exercises keyboard drill-down, pointer text selection/copy, Details, Back,
loading, failure/retained rows and empty states. Refresh regressions also cover
changed exact-range content, missing topology, Back superseding a pending read,
close during refresh, retained search focus/editor preedit, and explicit
post-open light/dark theme assertions. This is synthetic native
verification, not live memory/provider access, OS IME/AX or product acceptance.

## Loaded-text filter

The native **Filter loaded text (case-sensitive)** field matches literal Unicode
substrings in the current response's note/summary text only. It does not search
IDs, provenance, unopened notes or other ranges/projects. Summaries are not the
full text of their underlying notes. The always-visible scope label and **No
matches in loaded text** state make this limited coverage explicit. Regex syntax
has no special meaning; case, combining sequences and whitespace remain exact.

Typing and clearing only filter the already loaded rows. They do not change the
range, parent stack, Details state or generation, and never queue a read. Clear
restores the current range's rows and returns focus to the retained Kit editor;
ordinary SelectableText selection/copy still owns the unchanged source. Explicit
Open notes, Back and Refresh keep their existing bounded read behavior; the query
continues to apply to the newly loaded range. Loading does not claim no matches,
and stale/error labels remain visible when filtering retained content.

Focused tests cover Unicode/literal matching, clear/order restoration, summary
vs unopened coverage, pending/empty text, and real keyboard/pointer filtering
with unchanged faux-server request counts and browser generation. Hidden native
cases cover680/1100 light/dark, keyboard clear, focus restoration and stale/empty
states. They do not qualify OS IME, live data or full-project search.

In-place tree expansion, global search, live refresh, source-chat navigation and
explicit forgetting remain separate work under the parent feature.
