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

## Shipped-execution follow-up, 2026-10-21

Continued from merged `f9b1a0f1`, not the initial confounded measurement. Both release packagers copy `.ts`
sources unchanged; the launch agent invokes bundled Node directly. The accounting worker has only built-in/local
runtime imports. There is no production JS bundle that removes its TypeScript parser cost.

The [paired probe and raw evidence](benchmarks/usage-worker-2026-10-21/README.md) copy the installed shipped Node
24.21.0 executable and freeze the exact source graph into release-shaped disposable directories. They preserve
binary/source hashes and use separate-process seeding and the credential-free allowlisted fixture environment.
This establishes **isolated shipped-worker execution equivalence**, not a rebuilt package or full installed-daemon
measurement. No installs, deployments, production data, providers or windows were used.

Unlike the prior harness invocation, final measured children do **not** receive `--expose-gc`; no forced GC runs.
The old `main_gc_only` stage label is a no-op in these samples. Different idle/peak values from the previous
source-mode run are not a newly implemented production improvement. Ambient host load is uncontrolled; raw
per-trial results and outliers are retained rather than pooled into the earlier data.

Three alternating serial sets, medians of fresh-process sampled peak RSS above the pre-worker baseline (MiB):

| Case | Shipped TS | TS, 1 MiB nursery | JS worker only | JS + 1 MiB nursery |
| --- | ---: | ---: | ---: | ---: |
| No worker | 0.09 | 0.09 | 0.11 | 0.09 |
| Bare Node worker | 11.23 | 11.25 | 11.12 | 11.27 |
| Empty store, idle | 24.20 | 24.59 | 14.84 | 14.30 |
| 50k rows, idle | 25.09 | 25.56 | 14.81 | 13.94 |
| 1,500 indexed pages | 40.42 | 43.64 | 31.22 | 29.53 |
| 1,500 pages + response JSON | 52.89 | 46.38 | 33.89 | 35.02 |
| 1,500 revision writes | 31.64 | 30.06 | 21.09 | 14.66 |

Only the first column is baseline shipped behavior. JS columns strip only worker/disk/validation modules in a separate
setup process, retaining the original TypeScript parent and validation code. These first runs are **diagnostics**,
preceding the release-generator implementation below.
The previous ~17 MiB derived-JS idle diagnostic remains a separate measurement, not replaced retroactively.

Shipped empty-store peaks span 20.98–27.28 MiB; JS-only empty-store peaks span 14.44–15.27 MiB. Packaging the
worker as generated JS is therefore a credible way to remove avoidable bootstrap cost, but is **not a gate fix**:
JS-only serialized-query peaks span 29.38–37.05 MiB. The small-nursery option does not consistently improve all
workloads. Even the combined diagnostic's write median below 16 MiB hides a 19.84 MiB sample, and its query
medians remain far above the gate. No V8/resource-limit setting was added to production.

At empty-store readiness, shipped worker median heap-used/physical/external memory was 10.4/15.0/9.9 MiB;
JS-only was 7.3/11.1/3.5 MiB. These categories are not additive RSS attribution, but their reduction independently
supports avoidable TypeScript bootstrap cost rather than a credential SDK import. There is no preload in either
final environment, and the worker graph contains no SDK dependency.

All short-run page responses remain 50,777 bytes. Per-sample query p95 values are preserved, including a
21.65ms shipped serialized-query outlier; all remain below 50ms, but ambient-load timings are not a speedup claim.
The nursery is an isolate GC heuristic, not an RSS cap; it cannot bound parent or external/SQLite allocations.

The three **6,000 serialized-page** samples per variant reinforce that idle-only success is insufficient:

| Worker variant | Individual peak increases, MiB | Median peak, MiB | Per-sample query p95, ms |
| --- | --- | ---: | --- |
| Shipped TS | 67.16, 64.23, 62.17 | 64.23 | 2.05, 1.63, 2.30 |
| TS + small nursery | 67.42, 58.23, 63.77 | 63.77 | 1.47, 2.70, 2.17 |
| JS worker only | 38.61, 27.73, 39.91 | 38.61 | 3.43, 5.43, 1.94 |
| JS + small nursery | 38.80, 36.09, 35.89 | 36.09 | 2.15, 2.64, 1.93 |

Shipped worker heap medians at ready/each 1,000-page boundary were 10.4, 18.4, 25.5, 32.1, 39.6, 17.7 and
15.6 MiB. Natural worker GC is again visible, while sampled process RSS retains a higher allocation footprint.
The JS-only heap medians were 7.2, 9.2, 8.2, 15.1, 15.5, 13.3 and 12.8 MiB; it still leaves substantial
query/parent/native high-water overhead. Final evidence retains all raw stages and final summaries. Neither
series proves a universal steady-state memory bound, and neither supersedes the prior ~80 MiB observation.

### Focused release-time reduction

The follow-up change adds `packages/daemon/scripts/build-usage-worker.mjs` to **both** release packagers. It strips
the three worker-only modules using bundled Node's own TypeScript stripper, rewrites their known local imports to
`.mjs`, and switches the worker URL in the staged parent copy only after generation succeeds. TypeScript remains
the single maintained source; there is no checked-in generated copy, runtime compilation, dynamic fallback,
additional dependency, V8 flag, worker lifecycle change or kernel/background API change.

Both relocated-runtime checks now verify that the generated files exactly match current source, verify the parent
selects the generated entry, and exercise real worker write/read/clear/close with a temporary synthetic database.
Focused tests cover deterministic regeneration, relocation, missing/stale outputs and an unexpected dependency.
The regular source-store durability/privacy/bounds tests remain unchanged. Full package creation/relocation on
both operating systems remains remote CI evidence, not a local installation or deployment claim.

Final `release-paired.jsonl` and `release-sustained.jsonl` freeze and invoke this **actual release generator**,
including its verification before measurements, and preserve its hash alongside source/binary hashes. The
historical `shipped` label denotes the unmodified `f9b1a0f1` TS baseline; `js_worker` is the proposed release path.
No small-nursery variant is adopted.

Final three serial alternating before/after pairs using that generator:

| Case | TS baseline median peak, MiB | Generated release worker median peak, MiB |
| --- | ---: | ---: |
| Empty store, idle | 25.14 | 14.58 |
| 50k rows, idle | 25.30 | 14.92 |
| 1,500 indexed pages | 44.98 | 32.14 |
| 1,500 pages + response JSON | 51.72 | 38.17 |
| 1,500 revision writes | 31.52 | 21.22 |
| 6,000 pages + response JSON | 72.91 | 46.66 |

The final sustained candidate peaks were **45.38, 46.89, 46.66 MiB**, versus baseline **72.91, 73.17, 55.14 MiB**.
The candidate's sustained per-sample page p95 was 0.58–0.90ms; responses remained 50,777 bytes. Idle candidate
peaks were 14.55–14.70 MiB (empty) and 14.91–15.11 MiB (populated). The no-worker control medians were 0.27/0.09
MiB before/after, bare-worker medians 11.75/11.70 MiB. This is a useful bounded-workload reduction, **not gate
closure**: writes and both query workloads still exceed 16 MiB. Candidate results are neither a total host-memory
cap nor proof of future workload bounds. The earlier diagnostic variation and prior corrected results remain
preserved alongside these final pairs.

### Review needed, not an implicit budget change

No measured variant closes the **unchanged 16 MiB peak gate**. The narrow V8 change is not a convincing safe
win. Generated-JS packaging removes avoidable parser cost but still leaves the peak gate failing. The storage
implementation, durability, privacy, queue/page/storage limits, the dedicated off-event-loop worker and
kernel/background APIs are unchanged.

Evidence-backed choices to review before default rollout:

1. **Keep 16 MiB and review a different execution/ownership design.** A shared existing storage-worker owner or
   lower-overhead native helper is a possible research direction, not a measured solution. Either needs explicit
   architecture review, lifecycle/failure isolation and privacy proofs, with durable acknowledgements and bounded
   queues preserved. Moving SQLite onto the daemon event loop, counting a child process as zero memory, or recycling
   workers across in-flight commits is not an acceptable shortcut.
2. **Continue query-allocation work after the independent packaging reduction.** The paired evidence supports
   lower bootstrap cost without changing the storage semantics. The proposed generator and relocated checks still
   need exact-head remote CI. More aggressive object/transport or GC work needs separate measurements and must
   preserve response validation, durability, privacy and bounded ingress. Idle-only success cannot close the gate.
3. **Explicitly review a measured workload budget instead.** The present implementation does not fit 16 MiB.
   Any replacement budget must state idle versus sustained-query/capture workloads, total host/process accounting
   and duration, and be verified in the full daemon. These isolated results do not establish a universal RSS bound
   or justify simply rounding a gate above the largest observed sample.

Until that choice and subsequent verification, default dashboard rollout remains blocked; independent capture,
bounded-query and UI implementation can continue. This document does not authorize an architecture or budget change.
