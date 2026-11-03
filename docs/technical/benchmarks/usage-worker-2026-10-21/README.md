# Accounting worker probe, 2026-10-21

Synthetic, offscreen macOS arm64 measurements on base `f9b1a0f1` (merged allocation fixes).
No production source module is modified by this probe. No installed application data, credential environment,
inference, network calls, dependency installs or native windows are used.

- `exploratory.jsonl`: first single-sample controls, retaining the old harness's `--expose-gc` flag. These are
  exploratory, not the final paired comparison.
- `paired.jsonl`: three serial, alternating-order sets, all seven workloads, 1,500 operations per workload.
- `sustained.jsonl`: three serial, alternating-order sets of 6,000 serialized pages.
- `release-paired.jsonl`, `release-sustained.jsonl`: final before/after comparison using the actual release
  generator, not the initial ad-hoc JS control. These additionally record the frozen generator hash.

Each JSONL line is a metadata object, a raw sample with all stage/heap/RSS/latency measurements, or a final
derived summary. No accounting rows or real identifiers are included. Reported RSS is sampled every 5ms and
at stage boundaries, relative to the fresh child's pre-worker baseline, not a universal allocation bound.
Summary CPU excludes startup; startup duration is recorded separately. Page timing excludes extra JSON encoding.
All four variants use the same fixture and parent source graph; comparisons isolate worker execution only.

## Execution equivalence and limits

At the measured baseline, both release scripts (`apps/macos/scripts/bundle-runtime.sh`,
`scripts/linux/bundle-runtime.sh`) copy the TypeScript sources without transpiling them. The launch agent runs bundled `node …/src/main.ts`, without a
TypeScript loader hook. `UsageHistoryStore` starts `usage-history-worker.ts` with inherited Node execution
arguments; its transitive runtime imports are only local modules and Node built-ins. Protocol imports are erased
types, so there are no installed third-party dependencies in this worker graph.

The final probe copies the installed, shipped Node executable into disposable `runtime/node/bin/node`, preserves
`runtime/packages/daemon/src` layout and ESM package type, and freezes the five source files before any sample.
Metadata preserves the binary and source SHA-256 digests, Node/V8/SQLite versions and environment key names.
Each measured child gets only PATH, optional TMPDIR/SYSTEMROOT, disposable HOME and PI_OFFLINE. Seeding is a
different, exited process. Measured children have no `--expose-gc`, compile cache or NODE_OPTIONS. The historical
`main_gc_only` stage name remains in the source harness, but is a **no-op** in the final runs.

This is **production-equivalent execution of the isolated shipped worker leaf**, not an installed full-daemon
measurement or a rebuilt release package. The installed app predates these accounting modules. We reuse its
Node binary, not its daemon sources or data. Full package installs, relocated runtime checks and CI remain remote
verification; capture/daemon/native overhead needs separate evidence. Ambient host load was not controlled.

Variants:

| Name | Worker execution |
| --- | --- |
| `shipped` | Unmodified TypeScript source, as release packaging ships it |
| `nursery1` | Same TypeScript, worker-only `maxYoungGenerationSizeMb: 1` |
| `js_worker` | Only the worker/disk/validation graph stripped to `.mjs` in a separate setup process |
| `js_worker_nursery1` | Both diagnostic changes |

The nursery variants are **unshipped experiments**, never automatic production fallback. The JS control retains
the original TypeScript parent and validation imports, avoiding an artificial reduction of the daemon baseline.
Worker V8 resource limits are not process RSS limits and do not cap SQLite/external allocations or the parent.
The final `release-*` runs use the proposed production generator for `js_worker`; the `shipped` label is retained
for the original TypeScript baseline. Both release scripts now invoke that generator in staging, and both runtime
checks verify generated-source freshness and real synthetic worker operations. The source checkout still uses TS.

## Reproduce

Use the same shipped Node 24 executable and machine-wide Node verification slot. Freeze the script and source
graph before a run and do not edit them while running. The script freezes the source graph itself at startup;
its optional first argument identifies the repository root when the script is copied outside the checkout.

```sh
python3 scripts/verification-slot.py node -- /path/to/shipped/node scripts/bench/usage-worker.mjs > paired.jsonl
USAGE_BENCH_CASES=serialized_queries USAGE_BENCH_BATCHES=6 USAGE_BENCH_BATCH_SIZE=1000 \
  python3 scripts/verification-slot.py node -- /path/to/shipped/node scripts/bench/usage-worker.mjs > sustained.jsonl
```

`USAGE_BENCH_TRIALS` defaults to 3 (max 5). Existing benchmark batch/page caps remain in force.
`USAGE_WORKER_VARIANTS` can select a comma-separated subset of the four variants. Every sample gets a new process
and database copy; trials reverse variant order to alternate the paired comparison. The same seed is shared only
as an on-disk fixture. Temporary executables, source copies and databases are removed when the controller exits.

For the final implemented-path comparison, set `USAGE_WORKER_VARIANTS=shipped,js_worker` in both commands.
