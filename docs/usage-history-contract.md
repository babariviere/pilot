# Local usage history, version 1

This contract adds a **local accounting** plane, not telemetry, billing or routing. Checked against main
`e3bb09bd` on 2026-10-21. The existing [chat accounting](ai-usage-accounting.md) and
[telemetry boundary](telemetry-contract.md) remain in force. New writes must implement this contract first.

## Data and authority

The protocol types are `UsageObservation`, `UsageHistoryStatus` and `UsageHistoryPage`, mirrored as Codable
types in PilotCore. All numeric values are finite, nonnegative safe integers, in tokens, milliseconds or USD
micros. Reject invalid values, do not silently coerce them. Aggregation must detect overflow and report partial
coverage, never wrap or claim an exact saturated amount. Unknown is absent, not zero.

An observation contains only:

| Field | Contract |
| --- | --- |
| `schemaVersion` | `1` |
| `generation` | Host-issued erasure epoch, read from status before capture; stale epochs rejected |
| `sourceId` | Durable opaque source UUID, stable across worker restart/park and source replay |
| `operationId` | Stable source-owned identity, max 128 restricted identifier characters, persisted before publication |
| `revision` | Positive safe integer; source commit order, **not** arrival time or wall clock |
| `kind` | `request` or `checkpoint` |
| `scope` | `direct` or `child` |
| `observedAt` | Time the evidence was observed, Unix milliseconds, not necessarily the request date |
| `completedAt` | Optional committed physical-request completion time; omitted when unknown |
| `coverage` | `committed`, `legacy` or `partial`; no claim of complete host/account usage |
| `purpose` | `agent`, `control`, `follow_up`, `title`, `triage`, `classification`, `memory`, `compaction`, `other`, `unknown` |
| `attribution` | Optional project/chat/run UUIDs; optional mission tuple `(homeId, lineageId, missionId)`, all UUIDs |
| `physicalModel` | Optional observed `{provider, model}` identifiers, each <=128 restricted identifier characters |
| `virtualModel` | Optional **observed** `{provider, model}` identifiers; never a newly inferred routing policy |
| `tokens`, `cost` | Existing `AIUsageTokens` and `AIUsageCost`; retain pricing revision with the estimate |
| `requests`, `providerAttempts`, `retries`, `durationMs` | Optional committed/observed nonnegative integer counters |
| `outcome` | Optional `success`, `failure`, `cancelled` or `unknown` from committed outcome evidence |

The full canonical allowlisted record is at most 4 KiB. No arbitrary metadata, error text, tool names, titles,
paths, URLs, messages, prompts, completions, headers, tokens/credentials, email, account fingerprints or request
payloads. Model identifiers are exact catalog/response identifiers, never credential or endpoint strings. Adapter
code must construct fields from trusted structured evidence, not extract attribution from transcript prose.

Record identity is `(sourceId, operationId)`, independent of host aliases and chat titles. Equal revision and
equal canonical record is a no-op; equal revision with differing content is a visible conflict; older revision
is ignored. Higher revisions **replace** the entire record, including downward corrections. Kind and direct/child
scope cannot change under one identity. New physical retries are counted only when observed. A new billable
physical invocation needs its own operation identity; replaying its evidence does not.

### Non-overlapping totals

`UsageDoc` is the authoritative per-conversation replacement checkpoint. Preserve the existing direct-model and
child-tool summary code and its replacement/roll-forward semantics, unchanged. Do not treat successive checkpoint
values as increments. Do not add a rolled legacy total to its detailed requests.

Only `request` rows with committed completion timestamps are additive in dated charts and model/purpose breakdowns.
Unknown historical dates must be represented by checkpoints, not undated additive requests.
`checkpoint` rows are a **separate, non-additive reconciliation view**, including undated legacy totals.
This first version does not invent dated
residuals by subtracting incompatible snapshots. A chart is explicitly observed/partial when checkpoint coverage
exceeds detailed evidence. Consumers must never sum the two views.

For delegated work, use the actual child request as the sole additive row where available. Parent tool usage is a
child-scope checkpoint only, never another additive request. Direct child rows retain their original source and
operation IDs when observed through a parent. The root summary and the child's summary are not two costs. Forks
reference inherited evidence with its original identity, not a new charge; only newly committed requests get new
IDs. Reset and compaction change context, not usage identity. Deterministic compaction without inference creates
no token or cost row. Background work uses its own stable operation and purpose, not a fabricated chat request.

Input excludes cache-read/cache-write classes. Reasoning is a subset of output. Cache efficiency keeps numerator
`cacheRead` and denominator `input + cacheRead`. Retry/error/aborted output can have committed usage. No response
is not proof of zero usage. Timing/retries may remain partial after a crash even when tokens recover.

Catalog estimates are not invoices, marginal subscription spend or quota. Missing/zero placeholder prices stay
unavailable. Retain the pricing revision that produced each observation, do not silently reprice history. Different
versions can be summed only as a labelled mixed-version estimate. Physical provenance must come from the request
that ran, never the current chat model. Existing virtual selections may be reported if observed. No new routing
lifecycle, configuration, credential affinity, provider polling or paid calls are required.

## Storage, recovery and migration

One `accounting/usage-history.sqlite` per execution host, under its private Pilot home, mode 0600 in a mode 0700 directory.
All SQLite work/fsync is off the daemon event loop in a dedicated worker. Transactions durably commit before
acknowledgement (`synchronous=FULL`, bounded rollback journal). A crash before ack is uncertain: replay the same
committed source identity/revision, never reissue inference. Failed writes expose partial/unavailable status and
cannot stop, retry, reroute or otherwise change agent work.

Schema version lives in `PRAGMA user_version`. Version 0 initializes transactionally; unknown versions or corrupt
databases fail closed without overwriting/quarantining copies. No backup of sensitive accounting is created.
Existing `ai-usage.json` files remain authoritative compatibility files and are not rewritten by migration.
Import at most one undated legacy checkpoint per chat/scope from their already-bounded summary on normal session
load, in bounded batches. Stable IDs and revisions make rerunning migration idempotent. Never walk transcripts or
invent old model/date attribution. Source adapters recover committed detail using bounded durable evidence cursors
on normal recovery, independent of compaction/context availability. Missing pre-capture provenance stays unknown.

The store is a bounded materialization, not a second transcript or permanent ledger. Default retention is **30
days** of locally observed evidence, including checkpoints by their observation time; request dates older than the
window cannot be resurrected by replay. A monotonic persisted retention floor rejects stale replay. Maximum
**50,000 rows**, **64 MiB database** (plus bounded SQLite transaction journal), **32 pending messages / 256 KiB
ingress**. Expire in <=500-row batches on writes/startup and hourly idle maintenance, not on UI repaint.
Reads immediately exclude expired rows; idle physical cleanup can lag by at most an hour while the host is running.
Capacity rejects new writes rather than evicting replay fences or growing without bound.
Rejections/expiration/conflicts and store availability are
visible through content-free status. Counters survive restart; volatile queue overflow is explicitly process-local.
At most one outstanding maintenance call. Closed/draining stores refuse new work and join before home removal.

### Lifecycle and erasure

Archive and park retain data only within the same 30-day window. Rename, fork and reset do not relabel/move old
charges. Delete a chat: delete attributed rows **before** removing its session directory and fence old writers by
rotating the host generation. Clear usage history: atomically delete all rows, rotate generation, advance the
capture floor, reset coverage start. No durable tombstone list that can grow without bound. Old in-flight reports
are rejected. Capture adapters must acquire the new generation and start at the new floor, never replay cleared
history. Never transplant old operation evidence into a new generation. After any erasure, legacy cumulative
summary import is disabled for that store: a later summary timestamp cannot prove which lifetime tokens came
after deletion. New capture adapters resume with new committed operations only.
Clearing diagnostics does not clear accounting; clearing accounting does not change credentials, runtime
history or existing composer summaries. This is logical deletion using SQLite secure_delete, not a guarantee
against filesystem snapshots/backups or SSD forensic recovery.

## Access and query budgets

Internal store methods are trusted daemon APIs, not agent tools or a generic SQLite/SQL endpoint. Native clients
can receive bounded projections through the existing authenticated/loopback host boundary; access does not enroll,
connect, wake or authorize a devbox. Responses carry host identity separately; dedupe by canonical daemon/source/
operation identity, never host display name. Unsupported/offline hosts are omissions, not zeros. Canonical mission
identity does not become host-scoped. No cross-host background replication of the raw accounting database.

Queries use indexed completion time and keyset paging, at most **100 records / 512 KiB response**, time ranges
<=366 days and <=400 UTC buckets per chart. UTC half-open windows `[from, to)`; day buckets are multiples of
86,400,000 ms, independent of locale/DST. Unknown dates appear only in the separate reconciliation view. The store
returns raw bounded pages, not an unbounded in-memory read or all-history scan; the query layer bounds aggregation,
cancellation and scope filters separately. No read opens a kernel, parses history, calls a provider or polls hosts.
Retention may make “All” mean retained history only. Coverage/status accompanies all results.

Local accounting identifiers are outside diagnostics reads and automatic repair evidence. Do not attach raw rows
to logs, exceptions, artifacts or remote telemetry. Existing explicit telemetry allowlists remain unchanged and
continue excluding provider/model/policy/project/chat/operation/account identities. Remote telemetry remains
opt-in under its own contract. No network export of this new plane by default.

## Verification and rollout

Required fixtures: v0 initialization/unknown schema, restart and duplicate/out-of-order/corrected input, equal-revision
conflict, crash before/after commit/ack, corrupt/oversize state, bounded queue/capacity, UTC boundaries, retention,
delete/clear fencing and checkpoint/detail/child overlap. TS/PilotCore JSON parity must cover optional unknowns.
Capture adapters must separately prove lifecycle recovery through replay, fork, reset, compaction, park and restart.
Store tests alone do not prove those capture seams or complete historical coverage.

Before dashboard release measure faux large retained histories and streaming versus baseline: p95 bounded page
query <=50ms and <=512KiB; no new uninterrupted main-thread accounting task >10ms; event-loop p99 regression
<=5ms and peak RSS regression <=16MiB. These are acceptance budgets, not measured results. On-screen UI performance
requires separate permission and evidence; routine checks stay offscreen. Full suites/packaging run in remote CI.
Rollout preserves direct selection, composer summaries, quota gates and informational budgets. Larger retention,
content/credential storage or remote export needs separate user review, not a routine schema revision.

### Initial offscreen store probe (not a release pass)

`node packages/daemon/src/usage-history.bench.ts` seeds 50,000 synthetic rows outside measurement in a disposable
home. On macOS arm64 / Node 24.21.0, one run of 200 indexed 100-row pages and 500 revision replacements measured
p95 page latency 1.18ms, largest response 50,777 bytes, event-loop p99 10.74ms versus an idle baseline 11.08ms.
Peak process RSS grew **51.34 MiB**, exceeding the proposed 16 MiB gate. Do not waive that gate or call the dashboard
performance-verified from this probe. Worker/isolate/query allocation needs profiling and repeatable before/after
measurement before default dashboard rollout. It ran no providers, native UI, live chats or on-screen benchmark.
Capture latency, full provider lifecycle recovery, native DTO execution, exact-head CI and packaging remain
separate verification obligations; a store test does not prove them.
