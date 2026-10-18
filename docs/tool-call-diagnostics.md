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
run for a long time. Pilot labels a call **suspected**, never deadlocked or causally diagnosed, using these
conservative thresholds:

| Evidence | Threshold |
| --- | ---: |
| Cancellation requested but the call has not finished | 30 seconds |
| Kernel liveness observation has stopped | 60 seconds |
| Filesystem call with no useful progress | 5 minutes |
| Network or MCP call with no useful progress | 10 minutes |
| Shell, codemode, orchestration or unknown call with no useful progress | 15 minutes |
| Unclassified background call with no useful progress | 60 minutes |

Explicit user waits, child-agent waits, known background jobs, sleep, update, quota, connectivity and user stops are
shown as those states instead of no-progress stalls. They can still become **suspected unresponsive** if kernel
liveness itself stops. A single daemon watchdog tracks the nearest deadline across sessions; 15-second kernel
heartbeats move that deadline without per-call polling. A suspected call appears as live **Needs you** attention and
as labeled bounded evidence in the Diagnose repair sheet. Completion, new useful progress or disabling collection
clears the live attention.

Pilot does not automatically timeout, retry, restart or replay a tool because it may already have caused external
effects. A manual stop or restart records what was interrupted but never claims that no external effect occurred.

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
