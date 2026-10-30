# Local Usage dashboard

The native Usage page is available by default in the sidebar, Go menu and command palette. There is
no feature flag or environment override. The user explicitly requested normal availability while the
unchanged 16 MiB accounting peak-RSS target and release verification remain documented, unresolved
work. Availability does not claim those checks passed or authorize a storage/runtime architecture
change. No storage backend, routing, inference or provider polling changes are part of this UI.

## Reading the page

### Pilot Next subscription refresh

Home and Usage share a native **Subscription limits** section and one explicit **Refresh limits**
operation. This is separate from **Refresh history**, which queries only retained local aggregates.
Swift's existing Home and Usage panels consume forwarded cached reports; Swift does not own a provider
collector or refresh cadence. Pi's session extension owns the existing 60-second collection cadence.

Next requests `POST /api/subscription-usage/refresh?provider=anthropic|openai` only after the pinned
Local hello advertises `subscriptionRefresh: 1`. Both this operation and the passive
`GET /api/subscription-usage` require exact daemon/lineage IDs. Requests for each provider coalesce
in the daemon. The tool-free runtime uses canonical Pi OAuth through the existing credential broker,
never GUI credential access, API-key commands or fallback Claude Code/CLI stores. No agent is started.
The pinned Pi usage collector retains its one-minute cache, cross-process request lock and backoff.
No timer, automatic retry or provider polling is added to the app or daemon.

Feedback distinguishes updated, recent cached report, deferred, unavailable credentials and failure.
Reports keep the cache's actual `fetchedAt`, windows and resets, including after errors. Account identity
is explicitly not reported; neither chat identity nor provider name is presented as account identity.
Expanded details disclose source and time; stale/future/unknown timestamps remain visible. Updated shared
cache files still reach existing subscription admission and force behavior through pilotd's reader.
Older daemons refuse refresh explicitly instead of silently rereading an old snapshot.

The sections below describe the legacy Swift historical dashboard unless marked otherwise.

- Local execution only, always labelled observed / partial. Historical non-Local work is not included.
  The installed pinned Local identity must be unique and connected. No other execution mode or fallback.
- Today, 7 days, 30 days, All retained and Custom use UTC days and half-open windows. All is bounded to
  366 days and reads only retained evidence, not lifetime totals. Custom accepts either date order and
  includes both dates, no future days, at most 366 days. Apply commits the range; Cancel does not query.
- Compact summaries show input/output, cache reads/writes, reasoning (inside output), requests,
  observed attempts/retries and catalog estimates. Known subtotals retain unknown/incomplete counts;
  absent is Unknown, explicit zero stays zero, unsafe sums say Overflow. Cache efficiency is
  `cacheRead / (input + cacheRead)`, unavailable with missing/incomplete classes or zero denominator.
- One daily UTC trend shows known input + output subtotals, not cache or reasoning added again.
  The token axis uses readable k/M labels and a zero baseline. The domain covers full UTC days,
  including the partial current day, so its bar stays inside the plot rather than overlapping labels.
  Missing buckets/classes are unknown, not zero. The chart includes accessible dates/values and text
  explaining partial coverage. It does not interpolate gaps or invent pre-capture usage.
- Foldable project, canonical mission, chat, physical serving model and purpose breakdowns group the
  same dated requests. Purpose includes background title/triage/classification/memory/compaction work,
  plus ordinary agents and follow-ups. Do not add amounts across sections. One disclosure is active
  at a time; its choice is remembered. The first ten groups are cached for the active scope only.
- Breakdowns default to highest estimated cost first. Sort by cost, input, output, cache reads,
  requests or observed duration, lowest or highest first. Sorting covers all matching groups before
  paging, with identity as a stable tie-breaker. Unknown/overflow subtotals stay last in either direction;
  partial known subtotals retain their labels. Changing order clears breakdown caches and paging cursors.
- Select a group to inspect its exact scope, including explicit missing attribution. Requests are
  content-free records: numeric usage, outcome, physical model, original source/operation and canonical
  attribution. Existing virtual provenance is shown only when recorded, not inferred or routed.
  Current project, chat (including archived chats) and mission names come from the already-loaded Local
  catalogs, not transcripts or stored ledger titles. Missions resolve only against their exact canonical
  home/lineage. Request rows also show these names; IDs remain in expanded provenance/tooltips, or as a
  fallback when a name is unavailable. All Local work clears the filter.
- Reconciliation shows retained checkpoints **independent of selected dates**. Their amounts may
  overlap requests or one another. They never enter summaries, trends or breakdowns. Records replace
  the current page, 25 at a time; no page totals or checkpoint values are accumulated.
- Estimates retain historical pricing revisions, with unpriced/partial and mixed-version labels.
  **Billed spend is unavailable.** Catalog estimates are not invoices or marginal subscription spend.
  Cached Local subscription windows remain a separate panel, with provider report time/reset/staleness
  information, may include other apps, and are not converted to dollars or filtered to the chart dates.
- Coverage explains capture/retention floors, retained/expired rows, rejections, conflicts and
  process-local queue overflows. The host observation timestamp is shown; refresh is explicit.

## Native behavior and bounds

`UsageDashboardModel` reads `ClientDirectory.localUsage(query)`, then bounded daily buckets. Breakdowns
are loaded on disclosure and request/checkpoint pages on user action through `usagePage(query,on:)`
on the accepted Local host. At most one overview pipeline and one detail pipeline are active, each
sequential, with a 180 ms cancellable debounce. Reads never run from view bodies, subscriptions to
accounting events or a refresh timer. Token aggregation stays inside the existing storage worker;
bounded trend preparation and cached subscription-snapshot selection run off the main actor.

Trend reads use at most four sequential pages of 100 groups. The API's 400-bucket **window** bound
does not raise its 100-group **response** bound. Trend pages remain private until the complete bounded
trend is accepted; repeated totals on those pages never replace or add to the overview. Ordinary live
history corrections may change page totals without changing the erasure epoch. A failed trend or
breakdown is shown as unavailable while preserving the accepted overview, not as a changed connection.
Connection, host/lineage and erasure mismatches still discard the entire view. Refresh clears all
cursors, failures and detail caches, and there is no automatic retry.

The only cache is the mounted page's active scope: one summary, at most 400 trend buckets, five first
breakdown pages of ten groups and one detail page of 25 records. Next replaces, never appends. Scope
changes and Refresh cancel obsolete tasks and clear data. Revision fences discard late deliveries;
Local connection-token and erasure-generation fences invalidate all cached values. Endpoint events
check identity only, never query. Failed/unavailable reads do not substitute old totals. Pagination
remains a live retained view, not an immutable multi-call snapshot. Refresh after corrections.

The layout adapts the approved revision-2 light/dark native mocks and pinned Magpie source/tests at
`dee5c9d75f452756752dbbed3b46308f6d8edffc`: shared date ranges, compact summaries, one trend, foldable
lists and progressive Overview → Requests. Unlike Magpie, this uses native Theme/PageHeader/shared
controls, authoritative cache semantics, no account/key/content archive or exports. The mocks' old
connected-host wording is superseded by Local-only labels. Narrow controls wrap; wide pages retain
the reading column. Native buttons, date pickers and disclosures support Tab/Space/Return and
VoiceOver; the chart has spoken values, and color is never the only coverage signal. Composer usage,
quota behavior, canonical provenance and unrelated host navigation are preserved.

## Verification and limits

### Names, sorting and chart follow-up (2026-10-23)

The daemon query suite covers every metric/direction, ties spanning pages, explicit zero, unknown and
overflow-last ordering, scope/order cursor fences and the fixed statement-cache bound. The HTTP suite
checks sorted reads and invalid sorting fields. Native fixtures cover archived titles, canonical mission
homes/lineages, named record attribution, sort/cursor/cache replacement and actual chart pixels at
420/900 widths in both appearances. These are synthetic checks, not live-account usage validation.
The native test build also exposed an existing missing `@testable import PilotCore` in
`ArtifactPresentationTests.swift`; only that fixture import was corrected to unblock verification.
The production mounted-control/pixel matrix passed locally in all four width/appearance combinations.
The wrapper also passed 13 focused presentation/model/Local-transport tests (14 native tests total).
The accompanying artifact is a static mock, not a production capture. Full suites and packaging remain CI checks.

An offscreen run of the unchanged `scripts/bench/usage-queries.mjs` on 50,000 faux rows, with queued
replacement writes, compared the parent source and this change: ordinary breakdown median/p95
375/449 ms versus 312/441 ms; response sizes were unchanged and event-loop p99 was 4.37/3.84 ms.
This is one serial pair during native compilation, not a speedup or acceptance-gate claim. A separate
temporary probe added chat identities and ranked cost reads: 20,000 rows, 900 dated chat groups,
12 samples, 85/101 ms median/p95 and a 12.6 KB response. The original 50,000-row supplemental seed
hit the existing SQLite byte cap, so the workload was reduced without raising any storage limit.
The existing 50 ms query target and 16 MiB memory gate remain unresolved; no installed-daemon,
interactive/streaming GUI or release/packaging performance acceptance is claimed.

- `UsageDashboardPresentationTests`: UTC/DST/custom bounds, unknown/zero/partial/overflow, cache
  denominator, reasoning subset and exact canonical/missing group filters.
- `UsageDashboardModelTests`: fake Local queries, coalescing/cache bounds, no checkpoint/page sums,
  unavailable/unsupported/capacity/error states, stale scope and connection/erasure fences, paginated
  trends with changing live totals, explicit-refresh recovery and late trend deliveries.
- `usageDashboardMountedControlsReadLocalRangesFoldAndPageInBothAppearances`: real mounted production
  range, refresh, custom Cancel, disclosure and request/reconciliation controls with faux data,
  narrow/wide in light/dark. The wrapper runs pointer interaction alone; model fixtures run in the scheduler partition.
- Existing `UsageProjectionTests` verifies pinned Local-only reads and rejection of ambiguous identities.
  Its HTTP fixture enforces the daemon's per-response bound and exercises two explicit refreshes through
  the production directory and dashboard model. The daemon query suite separately checks that 400 is
  rejected, 100-group cursor pages have unique buckets, corrections preserve cursors and erasure fences them.

Full suites and packaging remain CI checks. After the user authorized local native verification,
the real `apps/macos/scripts/test.sh` wrapper built the application and test targets, then passed
16 focused tests: nine usage/presentation/model/Local-transport tests, six retained-history and
qualified-navigation tests, and the mounted pointer fixture in its own `--skip-build` invocation.
The mounted production page passed actual document/viewport bounds at 420/900 widths in both
appearances. The native build also exposed a stale test of the retired `sharedMissionVersions` API;
that obsolete API-only test was removed, without restoring remote execution or weakening retained
history assertions. Local destination checks use the composer's `executionHost ?? localHost` rule.

The earlier isolated source harness passed nine tests but is not used as a substitute for these real
native results. The Python wrapper suite passes 107 mocked tests with its real Swift-building fixture
excluded; Swift lint, font-role checks and shell/Swift syntax checks pass. Exact-head CI remains
separate evidence, not inferred from local results or prior-main checks.

Static light/dark mock artifacts reuse the reviewed revision-2 sources with Local-only wording;
they are not production screenshots. None of these checks proves keyboard/VoiceOver quality,
installed-daemon responsiveness, large-history streaming smoothness, packaged behavior or the
accounting memory target. No live/paid experiment, visible benchmark, deployment or merge was run.

Contracts: [accounting](usage-history-contract.md), [queries](usage-queries.md).
