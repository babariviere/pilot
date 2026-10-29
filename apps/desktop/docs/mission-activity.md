# Read-only Local mission activity

The mission overview's **Browse activity** opens a separate reading page. Its
only network actions are explicit reads: newest snapshot, earlier events and
retry. Back returns to the retained overview and its focus/scroll owner.
There is no posting, handoff, health or task editor here.

## Contract and attribution

Source audit against base `90d2661e`:

- [`MissionActivityTab`](../../macos/Sources/Pilot/MissionTabs.swift) combines
  newest/older events by event ID, renders a newest-first lazy timeline and asks
  for older events using the oldest displayed ID. Its composer is deliberately
  excluded from this slice.
- [`PilotClient.missionEvents`](../../macos/Sources/Pilot/PilotClient.swift)
  uses GET `/api/missions/:id/events?before=N`.
- [`server.ts`](../../../packages/daemon/src/server.ts), missionRoute's events
  branch, accepts that GET and numeric `before`. It does not accept an activity
  page size, task filter or service-tool cursor. No endpoint was added.
- [`MissionStore.events`](../../../packages/daemon/src/missions.ts) filters the
  exact mission and `id < before`, orders by descending event ID and returns at
  most `DETAIL_EVENTS = 50`. A short page has no `hasMore` or completeness
  metadata. We keep Earlier available until an empty page or the local cap.
- [`MissionEvent`](../../../packages/protocol/src/index.ts) is append-only and
  contains ID/kind/text/time plus optional chat/task/health. It explicitly says
  an omitted `sessionId` means **user or daemon**. `recordSystemMessageState`
  also records system events with a chat ID. Therefore a chat ID is a recorded
  source, not proof of an agent author; neither text nor title can establish an
  actor role. The page retains this uncertainty instead of claiming a precise
  user/agent/system distinction the accepted GET cannot provide.

Canonical identity is `(Local daemon, lineage, mission ID, event ID)`. No title
matching, remote fallback, chat-content fetching or hidden-reasoning projection.
The identity handshake precedes every page read. Redirects, proxy fallback and
automatic retries are disabled. Only known event fields reach the model.

## Bounds and state

`mission_activity` admits at most 50 events per response, 2 MiB wire JSON,
and 250 retained events. Event text retains the full persisted value without
applying write-content limits. Oversized/malformed wire responses fail as a whole, never as an apparently
complete clipped page. Equal event IDs deduplicate only when their fields
agree; conflicts are errors. ID order is stable even when timestamps agree or
arrive out of order. Exact timestamps and optional source context are disclosed
with the full selectable/copyable event text.

Loading, first empty, older end-of-snapshot, local viewing limit, failed read and
retained-but-stale refresh are different states. No polling, automatic paging
or independent user-note fanout is performed. Refresh replaces the window, not
the underlying history. An empty page is an observation, not a live guarantee.

The one-command/one-output reader cancels superseded requests. The UI also fences
each response by canonical mission, generation and requested earlier boundary.
Leaving the activity page, changing mission or losing Local availability closes
its lane. Late results cannot relabel another mission. Overview/chat inspectors,
conversion, briefs, drafts and composer authority remain with their existing
owners; this feature adds no input or mutation state to them.

## Design and verification map

Use the existing calm reading column and semantic tokens. The timeline leads
with event kind, source and a short preview. Full text and event metadata are
disclosed per canonical ID. Source limitations and byte/row caps are available
through **Source and viewing limits**, not a permanent diagnostics wall. The
compact Back/Refresh toolbar and grouped title distinguish page controls from
the timeline. Each event has one shared Tray surface, subtle border and row
radius, with source/time separate from content. Expanded metadata stays inside
that same boundary. Copy is a shared icon-only action in the card header,
painted on card hover or keyboard focus, with a fixed layout slot. It copies
the exact admitted text even when details are collapsed. This follows user
feedback that the first loose-column
screenshots did not make boundaries clear enough. Tab
and Enter reach the real Kit buttons; selectable text keeps the page focus.

Selected checks, not a full/native sweep:

- `mission_activity::tests`: identity/order/dedup/conflict, attribution limits,
  malformed/oversize, paging/end/error, view cap and stale navigation.
- `mission_activity_reader::tests`: exact GET+before, pinned Local identity,
  malformed/status/redirect/length/chunked bounds, cancellation and close.
- `--test mission_activity`: real mounted production Browser/Activity over
  owned faux GET transport at 680/1100, light/dark. Real emitted navigation,
  keyboard disclosure/copy, wheel scrolling, earlier/end, retained-error,
  overview focus return and pending-source cancellation. Outer route hosting is
  synthetic, not the entire LocalViewer. No claim of full-app draft/IME runtime
  coverage, OS accessibility, live operation, visible smoothness or performance.
- Matching lib/native Clippy, format and native registry contracts. Exact
  PRE/POST input hashes, commands, logs and screenshots are private receipts.

Implementation/source presence is not a test result. See the task's final
evidence receipt for actual execution and any remaining gaps.

### Executed evidence (2026-10-26)

- `activity120-pass3/check.json`: scoped lib/native Clippy, **9** pure/faux
  tests passed with **0 ignored**, plus four native layouts. PRE/POST matched
  all **211** selected inputs.
- `activity120-final1/check.json`: after view-only spacing/disclosure changes,
  matched lib/native Clippy and all **4** named mounted native journeys passed.
  The journey now waits for admission of the delayed A request before leaving
  for B. **211** PRE/POST hashes matched. The nine model/transport inputs remain
  byte-identical to pass3, rather than being redundantly rerun.
- Eight final screenshots were produced. Actual 680-light timeline and
  1100-dark retained-error captures were inspected and published with this
  task. These are actual GPUI screenshots with synthetic data, not SwiftUI
  mocks or full-app acceptance evidence.
- Native registry compile/execution correspondence passed with PATH Bash and
  `/bin/bash`; shell syntax and formatting passed. An initial command used the
  wrong Python test-class name and was rerun correctly; it is not counted as
  passing evidence. Earlier compile/lint failures remain in private receipts.
- `activity120-boundary2/check.json`: after that user-requested boundary
  correction, all four selected mounted native journeys and matching lint
  passed with 211 identical PRE/POST inputs. New assertions measure actual
  event separation, detail inset and header containment. The artifact images
  are now revision 2 (680-light and 1100-dark timelines); revision 1 remains a
  historical, visually rejected layout. The model/reader remain unchanged.
- `activity120-integration1/check.json`: composition onto accepted `cf8a4f96`
  preserved the published task browser. Four native journeys plus matching
  lint passed with **218** identical PRE/POST inputs, including task-source
  suspension while Activity is open and rearming on return without a fetch.
  Three incidental formatter-only changes in foreign chat-action files were
  then restored to exact upstream bytes, not retained as feature changes.
- `activity120-hover1/check.json`: final icon-only hover Copy refinement,
  including that exact upstream restoration, passed four native journeys and
  matching lint with **218** equal PRE/POST inputs. Actual pixel differences
  prove the icon paints on card hover; bounds remain identical. Keyboard Tab,
  Enter and pointer click both copy the exact event. Updated screenshots are
  artifact revision **3**. The model and faux transport tests are unchanged
  from the nine-test pass3 receipt.

Logs, exact command reports, input hashes and PNGs are in private
`/tmp/activity120-{pass3,final1,boundary2,integration1,hover1}` receipts and the
owning chat's durable job log.
No production actions, real profile reads, full suites, Swift checks or remote
CI polling were run. Full-app conversation/brief/inspector/IME runtime paths
were not requalified by this isolated Browser fixture; their source is not
modified by the activity modules.
