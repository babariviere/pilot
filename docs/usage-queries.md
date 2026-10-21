# Local usage query API (version 1)

This is a read-only projection of retained, host-local accounting, not billing, routing or telemetry.
The [accounting contract](usage-history-contract.md) still governs capture, privacy and erasure. The
query DTOs do not depend on a particular storage backend. The existing dedicated storage worker and
SQLite ownership are unchanged. The separate 16 MiB memory gate is neither passed nor waived here.

## Current scope: Local only

The first dashboard pass reads **Local usage only**. Label its totals and charts “Local” and
“observed/partial”, not globally complete. Devbox usage is deliberately excluded, not zero and not a
request to connect or refresh another host. Remote collection, polling, fanout, aggregation and related
integration/release checks are deferred follow-up work. Already-landed per-host capture and canonical
source/mission provenance remain unchanged. Nothing changes unrelated devbox behavior.

## Native client handoff

`packages/protocol/src/usage-history.ts` and `PilotCore/UsageHistory.swift` define:

- `UsageAnalyticsQuery` / `UsageAnalyticsResult`: summary, breakdown and sparse UTC buckets.
- `UsageHistoryQuery` / `UsageHistoryPage`: bounded request or checkpoint drill-down, with the same filters.
- `UsageQueryFilters`: exact project, canonical mission tuple, chat, purpose, observed physical model,
  observed virtual model/revision. `missing` selects unattributed groups explicitly, not a wildcard.
- `UsageConnectedProjection`: a bounded response envelope; the active Local consumer returns one Local
  host, never an aggregate over connected hosts.

Call **`ClientDirectory.localUsage(query)`** on explicit refresh or scope changes, not from a view body or
on every repaint. It resolves only the installed, pinned Local endpoint; missing/ambiguous Local identity
fails closed rather than selecting a devbox. Cancel obsolete Tasks and retain only the active bounded
result. `ClientDirectory.usagePage(query,on:localHost)` reads a drill-down on that same qualified Local host.
Project/chat filters refer to Local IDs. Canonical-mission filters still use the full home/lineage/mission
tuple, but only Local execution evidence contributes in this pass.

Nothing connects/enrolls a host, wakes an agent, retries on another host, reads credentials, scans
transcripts or polls providers. There is no background refresh timer or cache. Cancellation stops native
delivery; already executing, bounded storage queries may finish. Subscription windows remain separate.

Negotiate `hello.capabilities.usageQueries == 1` exactly. Older/unknown versions are `unsupported`, not
zero. Connection-generation and hello daemon/lineage fences reject replaced endpoints. Projection
states are `fresh`, `disconnected`, `unsupported`, `unavailable`, `limited` (query capacity), and `alias`.
Only `fresh` has a result.
`queriedAt` on results is the host's observation clock; the projection timestamp is the client's read
completion clock. Do not compare host wall clocks as an ordering or identity mechanism. No stale usage
cache is silently substituted after a failure. Status gives coverage start, effective retention floor,
generation, retained rows, rejections/conflicts/expiration and process-local queue overflows.

### Retained identity coverage

`ClientDirectory.usageProjection(query,on: explicitHosts)` and pure projection-plan DTOs retain coverage
metadata for known Local and saved identities, but are **not wired to the dashboard's active path**.
Only the sole installed Local client can issue a read. Saved identities remain disconnected coverage
or aliases, never executable endpoints. The plan is bounded at 32 identities and reports `omittedHosts`;
there is no remote endpoint registry, fanout, connection or failover.

Host aliases are deduplicated by case-folded `(daemonId,lineageId)` before reads, preferring an already
connected endpoint. No failed read tries a second alias. The storage primary key `(sourceId,operationId)`
counts replayed evidence once; revisions replace, including downward corrections. Source identity is
qualified by its canonical daemon/storage lineage, never display name. Mission identity is independently
the exact canonical `(homeId,lineageId,missionId)` tuple. Replicating a mission does not replicate accounting
or create a charge. Distinct execution hosts can legitimately charge the same mission. Do not deduplicate
those by mission, chat title, execution-host alias, or parent checkpoint, and do not sum alias responses.
If a future release presents a combined overview, combine only unique `fresh` host totals, recheck safe-integer sums,
and preserve every metric's unknown/partial counts. Missing or omitted hosts always keep coverage partial.
The projection deliberately does not combine non-additive reconciliation values into a global amount.

## Reading results honestly

`total` includes **only dated physical requests in `[from,to)`**. All groups use the same predicate and
reconcile with that total, including explicit unknown keys. Checkpoint values never enter totals, model
or purpose breakdowns, or date buckets. Terminal undated unknowns stay checkpoints, not fake completions.

Every aggregate has record/committed/partial/legacy counts, unpriced and partially priced counts, and
per-class metrics for input, output, cache reads/writes, reasoning, estimated/billed USD micros, requests,
provider attempts, retries and duration. For each metric:

- `known` is the number of records with a numeric value; `unknown` counts absent values.
- `partial` is the subset of known values explicitly reported incomplete (reasoning/partial estimates).
- `value`, when present, is the **known subtotal**, never a zero replacement for missing evidence.
- No known values means absent `value`, including empty results. Known explicit zero remains zero.
- Unsafe sums omit `value` and set `overflow`. Never display a saturated value as an exact amount.

Label all totals observed/partial even if every retained row says committed. Retention, capture gaps,
unknown response classes and intentional exclusion of devbox evidence prevent claims of complete global
or account usage. Costs remain
catalog estimates, not invoices or marginal subscription spend. `pricingVersions > 1` labels mixed estimates;
when it equals one, `pricingRevision` identifies that estimate version. Future cross-host consumers must
not add revision counts across hosts to infer mixed pricing. No history is repriced. Reasoning is a subset of output; cache
efficiency retains numerator `cacheRead` and denominator `input + cacheRead` with their coverage labels.

`reconciliation` is a **non-additive coverage view of retained checkpoints**, matching scope filters but
independent of the chart's time window. Its metrics contain counts only, **never numeric sums**. Parent
and child summaries can overlap one another and detailed evidence. Drill into `kind: "checkpoint"` pages
to inspect original numbers/unknowns or non-model compaction activity; do not sum them or allocate them
to dates. Missing fields on activity checkpoints are not proof that a physical request happened.

Subscription window snapshots remain on the existing separate provider/account-level path, with their
own source, refresh/reset times and possible usage from other apps. Never convert percentages into USD,
append them to this query, or allocate them to a project/mission/chat.

## Examples and group keys

```ts
const summary = { version: 1, view: "summary", from, to };
const byModel = { ...summary, view: "breakdown", dimension: "physicalModel", limit: 100 };
const daily = { ...summary, view: "buckets", bucketMs: 86400000, limit: 100 };
const scoped = { ...summary, filters: { mission: { homeId, lineageId, missionId } } };
const unknownModel = { ...summary, filters: { missing: ["physicalModel"] } };
const requests = { kind: "request", from, to, filters: scoped.filters, limit: 100 };
const checkpoints = { ...requests, kind: "checkpoint" }; // dates do not constrain checkpoints
```

Breakdown `key` is a JSON string, decoded with `JSON.parse`:

| Dimension | Known key | Unknown key |
| --- | --- | --- |
| project, chat | canonical lowercased UUID string | `null` |
| mission | `[homeId,lineageId,missionId]`, lowercased | `null` |
| purpose, scope | exact string | purpose has an explicit `unknown` value |
| physicalModel | `[provider,model]` | `null` |
| virtualPolicy | `[provider,model,revision-or-null]` | `null` |

For a virtual policy whose revision is absent, combine its virtual-model filter with
`missing: ["virtualRevision"]` when drilling in. Model identifiers remain exact/case-sensitive.
Buckets use zero-padded 16-digit UTC epoch-millisecond keys, convertible to a safe integer, sorted
chronologically. Supported widths are one hour or one day; the first bucket can start before `from`,
but only matching requests contribute. Omitted buckets are no observed evidence, not proven zero spend.

## Transport and resource bounds

Existing loopback/origin and SSH-forward boundaries apply. Two read-only, `Cache-Control: no-store` GETs:

- `/api/usage-history/query?daemonId=...&lineageId=...&query=<URL-encoded JSON UsageAnalyticsQuery>`
- `/api/usage-history/page?daemonId=...&lineageId=...&query=<URL-encoded JSON UsageHistoryQuery>`

Identity mismatch is 409, query capacity is 429. Invalid queries are 400, unsupported service is 503. Worker failures and query
capacity failures have fixed, content-free messages. No SQL, raw row or rejected identifier is returned
in errors. Query strings are excluded from the server's operation log. This plane remains excluded from
diagnostics tools and remote telemetry; there is no agent query tool or cross-host daemon relay.

Queries are allowlisted, <=4 KiB decoded JSON, use half-open UTC windows <=366 days, <=400 buckets per
chart and <=100 groups/records per response, <=512 KiB. The existing `usage_time` B-tree bounds completion
range/keyset reads. An optional backwards-compatible `usage_query_v1` covering expression index stores
the fixed numeric/scalar query expressions, avoiding repeated ledger JSON parsing for aggregate reads.
Index construction occurs in the existing worker on open, never on repaint. Near-cap older stores that
cannot fit the index keep the time-index fallback without erasure, eviction or raising the byte cap.
Fixed SQL reduces values inside the storage worker, never rehydrates ledger objects into daemon/UI memory.
Candidate work is independently bounded by the 50,000-row/64 MiB store; scope predicates apply inside
that indexed range. There is no precomputed rollup table. Arbitrary SQL/dimensions are not accepted.
The statement cache is bounded at
20 entries. At most two queries per store may be outstanding, within the existing 32-message/256 KiB
ingress; capture and query messages continue sharing the same worker ownership.

`next` is an opaque keyset cursor bound to kind/view, window, normalized filters and generation.
`truncated` marks remaining aggregate groups, not a reduced `total`. Raw pages use `next` to signal
remaining rows. Totals cover the full matching window on each call, not just that page. Never sum the
repeated totals across pages. Pagination is a live retained view, not an immutable multi-call snapshot:
new evidence/corrections can change totals/groups between pages. Cancel/reload a drill-down when scope,
connection or generation changes, and refresh the overview after changes instead of assuming snapshot
equality. Erasure invalidates old cursors and stale writers; no cross-host materialization/cache can
reimport erased evidence. Reads do no retention writes and immediately exclude expired rows.

## Verification

Shared JSON fixtures under `packages/protocol/fixtures/usage-{analytics,query}.json` exercise TS/Core
parity. Faux tests cover UTC boundaries, missing classes, undated checkpoints, mixed pricing, replacement
and duplicate identities, all filters/unknown groups, pagination, overflow, generation, retention, query
budgets and HTTP identity/origin/method boundaries. The Local consumer fixture asserts that no non-Local
endpoint is queried. Deferred-helper fixtures also cover connected/unsupported/disconnected/alias hosts,
without making real devbox integration a first-pass requirement.
Native tests are source additions for remote CI, not locally built or executed evidence. No native window,
provider call, installation, deployment, merge or runtime/backend migration is part of this change.

`node scripts/bench/usage-queries.mjs` runs the offscreen 50,000-row faux probe with a separate seeding
process and allowlisted credential-free environment. Optional `USAGE_QUERY_BASELINE=/path/to/frozen/src`
compares existing page reads against a frozen baseline; aggregate APIs have no baseline equivalent.
The probe queues a replacement write beside each query. It reports response bytes, latency and probe
event-loop/process CPU/RSS (including its worker thread), not installed-daemon/UI performance. Full rollout and the
unchanged D6 memory acceptance gate remain separate verification.

### Offscreen query evidence, 2026-10-21

One fresh-process pair against frozen main `8d529c22`, 50,000 retained synthetic rows, 12 samples per
case and one replacement write queued beside each query. Cold worker start and index construction are
outside query timings. Both processes used the same shipped Node 24.21.0 and a credential-free environment;
macOS added only `__CF_USER_TEXT_ENCODING`. The final fixed SQL streams preprojected scalar index facts into
grouping, rather than carrying ledger JSON through the sorter. Raw results are in
[`benchmarks/usage-queries-2026-10-21.jsonl`](benchmarks/usage-queries-2026-10-21.jsonl).

| Query | Median | p95 | Largest response |
| --- | ---: | ---: | ---: |
| Existing page, baseline | 2.0 ms | 4.0 ms | 74,059 B |
| Filter-capable page | 2.3 ms | 4.8 ms | 74,149 B |
| Summary | 34.8 ms | 37.5 ms | 2,318 B |
| Model breakdown | 238.9 ms | 307.3 ms | 6,523 B |
| Daily buckets | 98.4 ms | 124.5 ms | 32,216 B |

Probe event-loop p99 was 1.64 ms baseline / 1.58 ms candidate; process peak RSS was 118,864 / 132,528 KiB.
Only the page workloads are matched; candidate CPU/event-loop/RSS also include 36 additional aggregate reads.
These short probes do **not** close the separate sustained-load/installed-daemon memory gate. Broad model
breakdowns remain hundreds of milliseconds off-thread, and time-index fallback on near-full older databases
is slower. UI must cancel/coalesce refreshes and never query per repaint. This is not on-screen, provider,
Swift, remote-CI or default-rollout evidence. Additional index storage can reach the unchanged byte cap sooner;
capacity still rejects new capture rather than evicting records or enlarging the store.
