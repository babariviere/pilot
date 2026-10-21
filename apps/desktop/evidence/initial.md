# Initial fixture evidence, 2026-10-21

At initial capture this was uncommitted work in `apps/desktop`, not a production migration.
No visible app/benchmark session was launched. No daemon connection, canonical
data/draft/settings write, service setup, Swift change, commit, push or PR.

## Build identity

Host: Apple M3 Pro, arm64, 11 logical CPUs, 36 GiB RAM, macOS 27.0.1
(26A434). Selected developer directory was `/Applications/Xcode.app/Contents/Developer`,
SDK 27.0. This was **not** a Command Line Tools-only validation. The wrapper sets
`MACOSX_DEPLOYMENT_TARGET=15.0`; a real macOS 15 machine was not available.

```text
rustc 1.98.1 (48a229cea 2026-09-01)
commit 48a229ceaefd4985c50990b14116b6d856af0985
LLVM 22.1.8, host aarch64-apple-darwin
cargo 1.98.1 (797e8a9bc 2026-08-05)
mbx 1.26.0
```

Only app dependency: `gpui-kit =0.8.0`. Cargo resolved a lockfile with 840
packages, including target-specific/optional dependencies. `cargo tree` confirms
baseline `gpui-pre 0.3.9` and no active `gpui-fast` reverse dependency. Merely
finding Fast in the lockfile does **not** mean it was built. Kit enables Wayland
and X11 build features; runtime Linux selection is restricted to Wayland.
No direct mixed-version GPUI imports, WebView or user shader pipeline was added.

mbx macOS archive SHA-256 verified before extraction:
`5927803d54f313600f7c6792369867eb26f9dfaa909b04fb5727efcf0d17b0b7`.
The source pins GNU Linux arm64/x86-64 archives too, but they were not executed.

Input SHA-256 identities:

```text
Cargo.lock: 16f747e5cc611d03d9dce198333822b4e49c32bca6da5111d33331ecbfcdb7ba
reply.md:   720626c81182b424721da524a0f967b78a4d69b553173c25a8d8312113bf9775
```

Rust components are in ignored `.tools/rustup`, mbx in `.tools/bin`.
**Incidental setup deviation:** initial rustup auto-self-update changed the
existing rustup manager 1.29.1 → 1.29.2 despite a local Rust home. No global
toolchain/default/config was intentionally changed; the user default remained
1.99.1. Current bootstrap uses `--no-self-update`. Do not describe that first
bootstrap as having zero machine-wide binary side effects.

## Exact verification entrypoints

From the repository root:

```sh
bash apps/desktop/scripts/bootstrap.sh
bash apps/desktop/scripts/cargo.sh build --locked
bash apps/desktop/scripts/check.sh
```

`check.sh` passed rustfmt, `clippy --all-targets --locked -- -D warnings`,
10 sequential pure/UI integration tests, and the native offscreen rendering
test. The UI tests use the **production library view**, not a lookalike harness.

Coverage:
- Stable IDs and full deterministic history pagination, no duplicate IDs.
- Stream ticks + prepend preserve identity and reconstruct exact source.
- Blank/overlapping/capacity-limited echo rejected, no partial history eviction.
- Verbatim user text is not interpreted as Markdown, no image/link fetch path.
- 1 MiB/2,000-paragraph and 5,000-line-fence generator sizes.
- Pointer echo + keyboard submit, Shift-Enter newline, editable busy draft retained.
- Real Kit wheel dispatch leaves tail mode, prepend + stream preserve top ID and
  offset, Latest resumes following.
- Synthetic input-handler preedit refuses explicit send until commit. This
  does not run an OS IME, candidate window or Wayland input protocol.
- Two **defect characterizations**, not parity successes: combining-accent
  Backspace leaves `e`; selection clears after its rendered endpoint unmounts
  and does not revive when scrolled back.

Native offscreen renderer: **1920×1520 Metal image** for a 960×760 logical
window. Tested actual composer input and echo click, captured nonuniform native
pixels, inspected the image. `evidence/local/offscreen.png` and the attached
image artifact contain this actual rendering. The separate attached SwiftUI
mock is static and is **not** the GPUI implementation. No mock renderer was
substituted for the native renderer.

Dependency warning retained: `block 0.1.6` has a future Rust incompatibility
notice. Initial local app compiler/import issues and a Clippy suggestion were
fixed and covered by the passing rerun. No upstream patch/fork was needed for
the fixture to compile. Defects above remain unfixed by design.

## Build/cache observations, not performance claims

All commands ran serially through mbx with private `target/dev`, two Cargo jobs,
two shared fixture CPU shares and a 4 GiB scheduler admission estimate. This is
not a hard OS memory limit. Dev/test debug info is disabled; no release build or
matched Swift run was performed.

Raw `/usr/bin/time -l` observations:

| Observation | Wall time | Maximum resident set | mbx summary |
| --- | ---: | ---: | --- |
| Initial dependency population + app compiler failure | 153.87 s | 1,879,949,312 B | 0 hits, 0 misses, 536 not looked up, 5 bypassed |
| First successful app build after fixing imports/API use | 3.07 s | 913,915,904 B | 0 hits, 1 miss |
| Initial 8-test build + run | 43.02 s | 1,469,169,664 B | 0 hits, 0 misses, 60 not looked up, 1 bypassed |
| Passing complete check rerun, including final 10 tests + render | 41.19 s | 1,469,546,496 B | includes rebuilds after splitting the production library |
| Final locked normal build of delivered source | 48.06 s | 1,478,443,008 B | 0 hits, 9 misses, 2 not looked up |

The first row is **not a successful cold-build time**. The second is not a
no-op or one-file benchmark. Max RSS is the `time` child-process measurement,
not aggregate compiler+app memory, not steady-state application RSS. These
single observations on a shared machine prove no speedup or runtime benefit.
The final normal build rebuilt GPUI-layer crates after the test-support feature
graph, so it is not a clean cold-build or one-source-edit measurement either.
The resulting binary's `--help`, final rustfmt check and shell syntax checks passed.

mbx reported some build-script declaration cache bypasses. Its initial default
free-disk reserve was about 45 GiB on this volume, exceeding available disk, so
it evicted roughly 2.1 GiB logical from the **fixture-only store**. The wrapper
now explicitly uses a 2 GiB action-store cap and 4 GiB free reserve. It disables
managed target views and remote cache URL. There was no unrelated cache purge.
The shared fixture store is under `~/.cache/gpui-fixture-mbx-v1` by default;
`target/dev` remains private.

At the final inventory, mbx reported 2,483 objects, 410 action results, about
1.2 GiB logical action-store data, one live checkout and **zero managed target
directories**. `du` reported about 3.0 GiB private target files, 472 MiB local
tools, 1.3 GiB shared fixture cache. APFS clone sharing means these logical
sizes must not be added together as physical disk usage.

The build-loop/cache-probe job ended **cancelled before output**. It was not
restarted as a benchmark. No actual cross-root restore hit, warm/no-op, one-file
edit, second GPUI worktree, repeated cold run or plain-Cargo A/B is claimed.
Reproducible opt-in scripts remain in `scripts/measure-builds.py` and
`scripts/cache-probe.py`; the latter is explicitly a tiny cache mechanism
probe, **not** a representative GPUI worktree benchmark. Neither opens a GUI.

## Unvalidated platform/UI work and next checkpoint

- No real Wayland host or Linux compile/link/runtime check was available.
  Linux code is compile-gated, socket preflight + WAYLAND-only backend selection;
  native prerequisite and runtime behavior must be checked on a real host.
- No visible macOS smoke, scrolling smoothness, typing latency, CPU/RSS/GPU,
  startup, narrow-window, live appearance/reduced-motion or Swift comparison.
  Offscreen rendering is not substitute evidence.
- No native Japanese/Pinyin/Korean IME, full grapheme corpus, VoiceOver or Orca
  verification. Input AX text runs/caret/selection and Markdown semantics remain
  source-identified gaps, not waived requirements.
- Giant sources are generated/tested, not rendered or timed in this session.
  Fit-content TextView still has the all-block layout risk. No A2/A3 repairs,
  parser cache/highlighting changes, selection semantics redesign, full keyboard
  transcript, queued inputs or rich-paste implementation was attempted.

**Next review:** arrange a visible macOS fixture session and a real Wayland
host separately. Review this small proof and the reproduced gaps before
authorizing A2/A3 or any live-data/packaging migration. Swift remains available.

## Follow-up: manual return to tail

User smoke feedback: the proof was otherwise good, but manually scrolling back
to the bottom did not resume automatic following. Clicking Latest did work.
This is user-reported interaction evidence, not an agent smoothness measurement.

Added `wheel_back_to_bottom_resumes_stream_following`, exercising real Kit
wheel events while a reply streams. It **failed on the original implementation**
at the assertion that scrolling back to the bottom resumes following. Setting
the MessageScroller list's vertical padding to zero made the focused test pass.
Kit's default list inset interferes with the pinned GPUI bottom re-engagement
path. Inter-row spacing is unchanged; no upstream crate or cache was patched.

Also added `streaming_stays_physically_at_tail_after_reply_exceeds_viewport`.
It checks actual reply-bottom geometry across stream ticks, not only the follow
mode flag, and passes. Existing reading-above-tail anchor coverage remains.
No forced return to tail on each stream chunk, new transport or A2/A3 repair
was introduced. Relaunch the fixture binary to pick up rebuilt code.

Follow-up verification passed: rustfmt, strict all-targets Clippy, all **12**
pure/UI tests, native offscreen rendering and a locked normal binary rebuild.
The user then confirmed: "it's good now". This confirms the reported interaction
is satisfactory, not full parity, Wayland validation or measured performance.

## Follow-up: built-in stream fade

The user subsequently approved enabling Kit's `.stream_fade(true)` on the
fixture's retained Markdown TextViews. This uses Kit's default word pacing and
reduced-motion handling, without a custom animation or dependency-patch change.
Selection, composer and tail-follow regression checks run with the fade enabled.
No visible animation-timing or smoothness measurement is claimed.
