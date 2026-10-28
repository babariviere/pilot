# Linux visual helper checkpoint, 2026-10-28

**Partial native helper/kernel evidence, not Wayland/product qualification.**
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

The last lifecycle checks exercise the independent driver, **not** the disabled
Linux product transport. They do not qualify product cancellation races,
restart admission, global two-worker scheduling or the teardown-failure latch.
The real product's startup/exchange2s deadline, reap1s deadline and transactional
reader commit are source-audited only on Linux at this checkpoint.

Scoped checks also passed: locked worker/example builds, strict worker
Clippy `--all-targets`, pinned rustfmt on the new Rust file and Python syntax.
`cargo test -p pilot-visual-worker` contains zero unit tests; the80 native
subprocess checks above are the executed security suite, not that empty gate.

## Wayland blocker and remaining qualification

`sway` and `weston` are absent from the authorized host's PATH. Installed
Cage0.3.1 was briefly tried with an owned headless/pixman `wayland-info` client.
It advertised `wl_seat`9/seat0 and HEADLESS-1, but also announced built-in
XWayland support/display. Its client and compositor exited normally; the owned
socket disappeared. No X11 client, X11 product backend or real display was used.
**This fixture is excluded from qualification and was not used for a GUI run.**
Supply an installed, explicitly identified no-Xwayland compositor such as Sway
with `xwayland disable`, headless backend and pixman support. No system install
was attempted. The ambient pkg-config search also lacks wayland-client,
xkbcommon, libudev and vulkan metadata, although versioned system libraries
exist; the full pinned GPUI native build closure remains unverified here.

Then validate the exact-source GPUI fixture on that owned compositor: actual
seat/toplevel/buffers and native visual rendering, selection/copy, mounted
canvas lifetime, aggregate budgeting and product cancellation/reap/recovery.
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
```
