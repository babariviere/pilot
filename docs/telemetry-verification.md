# Telemetry and diagnostics verification

This is the final offline verification map for the diagnostics and telemetry stack. It does not enable uploads,
select a backend, contact a provider, inspect transcripts or grant recovery authority. GitHub CI runs the exact PR
head on macOS and Linux; local checks deliberately use faux providers, in-memory exporters and loopback receivers.

## Privacy and consent

| Boundary | Verification |
| --- | --- |
| OTLP schema | `packages/telemetry/src/index.test.ts` rejects prompts, responses, paths, chat URLs, raw host identity, errors, provider/model names and raw tool names, then inspects the accepted exporter payload. |
| Native schema | `PilotTelemetryTests`, `NativeDiagnosticsTests` and `TelemetrySettingsTests` cover closed enums, separate analytics identity/consent, unsafe endpoint rejection, private host settings and revocation. |
| Diagnostic read | `session-diagnostics.test.ts`, `control-diagnostics.test.ts` and `diagnostics-role.integration.test.ts` cover bounded projections, stale/missing evidence, direct/nested role denial and no transcript, path, wake or mutation access. |
| Devbox setup | `NativeDiagnosticsTests` and `DevboxSettingsInteractionTests` reject aliases, raw stderr and unknown reasons while retaining pre-registration stage evidence separately from remote connection state. |
| Clipboard | `SessionClipboardActionsTests` keeps the authoritative session root in the user-invoked clipboard action only. Missing path metadata does not disable a canonical host-aware chat link; neither value enters diagnostic or OTLP schemas. |

Remote operational reporting and product analytics remain off by default and separately consented. Tests use no
real collector, account, credential, user upload or privileged key.

## Bounds and failure isolation

The contract limits Node queues to 512 spans and native queues to 256, with fixed batches, one bounded attempt and
no disk spool. `packages/telemetry/src/index.test.ts` and `PilotTelemetryTests` cover queue shedding, blocking,
failing and throwing exporters, immediate revocation, no exporter work while disabled and bounded shutdown. The
operation path only ends an in-memory span; it never awaits export. AI accounting tests cap the aggregate file at
128 KiB, deduplicate recovery and child observations, roll old attempts into totals and preserve unavailable pricing,
billed-spend and subscription states rather than converting them to zero.

Tool-stall fixtures distinguish useful progress from liveness and suppress expected user waits, background jobs,
sleep, update, quota and connectivity pauses. Cancellation delay remains evidence, not proof of deadlock, and grants
no retry, replay, restart or timeout-changing action. Diagnostics repair fixtures similarly require one persisted,
evidence-bound specialist proposal and explicit confirmation before one separate ordinary Build chat can be created.

## Offline overhead checks

Run the real Node telemetry helper without network access:

```sh
node --expose-gc scripts/bench/telemetry.ts 5
```

The fixture alternates disabled, healthy in-memory and failing in-memory exporters. Each sample creates 10,000
allowlisted spans, flushes bounded batches and reports wall/CPU time, median and p95 enqueue cost, RSS delta, exported
count and queue/drop/failure counters. It is a helper microfixture, not application latency.

One local run on 2026-10-18 used Node 24.21.0 on macOS arm64, with ten alternating samples per mode:

| Mode | Median wall for 10,000 spans | Median CPU | Median sample p95/span | Median post-GC RSS delta |
| --- | ---: | ---: | ---: | ---: |
| Disabled | 0.2 ms | 0.3 ms | 0.02 µs | 0 MiB |
| Healthy in-memory exporter | 21.3 ms | 41.3 ms | 3.58 µs | 0 MiB |
| Failing in-memory exporter | 21.4 ms | 39.7 ms | 3.24 µs | 0 MiB |

Every healthy sample exported all 10,000 records. Every failing sample dropped the failed batches with an empty final
queue. The first enabled sample allocated SDK working memory, so the table reports the median post-GC delta rather
than hiding warm-up in a steady-state claim. This establishes disabled-path and sink-failure behavior; it does not by
itself establish the application-level 2% CPU budget.

For large retained histories and streamed tool turns, run:

```sh
node --expose-gc scripts/bench/request-timings.ts 5
node packages/kernel/src/bundled-extensions.bench.ts 5
```

The first alternates diagnostics off/on over 100 and 1,000 1-KiB history entries and a streamed tool turn. The
second uses 10,000 messages and a 65,536-character faux streamed answer. Existing methodology and limitations are
recorded in [Request timings](request-timings.md) and [Testing](testing.md). Native interaction performance stays in
GitHub's macOS tests (`CorePerformanceRegressionTests`, `ChatOpenTelemetryTests`,
`NativePerformanceCachingTests` and `HostAggregationPerformanceTests`); screen-off frame data is unavailable rather
than reported as zero.

The same local host produced these five-sample medians for the request-timing fixture after its file-backed-only
capability profile was excluded from the in-memory benchmark:

| History | Recording | Turn | Turn + log flush | CPU | Event-loop p99 | RSS |
| ---: | --- | ---: | ---: | ---: | ---: | ---: |
| 100 | Off | 9 ms | 9 ms | 12 ms | 20.0 ms | 453 MiB |
| 100 | On | 9 ms | 10 ms | 15 ms | 19.5 ms | 454 MiB |
| 1,000 | Off | 39 ms | 39 ms | 62 ms | 48.8 ms | 467 MiB |
| 1,000 | On | 40 ms | 41 ms | 57 ms | 50.2 ms | 467 MiB |

Enabled samples wrote exactly two summaries (468–474 bytes). The product turn stayed within the 5% interaction
budget in this sample; the additional log flush is asynchronous and outside the turn. Whole-process RSS includes the
SDK and fixture and is not isolated telemetry memory. One-millisecond wall-time rounding and host noise make these
smoke measurements unsuitable for claiming an improvement.

The 10,000-message/65,536-character fixture used one warm-up pair followed by five alternating samples. Baseline
startup was 8.78 ms versus 42.86 ms for the full bundled capability profile; streamed turn latency was 110.79 ms
versus 111.18 ms, process CPU 142.53 ms versus 145.11 ms, and whole-process RSS 563.99 MiB versus 568.84 MiB. The
streaming deltas in this sample were about 0.4% wall, 1.8% CPU and 4.85 MiB RSS. The startup cost is real and tracked
separately; this broader profile fixture cannot attribute that cost to telemetry or diagnostics alone.

Measurements are host-sensitive. Compare at least five alternating samples on one quiet exact build, retain raw
JSON, and report medians/p95 plus Node version, OS/architecture and display state. A noisy local result is not a
budget waiver. An exact-head regression in Node, macOS, Linux headless or package verification blocks the stack.

## Focused commands

```sh
node --import tsx --test packages/telemetry/src/index.test.ts
node --import tsx --test packages/daemon/src/telemetry-settings.test.ts packages/daemon/src/server-telemetry.test.ts
node --import tsx --test packages/daemon/src/ai-usage.test.ts packages/daemon/src/tool-stalls.test.ts
node --import tsx --test packages/daemon/src/native-diagnostics.test.ts packages/daemon/src/session-diagnostics.test.ts
node --import tsx --test packages/kernel/src/usage.integration.test.ts packages/kernel/src/diagnostics-role.integration.test.ts
pnpm typecheck
```

Swift tests, app bundling, Linux runtime packaging and the complete Node lanes run in GitHub CI. No local Swift
build or installed-app result is accepted as exact-head evidence.
