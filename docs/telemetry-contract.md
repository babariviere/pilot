# Diagnostics and telemetry contract

**Contract version:** 1

**Status:** implementation baseline

**Transport:** OpenTelemetry Protocol over HTTP with protobuf (`OTLP/HTTP`)

**Backend:** none selected

This document is the compatibility and privacy boundary for Pilot's local diagnostics, performance telemetry and
product-adoption events. A producer must not add a field, span, event or resource attribute merely because an SDK
can encode it. Additions require a contract revision, privacy review and fixtures that reject non-allowlisted data.

Remote export and analytics are disabled by default. Local operational diagnostics remain useful offline. Pilot
does not create a vendor account, deploy a collector, or upload data as part of enabling this foundation.

## Existing sources and ownership

The contract combines existing evidence instead of replacing it:

- Kernel request timings already record bounded, content-free preparation/provider milestones in rotating
  `performance.jsonl` files. See [Local request timings](request-timings.md).
- `pilotd` already exposes bounded event-loop, request and process counters at
  `GET /api/diagnostics/performance`. See [pilotd event-loop stalls](daemon-stalls.md).
- The native app already emits local `os_signpost` streaming intervals. See the
  [performance check](performance-check.md#streaming-benchmark).
- Session state, pause gates, recovery and worker supervision remain authoritative in their current owners.
  Diagnostics observe transitions from those owners and must never derive or drive state.

Conversation history, prompts, responses, reasoning, tool traffic and private compaction reports are explicitly
outside this contract.

## Data classes and controls

The three controls are independent. Turning one on never turns on another.

| Class | Default | Purpose | Storage and deletion |
| --- | --- | --- | --- |
| Local operational diagnostics | On | Explain current and recent lifecycle state on the selected host | Owner-only, bounded files beside session state. Session deletion removes session evidence. A separate clear action removes retained diagnostic files without deleting chats. |
| Remote operational telemetry | Off | Export allowlisted traces and aggregate performance measurements | Memory only before export. Disable/revoke drops queued data and stops new export. No offline disk spool in v1. |
| Product analytics | Off | Export only cataloged feature eligibility, exposure, attempt and outcome events | Memory only before export. Requires both remote export and analytics consent. Disable/revoke drops queued events and rotates the analytics identifier. |

Local collection has no network side effects. Remote export is an explicit per-host setting so enabling a local Mac
does not silently enable a devbox. A remote host reports its own effective settings. A disconnected host is
`unavailable`, never assumed to share the Mac's setting.

### Retention

- Lifecycle files retain at most 256 events and 256 KiB per session, whichever is reached first, with one 256 KiB
  predecessor. Events older than 7 days are omitted during read and compacted opportunistically during a later
  write. Parking does not delete them.
- Existing request-timing files retain their current two 256 KiB segments and 64-line in-memory queue.
- The daemon retains 32 recent stalls and at most 1,024 recent global lifecycle/transport observations in memory.
- Read APIs return at most 128 evidence items and 64 KiB of encoded evidence. They report `truncated`, dropped
  counts, the observation window and freshness. They do not wake a worker to fill a gap.
- Export queues are memory-only. There is no diagnostic or telemetry backup promise. A crash can lose observations.

## Identity and correlation

### Host and subject identity

Local diagnostic APIs use Pilot's full `HostRef` (`hostId`, `daemonId`, `lineageId`) plus the session UUID. These
values are access and routing identifiers, not export attributes. Requests with an unqualified, stale or mismatched
host are rejected rather than falling back to Local.

Remote operational resources may include `pilot.host.id`, a lowercase base64url HMAC-SHA256 of
`daemonId + "\u0000" + lineageId`, truncated to 16 bytes. The key is local to that installation and is not exported.
This makes the value stable enough to compare releases on one installation while preventing a backend from
recovering raw Pilot identity. It must not appear on metrics.

When analytics is enabled, `pilot.analytics.id` is an independently generated random 128-bit value. It is shared by
the app and its local daemon only, never copied to a devbox, and never derived from a machine, account, repository or
session identifier. Revoking analytics deletes and rotates it. There is no cross-installation or cross-device user
identity in v1.

### Trace context

- W3C Trace Context is the only wire format. HTTP uses `traceparent`; v1 neither emits nor accepts baggage or
  arbitrary `tracestate` vendor fields.
- The native app starts user-interaction traces. `pilotd` extracts the parent and injects a compact
  `{ traceparent }` field into daemon-to-kernel IPC. A kernel may start a local root when no valid parent exists.
- Trace IDs may appear in local evidence references and individual spans. Trace, session, request, task, repository,
  PR and host identifiers are forbidden as metric attributes.
- An evidence reference is `diag:v1:<source>:<opaque-id>`. The opaque ID is generated by the evidence owner and has
  no path or content. A reference can be unresolved after rotation; readers report that explicitly.
- Durations use monotonic clocks within a process. Wall timestamps are RFC 3339 UTC with millisecond precision and
  are only for ordering/correlation. Cross-process wall-clock differences must not be subtracted to claim latency.

## Resource schema v1

All exported resources use OpenTelemetry semantic conventions where stable. The complete v1 allowlist is:

| Attribute | Values |
| --- | --- |
| `service.namespace` | `com.babariviere.pilot` |
| `service.name` | `pilot.app`, `pilot.daemon` or `pilot.kernel` |
| `service.version` | Numeric Pilot release, without branch, path or commit message |
| `service.instance.id` | Random process-lifetime UUID. Traces only, never metrics |
| `deployment.environment.name` | `release`, `development` or `test` |
| `os.type` | `darwin` or `linux` |
| `process.runtime.name` | `swift` or `nodejs` |
| `process.runtime.version` | Bounded numeric runtime version |
| `pilot.schema.version` | `1` |
| `pilot.host.kind` | `local` or `devbox` |
| `pilot.host.id` | Operational traces only, as defined above |
| `pilot.analytics.id` | Cataloged analytics spans only |

No hostname, username, hardware serial, IP address, executable path, repository, working directory or environment
variable is a resource attribute.

## Local diagnostic schema v1

Every lifecycle event is a JSON object with only these fields:

```json
{
  "v": 1,
  "id": "opaque-owner-sequence",
  "at": "2026-10-17T08:00:00.000Z",
  "source": "daemon",
  "release": "1.45.1",
  "hostKind": "local",
  "kind": "pause.changed",
  "reason": "quota",
  "state": "paused",
  "traceId": "0123456789abcdef0123456789abcdef",
  "durationMs": 1250,
  "count": 1
}
```

`source` is `app`, `daemon`, `kernel` or `os`. `release` is a numeric Pilot release and `hostKind` is `local` or
`devbox`; the qualified host identity remains in the response envelope rather than every event. `kind`, `reason`
and `state` are closed enums. The first v1 kinds are
`worker.start.requested`, `worker.started`, `worker.start.failed`, `worker.parked`, `worker.recovery.started`,
`worker.recovery.completed`, `worker.recovery.failed`, `pause.changed`, `quota.changed`, `connectivity.changed`,
`execution.started`, `execution.completed`, `request.slow`, `event_loop.stall`, `native.crash` and `native.hang`.
Unknown future values are decoded as
`unknown`, not displayed as raw strings.

Optional numeric fields must be finite and nonnegative. `traceId` is exactly 32 lowercase hexadecimal characters.
No generic attributes map, message, error text or stack is accepted. Reason codes are reviewed enums such as
`user`, `sleep`, `update`, `quota`, `usage_limit`, `connectivity`, `startup_timeout`, `process_exit`,
`recovery_backoff`, `parked_idle` and `unknown`. State values are similarly bounded.

A diagnostic response includes schema version, selected qualified host/session, release, collected/read timestamps,
freshness (`fresh`, `stale`, `unavailable`), source availability, current state, bounded summaries, evidence, dropped
counts and truncation metadata. A source is stale after 30 seconds for live counters or after its owner disconnects.
Historical lifecycle evidence remains historical and is labeled with its observation window, not marked current.

Tool evidence is a separate closed local source. In-flight `tool.in_flight` items contain an opaque ref, closed tool
category, nested flag, `dispatching`/`running`/`cancelling` state, elapsed duration, useful-progress age, liveness age
and optional cancellation-wait age. Completed `tool.call` items add a reviewed outcome and observed
dispatch/execution/cancellation-wait durations. Raw call IDs, tool/server names, arguments, results, commands and
errors are never schema fields. A liveness update is not useful progress, and neither age proves a deadlock.

Agent-facing access is limited to an explicitly admitted diagnostics session role. That runtime profile exposes only
the bounded diagnostic read tool, is bound to one exact chat on its qualified host, and has no shell, source,
transcript, write, restart, retry, replay or child-agent authority. A user-authorized repair handoff selects at most
16 currently available evidence refs and bounded cause/test guidance for a separate ordinary coding agent; creating
the handoff itself performs no target or repair-chat mutation.

## OpenTelemetry signal schema v1

### Spans

Allowed span names are closed and low-cardinality:

- `pilot.message.send`, with child phases `api`, `admission`, `startup_wait`, `preparation`, `provider`,
  `publication` and `first_visible`.
- `pilot.chat.open`, with child phases `api`, `history_read`, `reduction`, `publication` and `first_transcript`.
- `pilot.daemon.request`, `pilot.kernel.request` and `pilot.event_loop.stall` for existing diagnostic seams.
- `pilot.tool.call` and `pilot.tool.cancel_wait` for completed tool execution and observed cancellation wait.
- `pilot.feature` for a cataloged analytics event.

Allowed span attributes are booleans, bounded numbers or enums: `pilot.operation`, `pilot.phase`, `pilot.outcome`,
`pilot.reason`, `pilot.cold`, `pilot.recovered`, `pilot.retry_count` (0...8), `pilot.queue_depth` (0...512),
`pilot.history_bucket` (`0`, `1-100`, `101-1000`, `1001+`), `pilot.progress_kind` (`thinking`, `text`, `tool`,
`none`), `pilot.frame_observation` (`available`, `occluded`, `asleep`, `unsupported`) and cataloged
`pilot.feature.*` fields. Tool spans additionally allow `pilot.tool.category` (`shell`, `filesystem`, `network`,
`background`, `codemode`, `mcp`, `orchestration`, `other`), `pilot.tool.nested` and bounded observed
`pilot.tool.dispatch_ms` / `pilot.tool.execution_ms`. HTTP route is a normalized allowlisted route template, never
a URL.

The initial `pilot.feature.*` allowlist is [feature-adoption catalog v1](feature-adoption.md). Its three feature
names, four stages and closed availability/outcome reasons are part of contract v1; producers cannot add another
feature or field without the change process below.

Exceptions are not recorded through automatic SDK exception helpers. Failures use reviewed outcome/reason enums.
Stack traces, exception messages and raw HTTP status text are forbidden.

### Metrics

V1 metrics are histograms/counters derived from completed allowlisted spans: interaction duration, phase duration,
failure count, dropped telemetry count and feature-event count. Attributes are limited to service name/version,
operation, phase, outcome, reason, cold/warm, progress kind, frame-observation availability and cataloged feature
name/event/outcome. Producers enforce at most 128 distinct attribute sets per instrument per process lifetime;
overflow is folded to `other` and increments a dropped-cardinality counter.

Histograms use milliseconds with explicit buckets `10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000,
60000, 120000`. Release views should report p50, p95 and p99 plus counts and failures. A percentile without a count
and release is not actionable evidence.

## Forbidden data

Serializers and tests must reject, rather than redact after capture:

- prompts, responses, reasoning, conversation titles and transcript rows;
- code, diffs, tool names, arguments, output and job commands;
- filesystem paths, repository/remotes/branches, URLs and query strings;
- provider/model names, headers, cookies, tokens, credentials and environment values;
- Slack, Linear, GitHub or other integration content and identifiers;
- raw error descriptions, localized failure text, stack traces and crash report bodies;
- session, task, PR, repository and raw host identifiers as exported attributes;
- arbitrary maps or caller-supplied attribute names.

Payload limits are applied before serialization. Oversize or invalid observations are dropped without logging the
rejected value.

## Concrete budgets

| Budget | Limit | Overload behavior |
| --- | --- | --- |
| Local lifecycle event | 1 KiB encoded | Drop event |
| Per-session lifecycle writer queue | 64 events plus active write | Drop newest, report `droppedBefore` later |
| Per-session lifecycle storage | 2 x 256 KiB, 256 events visible, 7-day read window | Rotate/compact |
| Per-session tool evidence | 32 active calls, 64 queued writes, 2 x 256 KiB, 64 completed items visible | Drop newest/rotate and report loss |
| Native crash/hang archive | 32 items, 32 KiB, 7-day read window | Drop oldest, report count |
| Diagnostic API | 128 evidence items, 64 KiB encoded | Truncate oldest detail, report counts/window |
| Node spans | 512 queued per process, batches of 128, 5 s schedule, 3 s export timeout | Drop newest; never await from product path |
| Swift spans | 256 queued, batches of 64, 5 s schedule, 3 s export timeout | Drop newest; serial utility queue, never main actor |
| Export retries | At most one SDK attempt per batch; no Pilot retry and no disk spool | Drop batch and count locally |
| Span/event attributes | 24 attributes, names <= 64 bytes, enum values <= 64 bytes | Reject whole observation |
| Span events | 16 per span | Drop excess and count |
| Trace lifetime | 5 minutes | End timed-out trace with reviewed reason |
| Metrics cardinality | 128 attribute sets per instrument/process | Fold to `other` |
| Analytics event rate | 120/hour/installation, burst 20 | Drop excess and count locally |

Telemetry failure must not extend an API response, durable admission, tool execution, UI render or shutdown by more
than the asynchronous enqueue cost. Shutdown may request a best-effort flush for up to 1 second, off the main actor
and daemon request loop, then abandons queued data.

## Initial performance budgets

These are regression thresholds for the approved fixtures, not promises about provider latency:

- Telemetry disabled: no exporter, timer, network request or telemetry queue. Starting an allowlisted disabled span
  adds no more than 5 microseconds p95 in the Node microfixture and 20 microseconds p95 in the Swift microfixture.
- Telemetry enabled with a healthy local faux receiver: no more than 2% median process CPU and 5% p95 interaction
  latency regression across the large-history and 4 updates/s streaming fixtures; less than 5 MiB steady-state RSS
  per process and no main-thread I/O.
- Offline, slow or failing receiver: send/open p95 may not regress by more than 5%, export queue stays within the
  limits above, no durable work waits for export, and process RSS returns to within 5 MiB of its pre-test level after
  queues are dropped.
- Send-message reporting separates app intent, daemon acceptance, admission/startup, kernel preparation, provider
  wait, publication and first visible text. Thinking is not first visible text.
- Open-chat reporting separates API/transport, cold history read, reduction, publication and first transcript.
  Occluded/asleep/unsupported frame measurements are `unavailable`, never zero.

Measurements compare at least five alternating disabled/enabled runs on the same build and machine, report median
and p95 with counts, and disclose system load, display/occlusion state and release. Exceeding a budget blocks the
instrumentation change or requires an explicit contract revision with evidence.

## Export topology and credentials

Each process exports OTLP/HTTP protobuf to a user-configured collector endpoint. The recommended topology is a
collector on the same host (`127.0.0.1`), with backend authentication held by that collector. Pilot rejects URL
userinfo, arbitrary header configuration and cleartext non-loopback HTTP. Distributed app binaries never contain a
privileged backend key. A direct HTTPS endpoint is allowed only after explicit per-host opt-in and must use a
revocable, ingestion-only credential supplied by a future trusted credential broker; v1 does not persist one in a
plain settings file.

The app, daemon and each kernel export independently so a devbox does not relay telemetry through the Mac and a
stalled daemon cannot block native export. Propagated trace context provides correlation. V1 producers sample 100%
of allowlisted traces so a failure discovered at the end of an interaction is not discarded by an earlier head
decision; the bounded queues shed overload. Collectors may tail-sample successful traces after ingestion, retaining
failures and lifecycle anomalies, and analytics has a separate rate cap. Local diagnostics are unsampled.

## SDK and packaging feasibility

The evaluated baseline is compatible with Pilot's Node 24 and macOS 14 minimums:

- **Node:** `@opentelemetry/api` 1.9.1, `@opentelemetry/sdk-trace-node` 2.12.0,
  `@opentelemetry/resources` 2.12.0 and `@opentelemetry/exporter-trace-otlp-proto` 0.223.0 support Node 24. The SDK
  exposes W3C propagation, `BatchSpanProcessor`, injectable exporters and OTLP/HTTP. Pilot should install only the
  trace/resource packages it uses rather than the broad auto-instrumentation bundle.
- **Swift:** `open-telemetry/opentelemetry-swift` 2.6.0 and `opentelemetry-swift-core` 2.6.0 use Swift tools 6.0,
  support macOS 12+, and provide `OpenTelemetryApi`, `OpenTelemetrySdk` and
  `OpenTelemetryProtocolExporterHTTP`. That fits Pilot's Swift tools 6.2 and macOS 14 floor. Pin exact package
  versions and verify the resolved lockfile and release bundle in CI.
- **Protocol:** OTLP/HTTP protobuf avoids Swift gRPC/NIO runtime requirements on the app path and is supported by
  standard collectors and the Node exporter. A faux local HTTP receiver can verify headers, protobuf signal type,
  bounds and failure behavior without external accounts or uploads.

Swift's package is split between API/core and exporters and has a larger dependency graph than the Node trace-only
set. Packaging checks must confirm license inclusion, app size and relocation. Neither SDK's defaults are the
contract: Pilot supplies the smaller queues/timeouts above, explicit resources and allowlisted helpers, and disables
automatic HTTP, exception, environment, host and process instrumentation.

## Change process

1. Increment the contract version for any new data shape, identity behavior, signal, event catalog or retention
   change. Additive enum values still require review.
2. Update shared TypeScript and PilotCore mirrors before a producer emits the new version.
3. Add privacy fixtures that attempt every forbidden category and inspect the encoded OTLP payload at a faux sink.
4. Document migrations. Readers may support the previous version, but producers emit only the current version.
5. Keep backend selection, hosted deployment, vendor accounts, real-user uploads and privileged credentials outside
   code changes unless separately authorized.
