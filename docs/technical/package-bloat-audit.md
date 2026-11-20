# Package bloat audit, 2026-11-20

**Start with packaging exclusions and the daemon's `tsx` dependency.** These changes do not
require retiring a product feature. The inventory below was taken before the legacy
visual and shader compiler cleanup, so those original totals include deleted files.

## What can stop shipping

The [macOS runtime builder](../../apps/day/macos/scripts/bundle-runtime.sh) and
[Linux runtime builder](../../scripts/linux/bundle-runtime.sh) stage `packages/`, skip
`*.test.ts`, and install production dependencies with the hoisted linker.
[Day uses the macOS builder](../../apps/day/scripts/bundle_runtime.py).

| Candidate | Estimated payload | Evidence |
| --- | ---: | --- |
| Test fixture directories, test helpers and benchmarks | 73 files, 471 kB raw, 104 kB gzipped | `src/fixtures/`, `src/testing/`, `packages/artifacts/test/`, `packages/protocol/fixtures/`, `*.bench.ts`, and `packages/kernel/scripts/bench-*`. Keep files still used by the [Day native host tests](../../apps/day/native/tests/host.rs), [worker benchmark](../../scripts/bench/usage-worker.mjs), and other development callers in the checkout. |
| Adjacent test files with other names | 13 files, 88 kB raw | Includes [planning workers fixtures](../../packages/daemon/src/planning-workers.fixture.ts), [fixture helpers for MCP tests](../../packages/daemon/src/mcp-test-fixtures.ts), and the now-deleted visual conformance generator. Audit each remaining exclusion. |
| [Daemon's production `tsx`](../../packages/daemon/package.json) | About 0.40 MB on Linux or 0.57 MB on macOS with optional `fsevents` | Daemon entry points use native Node TypeScript support. The [test runner's comparison mode](../../scripts/test.ts) and [reopen benchmark](../../scripts/bench/reopen.ts) use the **root** dev dependency, which stays. The [lockfile](../../pnpm-lock.yaml) also resolves `esbuild` through Chord, so do not count it as savings. |

The first two rows total **559 kB raw**, about **128 kB** as a separate gzip archive.
The staged first-party tree had about 7.5 MB after the existing test exclusion but before
other release pruning. Do not apply a blanket exclusion to everything outside `src/`.
One example is the [usage worker builder](../../packages/daemon/scripts/build-usage-worker.mjs),
which both runtime smoke checks call. Another is the
[artifact skill and kit](../../packages/kernel/skills/pilot-artifacts/SKILL.md).

## Obsolete code and inactive prototypes

- **Orphaned fixtures, about 25 kB.** No current automated callers were found for
  [the Next log fixture](../../packages/daemon/src/next-app-log.fixture.ts),
  [the old usage query fixture](../../packages/protocol/fixtures/usage-query.json),
  [the review test host](../../packages/daemon/src/testing/review-host.ts), or
  [the workflow test host](../../packages/daemon/src/testing/workflow-host.ts).
  The hosts still have documented manual use. Retiring them would also retire those
  manual entry points. These bytes overlap the packaging rows above. The
  [real Next log reader](../../packages/daemon/src/diagnostic-logs.ts) still has callers.
- **Old context digest, 42 kB.**
  [`context-digest.ts`](../../packages/kernel/src/context-digest.ts) has no production
  caller. The [offline handoff comparison](../../packages/kernel/src/testing/handoff-evaluation.ts)
  and [digest tests](../../packages/kernel/src/context-digest.test.ts) still use it.
  The production kernel uses [Posthorse](../../packages/kernel/src/posthorse.ts).
  Keep the comparison in the checkout if it still has value.
- **Unwired review prototypes.** The removed visual precheck and its worker accounted for
  about 23 kB, separate from the compiler stack. The
  [critical-review capture](critical-review-foundation.md) and
  [retained run linkage](retained-review-run-linkage.md) also include test-covered
  code with no production entry point. Exclude or retire those paths as a group,
  not by deleting shared review modules.
- **Shared-note model summarizer.** [Daemon startup](../../packages/daemon/src/daemon.ts)
  passes no summarizer to [the memory service](../../packages/daemon/src/project-memory.ts).
  This leaves the model path dormant outside tests. Keep historical notes and their
  readers, and do not confuse this path with ordinary chat compaction.

## Removed: legacy visual and shader compilation

The [artifact write path](../../packages/artifacts/src/render.ts) now accepts only images
and NSH. The [macOS](../../apps/day/macos/scripts/check-runtime.sh) and
[Linux](../../scripts/linux/check-runtime.mjs) runtime checks use NSH source in place
of compiling a visual. Saved legacy source, numbered revisions, and provenance remain readable.

The three package copies used by this path, `glslang-wasm-validator`, `naga-wasm`,
and `quickjs-wasi@3.6.4`, account for **about 4.61 MB** after macOS metadata pruning
in a local file inventory. That is an estimate, not a measured archive delta.
The Pi SDK still brings its own QuickJS copy. Do not count that copy, `pi-codemode`,
or the kernel's `typebox` as savings.

The [NSH artifact host](../../packages/artifacts/src/nsh-host.ts) is independent of this cleanup.

## Verification boundary

This audit checked tracked paths, source references including worker and fixture
loads, manifest and lockfile entries, and local dependency file sizes. It did not
build an installer or measure installed disk savings. The [Day legacy retirement audit](day-legacy-retirement.md)
lists migration, history, and recovery paths that must remain.

For a cleanup, compare manifests and bytes from before and after staging on both
platforms. Run the relocated runtime smoke checks and confirm the repository
tests still have their required fixtures.
