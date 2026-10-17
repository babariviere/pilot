# Tool-call diagnostics

Pilot records bounded, content-free lifecycle evidence for model-issued tools and calls made by other tools through
Pi's nested tool API. This includes built-ins, MCP tools and calls made inside `codemode`. The observer uses Pi's
public execution events, so an outer `codemode` duration does not hide an unfinished nested call.

## What is observed

An in-flight item has a stable opaque evidence ref, a closed category, whether it is nested, and one of
`dispatching`, `running` or `cancelling`. It reports elapsed time, age since useful progress, age since the last
kernel liveness observation and, after cancellation is requested, cancellation-wait age. Dispatch time includes
validation, extension admission and the nested sequential queue where Pi exposes that boundary. Execution time is
reported only when Pi supplies it. Missing phase timing stays unavailable rather than being inferred.

Completed calls retain `success`, `failure`, `timeout`, `cancelled` or `interrupted`, total duration and observed
dispatch/execution/cancellation-wait durations. An orderly shutdown closes unfinished calls as interrupted. After an
unexpected worker exit, a persisted start without a finish is projected as interrupted once no live observer owns
it. Disabled collection never turns a still-running call into a guessed interruption.

Liveness is not useful progress. A promise can remain live while making no progress, and a healthy silent tool can
run for a long time. This slice exposes the two clocks without declaring a stall, deadlock or root cause. Suspected
stall thresholds and native presentation are documented separately when enabled. Pilot does not automatically
timeout, retry, restart or replay a tool because it may already have caused external effects.

## Privacy and bounds

Raw tool-call IDs, names, MCP server names, arguments, results, commands and errors do not cross the observer. A
closed mapping emits only `shell`, `filesystem`, `network`, `background`, `codemode`, `mcp`, `orchestration` or
`other`. At most 32 active calls are projected. The private writer queues at most 64 records and rotates two
256-KiB files beside the session's other local diagnostics. Progress publication is coalesced to 250 ms, persisted
progress is limited to once per five seconds and liveness snapshots occur every 15 seconds only while calls exist.

The diagnostics specialist sees tool evidence through the existing host-qualified, target-bound read-only snapshot.
Reading it does not open transcript storage or wake the target. Turning off local diagnostics stops new records;
**Clear local diagnostics** removes both tool files along with the other local evidence. Remote operational export
remains separately opt-in and emits only completed `pilot.tool.call` and `pilot.tool.cancel_wait` spans with the
closed category, nested flag, reviewed outcome and bounded durations. There is no disk telemetry spool.
