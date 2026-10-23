# Rust CI platform coverage and source-frozen verification ledger

## Scope and status

The normal Rust lane is an independent **Linux sibling job `rust` in the
existing `tests.yaml`**, called by both `pr.yaml` and `main.yaml`. Separate
macOS-native and opt-in macOS-release siblings cover platform-specific work.
No `needs` dependency on Node, Swift or other jobs; no Rust steps added to them. The separate
`desktop-rust.yml` is deleted. Fix base: accepted main
`ad2d9d94a2013c182a12426bfe2a3250fd98af5a` (the earlier initial topic base was
`46923720ea3a23f8e3d7f3f48e0005fffecfab6c`). Production app/library/Cargo/patch/
helper and release implementation remain unchanged. Scoped native test-only
slider/motion harness corrections and one cfg(test)-only fail-closed runtime
regression are explicitly included below. No signing, release/feed
publication, app installation/restart, service or production credential access.

**Current candidate: the motion correction and its actual instant-appearance
negative controls passed the final focused verification below.** It is folded
with source/tests/evidence into one feature commit on accepted main `ad2d9d94`,
not rebased onto fresh main. The last previously published
head's Linux/Rust-native/Node jobs completed successfully; its inherited Swift
fixture failure remains separate. No new-head or whole-CI success, macOS
release, visible smoothness or full app acceptance claim. Results are inspected after
completion notification, without polling or manually rerunning CI.

## Latest exact-head terminal qualifications

The user's substantive terminal preflight reported ALL checks completed for:

- PR985 head `e5fedc134daa4818cef306d8f3a73c661bdd7ab5`, run39989575960:
  `rust`, `rust-macos-native` and Node job conclusions **SUCCESS**; general
  macOS job **FAILURE** for the known inherited Swift fixtures; opt-in release
  **SKIPPED**. This is that head's job metadata, not a claim to have reread its
  full native log/counts or a new-head pass.
- Dependent PR986 head `bb68ce58702efd35799f5716f3c6830759705345`, run39990195894:
  Linux and general macOS job conclusions **SUCCESS**; Rust-native **FAILURE**
  at motion. Its first1100Light readback-completion timestamp was297ms; all
  subsequent captures were later. These results are NOT interchangeable with
  PR985, and the Settings owner alone owns its branch/consolidation.

No further remote polling, manual reruns or stale active-status wait is used.
The inherited Swift defect is owned by the separate PR981 repair, not skipped
or classified as an infrastructure flake here.

## Test-only motion oracle correction

The old probe discarded its real pre-update image and treated the first
post-update image as the zero-opacity endpoint. If that image already showed
partial opacity, a real fade could be rejected when all later images settled.
Warming and delayed PNG encoding already existed; they alone are not this fix.

Only `src/motion_probe.rs` changes:

- Warm actual initial FULL text's layout/glyphs/readback, then replace it with
  PREFIX through Kit's normal non-append reset semantics on the same entity.
- Retain a genuine prefix-only native baseline BEFORE appending FULL. Compare
  actual post-update native frames with that baseline and settled final.
- The appended-word mask selects changed ink over baseline background and
  asserts that existing PREFIX ink remains exactly pixel-identical. Existing
  header/geometry/entity guards remain; no shifted-prefix pixels count as fade.
- Retain the ACTUAL initial FULL native image as an executed instant-appearance
  negative control (initial content has no append/fade segments). Require exact
  equality with normal settled FULL and zero intermediate pixels from the SAME
  positive oracle/mask. No invented or substituted pixels, fade-policy override,
  production mutation or claim of running a disabled production fade.
- Draw/readback in one window update, record separate pre-draw and readback-end
  Instants before pixel extraction/PNG encoding. Paint timestamp brackets the
  draw start, not a precise GPU execution/display timestamp. Negative baseline
  relative times are intentional. A host missing the unchanged280ms interval
  FAILS explicitly; a late settled-only capture is never accepted.
- Preserve the original `>5` intermediate-pixel threshold,48-luma endpoint and
  12-luma intermediate margins, final settled equality, idle render count,
  canonical entity, unchanged geometry and exact source/clipboard guards.
  No production fade duration/clock/pacer/queue/limits changes.

First focused local job `3b6fac0f` EXIT0, frozen working source
`4455efb3554f1b4988d2eaabdf797fc8a0121f16`, motion SHA-256
`98610da3d2ed8c8f1517b89ee6c8e80c025af1ef07a04af1db196a24a1dc7c40`:
strict Clippy `--features native-probes --test motion -- -D warnings` and actual
4-scene native motion target passed. Intermediate counts3690/3618/3682/3608
at680Light/680Dark/1100Light/1100Dark; post-update draw-start times94/190,
94/183,94/231,94/229ms respectively. All settle/idle/geometry/entity/copy checks
passed.131 tracked build inputs were identical before/after. This earlier
source had only an observation-level settled-pixel negative control: it does
NOT prove the later explicit mask/actual-initial-image negative control.

The refined motion SHA-256 is
`36ce688d40157acf564eca668189e0084b926269ef198685b283175ffb524137`.
The refined JSON keys explicitly say `draw_start_ms`, `readback_end_ms` and
`draw_and_readback_ms`: none purports to be an exact GPU/display paint time.
Final focused local job `1238ac15` **EXIT0**, actual shared verification slot
1/1 (PID42719), mbx2CPU/4GiB admission, frozen source
`7db4077666e76aed715135737b2aa5e207c2ca9d`:

| Scene | Actual positive intermediate pixels | Appended-word mask | Actual native initial-FULL negative intermediate pixels | Post-update draw starts, ms |
| --- | ---: | ---: | ---: | --- |
| 680 Light | 3690 | 3690 | 0 | 95,192,410,605 |
| 680 Dark | 3618 | 3618 | 0 | 94,185,408,603 |
| 1100 Light | 3682 | 3690 | 0 | 95,239,414,601 |
| 1100 Dark | 3608 | 3618 | 0 | 96,238,410,605 |

Strict Clippy `--locked --features native-probes --test motion -- -D warnings`
passed, then the actual native four-scene `--test motion` target passed.
EVERY instant-appearance image exactly matched normal settled FULL in the
sampled region and failed the SAME intermediate oracle with zero pixels;
no fabricated pixels or endpoint substitution. Existing PREFIX ink equality,
settled equality, idle render count, entity/geometry and exact clipboard/source
guards all passed. All131 recorded tracked build inputs were identical before
and after. The final result-ledger fold changes documentation only; compiled
inputs are compared with that frozen source before publication. Local checks
were serialized after the previous admitted checks had actually joined; this
slot is now fully released. No repeated full Cargo/Linux/Swift/native matrix.

This is bounded offscreen native phase evidence, **not visible smoothness** or
an exact GPU/display paint-time measurement. It is NOT a new-head remote-CI
pass. The normal published-head run must qualify its own Linux/Rust-native/
Node results; inherited general-macOS Swift failures stay separately reported.
Private synthetic native captures and raw manifests remain ignored under
`evidence/local/`, not published.

### Single-feature consolidation and retained receipts

The previous published head is
`e5fedc134daa4818cef306d8f3a73c661bdd7ab5`. Only motion harness source and this
ledger differ from that full tree. Its workflow, CI scripts/contracts, slider
stress/negative controls and non-Mac refusal regression are preserved byte for
byte. Old exact-head/run receipts in this ledger remain historical, not new
hash success claims. One net feature delta is parented directly on accepted
`ad2d9d94a2013c182a12426bfe2a3250fd98af5a`, without replaying merged ancestry
or rewriting another branch. The dependent Settings owner receives the exact
old/new head, base, tree and changed-path mapping BEFORE the task-only leased
push; only that owner may restack its child. No checkpoint/fixup/evidence-only
publication, signing, release, merge, app switch or real app/daemon restart.

Fresh lightweight full orchestration suite:50 Python tests PASS (including
both PATH Bash and system Bash3.2),18 focused Node workflow contracts PASS,
actual actionlint1.7.12 validates PR/Main/shared workflows and rejects the
original invalid-context mutation. Shell syntax/whitespace/rustfmt checks PASS.
No duplicate full Cargo/Linux/Swift/native matrix was run locally.

## Historical shared macOS contract follow-up, separate from Rust native status

Normal run [39987999249](https://github.com/babariviere/pilot/actions/runs/39987999249),
head `3fab660e82d42122d94566b1ead15ce30926be12`, tested merge
`ed9283fcda199d3803fa9a598a40059f0190f13a` into `ad2d9d94`:
the completed `tests / macos` job **120532830724** failed for two independent
classes. Its Node native lane and SwiftLint passed. Its 108 Python packaging
tests passed. Two Node workflow assertions then failed because this PR changed
the workflow structure:

1. `release-workflow.test.mjs:60` required an empty `workflow_call`, rejecting
   the new explicit boolean opt-in input.
2. Line181 counted exactly one total `macos-15` job, rejecting the distinct
   Swift/native/opt-in-release jobs.

**Own actionable fix** in
`apps/macos/scripts/tests/release-workflow.test.mjs` only: require reusable-only
trigger semantics plus the exact optional boolean/default-false release input;
require one **Swift test invocation** instead of one total Mac runner; add
Linux-vs-Mac roles/no-needs/default-off artifact assertions. Existing release,
Swift change-filter, smoke-test, signing and promotion checks are retained.
No workflow, release/packaging implementation or Swift runner behavior changes.
The focused Node file now has **18 passing tests**, and actual actionlint
positive/negative validation passes. This is not a local Swift/native build.

**Inherited external blocker**, routed to the existing Swift fixture repair
owner instead of duplicating its source: MenuBarTests.swift144 retained
availability/count snapshot, SlackTriageEntryTests.swift49/110 old `devbox`
instead of `legacy-fixture`, KeyboardNavigationTests.swift237 missing Usage;
then the existing180s watchdog with no native terminal summary. This topic's
Swift test/source/wrapper bytes are unchanged from accepted main. They match
the known separate [PR981](https://github.com/babariviere/pilot/pull/981) repair
lane. No rebase, foreign-branch integration, assertion skip or timeout increase
is done here. The remaining Swift failure is not classified as infrastructure
or a flake merely because it is outside Rust scope.

The same completion-notice snapshot reported `tests / rust` **SUCCESS** on
current `3fab660e` (job120532831079); its detailed counts were not reread or
inferred from the prior147 result. `rust-macos-native` was still running at
that snapshot, so no positive/negative native-control pass is claimed and no
poll/wait/retry is used. Opt-in release remained skipped. Whole PR remains
unqualified while native completion and inherited Swift repair are outstanding.

Frozen Node contract source before follow-up push:
`0477abd760a9da3fa462405b8c5f91edeecd470c4e74db6382c427fd4c254915`.

## Explicit test-only safety and negative-control follow-up

After the burst-delivery patch, the user authorized precisely these additional
test seams. No production guard, pacer, callback limit, binding, transport,
Settings, updater or other workspace changes:

- `src/visual_runtime.rs`: **one** new
  `#[cfg(all(test, not(target_os = "macos")))]` module. It calls the actual
  `Process::start`, requires the exact fail-closed `unavailable` result with
  no source line/limit and all worker slots available. An unexpectedly started
  owned child is stopped before the test fails. The existing production guard
  remains byte-identical; no helper or Linux execution capability is enabled.
- `src/artifact_slider_probe.rs`: two native **test-instance mutations** using
  the same real production-pane input path. `Unpaced` resets only the probe
  Flow's deadline through `Default`, preserving its flight/latest data.
  `OldestQueued` deliberately restores an older pending intent for the same
  control/binding/generation instead of retaining the newest value. No mutant
  mode or hook is added to any production implementation.
- Both negative controls must be rejected by the **same rate/latest-thumb
  oracle used in the normal probe**. If the mutation fails to exercise the
  defect, the negative control itself fails, rather than logging pretend
  rejection. The normal path retains its original explicit rate/count/queue/
  latest/outcome assertions; both normal and negative fixtures assert cleanup
  after closing. They run at one small native scene after the normal four
  width/theme scenes, not as a change to app pacing behavior.
- `scripts/test_ci.py`: source-contract checks guard the test-only cfg/real
  entrypoint and shared positive/negative oracle wiring. These are static
  checks, not proof that a native mutation executed.

The normal stress requirement stays at **at least360 fast gaps among480
inputs** (the original75% fraction), actual window above30 inputs/s,
34ms virtual dispatch gap,33ms observed gap with existing1ms tolerance,
at most30 callbacks in any actual second, bounded one-flight/one-latest,
exact thumb/latest state and cleanup. Burst input timing is reported separately
from production application performance. No assertions were relaxed or native
tests ignored. No throughput waiver or runtime retry.

Local checks: **50** lightweight Python tests, real actionlint positive/negative
validation, rustfmt format/syntax and whitespace pass. No local Cargo/native/
Swift build or duplicated active Settings gate. The new Rust tests and native
negative controls remain **uncompiled/unexecuted locally**, awaiting a normal
new-head CI run. Historical Linux success remains qualified only to
`0d53ad6a`; it is not inferred for the next head.

Latest test inputs frozen before publication:

| Input | SHA-256 |
| --- | --- |
| `src/artifact_slider_probe.rs` | `4b2fc05b5802cf0fcfbe33cead2028b657d80b4a1180678ace6e43d701ba277d` |
| `src/visual_runtime.rs` | `fd6b9d1f4c96ae0a44b4720e3b183d737ff747417faa3d597e8aa94ea2836dee` |
| `scripts/test_ci.py` | `416f2b00743c5691c47ca077db9ec80e0598f0912be6c10c9c6f3924c638113a` |

## Real Linux success and actionable Mac-native failure

Normal PR [run 39985273731](https://github.com/babariviere/pilot/actions/runs/39985273731):
PR head `0d53ad6a600d4275d5bb4deb73c1ede29e6d0eae`, tested merge
`b0271d8fbe9b1ec0fe6e45065040549f43a30408`, into accepted main
`ad2d9d94a2013c182a12426bfe2a3250fd98af5a`.

**Linux job [120523130203](https://github.com/babariviere/pilot/actions/runs/39985273731/job/120523130203): SUCCESS.**
Actual Ubuntu24.04 image `20261012.334.1`, x86_64, Rust1.98.1
(`48a229cea`)/mbx1.26.0, Python3.13.16. Started `2026-10-23T16:16:27Z`,
terminal success `16:25:07Z`: **8m40s total** including runner/bootstrap/checks.
The exact input download cache missed; there was no restored compiled target
or mbx store. Production app/helper debug build finished in **3m38s**, strict
workspace/native-probe/all-target Clippy in **1m50s**. Library result:
**147 passed, 2 explicit disk workloads ignored, 0 failed**, then
**17 Settings tests passed**. Helper binary harness had 0 direct tests, as
documented; Python/actionlint passed. Library test runtime65.11s is not a UI
performance measurement. mbx emitted build-script/search-path cache bypass
warnings, not compiler/test failures. This single cold-run observation is not
a matched speedup, RSS result, Linux native/Wayland acceptance or macOS proof.

**Mac native job [120523130414](https://github.com/babariviere/pilot/actions/runs/39985273731/job/120523130414): FAILURE**, not unsupported.
All **8 exact Mac-only helper/runtime tests passed**. Metal was available;
the 7 probes rendering/chrome/visuals/disclosure/style/icons/motion passed.
`controls` reached the happy-path/lifecycle scenes, then failed the existing
pacing-input prerequisite at `artifact_slider_probe.rs:243`:

```text
native input must actually outpace callback budget: 24 fast gaps, 25 inputs/second
```

This did **not** reach the callback-rate assertions. The harness's single
input per `HeadlessAppContext` update was serialized with its automatic native
draw/flush on this runner. Source inspection confirms an update can draw even
without explicit `render_frame`. Merely retrying it, lowering the required
input rate, skipping controls or calling it unsupported would hide missing
stress coverage. The remaining history/shell/navigation/Inbox/jump/workbench/
catalog probes did not execute after the failure. Optimized Mac release was
correctly **SKIPPED** because its opt-in input was false.

### Test-only correction, no production pacing change

Keep 120 conservatively wall-paced ticks, each sleeping at least8ms before
advancing virtual time by8ms. Deliver **4 actual native pointer moves within
each App update**, with a faux-channel production-pane acknowledgment after
**each** event, so frame-readback cost does not serialize every raw input.
Record each actual `Instant`; never accelerate the virtual clock or catch up
render time. Total stress input480; required fast-gap quota increases
**90→360**, preserving the75% prerequisite. Actual input-window maximum must
still exceed30/s. No pass is fabricated if the runner cannot deliver that.

All dispatch assertions remain unchanged: at least15/at most31 enqueues,
both sliders exercised, virtual gaps at least34ms, actual gaps at least33ms
(existing1ms observation tolerance), at most30 dispatches in any actual
one-second window, instant ack cannot release another callback, exact latest
intent/thumb state, one-flight/one-latest bounds and clean deadline/queue/flight
teardown. Only the native probe harness changes, not `ArtifactPane`, slider
admission, bindings, view/runtime or transport. Nonempty acknowledgment checks
avoid adding empty App updates. No retry loop, throughput-waiver or CI condition
changes. The new source guard protects those stress/clock/assertion contracts;
it is **not native execution evidence**.

Local follow-up checks: **48** lightweight Python tests, actual actionlint
positive/invalid-context regression, Rust source rustfmt syntax/format and
whitespace checks passed. No local Cargo/native/Swift build or native rerun.
The corrected probe still requires normal remote compilation and execution.

Follow-up inputs frozen before the next source push:

| Input | SHA-256 |
| --- | --- |
| `src/artifact_slider_probe.rs` | `ba4161eb19bc9832f364f591ebce958a854745d336bed22e2bee4e26d05e8078` |
| `scripts/test_ci.py` | `b95704b874e1a2c4966add36f752c1008f268ba9f62872f79210681bc3095439` |

## D33 Linux-runner change checkpoint

User clarification changes the default platform plan. This is a scoped
fast-forward on the bound topic, not a new workflow or history rewrite.
The prior Mac-only runner results below remain historical, **not evidence of
Linux compilation/test success**. First real Linux result is pending the next
normal PR completion notice; no polling/manual retry.

Before this source push **47 lightweight Python tests passed**, including
both shell paths, Linux acceptance/Mac-native-and-artifact refusal, exact Mac
test-list failure propagation, actual-source registration parity, parallel
runner roles and opt-in-only release. Real actionlint validated PR/Main/shared
workflows and rejected the invalid-context mutation. Neither these mocks nor
the validator establish Cargo success. No local Linux/Cargo/Swift build was run.

Frozen current inputs before the real Linux run:

| Input | SHA-256 |
| --- | --- |
| `.github/workflows/tests.yaml` | `4fd5217c22b52969cdc1125780b23748e7bcda8a4e212690ec4de6cf8ed580d0` |
| `scripts/ci.sh` | `02d1f685be125dd946c4d281f448f92c32fdfceded66da148cf86a9815220ce2` |
| `scripts/test_ci.py` | `9a66976ef155d6bcb8628f0a912463407d13bd1f08cb2ed5bf6f116414204e18` |

## Merged catalog and Settings-foundation execution registration

After the preceding Bash correction, the accepted main source advanced to
`ad2d9d94a2013c182a12426bfe2a3250fd98af5a`, containing the merged component
catalog and pure Settings foundation. This topic integrates that exact main
with an **ordinary merge**, preserving its initial `46923720` branch history
and Bash correction. No rebase, merged-branch rewrite or foreign net source
diff. The shared workflow/validator are unchanged.

Only their missing execution registrations are added:

- `catalog` appended to the native array, reusing the source owner's minimal
  unpublished `996821ac` script/test intent, not replaying that lineage. It now
  compiles with the 14 earlier probes and executes when Metal is supported.
- `cargo test --locked -p pilot-desktop --test settings_state -- --test-threads=1`
  added after `--lib`: the **17** merged path-import tests are auto-discovered
  integration tests, not library tests. All-target Clippy alone did not run them.
- The **native Settings UI target is still unmerged and is not registered**.
  No app, component, Settings, Cargo or helper implementation is modified.

The new regression reads the **actual `Cargo.toml` and `tests/*.rs`**: each
declared ordinary native target must match the execution array and have a
source file; auto-discovered pure integration tests must match explicit pure
execution. Only the existing private `capture` and large `scaling` workloads
are excluded. It checks the real `settings_state` path import/module and 17
test definitions, not fabricated Cargo output. Fake-tool assertions separately
require actual catalog and Settings-harness invocation. This is registration
evidence, **not compilation or passing Rust-test evidence**.

After this scoped update **37** local Python tests passed, both shell syntax
checks and real actionlint positive/negative validation passed. No local Cargo,
native or Swift build/test. There was no remote CI polling or manual rerun.

Latest sources frozen before publication:

| Input | SHA-256 |
| --- | --- |
| `scripts/ci.sh` | `2d0c7ecd2143dfeaecfa80d15f25a2d7a0566c6d3fd118d8741c1761bf775859` |
| `scripts/test_ci.py` | `ff8b7b9e84a05d5716640c1378f244aab5206bd7a30b59318c85763ef6966f2d` |

## First real runner result and Bash compatibility correction

Normal PR [run 39981247490](https://github.com/babariviere/pilot/actions/runs/39981247490),
Rust [job 120508794309](https://github.com/babariviere/pilot/actions/runs/39981247490/job/120508794309):

- PR head: `deb77a4a272e8452e1fa72850e6cdb57fb035177`.
- Tested merge SHA: `83c8b80f972eb1db4b6d987f22196cb34ceead07`, into main
  `46923720ea3a23f8e3d7f3f48e0005fffecfab6c`.
- Actual image `macos-15-arm64`, image version `20260907.0337.1`, Python
  `3.13.15/arm64`; Rust job started `2026-10-23T15:52:57Z`, terminal failure
  at `15:53:14Z` (17 seconds, not a cold Rust build measurement).
- Checkout/runtime paths/input filter succeeded; real Actions validation and
  invalid-context mutation regression **passed on the runner**.
- Two negative fake-tool tests failed in the pre-Cargo contracts step:
  old-macOS refusal continued to the fake checks; wrong-binary-architecture
  refusal continued to the synthetic manifest. Bootstrap, Cargo checks,
  release builds and native probes were **not run**. No binary artifacts.

This was a deterministic **own script compatibility defect**, not a flake or
runner outage: Apple's `/bin/bash` **3.2.57** ignores `set -e` for a bare
`[[ false ]]` command, unlike the developer PATH's Bash **5.3.20**. A small
local system-shell reproduction confirmed both guards could continue. Both
guards now explicitly report refusal and `exit 1`; tests are not loosened.

The entire fake-tool suite now runs under **both PATH `bash` and `/bin/bash`**.
After the correction, **36 local Python tests passed** (14 orchestration
cases per shell, 4 workflow contracts, 4 measurement mocks). Both shell syntax
checks and the real actionlint positive/negative checks passed. No local
Cargo/native/Swift suite was used. Normal source push will start fresh PR CI;
no manual rerun or CI polling. The unrelated job outcomes do not establish
Rust results and are not changed here.

Corrected sources frozen before the follow-up push:

| Input | SHA-256 |
| --- | --- |
| `scripts/ci.sh` | `2b1a58fd7f5659476ef4b7b79bd7d70243d5df3916985b450a2988760f70ee40` |
| `scripts/test_ci.py` | `3285a0cec68005ccfa55de11710f1c88e7caac0f4432b52cf52c0af6b86d95e0` |

Workflow and validator inputs remain byte-identical to the initial fix hashes
below. This correction is a fast-forward on the same topic, not a rebase or
foreign source integration.

## Exact initial failure and validator regression

Completed main run [39977340452](https://github.com/babariviere/pilot/actions/runs/39977340452),
head `46923720ea3a23f8e3d7f3f48e0005fffecfab6c`, failed workflow validation
at `2026-10-23T15:19:55Z`, the same creation/update timestamp. Its jobs API
returned `total_count: 0`. **No Rust command reached a runner.** The initial
merged CI source and 19 mocked tests never established a genuine Rust run.

Real **actionlint 1.7.12** reproduced two errors against that exact workflow:

```text
desktop-rust.yml:42:27: context "runner" is not allowed here [expression]
desktop-rust.yml:43:30: context "runner" is not allowed here [expression]
```

Both were `${{ runner.temp }}` in **job-level `env`**, for `XDG_CACHE_HOME`
and `DESKTOP_CI_OUTPUT`. GitHub does not make the `runner` context available
there. They are now initialized in a `run` step using `$RUNNER_TEMP` and
`$GITHUB_ENV`. The split into a separate workflow was unnecessary and is
removed as requested. Existing non-Rust job bodies and wrapper behavior are
unchanged (only the stale single-Mac-job comment is corrected).

`scripts/validate-workflows.py` downloads the maintained actionlint release
into ignored project-local `.tools`, SHA-256 verifies the archive on every use,
and validates the **real PR/Main/shared workflow files**, including Actions
schema, expression contexts and reusable calls. It also mutates the real Rust
job with the original invalid job-env context and requires the real validator
to reject it. No fake validation, ignore rule or continue-on-error. Shellcheck
and pyflakes integrations are explicitly disabled, not represented as passed.

Pinned macOS arm64 validator archive SHA-256:
`aba9ced2dee8d27fecca3dc7feb1a7f9a52caefa1eb46f3271ea66b6e0e6953f`.
The previous Ruby/YAML syntax parse and string assertions were insufficient:
valid YAML is not valid Actions context semantics. This regression addresses
the exact missed error but is still not remote execution evidence.

## Current D33 platform split, gates and limits

D33 explicitly authorizes Linux CI test builds, not a Linux desktop release or
rewriting CI scripts in Rust. The default PR/Main workflow no longer builds
optimized macOS app/helper binaries on every change.

| Shared sibling job | Runner/target | Actual scope | Not established |
| --- | --- | --- | --- |
| `rust` | Ubuntu 24.04 x86_64 / `x86_64-unknown-linux-gnu` | Normal **debug production app and helper build**, rustfmt, strict workspace/all-target/native-probe Clippy, helper harness, complete platform-eligible production library tests and 17 path-import Settings tests; script/workflow validation | macOS artifact/UI/signing, Linux native renderer/Wayland acceptance, real OS IME, source execution, release/performance |
| `rust-macos-native` | macOS 15 arm64 / `aarch64-apple-darwin` | Real sibling debug helper; **8 existing macOS-only library runtime tests**, then all 15 production offscreen Metal probes when available | portable-suite rerun, optimized app build, signed update, visible smoothness/OS IME |
| `rust-macos-release` | macOS 15 arm64 / `aarch64-apple-darwin` | **Opt-in only** `workflow_call.inputs.desktop-release-build: true`; locked optimized app+helper and unsigned provenance artifact | publishing/signing/installable update, portable/native checks inherited from another job |

The input defaults **false**, and neither existing PR nor Main wrapper sets it.
It is a later packaging verification seam, not a new triggered workflow, release
workflow change or production-release authorization. All three jobs are parallel
siblings without `needs`; existing non-Rust job bodies are unchanged.

### Production modules, dependencies and actual test platform

Linux does **not** substitute a copied fake core or drop UI interaction tests:
the full existing production library is compiled/tested, including real model,
network fake-server, drafts/worker, reader/selection, composer/Unicode/marked
input, tool, appearance/component and visual-planning modules. The existing
`#[gpui_kit::test]` tests use GPUI's synthetic `TestAppContext`/`TestPlatform`,
whose default text system is `NoopTextSystem`; no native GPU/compositor is
needed for these tests. This is not native text shaping or display evidence.
`DISPLAY` and `WAYLAND_DISPLAY` are explicitly unset during the Linux gate.
Existing ignored synthetic disk/large workloads remain reported as ignored.

Inspected exact Kit **0.8.0**, GPUI/Platform **0.3.9** manifests and the lock-
verified `gpui-pre-linux-0.3.9` archive, SHA-256
`e28213c3fde6f13e91ba0b74b90cbaadec9373e36a031eda98561d31059870f3`.
Kit enables **both Wayland and X11 build dependencies** upstream, including
font-kit/wgpu, xkbcommon, xcb and portal/accesskit support. This is a dependency
build fact, **not an X11 runtime target**. No X server/Xvfb/compositor/native
Linux probes are launched. The ephemeral Ubuntu runner installs compiler,
clang/lld/pkg-config, fontconfig/freetype, Wayland/xkb/xcb/X11-link headers,
Vulkan/EGL/OpenSSL/udev and DejaVu fonts. No workstation/global installation.
Linux links with lld to bound linker overhead; no claimed speedup without a
completed run and comparable measurements.

The helper source-execution guard in `visual_runtime::Process::start` is
unchanged: non-macOS returns **unavailable** before starting a helper. Existing
Linux confinement source is not enabled or declared validated by compilation.
No Cargo/lib/appearance/check feature extraction or framework change was needed
for this first real full-workspace Linux CI attempt. Actual Linux compilation
may still reveal platform defects; those are failures, not silent test skips.

### Native Mac-only inventory

Existing `#[cfg(target_os = "macos")]` coverage remains on the Mac job:

- `visual_runtime::tests`: shared draw/API/event/state corpus, native canvas
  packets, actual sandbox/load/event/OOM-null and stopped-child hard deadline
  with killed/reaped worker (**5** tests).
- `visual_session::tests`: failed-handler retry/state and draw-interrupt/null
  discard (**2** tests).
- `artifact_worker::tests::explicit_scoped_read_and_event_use_only_faux_gets_and_close_reaps`
  (**1** test).

The Mac job first obtains the **actual compiled test list** and requires each
of these 8 exact names before invoking it with `--exact`; zero-test filter
success cannot pass silently. It does not run `--lib` unfiltered, rustfmt,
Clippy or the 17 portable Settings tests again.

All **15** ordinary native renderer probes compile, including catalog, even
without a GPU. Only an Objective-C Metal preflight returning nil device
(exit 78) records **UNSUPPORTED**, warning/summary/status, **not** executed or
passed native tests. Compiler errors, preflight crashes and actual probe
failures fail. Supported hosts execute rendering/chrome/visual/disclosure/
style/icon/motion/control/history/shell/navigation/Inbox/jump/workbench/catalog
serially. Private captures and scaling/large-render workloads are not run.
The still-unmerged native Settings UI target is not registered here.

### Resources and toolchains

Existing pinned Rust **1.98.1**, SHA-verified mbx **1.26.0**, private checksummed
crate patches/QuickJS-NG preparation and unchanged Cargo wrapper. Python 3.13;
Mac Xcode26.2/deployment15.0. No rustup default/global setup/sudo locally.
Two Cargo jobs/mbx CPU shares, **4 GiB admission estimate**, not an OS memory
limit. Linux/Mac native outer ceilings **60 min**, opt-in Mac release **50 min**;
bootstrap10, Linux gate35, Mac runtime/native25 each, opt-in release35 minutes.
These are watchdog ceilings, **not measured cold-build times**. All compiled
objects start cold on independent runners; download caches do not change that.
No local Cargo, Linux/native renderer or Swift suites duplicate remote work.

## Inputs, cache and trust

The existing PR/Main wrappers trigger shared CI. The Rust job's PR step filter
covers the desktop workspace (including lock/toolchain, source, fixtures,
patches and scripts), shared visual runtime/fixtures, C engine and headers,
root Cargo/config/toolchain inputs and both wrappers/shared workflow. It diffs
the tested merge commit against its first parent; unavailable/unknown diff
fails open to running checks. Main always runs Rust when the existing Main
wrapper invokes shared CI (its unchanged release-commit exception remains).
Desktop `evidence/**` is documentation/output only, excluded on PRs so a
result-only ledger update does not start another expensive Rust build. The
job still validates workflows/lightweight contracts. In particular, compiled
`fixtures/reply.md` is **not** excluded by a broad Markdown filter.

Permissions are `contents: read`; checkout credentials are not persisted.
Normal `pull_request`, never `pull_request_target`, with no secrets. Only Cargo
registry **archives** and checksum-verified preparation downloads are cached.
Exact OS/architecture/Rust/mbx + workspace/transitive-input hash key, no restore
prefix. Generated Python bytecode/evidence/private tools/build directories are
excluded from identity. No
toolchain, registry source, Cargo target/incremental, mbx object, auth, signing,
HOME or user-state cache. Every runner's compiled objects start cold. PR cache
scope cannot promote its outputs to the default branch; existing release jobs
do not consume these caches/artifacts. This workflow never promotes anything.

## Artifact contract for later packaging integration

`desktop-rust-unsigned-aarch64-apple-darwin-<tested SHA>` (7-day retention):

- `pilot-desktop`, `pilot-visual-worker`, sibling raw release executables.
- `manifest.json`: schema 1, kind `unsigned-ci-executables`,
  `installable_update: false`, tested checkout SHA/tree, separately recorded
  PR head SHA (null on main), package versions, target/deployment/profile,
  empty app features, actual Rust/mbx/Xcode/SDK versions, lock hash and each
  binary's byte size/SHA-256. `lipo` rejects non-arm64 binaries.

The default PR checkout is GitHub's **merge commit**, not its head. Both
identities are explicit. The opt-in Mac artifact is uploaded after its release build succeeds; it does
**not** imply a portable-suite or native verification result from a sibling job. Read the separate `desktop-rust-native-status-<tested SHA>` artifact
and workflow conclusion. Failed native execution cannot hide behind successful
binary upload. Artifacts contain no chat/source dumps, logs, credentials,
signed bundles, updater frameworks or feeds.

These are **non-release CI outputs, not a signed installable update**. No
Developer ID signing/notarization is performed (Apple's linker may produce an
ad-hoc signature). ZIP download may lose executable modes. Later packaging must
build/verify a separate app identity/version/feed, updater native resources,
signing/notarization, safe lifecycle and immutable source provenance. Never
install or publish these raw binaries as an updater payload.

## Fix checks before new publication

```sh
bash -n apps/desktop/scripts/ci.sh
python3 apps/desktop/scripts/validate-workflows.py
python3 -m unittest discover -s apps/desktop/scripts -p 'test_*.py' -v
git diff --check
```

**22 Python tests passed**: 18 CI/filter/parallel-job/wrapper/runtime-temp
contracts plus the 4 existing measurement-runner mocks. Real actionlint passed
all three actual workflows and rejected the invalid-context mutation. No
local Cargo, native renderer or Swift suite was run. Validator preparation is
source-local, not a global installation. The normal new PR run must still
prove a real runner and the actual Rust bootstrap/check/release/native outcome.

Fix input SHA-256 frozen before publication/normal PR execution:

| Input | SHA-256 |
| --- | --- |
| `.github/workflows/tests.yaml` | `8be5ecad6e37e308249d15f155c4ec0c7a8bcf47ee3f7f1b8dbc348e11b44949` |
| `.github/workflows/pr.yaml` (unchanged) | `2da75177ac0aa4098297484c927b8259b5a2a4ca31b02f826a3bef831bf97d9c` |
| `.github/workflows/main.yaml` (unchanged) | `6a7d1fda92c81a58e6dcf60d387e3abf5e5cfca5ecc07d88ad3410edd86afe53` |
| `scripts/ci.sh` (desktop-relative) | `6b38c14ee6b2610048867f33edb42b0f029ee0706d5a50baca29b4e289ccce29` |
| `scripts/test_ci.py` | `14c0569c1bbd4e0edd2c77585a9b6116263440df57dd8d51ae0f614131e0ae1e` |
| `scripts/validate-workflows.py` | `10d1618b3366b2535ca4cbb740ba3b6d963233467ec2bf02f76cd8bd0203d15c` |

## Historical initial checks and frozen inputs (not passing Rust CI)

Before first publication, 2026-10-23:

```sh
bash -n apps/desktop/scripts/ci.sh
python3 -m unittest discover -s apps/desktop/scripts -p 'test_*.py' -v
git diff --check
```

**19 passed**, including 15 new CI/workflow contracts and 4 existing mocked
measurement-runner contracts. Tests use temporary fake tools, not Rust/native
processes or real state. Ruby's YAML parser also accepted the workflow document
(its YAML 1.1 representation treats `on` as a boolean; GitHub uses its own
workflow parser). No actionlint/schema or remote execution claim from that
syntax check. An initial test's overbroad cache-comment assertion failed and
was corrected to assert exact cached paths; no production guard was weakened.

Pre-publication SHA-256 identity (these files frozen before remote run):

| Input | SHA-256 |
| --- | --- |
| `.github/workflows/desktop-rust.yml` | `dbfa32cafbd5243af20910cd14634ee57e0db1a52cbc40491990d8baa7b54aa5` |
| `apps/desktop/scripts/ci.sh` | `1d1d787971396dc95a876b7df840d96faafeb0039aee018a55636537ba20e45f` |
| `apps/desktop/scripts/test_ci.py` | `20801115838d270e35cda3520f734c4c100ffe095e5ed29d14d1093dcb319fe8` |
| `apps/desktop/Cargo.lock` | `c2ed69e73723fb4318ea842349350a95336a745ef7c8f1e0628b457a9b0c291e` |
| `apps/desktop/rust-toolchain.toml` | `887f9be066a15585a2c583578e84b0fcb541126d81546276bad3d2ff00d61167` |
| `scripts/bootstrap.sh` (desktop-relative) | `cb2602da76b4cbd5c88d6e743c49d2d97ccdfbc9c650228d0b237dab7448abee` |
| `scripts/cargo.sh` | `f14d6f931fa61566557d2e620d258248a3d3661a46e625bd1ca24d5fd4352a65` |
| `scripts/check.sh` (not changed/invoked wholesale) | `bbc3f7f278eee39430fd60b70e4922b54f8856380e602a744b06a77d72ce1ec3` |
| `scripts/prepare-patches.py` | `9d8cb445d7fd78d4e2fef5fee74ddad3f08de7525de42e602ada75ac1fb0788a` |
| `scripts/prepare-visual-worker.py` | `e479b0640b76bd622aafa3f5e8e80466419db3faf22575f4b66251827f6192fe` |

These are the original invalid-workflow checkpoint hashes, not the fix hashes.
At that earlier initial fix, before the explicitly authorized test-only
slider/motion/non-Mac follow-ups, the delta contained only shared CI/
orchestration/filter/validator/test/evidence files; Rust/shared-engine/runtime/
fixture inputs matched accepted main
`ad2d9d94a2013c182a12426bfe2a3250fd98af5a` after its ordinary integration.
Existing Node/Swift checks, previous warm local GPUI checks and parent PR green
statuses establish none of this workflow's Rust/cold/native results.
