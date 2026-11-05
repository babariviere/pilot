# Retained visual precheck

Status: host-only adapter and isolated tests. No production dispatcher, endpoint, agent tool,
reviewer/provider call, approval, acceptance gate or live validation uses it. Returned observations
are not durable review completions and are not automatically projected into mission checks.

## Inputs and custody

`prepareRetainedVisualPrecheck({ now, timeoutMs }, expectedEngine)` reads the installed checker
and its dependencies without executing a visual or WASM. It returns intended validator pins and
an isolated `run` method. Supply these pins to
[`captureRetainedArtifact`](retained-artifact-acquisition.md). The clock is an explicit proposed
execution input, never reconstructed from publication metadata.

`run(descriptor, reopen, signal?)` requires a **trusted host closure** around
`MissionService.reopenRetainedArtifact` (or its host acquisition function in isolated tests).
It is not a request callback or an authorization DTO. The adapter reopens before execution and
after worker settlement, preserving acquisition's current custody, allocation, assignment,
policy, profile, run, context and validator fences. It also compares the retained descriptor,
container hash and exact derived source/data JSON hashes and seed. Reopen refusal, cancellation
or changed bindings suppress the report. There is no latest fallback or retry.

The original persisted JSON container stays separate from the derived `source`, `dataJSON` and
artifact ID passed to the checker. Stored API, engine and check metadata are historical fields,
not current execution. The actual returned API and engine must match the intended pins.

## Executed bytes and configuration

The adapter takes an in-memory snapshot of the checker, worker bootstrap and the installed
QuickJS, TypeBox, naga and glslang packages. It supports the current source-layout pnpm
installation only. Unsupported layouts/dependencies fail rather than load arbitrary replacements.
Snapshots are limited to 4,096 files and 32 MiB, including metadata. File-handle reads check the
opened size against the remaining allowance before allocation and read at most 64 KiB per call,
up to that size plus one sentinel byte. Growth, shrinkage or changed metadata refuses the snapshot.
Package metadata has an additional 64 KiB per-file cap and is parsed from the same captured bytes,
not a second read.
An incremental directory walk counts every entry, including excluded files and directories,
against a shared 8,192-entry budget (plus one sentinel). It buffers one entry at a time, limits
depth to 64, and closes directory handles on refusal. No recursive listing is hydrated first.
The intended build digest covers code/package
files. The runtime digest covers the exact runtime.js/WASM assets and the host Node executable
hash, Node component versions, platform and architecture. Executable hashing is incremental,
limited to 512 MiB, and rechecked before and after execution.

Owned workers start with empty environment and explicit preload arguments. A frozen loader
supplies captured module source and runtime asset bytes, including nested checker workers.
It refuses files outside the snapshot. This avoids a cached module or a later disk reread
being mistaken for the pinned code, runtime text or compiled WASM. The checker receives the
compiled module made from those captured QuickJS bytes, not an opaque pre-existing WASM cache.
For captured file modules the loader returns the captured source directly, without calling the
next live body loader. It accepts only the already resolved module, module-typescript or JSON
format; unknown or unsupported formats are unavailable, not guessed from source or extension.
Builtin loads still delegate to Node. Resolution is not a later file-body load.

Each successful worker records loaded module and asset hashes/lengths, plus the actual resolved
import edges. All must belong to the pinned snapshot. The complete installation digest includes
unused files; the execution receipts identify the subset actually used. Node's resolver still
selects supported paths, but it cannot execute source outside that snapshot. This is host
provenance, not OS executable attestation or protection from hostile same-user processes.

The execution worker checks the actual shared sampling limits, initial-worker and shader resource
limits, empty environment policy and exact bound clock/timeout options before calling the checker.
The host compares that configuration, complete stage trace and execution receipts before returning
`passed`. Missing/mismatched receipts, stages, engine, configuration or bindings cannot pass.

## Stages, cancellation and limits

The adapter reuses `checkVisual`, not `assertShaderCompiles`:

1. Load worker modules, then QuickJS WASM and runtime.js.
2. Run the initial checker worker. Its existing timer covers this worker only.
   naga translates the sampled shaders to Metal **inside this worker**.
3. Run each later glslang worker with its existing separate 10-second timer.
4. Check the corresponding Metal translation and await outer worker exit.
5. Reopen the retained input and reauthorize before returning a usable report.

There is **no end-to-end deadline**. Installation snapshotting, input acquisition, module/runtime
loading, later shader workers, termination and final reauthorization are outside the initial
worker timer. Cancellation stops admission, aborts the checker and waits for the load and owned
checker work to settle. A late success cannot override cancellation. Termination/drain can take
longer than the timer or cancellation request. `workerExited` records outer exit; `joined` also
requires the checker's settlement marker and join observations for every started worker/load.
Before admission `workerExited` is null and there is no work to join. An outer crash or missing
marker does not prove nested join, and cannot pass. A rejected termination promise is not a join.

Unavailable checker/runtime stages remain unavailable, including broken glslang. No permissive
shader-publication fallback is used. Stage failures, sample-limit partial results and mismatches
are non-passing. Reaching either the 24-interaction or 96-draw cap is conservatively partial,
even if the last sampled state happened to finish exactly at that cap.

This is a **limited sample validator**, not proof of complete visual or UI correctness. It checks
sampled trees, controls, Mermaid, draws and shader translation/GLSL compilation. Its report includes
the actual limits, two draw widths, sampled times and pointers. It does not inspect pixels,
exercise every state, compile MSL on a native GPU, verify usability/accessibility or requirements,
or replace independent review, human inspection or acceptance.

## Verification

`packages/daemon/src/retained-visual-precheck.test.ts` uses real retained-container capture/reopen,
vault and isolated checker execution. Corrupted snapshot fixtures cover unavailable WASM/shader
stages, incomplete traces/configuration/settlement, cancellation, derived arguments, engine and
access mismatches. No installed package bytes are modified.
File-handle and directory fixtures also prove pre-allocation oversize rejection, capped growth
reads, bounded metadata/aggregate bytes and incremental shared entry limits without package writes.

`packages/artifacts/src/visual/observed.test.ts` uses fake workers, held termination promises and
mock timers. It proves loading is outside the initial timer, the later shader timer is independent,
and timeout/abort wait for join while suppressing late success. No deadline is increased.
