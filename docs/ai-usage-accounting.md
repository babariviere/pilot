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
closed scope/status classes and nonnegative numeric deltas. It contains no chat, request, provider, model, tool,
repository or content identifier. Export remains off by default, memory-only and subject to the telemetry contract's
queue and revocation behavior. The accounting is observational: it cannot route models, enforce budgets, retry,
restart or change context.
