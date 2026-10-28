# Linux visual helper checkpoint, 2026-10-28

**Native helper/kernel and isolated Wayland evidence, not full product qualification.**
Linux visual execution remains refused by `Process::start`. No platform guard,
security policy, release configuration or production acknowledgement changed.

## Exact inputs and isolation

The production helper was built from source
`45fef8339e6c50e3def101490d692ea57d595d16`, transferred over an SSH archive pipe
to the explicitly authorized `babariviere@192.168.0.198`. Production helper,
shared runtime, engine, manifests and lockfile were unchanged. The new
`visual-worker/examples/linux_confinement.rs` compiles the **same** isolation
and watchdog modules into a separate attack fixture, never into the product.
`scripts/linux_visual_confinement.py` drives that fixture and the real helper.

After native execution, local/remote helper build inputs matched.
The built helper SHA256 was
`7d401e012fb046aa5ff6a1dc679c106a4ee4c3adfcd216410227d8918c1a49ef`.
QuickJS-NG0.17.0 was materialized by the existing checksum-pinned preparation;
the native compiler was pinned Rust1.98.1, not the ambient Homebrew1.98.0.

Actual host: x86_64 Bazzite44, image44.20261023.0 (Kinoite), kernel
`7.2.9-ogc3.1.fc44.x86_64`. The initial SSH process had zero effective,
permitted, inheritable and ambient capabilities, no-new-privs0 and seccomp0.
That is a host observation, not an assertion about other machines or distros.

All source/tools, Cargo/mbx caches, HOME/XDG directories and fixtures lived in
`/var/tmp/native-visual-qualify.DYksJk`. Native builds/probes ran in owned
transient user scopes with CPUQuota200%, MemoryMax4G and TasksMax256, plus
bounded wall deadlines. No sudo, global/system installation, real app/daemon/
profile inspection or mutation, release, signing or unconstrained execution.
Private Rust toolchain/tool downloads used existing preparation pins. Initial
scope attempts failed before compilation because of working-directory/bus
environment setup; the bounded scope was corrected, not bypassed.

## What actually passed

The final native driver completed **80 checks**:

- The raw-syscall fixture executes32 denied operations on both the main thread
  and a thread created **before** installation. File open/read/write admission,
  create/unlink/rename/mkdir; IPv4/IPv6/Unix socket and socketpair, connect/send;
  execve/execveat; clone/clone3, ptrace, io_uring, bpf, prctl, seccomp replacement,
  getppid, kill, pidfd/process-vm reads, dup/pipe/eventfd/memfd/epoll and executable
  mmap/mprotect all returned EPERM. Some operations use deliberately invalid
  arguments to avoid side effects on regression. This is a denial corpus, not
  proof that each operation would otherwise succeed or an exhaustive syscall audit.
- Passed writable/readable file and listening-socket descriptors100..102 are
  closed by the real `prepare` function: fstat, inherited read and inherited
  write return EBADF. The sentinel is unchanged and listeners accept no contact.
  Targets are synthetic owned files/executables/listeners, not real services.
- A400MiB anonymous data mapping fails ENOMEM under the320MiB address-space
  cap, while ordinary RW mappings work. The fixture reports38 results per
  attacking thread (32 denials, five descriptor checks and one memory check).
- Independent parent reads of `/proc/<pid>/task/*/status` show seccomp2,
  no-new-privs1 and one filter on all three fixture threads, including the
  pre-existing attacker and production watchdog. On every actual helper
  startup, both main/watchdog threads have seccomp2/no-new-privs1. This is real
  kernel observation plus syscall attacks, not acceptance of `sandbox:true`.
- The production watchdog exits the attack fixture with124 during an active
  non-interruptible Rust spin. It remains parked during ordinary idle work.
- Actual helper `/proc/limits` shows CPU60s, core/file-size0, NOFILE16 and
  AS335544320. These kernel settings are observed, not all driven to exhaustion.
  The JS engine is separately driven into its32MiB heap,512KiB stack and
  setup-time limits; each yields the appropriate error and discards the helper.
- All nine shared view/event/state cases and43 error cases pass through the
  real helper. This includes draw/handler failures and aggregate node/text
  rejection. The5000ms command-overflow fixture accepts its exact error **or**
  the truthful production8ms timeout; no production budget was increased.
  Shader/Mermaid nodes are output data, not shader or GUI rendering evidence.
- Six malformed JSON/schema frames, oversized/truncated frames, and11 source,
  data, seed, state, event and draw request bounds are rejected. Request4MiB
  and reply2MiB framing limits remain unchanged.
- An exactly owned SIGSTOPped helper stalls for the driver's2s deadline, then
  is killed/waited. Cancellation during a partial request is killed/waited;
  a fresh process renders successfully afterward. Every driver-owned helper
  is reaped and absent from `/proc` after teardown.

The original driver lifecycle checks are independent, not product transport
acceptance. Later native parent-transport tests below exercise actual Linux
IPC deadlines/cancellation/reaping and two-worker capacity. Full mounted-reader
lifetime and teardown-failure-latch qualification remain separate.

Scoped checks also passed: locked worker/example builds, strict worker
Clippy `--all-targets`, pinned rustfmt on the new Rust file and Python syntax.
`cargo test -p pilot-visual-worker` contains zero unit tests; the80 native
subprocess checks above are the executed security suite, not that empty gate.

## Wayland fixture and remaining qualification

**Correction: Wayland-only is a Pilot backend requirement, not a ban on a
compositor optionally serving other X11 clients.** Cage's unused X11 listeners
are neither a Pilot XWayland fallback nor a helper confinement failure. The
previous Sway/runtime-disable/native-only-compositor-build prerequisite was
invented and is withdrawn. Do not install Sway or alter the user's KDE session.

Installed Cage0.3.1 already provides an owned headless/pixman compositor with
wl_seat9/seat0 and HEADLESS-1. Its matching release source requests lazy
XWayland support and logs "XWayland is running" when setting DISPLAY. A bounded
owned wayland-info probe observed no XWayland process, but did observe Cage's
own abstract/pathname X11 listeners and inherited DISPLAY=:1. Those observations
describe Cage, not Pilot's selected renderer/backend. Both owned diagnostic
processes exited0 and were reaped. The subsequent real GUI probe is below.

Use that existing isolated Cage fixture, **unset DISPLAY in the client**, and
require Pilot's real Wayland connection/seat/toplevel/buffer evidence and
fail-closed platform guard. Do not connect to or reconfigure the real KDE
session. Keep all existing helper confinement and product execution guards.

Missing Meson/Ninja/wayland-scanner and compositor development headers do not
block using the installed compositor. The actual pinned GPUI build **passed**
under CPU2/4GiB limits, without privileged/global installation or broad toolchain
changes. The first source transfer omitted three tracked icon/sky assets and a
later test compile needed the tracked Mermaid corpus. Supplying their exact
source revisions fixed these fixture-copy errors. No new host prerequisite was
needed. Existing build.rs linked versioned system libraries through its private
native-libs directory; no system symlinks or security policy changed.

### Isolated real Wayland GUI and native tests

The initial GUI run used103407a8a8d51256adabeea82012bd5efa3c0b84. The final
build/test recheck reconciles concurrent renderer work on
7f1cf5f41abf323268748f652b8444c63860b9ad, plus the test-only parent helper coverage
and qualification driver published alongside this evidence. Production
Process::start remains macOS-only. No environment variable or production fixture
flag can bypass it.

`scripts/linux_visual_wayland.py` runs an owned headless/pixman Cage with private
HOME/XDG directories, then starts the **real GUI** with DISPLAY absent. Actual
`/proc/<owned-gui>/environ` confirms it is absent. `wayland-info` observes
wl_seat/seat0, and WAYLAND_DEBUG from the GUI proves actual get_toplevel and
wl_surface.attach requests. The GUI stays alive for the bounded observation,
then is stopped/reaped; Cage is also stopped/reaped. A separate launch with
DISPLAY=:99 but no Wayland is refused by the unchanged production preflight.
Main uses `platform::linux(WindowingModes::WAYLAND)`, not backend auto-fallback.

Under that same owned Cage, the reconciled visual library filter passed35 tests
(the initial pre-reconciliation run passed34).
Existing real helper transport tests now run on native Linux through a private
**cfg(test)-only** start_at fixture, retaining the production refusal test.
They cover hello identity/runtime/active-denial validation, shared view/event/
state and draw records/errors, failed helper disposal, SIGSTOP-to-parent2s
deadline/kill/reap/fresh recovery, cancellation of an active exchange followed
by stop/reap/replacement, and a third worker waiting until a slot is reaped.
The same selection includes hostile wire/drawing data, scene/geometry aggregate
budgets, invalid state/frame transactional rejection and restart fencing.

The reconciled native visuals target passed72 narrow/wide/light/dark expected-tree
scenes, native canvas pixels, synthetic selection/copy/scroll/source disclosure
with a fake clipboard. It uses native headless GPUI rendering/text, with a real
Wayland compositor connection, not a visible-window or motion acceptance claim.
The initial pre-reconciliation native run passed68 scenes. No generated source
executes inside that renderer suite. The source helper and
trusted renderer are tested separately; this is not an integrated live reader
or enabled Linux product visual path.

The general check-scoped.py native-target guard remains macOS-only. This
explicitly authorized Linux qualification uses that wrapper for library tests
and the same pinned cargo.sh/profile for the single native visuals target.
No broad CI/native-admission policy was changed. Sway installation, compositor
rebuilds and changes to the user's real KDE session are unnecessary.

Locked workspace binaries, scoped production-library Clippy with native-probes,
pinned rustfmt on the changed Rust file and Python syntax cover this checkpoint.
Linux lib-test builds emit existing unused synthetic fixture warnings outside
the selected security tests; these were not hidden or converted into new gates.

Still qualify integrated mounted canvas/reader lifetime and combined source-to-
UI recovery before considering a narrowly scoped product-enabling delta.
Do not turn the product guard off merely to make these probes run. Any narrowly
scoped qualification admission needs an explicit source-backed design, not an
unconstrained fallback or a blanket Linux enablement.

No aarch64, other distro/kernel, visible GPU, IME, smoothness, full syscall
escape resistance or general Linux visual-support claim follows from this run.

```sh
cd apps/desktop
python3 scripts/prepare-visual-worker.py
bash scripts/cargo.sh build --locked -p pilot-visual-worker --example linux_confinement
bash scripts/cargo.sh build --locked -p pilot-visual-worker
python3 scripts/linux_visual_confinement.py \
  --worker target/dev/debug/pilot-visual-worker \
  --probe target/dev/debug/examples/linux_confinement --root "$OWNED_FIXTURE_ROOT"
bash scripts/cargo.sh clippy --locked -p pilot-visual-worker --all-targets -- -D warnings
python3 scripts/linux_visual_wayland.py \
  --binary target/dev/debug/pilot-desktop --root "$OWNED_FIXTURE_ROOT" --checks
```
