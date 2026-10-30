# Local Usage overview

Open **Usage…** in the sidebar. This passive native window leaves the current
conversation, selection and draft mounted. Choose 7, 30 or 90 UTC days, ending
at the explicit read time. Refresh is manual; nothing polls or mutates usage.

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
one summary query and one bucket query, with no paging. Both content-length and
streaming bodies are capped at512KiB before decode. Unknown versions, malformed,
duplicate/out-of-range buckets and truncated responses fail closed. Every request
has a5-second timeout and2-second connection timeout. One private worker owns
one in-flight future; bounded1-slot input/output lanes coalesce replacement.
Range replacement and window closure cancel the previous future. UI serial/range
fences reject late completions, including failed ones. Options are immutable per
window, so a completion cannot be adopted into another source.

Summary values come only from the authoritative `total`, which represents dated
requests. Never sum page totals, checkpoints or historical context. Bucket reads
are separate dated observations, not a transactional snapshot; a generation
change prevents adopting the trend. A failed trend does not replace a valid dated
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
marked as a previous observation. A different range clears old-range values.
Longer ranges do not override retention or imply complete history. Group filters,
records, reconciliation and informational budgets remain outside this overview.

## Verification scope

`check-scoped.py --unit usage_overview --test usage_overview --native-probes --lint`
maps only this model, transport/faux daemon and mounted production page, plus
matching production lint/build. It uses the existing shared serial slot, pinned
toolchain, mbx CPU2/4GiB bounds and private outputs. Full suites stay in CI.
The native target covers680/1100 light/dark geometry, loading versus empty,
coverage/summaries/trend, the partial-subtotal bar and axis ticks, 30/90-day
ranges with billion-token days and a retention floor, pointer range replacement,
disclosure, explicit retry, failed-refresh retention and close. Set
`PILOT_NEXT_USAGE_DIR` to save the captures. Captures are offscreen synthetic GPUI, not
the user's app or real usage. No new animation/timer or scrolling hot path is
introduced. No OS IME, live-daemon, Linux/Wayland, GPU performance or user acceptance
claim follows from these checks.
