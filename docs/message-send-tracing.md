# Message send tracing

`pilot.message.send` follows an idle composer send from the native intent through the first response row published by
SwiftUI. Every process continues W3C `traceparent`; trace context is kept in memory and is never added to transcript,
session metadata or metric labels.

The trace contains allowlisted phase spans:

1. The app root and `api` child begin before the HTTP request.
2. pilotd records API parsing, durable `admission`, and any `startup_wait`. Durable admission semantics are unchanged;
   a cold worker can continue after the API acknowledgement.
3. The kernel records IPC admission, local `preparation`, and the observable `provider` interval. The provider phase
   reports only `thinking`, `text`, `tool` or `none`, plus a capped retry count. It never records model/provider names,
   request bodies, response text, URLs, headers or errors.
4. The app records `publication` and `first_visible` when the frame-paced transcript model first publishes a new
   thinking, text, tool or failure row. The current seam cannot prove Core Animation display, so
   `pilot.frame_observation=unsupported` is explicit rather than inferred.

Queued or steering sends are admitted and traced through the phases that can be attributed safely, then end as
`unavailable/waiting` instead of attaching a later response speculatively. A worker/daemon restart can similarly lose
the ephemeral parent and produce a missing phase. Missing spans mean “not observed”, not zero latency or success.

Provider preparation uses monotonic durations and maps them onto bounded span timestamps. `retry_count` is 0 through
8 and counts observed transport retries after the first attempt. A first thinking delta remains `thinking` even when
visible text follows later. Failures use reviewed outcome/reason codes only. Sleep ends active native interactions as
unavailable; it is not counted as active response latency.
