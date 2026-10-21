# Usage-store allocation verification

Offscreen, synthetic local measurements on macOS arm64 / Node 24.21.0, 2026-10-21.
This is scoped storage verification, not a dashboard rollout pass. The **+16 MiB peak RSS gate is unchanged and
still fails**. No credentials, real sessions, providers, native windows, deployments or merges were used.

## Fixture correction

The initial +51.34 MiB observation had two confounders: seeding in a worker of the measured process left allocator
state behind, and inherited `NODE_OPTIONS` loaded the agent credential preload/SDK in measured descendants.
Fresh-process runs retaining that preload cost about +89 MiB even at idle. That is **not** an intrinsic store
minimum and must not be presented as a daemon measurement. A first derived-JavaScript control inherited the same
preload and was invalid for isolating the TypeScript loader.

`packages/daemon/src/usage-history.bench.ts` now seeds in a separate process and samples each case in a fresh child.
Fixture children receive only PATH/TMPDIR/SYSTEMROOT, disposable HOME and PI_OFFLINE, following the existing offline
probe convention. No daemon/kernel environment, credential hook, credential policy or worker dispatch was changed.
The measured leaf store imports only Node built-ins and its own validation code, not the model SDK.

The harness records process RSS every 5ms, main and worker heaps at stage boundaries, worker external memory,
startup latency, per-page latency, CPU and event-loop delay. Each standard workload has three batches of 500
operations over a 50,000-row database. Query pages contain 100 records; `serialized_queries` additionally encodes
each response as JSON. Inputs/outputs are synthetic and content-free. Natural peaks are recorded **before** an
optional main-only forced GC. Forced-GC/closed snapshots are diagnostic, never substituted for the peak gate.

## Practical fixes

- Cache at most 16 **fixed SQL** statements, rather than repeatedly preparing identical SQL and leaving native
  allocations to later V8 finalization. All values remain bound parameters. Close releases the cache.
- Share validation allowlists and avoid serializing each stored row again solely to recheck its byte size.
  SQL bounds corrupt payloads before materialization; the stored-row reader independently checks UTF-8 bytes
  before parsing and retains all numeric/provenance/unknown-field checks. Write canonicalization stays unchanged.
- Allocate one shutdown drain only when closing, rather than an extra settled promise and its closures on every
  RPC. Faults, rejected message cloning and shutdown still release all waiters.

No row/page/queue/storage/privacy limit was increased. No query-result cache or history scan was added.

## Serial paired results

Three alternating before/after pairs, baseline `09287819` versus the fixes above, using identical corrected
harnesses. Values are medians of three fresh-process samples, MiB above each sample's pre-worker baseline.

| Case | Before peak | After peak | Interpretation |
| --- | ---: | ---: | --- |
| No worker | 0.06 | 0.08 | Fixture drift |
| Bare Node worker | 11.33 | 11.33 | Runtime/isolate baseline |
| Empty store, idle | 30.13 | 31.91 | Fails 16 MiB **without any history/query workload** |
| 50k rows, idle | 30.34 | 30.17 | No proportional in-memory history hydration |
| 1,500 indexed pages | 50.92 | 50.67 | No convincing RSS improvement |
| 1,500 pages + response JSON | 58.42 | 60.86 | No query-memory win; slight regression/variation |
| 1,500 revision writes | 45.44 | 38.03 | Avoidable write allocation reduced |

Write peaks were 42.75–47.78 MiB before and 37.36–39.08 MiB after. Median write workload CPU fell from 1,577ms
to 1,275ms. Query-only CPU fell from 1,847ms to 1,413ms; serialized-query CPU from 1,840ms to 1,636ms. These short
samples under ambient machine load are not a broad speedup or smoothness claim. Query-only median p95 was
2.43ms → 1.53ms; serialized-response p95 was 1.98ms → 2.20ms. Largest response stayed 50,777 bytes. The reported
page timing excludes the extra response JSON encoding. All remain within the 50ms/512KiB page budgets.

The updated empty-store natural peaks ranged 30.47–32.13 MiB. Its worker used about 9.8 MiB heap and 9.9 MiB
external memory, before any request rows. A diagnostic copy of the same source graph stripped to `.mjs` outside
the repository, with the corrected fixture environment, reduced idle peaks to medians 17.53 MiB (empty) and
16.92 MiB (50k rows). That control is **not shipped code** or an approved architecture change. It supports a
TypeScript/bootstrap component but still does not establish a production path meeting 16 MiB.

A 4 MiB worker nursery experiment did not materially improve the serialized-page peak (two-sample median
57.88 MiB versus the standard ~61 MiB, with similar write/idle peaks). It was not adopted. An inherited warm
compile-cache experiment under the contaminated fixture did not resolve startup; no compile-cache or environment
change was made to production based on it.

The longer corrected probe ran **6,000 serialized pages per sample**, six batches of 1,000, three fresh samples.
Peaks were 79.77–80.30 MiB (median 79.98). Median RSS at the six boundaries was approximately 49.8, 63.8, 71.8,
79.4, 79.9 and 79.9 MiB. Worker heap rose to about 39 MiB then fell to 15–18 MiB with natural GC while process
RSS retained its high-water allocation; main-only GC did not materially lower RSS. This distinguishes allocation
high water from a claim of proportional live-row retention, but is not a proof that longer workloads cannot grow.
Per-sample p95 page latency was 1.07–1.69ms, with 50,777-byte responses. These larger sustained peaks also fail
the unchanged gate; the short 1,500-page result must not be used as a memory bound.

## Reproduction

```sh
python3 scripts/verification-slot.py node -- node packages/daemon/src/usage-history.bench.ts
# Longer bounded sustained-query check, still disposable and offline:
USAGE_BENCH_CASES=serialized_queries USAGE_BENCH_BATCHES=6 USAGE_BENCH_BATCH_SIZE=1000 \
  python3 scripts/verification-slot.py node -- node packages/daemon/src/usage-history.bench.ts
```

`USAGE_BENCH_TRIALS` defaults to 3, capped at 5. Cases are `none`, `bare`, `empty`, `populated`, `queries`,
`serialized_queries`, `writes`. Batches are capped at 10, batch size at 2,000 and total operations at 10,000.
For before/after comparison, freeze the four store modules (`usage-history.ts`, `usage-history-disk.ts`,
`usage-history-validation.ts`, `usage-history-worker.ts`) from the baseline and current revision in separate
temporary directories. Copy the **same current benchmark file** to both. Run them serially in alternating order
under one verification slot. Never edit either frozen graph during a run. The probe creates and removes its own
seed/working databases; it does not open the application's data directory.

## Remaining gate

The current dedicated source-mode Node/SQLite worker exceeds +16 MiB at idle on this runtime. Practical allocation
fixes reduce write growth but do not make that gate compatible with this measured implementation, nor prove a
universal lower bound for every possible architecture. Meeting it requires a reviewed execution/packaging change
or an explicitly reviewed, evidence-backed budget change. Neither is silently included here.

The proposed gate must remain open. Full installed-daemon/capture overhead, repeated live-host baselines,
native DTO execution, full CI/packaging, longer retention workloads and default dashboard rollout remain separate
release evidence. Dependency tasks are not marked done and no release gate is waived by this document.
