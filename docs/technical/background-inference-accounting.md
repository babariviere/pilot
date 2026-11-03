# Separate background inference

The [usage-history contract](usage-history-contract.md) applies to the daemon's separate completions as well as
agent requests. This is local accounting, not telemetry, billing, routing, or an inference retry mechanism.

## Inventory

Production TypeScript direct-call inventory against main `f9b1a0f1` (after PR923/924), excluding test and benchmark
fixtures. Searching only for titles or Slack would miss the isolated triage worker and model compaction loops.

| Path | Purpose | Trustworthy attribution | Existing behavior retained |
| --- | --- | --- | --- |
| `models.ts` → `generateChatTitle` | `title` | Session/project UUIDs from SessionManager; canonical mission tuple only through the optional trusted membership bridge | Cheapest authenticated scoped title model, no thinking, 128 output tokens, no provider retries |
| `models.ts` → `compactMemory` | `memory` | Project UUID supplied by ProjectMemoryService | Explicit authenticated Codex Luna, three validated submission attempts, no provider retries |
| `models.ts` → `compactControlNode` | `compaction` | Host background only. A node/job or current Control chat does not prove which chat owns its source | Same-provider scoped cheapest model, up to six correction calls, existing two provider retries and deadline |
| `models.ts` Slack classifier (poller and manual add) | `classification` | Project UUID from the source context | Scoped Codex Luna, no thinking/tools, 256 output tokens, no provider retries |
| `triage-model-worker.ts` → `models.ts.completeTriage` | `triage` | Project UUID explicitly passed by grooming and Linear sizing callers | Cheapest authenticated scoped model, 8192 output tokens, no provider retries, existing worker/deadline/cancellation policy |

The triage worker is shared by Slack/Linear correction grooming and Linear size classification. Neither a Slack
thread nor a Linear item is a chat/mission identity. Except for the title membership bridge, these call sites have no mission tuple with sufficient
provenance to attach one. No identity is extracted from prompts, model output, paths, titles or job source text.

Other direct production model calls are the ordinary native adapter `stream`/`streamSimple` seam, its `complete`/
`completeSimple` delegates, the child-profile wrappers, and the kernel's model-backed conversation compaction in
`session.ts`. They remain kernel-owned and are **not** wrapped here. Deterministic compaction makes no inference.
The repository has no other direct SDK completion or raw HTTP completion-client calls in first-party production
TypeScript. Dynamically loaded pi extensions are not a claim of complete host/account coverage.

## Capture and reconciliation

`BackgroundUsage` decorates only the separate completion runtimes. It strips the normalized assistant response
synchronously before any caller parses JSON, validates a summary, checks a post-response cancellation, saves
diagnostics or applies output. Errors and aborted responses can retain observed tokens and catalog cost. A later
consumer failure does not erase those observations and does not relabel a successful provider response as a
provider failure. Thrown calls without normalized evidence remain unpriced and partial, not proof of zero spend.

Each completion invocation, including each correction-loop call, gets an opaque source UUID before dispatch.
The source-owned operation/revision is durable before publication; replay reuses it. The daemon owns one
content-free outbox in `accounting/background-pending`, at most 32 records of at most 4 KiB, mode 0600 in a mode
0700 directory. It retains no prompts, completion blocks, diagnostics, error strings, payloads, headers or
credentials. There is no content export or telemetry path. Model provenance comes from normalized response
identifiers, never the chat's current selection. Missing/zero placeholder catalog costs remain unavailable.

Before dispatch the outbox holds an unknown partial operation without token/cost evidence or a completion date. A response replaces
that source record before the final dated request is published to the host store. Recovery reads at most 64
directory entries (including atomic-write remnants), replays the same final record, and deletes acknowledged
evidence. A crash-lost response instead becomes an undated partial reconciliation checkpoint, not a dated charge
or grounds to rerun inference. Source recovery never scans diagnostics or transcripts. Erasure drains stale
source writes and purges old-generation records before acknowledging; a late completion cannot transplant its
evidence into the new generation. Retention/capture floors also fence source replay.

The existing UsageDoc/`ai-usage.json` totals and memory diagnostic response copies are **not** additional requests.
They are never reimported by this adapter. The host store's existing legacy import remains a separate checkpoint
view. Consumers must not add checkpoints to request totals. No kernel request is counted again here.

HTTP response callbacks retain at most 100 observed responses/retries as numeric counters, then leave those
counters unknown. They do not claim visibility of transport retries that produced no callback or usage from a
lost provider response. Corrections retain separate request identities, not copied prompt/response histories.
The store and outbox have bounded admission; accounting I/O waits at most one second at admission/publication,
then inference continues unchanged. Late I/O retains only allowlisted numeric evidence. No accounting failure
retries, stops, switches or reroutes model work. Capacity/fault omissions keep coverage explicitly partial.

## Verification boundary

`background-usage.test.ts` uses faux providers and fresh private homes to cover success, errors, malformed output,
correction retries, cancellations, diagnostic/application failure, worker acknowledgement races, source replay
before/after uncertain publication, and erasure fencing. Existing model/source/compaction suites cover unchanged
selection and scheduling. These are correctness checks, not paid-provider, on-screen performance, or full-daemon
memory-gate evidence. Full suites and packaging remain remote CI gates.
