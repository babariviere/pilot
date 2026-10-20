# Source refresh health for diagnostics

`diagnostic_context({ action: "refresh_health" })` reads existing local observations about the Inbox Slack and
Linear refresh scheduler. It does **not** refresh a source. A diagnostics-role check runs before dispatch; native
and trusted linked-host reads retain the protected app capability and exact host/daemon/lineage fences.
Ordinary Ask/Build and caller-supplied roles cannot authorize inspection.

Use `host` from host discovery, optional registered `projectId`, and `query: "slack"` or `"linear"`. `before` pages
sources, at most five per call. `channelOffset` pages at most twenty configured Slack channels per source, up to
the existing hundred-channel limit. Returned source/project IDs and opaque channel refs identify the scope; valid
Slack channel IDs may be included, but channel names, message content, configuration secrets and cursor internals
are never returned. Every envelope carries the qualified host, collection time, scan/byte bounds and truncation.

## Evidence, not a green light from an old checkpoint

The reader distinguishes:

- Current configuration, installed adapter and automatic scheduler state, including stopped/not configured/not
  scheduled/unsupported cases and the registry's actual shared-slot occupancy.
- **Observed this process:** admitted poll attempt/start/completion, the last successful product-store commit,
  returned item count and closed per-stage outcomes. These are last observations, not an unbounded event log.
- **Retained checkpoint:** the last committed poll timestamp and per-channel page progress. These survive restart,
  but are explicitly not proof the scheduler is currently running or that every channel succeeded.

Discovery/classification, commit, waiting-reply refresh and reaction-read stages are separate. An empty successful
discovery and zero committed updates is observed success, not a failed read. Classification failure or a local
classifier quota can coexist with a successful page read and commit. Waiting/reaction-read budgets are not silently
relabelled classifier limits. Stage counts are labelled: returned messages/items, classification admissions where
instrumented (not proof of a provider/model call), committed items, or a reserved auxiliary batch size (not a count
of completed external reads).
A stage without completion is incomplete after the poll ends, not indefinitely “running.” Missing observations
remain unknown. Existing UI errors are bounded and credential-redacted; closed stage reasons are more specific.

## Cadence, capacity and uncertainty

The projection reuses the scheduler's five-minute cadence and ninety-second poll deadline. Normal scheduling,
backoff, quotas, models and MCP admission are unchanged. The two shared slots also serve lookups, starts, excerpts,
adds and reaction writes, so a due source can be queued behind other work. A queued state identifies derived
current capacity, not an invented queue receipt or start time. Explicit resync due requests retain bounded local
observation times; missing request times are labelled unknown.

Authentication, provider rate limiting, ordinary failure backoff and locally observed classifier/read budgets
remain distinct. The existing scheduler's actual `nextDueAt` is reported. A poll still present after its wall-clock
deadline is `deadline_elapsed`; a due poll with spare capacity can be `overdue`. Neither proves a hang: clock
changes, suspension and delayed timer delivery remain explicit uncertainties. Future observed timestamps yield
unknown clock state, not negative ages or a fabricated fresh result.

Slack reads **one history page of one channel per poll**, round-robin. Its nominal cycle is channel count × five
minutes, before shared-slot contention, backoff or suspension. Each channel has its own last page pull/failure,
age, opaque identity and coverage. One fresh channel never makes all channels fresh. A retained continuation is
positive backlog evidence (`hasMore: true`); its absence is not a claim all history or even deferred classification
is complete. A channel older than the nominal cycle is marked nominally overdue, not proved stalled. The latest
source checkpoint can advance with partial channel/classification errors and must not be treated as universal success.

## Bounds, controls and non-goals

New observations are content-free, process-local last-state records, bounded to 256 source observations and 256
explicit due-request observations. Eviction/drop counts are reported. They are cleared when local operational
diagnostics are disabled or explicitly cleared. Restart begins with no live observations, even when product
checkpoints say “ok.” Nothing new is uploaded, and clearing diagnostics does not change refresh scheduling.

Inspection never invokes external polls, manual-sync, sign-in, retries/restarts, classifiers, waiting-chat delivery,
reaction reads/writes, budget reservations or schedule/quota/model changes. It reads only current maps and bounded
existing checkpoint projections. Normal background refreshes can still run independently.

Coverage is not universal background-job health. The previously missing linked mission Linear synchronization,
parent-header poll/prefill reads, manual discovery lookups, Slack Done writes and triage-guide rebuilds now report
bounded observations from their real owners. `hostJobs` holds user-triggered discovery and linked-sync scheduling;
source rows contain applicable project jobs, with installed and event-driven/eligibility labels. Parent-header
stages distinguish requested/cached headers, external attempts and returned headers, without identities or titles.
Linked sync reuses existing fixed failure stage/category/retry metadata, separately from discovery health.

Each job key retains four recent completions, capped at 256 keys with drop counts. No-work checks cannot erase
the last actual write immediately. Read and write RPC counts are separate from local eligibility/reservation,
classification and commit stages. A queued/deferred/running observation is not a command, new durable backlog,
or proof of a scheduler heartbeat. Idle/unobserved is not failure. Full tracking-config hashes fence late results
after replacement/removal. See [job coverage and current quota semantics](agent-diagnostics.md#background-integration-job-health).
