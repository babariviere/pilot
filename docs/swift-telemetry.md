# Swift telemetry foundation

The macOS app owns a trace-only `PilotTelemetry` module built on exact 2.6.0 pins of
`opentelemetry-swift-core` and `opentelemetry-swift`. It uses OTLP/HTTP protobuf and W3C `traceparent`; it never
propagates baggage or `tracestate`. Pilot API requests inherit the current task-local trace context so later
interaction spans can correlate native, daemon and kernel work without putting content or identifiers in headers.

Remote export is disabled by default. In that state no SDK provider, exporter, worker, timer or queue exists. When
explicitly configured, the module accepts only span, resource and attribute enums from the
[telemetry contract](telemetry-contract.md), samples those reviewed spans, and keeps at most 256 spans in memory.
The native app follows the verified local daemon's [host-scoped telemetry controls](telemetry-settings.md); it never
inherits a devbox setting.
It exports batches of at most 64 every five seconds on the SDK's serial background worker, with a three-second
attempt timeout and no Pilot retry or disk spool. Export and shutdown never run on the main actor; shutdown waits at
most one second before allowing the export worker to finish independently.

The endpoint validator permits HTTPS or literal loopback HTTP and rejects userinfo, query parameters and fragments.
No arbitrary headers or generic OpenTelemetry environment variables enter configuration. Resources contain only
the reviewed service, release, runtime, environment, schema and host-kind fields. Optional host correlation accepts
only an already HMAC-derived identifier.

System sleep ends active interaction spans as unavailable before wall-clock suspension can look like active work,
and new spans remain disabled until wake. Frame observations distinguish available, occluded, asleep and unsupported
measurements; callers never turn the latter three into zero latency. Metrics are derived from completed allowlisted
spans rather than a second native instrumentation path.

The release bundle carries the upstream Apache-2.0 license and NOTICE files. CI remains responsible for verifying
the resolved dependency lockfile, packaged resources, relocation and size.
