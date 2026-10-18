# AI usage and cost accounting

Pilot reports content-free chat accounting from two existing authoritative sources:

- Pi Durable's per-conversation `UsageDoc` provides committed input, output, cache-read, cache-write, reasoning and
  catalog-cost totals. Pilot never forwards its provider, model or tool keys.
- Committed assistant and usage-bearing tool-result entries provide request/operation outcomes. The existing
  request timer adds observed provider-attempt and active/elapsed timing. Timing is explicitly partial.

The kernel sends only aggregate `direct` and `child` scopes. Direct usage is the model ledger; child usage is the
usage-bearing tool ledger, so parent and delegated usage are not added from overlapping transcript text. pilotd
keeps one derived `ai-usage.json` per chat. Conversation snapshots replace their previous totals, and worker timing
snapshots replace the same process epoch, preventing duplicate attribution after resume, packet replay or restart.
Observed outcome snapshots replace within one active-context epoch and roll into totals when a reset/compaction head
changes, while remaining explicitly partial when accounting began after an older epoch disappeared.
After 32 attempts or four timing epochs per attempt, older detail rolls into aggregate totals. The file is capped at
128 KiB, mode 0600, retained with the chat and removed with session deletion/archive cleanup. Malformed, symlinked or
oversize state is ignored; accounting never blocks an agent request.

Session time is daemon-observed and split into active, paused and idle intervals. Gaps while pilotd is not running,
and a final interval lost to an abrupt daemon crash, are omitted rather than guessed, so coverage is explicitly
partial. Provider attempts and timing can also miss a crash before publication. Committed token totals remain
recoverable from the durable source.

## Context efficiency and relaunch observations

The same bounded file keeps content-free observations that make efficiency regressions diagnosable without changing
agent behavior:

- Latest context usage records observed tokens, the model context window and derived headroom. It is one latest
  observation, not a time average or a claim that unobserved context stayed constant.
- Direct and child cache efficiency each retain the input, cache-read and cache-write growth seen between consecutive
  authoritative reports. The displayed ratio is `cache read / (input + cache read)` with its explicit denominator
  and observation count. Missing first reports and crash-lost publications remain outside that denominator.
- A compaction is counted only when the kernel explicitly publishes a `pi.compaction` activity epoch. Before/after
  tokens and removed tokens are reported only when both adjacent context observations exist. Compaction duration is
  unavailable because no authoritative timing seam exists.
- Physical request attempts beyond the first are counted as observed retries. Publication can be lost in a crash,
  so retry coverage remains partial.
- Each successfully published kernel worker records a closed launch reason: initial start, parked wake, user resume,
  crash recovery, startup retry, replacement or unknown. The next context observation is associated with that launch
  as prepared context volume. Relaunch cost is unavailable rather than inferred from catalog token prices.

These are measurements, not control signals. They do not trigger compaction, alter context, switch models, retry a
request, restart a worker or change parking/recovery policy.

## Informational budgets

Diagnostics settings can optionally configure one positive USD limit for this host. There is no default. The
comparison window is the existing bounded accounting retained with one chat, not a calendar month, provider billing
period or account-wide total. The selected basis is either:

- **Catalog estimate**, which compares the catalog estimate and continues to label it as an estimate; or
- **Billed spend**, which compares only authoritative billed amounts. Billed comparison is currently unavailable
  because Pilot has no billing source.

Complete retained observations report below, equal or above. A partial amount is a lower bound: it reports above
only when that lower bound already exceeds the limit, and otherwise reports indeterminate. Missing usage or pricing
reports unavailable, never zero. Subscription coverage remains a separate covered/not-covered/unknown field and
does not turn a catalog estimate into marginal or billed spend.

The comparison is derived only when diagnostics are read. It adds no ledger, background monitor or exported
telemetry attribute. The private limit stays in this host's telemetry settings file and host settings API; it is not
sent to the kernel or OTLP collector. Turning off local diagnostics withholds the comparison from the diagnostics
specialist. Clearing local diagnostics adds no budget record to clear and does not change settings or the existing
authoritative per-chat accounting.

An above result is informational. It is not consulted by admission, model requests, tool execution, subscription
quota handling, retries, context/compaction, parking or recovery, and it cannot pause, stop or reroute an agent.

## Cost semantics

- Token classes stay separate. Reasoning is a reported subset of output, not an additional token class.
- `catalog_estimate` means pi-ai's shipped model catalog supplied all observed estimates. Its package revision is
  retained locally; exported estimates are versioned by Pilot's `service.version` and `pi_catalog` source class.
- `partial_catalog_estimate` is displayed as **at least** the known amount. Missing or zero prices are unavailable,
  never free.
- Billed spend is unavailable until an authoritative billing source exists. Catalog cost is never relabeled billed.
- Subscription coverage is unknown unless explicitly reported, so Pilot does not present estimates as exact
  marginal subscription spend.

With remote operational telemetry enabled, a checkpointed increase emits a zero-duration `pilot.ai.usage` span with
closed scope/status classes and nonnegative numeric deltas. Context, compaction and launch attributes are closed
numeric or enum fields; no launch or usage span carries a chat, request, provider, model, tool, repository or content
identifier. Export remains off by default, memory-only and subject to the telemetry contract's queue and revocation
behavior. The accounting is observational: it cannot route models, enforce budgets, retry, restart or change context.
