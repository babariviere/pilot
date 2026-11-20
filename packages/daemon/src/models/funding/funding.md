# Request funding

Funding is separate from [informational usage accounting](../usage/ai-usage-accounting.md).
It measures catalog value, not provider bills or marginal subscription spend.
Erasing usage history does not erase reservations or refill an allowance.

## Scopes and consent

- A native-created mission has one lifetime account. Its planning, changes to
  the plan, research, builders, reviews, helpers and retries share that account.
- A standalone native chat has a quick-fix account. The existing continuation
  transaction carries its logical account ID to its replacement, not a new limit.
- Small app-wide background completions share a configured daily account. The
  day changes at midnight UTC, shown with its next reset time. Settled previous-day
  usage leaves that day's available balance; unresolved previous-day requests do
  not. Job and project attribution is shown where known.
- Project defaults are suggestions shown at native creation. The user's explicit
  creation amount opens the account before its first worker can spend. Missing
  defaults ask for an amount. Changing defaults never refills existing work.
- Existing totals can only increase through an explicit, revision-checked native
  approval. A failed or lost write is not automatically sent again.

Legacy desktop work keeps its existing controls until migration. Native-created
work has a durable `fundingRequired` marker; its helpers inherit the same scoped
credential capability. New members of a funded planning mission use its account.
An absent ledger/account never makes such work unmetered. This change does not
cut over the installed app or migrate old missions automatically.

## Limits off

One global switch (`funding_meta` key `off`, revision-checked like other settings)
turns limits off. `fundingRequests` then lets every reservation through with no price
lookup or ledger row, and drops its settle. Native creation opens no account and sets
no `fundingRequired` marker, so such work stays unmetered after limits return.
Workers that start while limits are off get no metered credential. Running metered
workers keep calling reserve until they restart; those calls are let through.
`Funding` caches the switch in memory because it is the file's only writer.

## Request boundary

`Funding` owns one `funding.sqlite` file through a bounded worker RPC queue.
SQLite transactions use FULL synchronous commits before acknowledgement.
The file stores no prompts, source paths, tool arguments or credential contents.
It keeps funding scopes, exact request IDs, pinned prices, bounds and usage.
There is no TTL eviction of uncertainty or request-count cutoff that strands a
long-lived allowance. Snapshot rows are limited, but their account count and
scope totals are exact. Old calls remain on disk, not in daemon memory.

The canonical credential broker binds worker capabilities to their host-owned
session or background attribution. Workers cannot choose a funding account or
send prices. The daemon resolves the physical model from its canonical catalog.
Each physical request gets a fresh reservation ID. Reusing one never dispatches
another request. A logical retry makes a new reservation and leaves unresolved
earlier charges counted.

The runtime guard runs after payload hooks, including native extension hooks.
It reads the final output cap, reserves a maximum, rechecks subscription and Stop
signals, and only then returns the payload to the provider. When the payload has
no verified cap, the worker sends the hold reason instead. The daemon refuses it
only while limits are on, so limits off never hold a request for its bound.
Funded requests use
no hidden provider retries, generated model fallback list or SDK continuation reuse.
The guard suppresses the SDK's generated fallback list before extension hooks;
an extension that changes the priced model or adds fallback models is refused.
Saved advanced settings stay unchanged. Re-entering an SDK
payload hook requires another reservation. Deferred and non-chat operations
without a qualified bound are unavailable, not treated as free.

The input maximum is the physical model's context window, not a token estimate
over a truncated transcript. The reservation uses the highest catalog tier and
input/cache rate, including the twice-input price of long-lived cache writes.
This is deliberately conservative and can require a much larger reservation
than the eventual charge. The UI shows the last maximum that did not fit.
Successful evidence settles at the pinned applicable tier and reported token
classes. Reasoning is included in output, not added twice. Zero placeholders,
errors, cancellation and lost replies do not refund reservations. A reported
overrun records the charge and blocks the affected adapter's future requests.

The qualified payload-cap paths are Anthropic Messages, OpenAI Responses and
OpenAI Completions. Hosted tools and multiple completions without a qualified
price/bound are refused. The ChatGPT Codex backend (subscription OAuth only)
refuses `max_output_tokens`, so its only bound is the model's own output maximum.
For Codex Responses the daemon reserves its canonical catalog `maxTokens`, priced
at catalog value like other subscription work. Other APIs without a payload cap
(Azure Responses, Google, Vertex, Bedrock, Mistral, pi-messages) are held before HTTP.
This does not silently choose a different model or patch the SDK.

## Independent holds and reviews

The existing fresh 99% subscription policy still gates parent and helper work.
Background completions now use the same policy logic in a separate durable
background policy. Unknown or stale readings cannot thaw an unexpired known
hold. Continue anyway is explicit and scoped; it never grants dollars, clears
Stop/Pause or approves a required review. Provider-reported exhaustion revokes
the applicable background override. Reset changes only subscription state, not
funding, user controls or review requirements.

Review-specific token, time, money and rolling limits remain unchanged.
`ReviewAccounting` accepts a host-only outer-funding adapter. Both ledgers must
reserve before `send`; a failed outer reservation cannot be bypassed by calling
`send` directly. Lost replies preserve both reservations. The existing retained
review execution seam remains inactive; its production activation and result
readiness rules belong to the required-review implementation, not this change.

## Verification boundaries

Focused tests use temporary stores, local HTTP fixtures and a real SDK request
adapter with fake HTTP. They cover restart, duplicate requests, concurrent
admission, uncertainty, daily reset, tiers/cache pricing, nested review limits,
capability inheritance and native creation receipts. They do not establish real
provider billing, native input/IME, daily-driver or cutover acceptance.

On macOS arm64, a generated-worker probe seeded 10,000 requests and measured
1,000 reserve/settle pairs. Final-source p50/p95/p99 were 2.27/3.50/4.56 ms;
main-thread loop p99 was 13.38 ms with a 10 ms sampler. Process RSS rose
14.55 MiB at worker startup and 26.80 MiB over the whole probe. Native checks
ran concurrently. These are synthetic observations, not a native streaming or
16 MiB RSS-gate pass. The worker caches fixed SQL statements; packaging strips
its closed TypeScript leaf graph to avoid a separate parser in that isolate.
