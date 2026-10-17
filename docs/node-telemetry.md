# Node telemetry foundation

Pilot's daemon and kernel workers share a strict OpenTelemetry helper in `packages/telemetry`. It uses W3C
`traceparent` propagation and OTLP/HTTP protobuf without auto-instrumentation. Remote export is disabled by default;
the foundation does not read generic `OTEL_*` exporter settings or add HTTP, exception, host or process attributes.

Only span names, attributes and resource fields in [the telemetry contract](telemetry-contract.md) are accepted.
An unknown field rejects the whole observation before it reaches the SDK. Prompts, responses, tool traffic, paths,
URLs, raw errors and arbitrary labels are not accepted by the helper.

When export is enabled by a later settings layer, each process owns a memory-only queue of at most 512 spans. It
exports batches of at most 128 every five seconds, allows one in-flight OTLP request and gives up before the SDK can
retry. Pilot never waits for export on an operation path. Shutdown may attempt a best-effort flush for one second.
Endpoints must use HTTPS or loopback HTTP and cannot contain userinfo, query parameters or fragments.

## Local in-flight hooks

Completed spans alone cannot explain work that never returns. The helper therefore offers an injectable, local-only
lifecycle hook with `started`, useful `progress`, liveness `heartbeat` and `finished` observations. The hook receives
only the allowlisted span name, service, trace/span IDs and timestamps. It cannot receive operation attributes,
arguments, output or remote tool/server names. Hook failures are ignored and cannot affect the observed work.

The hook deliberately distinguishes a heartbeat from useful progress. A live process may still be nonprogressing,
and age or silence is evidence of a suspected stall rather than proof of deadlock. The bounded persistence,
tool-category mapping and conservative stall policy are implemented by the tool-call reliability slices; this
foundation only supplies correlation and nonblocking lifecycle hooks. It does not restart, retry, replay or change
timeouts.
