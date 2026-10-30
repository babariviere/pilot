# Local Usage overview

Open **Usage…** in the sidebar. This passive native window leaves the current
conversation, selection and draft mounted. Choose 7, 30 or 90 UTC days, ending
at the explicit read time. Filter historical totals/trends by All projects, an
exact ledger project or authoritative Unattributed records. Refresh is manual;
nothing polls or mutates usage.

The screen answers one question: what usage did this Local daemon retain for
this date range? It leads with scope and coverage, then known-subtotal input,
output, cache-read and catalog-estimated cost, followed by a daily input/output
trend. Coverage details reveal capture/retention floors, accounting-loss counters
and dated trend values. All controls use native keyboard traversal. There are no
account totals, billing claims, remote reads or recovery/write controls.

## Subscription limits

Home and Usage share one retained subscription-limits owner. The existing
Local control socket (`GET /api/ws`) supplies `SessionSummary.usage.subscription`
on its initial session list and subsequent session updates. The viewer feeds
these reports to the shared owner even while a conversation, Inbox or Missions
is selected. Reconnecting uses the ordinary hello and session-list path, not a
provider refresh. No additional socket, provider call or timer is introduced.

The daemon reads Pi's shared provider cache; the client keeps the newest reported
`fetchedAt` per provider, never the transport receipt time. Claude and Codex windows
remain separate. The contract does not identify an account, so a report cannot
prove account matching or complete account coverage. Missing windows/counts and
unknown reset times remain unknown, not zero. A reset-passed window says
“was … · awaiting report” until another authoritative report arrives. A stale
cache replay cannot make it current. This display does not release usage-paused
work or change the daemon's 99% admission/reset/force-work policy.

Errors retain the last usable windows and their original report time beside the
error. Their ordering uses the failed report's timestamp separately, so a late
older error cannot taint a newer report and a late older success cannot clear a
newer error. Refresh limits remains explicit and daemon-mediated, preserving Pi's
credential ownership, existing cache and backoff. Historical tokens and estimated
costs below are a separate source.

## Audited authority and bounds

Source audit: `apps/macos/Sources/Pilot/UsageDashboard{Model,Page}.swift`,
`apps/macos/Sources/PilotCore/UsageDashboardPresentation.swift`,
`packages/protocol/src/usage-history.ts`, and daemon
`server.ts`, `usage-history-validation.ts`, `usage-history-disk.ts`.

The existing endpoint is **GET /api/usage-history/query**, with canonical
`daemonId`, `lineageId` and JSON `query` URL parameters. Hello must match the
discovered Local identity/protocol and advertise `usageQueries: 1`. Loopback
pinning is not authentication. Redirects, proxies and automatic retries are off.
The endpoint also rejects mismatched identity. No alternate host is attempted.

API v1 permits a maximum366-day window, at most100 returned groups per response,
at most400 time buckets, a4096-byte query, and512KiB response JSON. The ledger
retains at most50,000 records,64MiB, with a30-day retention floor. The overview
deliberately narrows the date choices to at most90 daily buckets and makes only
one summary query, one bucket query and one bounded project-breakdown query,
with no paging. Both content-length and streaming bodies are capped at512KiB before decode. Unknown versions, malformed,
duplicate/out-of-range buckets and truncated summary/day responses fail closed.
Every request
has a5-second timeout and2-second connection timeout. One private reader worker owns
one in-flight future; bounded1-slot input/output lanes coalesce replacement.
Range replacement and window closure cancel the previous future. UI serial/filter/range
fences reject late completions, including failed ones. Options are immutable per
window, so a completion cannot be adopted into another source.

Summary values come only from the authoritative `total`, which represents dated
requests. Never sum page totals, checkpoints or historical context. Bucket and
project-catalogue reads
are separate dated observations, not a transactional snapshot; an observed
generation change clears the whole observation. A failed trend does not replace a valid dated
summary. Missing days/metrics remain unknown or unobserved, never synthetic zero.
Daily input+output bars draw the known subtotal of each UTC day on a round token
axis (cache read/write and reasoning are not added). A day where some requests
lack input or output counts keeps its known subtotal as a floor, drawn with a
detached top edge; it no longer disappears. A counted zero shows `0`, a day whose
records carry no counts shows `?`, a day without requests stays blank, and days
before collection/capture/retention floors sit in one "outside retained history"
band. The legend lists only the marks present; per-day exact values are in each
bar's tooltip and in Coverage details. Numeric summaries use thousands separators
and retain per-metric known/unknown/incomplete evidence. Catalog costs are
estimates, not billed charges, including when subscription usage is present.

All history remains explicitly partial, with collection start and observation
time visible. Old data retained after a failed same-window refresh is clearly
marked as a previous observation. A different scope/range clears old-range values.
Longer ranges do not override retention or imply complete history. Other group filters,
reconciliation and informational budgets remain outside this overview.

## Project filtering

The retained Kit selector offers **All projects**, exact ledger project UUIDs,
and **Unattributed** only when the project breakdown returns the authoritative
JSON `null` key. A projection without project identity is not unattributed usage.
The existing in-memory project catalogue supplies optional Unicode display names
only. Deleted/unknown project UUIDs remain selectable without guessing a name,
cwd or current-chat attribution. Labels never determine query identity.

Each explicit history read captures one UTC range and filter. It requests:

- `view: summary`, optionally `filters: {projectId: <exact UUID>}` or
  `filters: {missing: ["project"]}`;
- `view: buckets`, the identical filter/range and `bucketMs: 86400000`;
- one unfiltered `view: breakdown`, `dimension: project`, `limit: 100`, for
  the date-range project catalogue.

No cursor is followed or totals accumulated. The catalogue may be truncated and
says so visibly; it is not a complete project inventory. An exact selected ID
survives being absent from the current first page. Catalogue errors retain prior
choices as a previous read, not a complete/current list. Summary/day truncation
still fails closed. Summary totals come exclusively from that filtered query's
`total`, never from a breakdown, bucket/page sum or previous selection.

The existing GET route checks daemon/lineage, validates the bounded query, then
calls `UsageHistoryService.analytics` through its two-query admission limit and
worker RPC. `UsageHistoryDisk.analytics` uses the dated-request reduction and
existing project/missing SQL predicates. It does not call providers, refresh
subscriptions, list/spawn sessions, record observations, expire or erase rows.
The ordinary lazy ledger worker/database opening can initialize storage/indexes;
passive here does not promise a filesystem-pure read. Source evidence:
`server.ts` usage-history route, `usage-history.ts` analytics/readQuery,
`usage-history-worker.ts` analytics dispatch, `usage-history-disk.ts` analytics,
FILTER_SQL/GROUP_SQL, and `usage-queries-server.test.ts`'s no-list/no-spawn GET
boundary. Project UUIDs are the canonical lowercase ledger keys, not new client
attribution or backend schema.

Range/filter replacement cancels the in-flight future and serial/filter/range
fences reject late successes and errors. Different scopes clear old totals before
reading; same-scope failed refreshes retain explicitly dated previous values.
Observed ledger generation changes between queries clear retained history and
catalogue rather than resurrect pre-erasure values. A summary generation change
from the prior observation is rejected before later read failures can retain the
old report. Reads are not transactional:
same-generation queries can still observe newly arriving records independently.
An erasure not yet observed by an explicit read is not a live-clear notification.
Subscription limits remain global and visibly separate, with their own original
`fetchedAt`/failure ordering. History selection never refreshes providers or
project-scopes subscription limits. No polling, account reads or mutations added.
Reconciliation/budgets remain separate residual work.

## Retained request records

**Retained request records** explicitly reads one page of25 dated request
observations under the currently captured UTC range and exact project filter.
Nothing prefetches records. **Next records** follows the API's opaque cursor;
**First page** rereads from the beginning. Successful pages replace the prior
page rather than accumulating a history or reconstructing any total. The
authoritative summary remains a separate dated query, even if its request count
differs from the number of displayed rows. The page API has no matching-count
or server observation-time field. Displayed-row count is not a total;
the displayed page receipt time is explicitly client time. `retainedRows` is a
global ledger count, not a matching count, and is not relabelled as one.

Audit: `UsageHistoryQuery`/`UsageHistoryPage` and `UsageObservation` in
`packages/protocol/src/usage-history.ts`; `server.ts` GET
`/api/usage-history/page`; `UsageHistoryService.page/readQuery`;
`usage-history-worker.ts` page dispatch; `UsageHistoryDisk.page` and
`usage-history-validation.ts`; historical Swift `UsageDashboardModel.show`
and `UsageDashboardPage.records`/`UsageRequestRow`. The existing GET validates
Local daemon/lineage, uses two-query worker admission and a keyset SQL page
ordered by `(completed,source,operation)`. The cursor binds erasure generation,
kind, range, last key and exact filter. The SQL range is half-open and also
applies capture/retention constraints. This path does not start sessions,
refresh providers, record/erase usage or expire rows. Lazy worker/database
initialization is still possible, so passive is not filesystem-pure.

Only `kind: request` is queried here. The contract's checkpoints deliberately
ignore the selected dates and can overlap requests, so undated reconciliation
is not presented as dated records. Each row preserves the returned kind,
source/operation IDs and revision. **Record details** reveals known versus
unknown token counts, catalog estimate status (never billed), and selectable
exact API data. **Copy record JSON** copies those fields without creating a
new detail or identity. Missing serving model/provider, attribution, amounts
and counts remain unknown. The current canonical ledger always has billed
cost unavailable; unsupported billed evidence is refused. No account identity
is supplied. Chat/project/attempt/mission IDs, when present, remain inspectable
plain data. This separate passive window does not add navigation callbacks,
activate chats, send inputs or infer a session ID from source/operation IDs.

The existing no-proxy/no-redirect/no-retry Local transport, hello capability and
identity fences,5-second timeout and512KiB response cap apply. The page reader
has bounded one-slot command/output lanes and retains only one page. Hiding,
history refresh, range/project replacement and closure drop the reader,
cancelling the in-flight future. Request serial/range/filter/generation fences
reject late successes and errors. Within-page identities and increasing keys
are checked, including the previous page's boundary; repeated/malformed cursors
and excess/short continuation pages refuse rather than mix rows.

Ordinary failed page reads retain the previous page visibly labelled as a
previous observation, with explicit retry. A changed generation or cursor
refusal clears both records and overview/catalogue, requiring visible history
refresh. HTTP400 does not distinguish stale cursor from other query refusal,
so the client conservatively resets without claiming erasure was proven.
There is no automatic cursor replay/reset or erasure subscription. Independent
same-generation pages can observe updates, corrections and retention between
reads; the last page is not proof of complete accounting. Global subscription
limits, credential ownership, freshness and privacy epochs are unchanged.

Design: retain the existing left-aligned token hierarchy, project selector,
authoritative totals and global limits. Subtract eager detail and nested cards;
reveal bounded unboxed rows and one selectable record at a time through native
Kit buttons (Tab then Enter/Space), with a keyboard-reachable exact copy action.
No new colors, motion clocks, polling or hot-path caches.

## Verification scope

`check-scoped.py --unit usage_overview --test usage_overview --native-probes --lint`
maps only this model, transport/faux daemon and mounted production page, plus
matching production lint/build. It uses the existing shared serial slot, pinned
toolchain, mbx CPU2/4GiB bounds and private outputs. Full suites stay in CI.
The native target covers680/1100 light/dark geometry, loading versus empty,
coverage/summaries/trend, the partial-subtotal bar and axis ticks, 30/90-day
ranges with billion-token days and a retention floor, pointer range replacement,
disclosure, explicit retry, failed-refresh retention and close. Filter-specific
checks exercise native selector keyboard selection, Unicode search cancellation and retained synthetic preedit during a read,
Escape focus restoration, exact project/missing/All scope, filtered empty and
retained-error states, plus bounded catalogue/error notices. Unit/faux-transport checks cover exact identity/query URLs,
filter-only cancellation/races, catalogue truncation/errors, authoritative totals
versus independent days, date replacement and observed erasure fencing.
Record checks additionally exercise native keyboard disclosure/copy, literal
selection with keyboard copy,25-row replacement, unknown counts, retained page
errors/retry, empty pages, range/project cancellation and visible cursor refusal.
Unit/faux transport covers boundary duplicates, opaque/repeated cursors,
wrong kind/range/filter/generation, pricing evidence, late success/error after
clear and cancelled in-flight reads. The matching default-feature plain build
is run separately and serially after this scoped gate. Set
`PILOT_NEXT_USAGE_DIR` to save the captures. Captures are offscreen synthetic GPUI, not
the user's app or real usage. No new animation/timer or scrolling hot path is
introduced. No OS IME, live-daemon, Linux/Wayland, GPU performance or user acceptance
claim follows from these checks.
