# Local request timings

Pilot records one small JSON line when each kernel model stream completes, fails or is aborted.
These diagnostics answer whether a slow tool follow-up is local preparation, provider setup/waiting,
or response generation. They do not change prompts, tool behavior, retries or durable admissions.
Failed preparation hooks also get a summary with no provider phase. Harness may treat that hook failure
as nonfatal and continue with its original request, producing a separate `stream` summary.

## Location, privacy and limits

- Enabled by default for Pilot kernels, including Ask. Standalone `NativeAdapter` callers opt in by
  supplying a performance sink. Set `PILOT_PERF_TIMINGS=0` in the daemon's environment before opening
  workers to disable future recording. This does not delete previously recorded files.
- Stored beside the session database:
  `~/.local/share/pilot/sessions/<session-id>/durable/performance.jsonl`, with one `.1` predecessor.
- Both segments are capped at 256 KiB and use owner-only permissions (`0600`). The worker's existing
  storage lease owns the single writer. Symlinks are not followed. Session deletion removes these files
  with its durable directory; parking does not delete them.
- Only finite nonnegative numbers and fixed version/source/outcome values are serialized. No prompts,
  responses, reasoning text, tool names/arguments/output, model/provider names, URLs, headers,
  credentials, error messages or stacks are accepted by the log serializer.
- Nothing is exported or sent over the network, daemon IPC, client API or model transcript.
- One asynchronous writer retains at most 64 queued lines, plus its current line, each capped at
  2 KiB. Overload drops records instead of holding up the model. `droppedBefore` on a later accepted
  record counts dropped lines. I/O failure disables that sink until the worker is reopened.
- Shutdown flushes pending writes. This is best-effort diagnostic data, not a durable audit log.
  Crashes can lose pending records, and unfinished streams do not yet have a summary.

## Reading a record

`v` is the schema version, `request` is a worker-local sequence number (resets on reopen), and `at`
is the Unix-millisecond time preparation began. Durations use a monotonic clock, not wall-clock
subtraction. `source` is `generation` for a Harness generation request, or `stream` for an independent
stream such as compaction. `outcome` is `completed`, `error` or `aborted`, not a chat outcome.

| Field | Meaning |
| --- | --- |
| `toolToPreparationMs` | Last native tool execution finishing to the next native prompt section beginning. Includes result hooks, persistence and scheduling. Absent without a live tool baseline, including after recovery or idle. |
| `preparationMs` | Native prompt preparation through the adapter handing off to the model registry. Includes section rendering, request hooks, native history synchronization and intervening Harness work. On recovery without section rendering, starts at the request hook. |
| `providerMs` | Registry handoff to stream completion. Includes SDK authentication/setup, request hooks, transport waits, retries, streaming and extension callbacks, not just remote AI compute. |
| `totalMs` | Preparation start to stream completion, before Harness response hooks and final persistence. Equals `preparationMs + providerMs` apart from rounding. |

The following milestones are milliseconds **since registry handoff**, not separate durations:

| Field | Meaning |
| --- | --- |
| `payloadReadyMs` | Provider payload hooks finished, before transport serialization/send. |
| `httpDispatchMs` | First call to the provider's injectable fetch; `httpAttempts` counts such calls. Does not inspect URLs, bodies or headers. |
| `responseHeadersMs` | First SDK response-header callback, before extension handlers run. |
| `firstProviderEventMs` | First parsed raw provider event, before extension handlers run. It may be metadata, not content. |
| `firstContentMs` | First nonempty normalized text, thinking or tool-call delta. Stream-start/block-start events do not count. |
| `firstThinkingMs`, `firstTextMs`, `firstToolCallMs` | First nonempty delta of each content type. Useful when reasoning precedes visible text. |

For example, high `preparationMs` suggests local history/prompt work. For injectable HTTP,
`httpDispatchMs` separates provider setup from the wait after sending; compare it with the first
header/event/content milestone. A large gap from `firstThinkingMs` to `firstTextMs` means the SDK
delivered reasoning before visible answer text, without recording the reasoning itself.

Missing milestones mean **not observed**, never zero. WebSocket sends do not use injectable fetch.
Google APIs reject custom fetch; virtual routers may select those APIs, so their fetch is not wrapped.
Their exact transport dispatch cannot be measured here. SDK callbacks, when supported, still work.
No private SDK internals or transport monkey-patches are used to guess a send time. Internal provider
retries share one summary, retain the first milestones and count observed HTTP attempts. Deferred
polling uses the SDK's separate polling path and is outside this stream instrumentation.

## Offline checks and overhead fixture

```sh
node --test --test-force-exit --test-concurrency=2 \
  packages/kernel/src/performance.test.ts packages/kernel/src/model.integration.test.ts
node --expose-gc scripts/bench/request-timings.ts 5
```

The fixture takes the sample count as its optional argument (five per variant by default), alternates
disabled/enabled recording over 100 and 1,000 history entries (about 1 KiB
each), one native tool call and a roughly 19 KiB streamed answer in small chunks. It uses disposable
storage, a faux model, in-memory credentials and no user extensions or network. Reports include wall
time (both turn latency and elapsed including log flush), process CPU, event-loop p99, RSS, record count
and log bytes. This compares the feature off/on,
not the installed app or an older binary. Host contention and JIT warmup can overwhelm tiny overhead;
repeat on a quiet machine before claiming a latency improvement or production overhead budget.

A 2026-10-14 macOS smoke run after the full suite, with host load still around 31 on 11 cores:

| 1,000-entry fixture | Recording disabled | Recording enabled |
| --- | --- | --- |
| Turn latency, two runs | 192–198 ms | 118–194 ms |
| CPU including flush | 127–136 ms | 129–158 ms |
| Event-loop p99 | 203–208 ms | 135–206 ms |
| Process RSS | 291–292 MiB | 292 MiB |
| Timing summaries | 0 | 2, totaling 474–476 bytes |

Enabled runs needed an additional 11–21 ms to drain the asynchronous log after the turn was idle.
The previous sample during the full suite had much noisier latency. These smoke checks demonstrate
bounded output and successful streaming/tool handoff, not a speedup or a reliable production overhead
budget. No GUI, live-provider or precise WebSocket-send performance has been verified.
