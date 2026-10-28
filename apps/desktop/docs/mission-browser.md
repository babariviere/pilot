# Read-only Local mission browsing

Use Missions in the main sidebar (Cmd-3), then open a received mission. Project
browse scope filters source provenance only, never logical identity or ownership.
The existing chat-to-mission confirmation remains separate. There is no new
creation wizard, task/coordinator management, join/move, archive/read-status write,
agent start or permission promotion.

## Overview at a glance

The overview follows Swift's Overview tab within the existing reading column:
goal, one meta line (status, project name, "N of M done · K working now"), a
progress bar and legend, then **Needs you** and **Working now** when they have
rows, followed by Chats, Tasks and Brief. Raw mission and project IDs stay out
of the visible text.

- Progress counts every received task (up to 256), not only the displayed rows,
  by Swift's work status: the stored status when phase gating projects Blocked.
  Dropped tasks are excluded; legend order is done, in review, in progress,
  blocked, to do, delegated, zeros omitted.
- Needs you lists member chats whose Local row needs attention or failed (exact
  member ID and project, not archived), then blocked tasks. Working now lists in
  progress then in review tasks, with the owner chat as a trailing link. Each
  section shows five rows and offers Show all.
- Chat links (Needs you rows, owners, member rows) use the same exact-ID
  `can_link` guard and `open` path; the guard covers every received member ID,
  while the Chats list still displays 16. Member rows add the chat's live Local
  state.
- A task row reveals that exact task ID in the existing Tasks pane: it opens and
  reads with its own generation, selects the task once a snapshot contains it
  (otherwise nothing is selected), focuses its details and scrolls the page to
  Tasks. All tasks and Show all open the list only. No task is changed.

Data comes from the same detail, member and Local chat snapshots; nothing new is
fetched or polled. `missions` exercises it natively at 680/1100 in light and dark,
including keyboard reveal and the exact owner link.

## Audited contracts

The implementation follows the current Swift logical mission catalog/navigation
and mission overview, and these existing daemon contracts:

- `GET /api/mission-catalog`: cached logical rows keyed by
  `[home.daemonId, home.lineageId, missionId]`, source provenance, canonical counts
  where known, and `totals`/`truncated`. The daemon folds logical identity before
  project filtering. Host names/aliases are not identity or execution placement.
- `GET /api/missions/:id`: canonical Local-home mission, goal, optional current
  brief and task context. Other returned sections are not retained as controls.
- `GET /api/sessions?archived=all&missionId=:id`: Local canonical membership,
  projected to bounded IDs/titles. Swift likewise obtains members separately,
  not from MissionDetail. A coordinator is an existing chat reference, not an
  instruction to start or appoint one.

Sources: `packages/protocol/src/{mission-catalog,index}.ts`,
`packages/daemon/src/{server,mission-catalog,missions,sessions}.ts`, and
`apps/macos/Sources/Pilot/{LogicalMissionCatalog,MissionModel,MissionPage}.swift`.
No protocol, daemon, Swift, schema, auth or permission changes are required.

The current catalog is capped at **50 rows, 16 provenance entries per row and
24,000 serialized bytes**. It has **no pagination**. The UI shows source totals,
scope-received counts and the partial notice, never promises complete discovery
beyond that window or invents a pagination endpoint. Large unpaged detail/member
responses can also exceed client limits; this is an explicit read failure or
partial-context boundary, not an empty successful mission.

## Identity, availability and lifecycle

`mission_browser.rs` validates the logical tuple against the qualified mission
reference, retaining exact case. Same title, path or raw mission ID at another
home cannot collapse a row or retarget a read. Only canonical provenance at the
pinned Local home permits the detail endpoint. A foreign/unavailable home remains
cached explanatory metadata; no host fanout, remote registry or Local-ID fallback
is attempted. Missing project names remain exact IDs with unavailable context.

`mission_reader.rs` uses fixed loopback GET routes, existing hello protocol/full
Local identity pinning, no proxies, redirects, cookies or auth fallback, and bounded
timeouts. Local reads are **not cryptographically authenticated**. Existing ordinary
chat-open subscription semantics, including possible PR refresh, are unchanged.
No mission WS subscription is added; snapshots update on explicit navigation or
Refresh only. GET data is not a mutation/durability receipt.

One window-owned reader has **one in-flight read**, one coalesced pending request,
one coalesced response and one idle HTTP connection. New destination/inactive/drop
cancels the old future. No per-frame fetch, polling timer or unbounded task queue
is introduced. Results match generation and canonical route before adoption;
An exited worker explicitly closes its coalescing command lane, even during
initialization failure/unwinding. A closed update stream clears Loading, retains
the snapshot as not current and offers explicit Refresh, not an automatic retry.
Lane fencing prevents an old closure from disabling a replacement reader.
buttons and Copy capture their source. Late responses cannot rename a new mission,
enable a stale link or navigate the chat. Changing project scope checks current
provenance; unrelated chat activity metadata does not dirty the long overview.

One catalog and one detail/member snapshot are retained, not an expanding cache.
Failures label retained data as not current; offline rendering performs no I/O
and disables chat links. Goal/brief use existing **plain selectable native text**,
not generated code, an image loader, browser, link handler or artifact VM. Markdown,
HTML and external image syntax remain literal. Explicit Copy preserves the visible
bounded Unicode string, never silently claims the full clipped source.

## Budgets

| Boundary | Limit |
| --- | --- |
| Catalog HTTP, before JSON decode | 128 KiB, including chunked bodies |
| Detail HTTP, before JSON decode | 2 MiB |
| Member HTTP, before JSON decode | 1 MiB |
| Catalog projection | 50 rows, 16 provenance items per row |
| Detail task admission/display | 256 received / 24 displayed |
| Member admission/display | 128 received / 16 displayed, coordinator first if present |
| Goal/brief display | 8 KiB / 32 KiB, UTF-8-safe clipping with notice |
| Title/task/member label | bounded 512/800-byte projections |

Raw bytes and decoded full wire JSON are temporary worker-owned data; unneeded
bodies/resources/artifacts are discarded after projection, not persisted or logged.
Counts remain canonical or explicitly received/displayed, never inferred from a
clipped task list. Byte caps apply before decoding both declared and streamed
responses. There is no claim of streaming JSON-field admission or measured RSS/
latency improvement.

## Existing chat and private state

Mission routes extend existing window-local history; the original chat, composer,
reader and private writer remain owned by LocalViewer. Native text is captured
before entering/changing mission pages or activating a linked chat. Preedit/picker
guards stay in the existing path. Current private-write/unsaved-input errors fence
new mission actions; existing All chats remains the ordinary route back to retained
input for recovery/copy, never clears a fault or silently retargets a delivery.
Private autosave and close flushing continue, without a format migration or invented
synchronous disk receipt.

Only the exact member ID, matching canonical Local home/project and current loaded
chat availability, can enter the existing `open` path. Unloaded or foreign chats
are disabled/explanatory. A snapshot is not live membership/CAS authority. No
creation/membership fallback makes a missing reference actionable. Existing reader
selection/anchor and immutable pending-operation guards remain. Returning from a
mission moves focus off its unmounted control into the mounted chat scope,
preferring the retained composer, so Back/Forward remains functional.

## Verification and limits

Fixtures use owned faux loopback HTTP, temporary private state and synthetic
content only. No real create/send/Stop/approval, production content/credentials,
service, install, restart or release is exercised. The actual LocalViewer native
target `missions` is registered in the existing Cargo/check/native-CI inventory.
Focused model/transport/UI cases cover identity/provenance, limits, malformed and
unsupported reads, cancelled/late results, offline/link source fences and private
write/oversized-input navigation refusal. Native cases use 680/1100 light/dark,
framework preedit, real pointer/keyboard, actual reducer reader keys, genuine text
selection, explicit retry, exact-chat navigation and private autosave/flush.

Failed receipts include an initial invalid offset baseline: it remained tail-following
while the logical offset changed by 24 px. The final test waits for autosave and
uses a real wheel to read away before its baseline, retaining the <1 pt and selection
invariants. A later actual timeout identified focus left on an unmounted mission
button after chat activation; that caused behavior is fixed, not hidden by increasing
the six-second bound. Earlier compile failures are not passing evidence. Final
source/CLI/PREPOST and terminal qualification are recorded below and in the PR.

Actual offscreen GPUI captures are not a SwiftUI/HTML mock, visible-motion,
OS IME/accessibility, Linux-desktop or full parity/performance acceptance. No
cosmetic/updater work is bundled. Swift remains available for deferred editing,
complete task/chat management, integrations and unsupported large context.

## Completed source qualification

Exact final executable/test source `f81e933a8948f7951fc241a988ac5c2b4c06f230`,
tree `6283c2e256bda0cc269a06670f2035b15a86fedc`, based on accepted main
`3f83499f96d9e51420eb4014ee62dca78db4f4de`:

- Job `9b51aa2a-d753-4e0e-9b77-a19ca701c24c`, **EXIT 0**, actual shared serial
  admission. Formatting check, strict all-target native-probe Clippy and **218
  library tests passed** (three existing explicitly ignored workloads). Original
  **shell/navigation/workbench** native targets, all **20 existing conversion**
  and **eight project-creation** cases passed, followed by all **four mission
  browser** width/theme cases with eight fresh captures.
- The native browser cases exercise actual LocalViewer and the private writer,
  reducer-derived canonical reader IDs, genuine in-viewport selection and a <1 pt
  reading-away anchor, keyboard round trip, synthetic marked input, Unicode Copy,
  same-title/distinct-ID and foreign-home refusal, explicit error retry, offline
  rendering/copy without reads, closed worker/update stream followed by explicit
  replacement retry, exact existing-chat navigation and private autosave/flush.
  Every observed faux HTTP request is GET; no mutation request or pending intent.
- Focused exit-fixed job `50bc3f6e-60ea-4227-98c6-3a2b4874db55`, **EXIT 0**, passed
  13 model/transport/lifecycle cases plus the same four actual native cases.
  The separate full-library gate includes the private-fault navigation refusal.
- CI inventory job `2e64635f-6858-4a6e-998c-52656772a74f`, **EXIT 0**, passed all
  **46 Python fixtures**, including compilation/execution inventory of `missions`.
  It ran under actual Node admission after formatting was complete, independently
  of native checks, with no duplicate full suite or formatting race.
- All three jobs retained identical source/tree/tracked-diff and **29 file hashes**
  PRE/POST. Wrappers and CLI are recorded by the job commands. This results-only
  section was added after terminal completion; publication records the docs-only
  and final commit-metadata mappings. No executable/test/registration bytes changed.

The earlier complete gate `8e1412b8-fd07-4ae0-aea4-6eb6f194d0de` passed at
`aac4a759fd79dadeb88c1d482d4728edbabdbc37`, before the reader-exit change. Its
terminal/PREPOST receipt is preserved, not transferred to the newer code. An
initial exit-test run also retained a failed native receipt: its pointer Refresh
was incorrectly placed before the keyboard-only selection assertion. The final
flow tests that pointer action afterward, without synthesizing selection or
weakening its invariant. Worker exit closes coalescing requests, clears Loading,
preserves precise existing errors and snapshots, and fences old reader lanes.

Run the relevant commands through shared admission and `scripts/cargo.sh`; no
real Local actions are part of these checks. Fresh remote CI, visible animation,
OS IME, Linux desktop and full Swift parity are not claimed by these receipts.
