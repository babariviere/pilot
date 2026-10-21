# Native visual runtime, foundation checkpoint

WIP, not viewer delivery. No artifact cards/detail UI is wired yet. Parent
transport/schema/session modules are test-only until their UI integration lands.
No generated source runs in the desktop process. No Swift/backend changes.

## Isolation implemented

`pilot-visual-worker` is a separate Cargo package. It compiles the existing C
visual engine and shared runtime against QuickJS-NG 0.17.0, with no libc/std/os
modules or host bridge. A checksum-pinned preparation script materializes only
the engine into private `.tools`, verifies the archive on every preparation and
refuses changed materialized files. Existing Swift/vendor/registry sources are
not edited. Source/archive/version pin matches the current Swift preparation.

Trusted native bootstrap runs before source is read. It closes inherited fds,
sets resource limits, creates intrinsics and a parked watchdog, then installs:
- macOS: deny-default Seatbelt after loader bootstrap, self process-info only.
  File, network and actual exec denial are actively probed before hello. Parent
  independently queries the actual child's file sandbox. `sandbox_check` is SPI;
  absence/failure refuses execution. Its process-exec query was not reliable;
  actual exec denial is required instead. No broad sysctl or file grants.
- Linux: no-new-privs, non-dumpable, parent-death kill, close-range, 320 MiB
  address-space cap and architecture-checked seccomp allowlist with TSYNC to the
  watchdog. No open/socket/connect/exec/clone/ptrace/io_uring or executable
  mappings. Parent checks `/proc` before sending source. Linux code is not yet
  built/run on a native Wayland host. Capability failure has no fallback.

Child environment is cleared and cwd is `/`. A parent-owned synthetic listener
ensures denial testing cannot contact the daemon or another real service.
Hello pins protocol, engine, runtime hash and actual child pid before source.
At most two workers exist globally. A failed reap latches execution unavailable.

## Transactions and limits

32 MiB JS heap, 512 KiB JS stack, setup/view 250 ms, handler 100 ms and draw
8 ms. Helper watchdog exits after 1.5 s of active work, parent hard deadline is
2 s, and kill/reap is bounded. Idle watchdog is parked, not polling.
Every error/interrupt/OOM/invalid reply discards the whole helper. No interrupted
VM resumes. Retry recreates it from last committed reader state. Normal success
keeps setup/closures as the existing contract requires.

Frames: 4 MiB request, 2 MiB reply; strict PV decoding with valid UTF-8, finite
numbers, duplicate-key/overflow/trailing-data rejection, depth/value/expanded-byte
caps. Host independently validates closed API 1, aggregate text and node limits,
sibling keys, dimensions, chart series lengths and current-path control ids.
State must be a bounded JSON array. Tree and state commit atomically only after
all validation; stale/disabled/mistyped events never reach the helper.
Shader metadata/source is retained, never compiled/executed; mixed valid trees
keep their other nodes. Renderer support remains unfinished.

## Evidence and remaining work

Full checkpoint verification: 83 library tests pass, one opt-in disk workload
ignored; fmt-all, strict parent/helper Clippy, native fixture/browser plus16
synthetic chrome scenes, locked app/helper builds and engine-symbol separation
pass. `JS_NewRuntime` is present in the helper, absent from the UI binary.
Native tests passed for sandbox/parent attestation, load/events, real
handler interrupt and heap exhaustion, null-OOM metadata, fresh-VM recovery,
no partial state commit, stale events, kill/reap of an unresponsive helper,
hostile wire/schema rejection, nine shared view/event/state fixtures and the
30 shared non-draw error cases. Draw/error-budget fixtures, canvas codec/renderer,
charts/layout/controls UI, artifact read/provenance/revision/generation fencing
and lifetime/state-cache integration are still pending. Native Wayland/macOS15,
broader escape probes and matched performance remain unverified. No real data,
real mutation, visible app, service install, release/default switch or Swift
removal. No full parity/security certification or speedup claim.

```sh
cd apps/desktop
python3 scripts/prepare-visual-worker.py
bash scripts/cargo.sh build --locked -p pilot-visual-worker
bash scripts/cargo.sh test --locked --lib visual_ -- --test-threads=1
bash scripts/check.sh
```
