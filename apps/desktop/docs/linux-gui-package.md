# Linux Wayland GUI package candidates

This is source tooling for an **unqualified development candidate**, not a
Linux release, installer, working bundled Local launch or supported updater.
The old `Pilot-linux-x64.tar.gz` is a headless runtime, not this GUI package.
No production release workflow, feed, signing key or installed app is changed.

## Minimal relocatable layout

```text
candidate/
  bin/pilot-next                  relative shell entrypoint
  libexec/pilot-desktop           real Rust GPUI GUI, embedded glyph assets
  libexec/pilot-visual-worker     sibling helper, execution still refused on Linux
  runtime/                       Node24 + daemon/kernel/protocol + prod dependencies
  rust-inputs.json                exact tested source/target/binary hashes
  runtime-inputs.json             exact source/target/full runtime inventory
  linux-gui-package.json         bounded payload inventory and disabled policies
```

The assembler reuses `bundle_runtime.py`'s source identity, duplicate-key-safe
JSON, bounded inventory, SHA256, relative-link and permission checks. It does
not reuse macOS signing, native Power/System Events helpers, `Contents` layout
or installer assumptions. Assets are embedded by `ChromeAssets`/GPUI-Kit; the
visual helper remains beside the GUI to match its existing discovery contract.
Legacy artifact libraries remain inert resources where unsupported.

Every input must come from the **same immutable full commit**, not live modules
or an installed app. Executable `manifest.json` uses the existing CI receipt
shape (`tested_sha`, `target`, `binaries` with name/bytes/sha256), with target
`x86_64-unknown-linux-gnu`. The separate runtime receipt has `source`, `target`
and `files` from the shared bounded inventory. It is outside the runtime to
avoid a self-hash. `runtime-build.json` uses the existing daemon contract:
schema1, exact source/version/Node24, protocol1, platform `linux`, arch `x64`.
Missing daemon/kernel/skills/generated usage worker/artifact/dependency
resources are refused. Receipt hashes establish consistency, not publisher
authentication or proof that an arbitrary supplied producer was trustworthy.

`linux_gui_package_runtime.py` now provides the separate runtime input producer.
It extracts a named Git commit into a private source tree, uses fresh
HOME/config/data/cache/tmp directories and the existing Linux production closure
builder (pinned Node/jj, frozen production dependencies, generated resources,
every-addon ABI audit and offline faux-provider/PTY smoke). Its legacy headless
archive and unsigned manifest exist only as temporary staging intermediates,
never as the GUI distribution, production upload or signed release. No existing
release workflow is called or modified. The builder's existing ABI ceilings
remain fail-closed. Header/expanded-byte preflight and safe data extraction
precede the final bounded inventory. The producer writes exact source/tree,
producer/builder hashes, runtime metadata and full-inventory receipt. It does not
enable Linux bundled launch or attest the existing user's runtime.

Use a native build environment with the required static C++ runtime. The
qualification run uses an unprivileged, digest-recorded Debian11/Python3.13
container on the native x86_64 host, not host package installation or a
Homebrew-specific compiler workaround. Missing archives and ABI/relocation
audit failures remain real build failures, never silently relaxed requirements.

```sh
python3 apps/desktop/scripts/linux_gui_package_runtime.py \
  --source "$SOURCE" --output /fresh/runtime-inputs
python3 apps/desktop/scripts/linux_gui_package.py assemble \
  --source "$SOURCE" --runtime /fresh/runtime-inputs/runtime \
  --runtime-receipt /fresh/runtime-inputs/runtime-receipt.json \
  --executables /matching-linux-binaries --output /fresh/candidate
python3 apps/desktop/scripts/linux_gui_package.py verify /fresh/candidate
# Native Linux x86_64 only. Trusted source-built inputs, never downloaded unknown ELF.
python3 apps/desktop/scripts/linux_gui_package.py dependencies /fresh/candidate
```

Assembly never executes Node, the daemon or the GUI. Verification hashes every
payload object, including added files, modes and relative symlinks. An existing
output is never overwritten. Inputs remain intact on a failed fresh assembly.
Limits match the shared seam: 30,000 objects, 2GiB expanded, 256MiB/file and
8MiB per JSON receipt. A larger closure fails rather than relaxing these bounds.

## Launch and ownership audit

`bin/pilot-next` without arguments explicitly requests `--bundled`, so a Linux
candidate cannot silently open synthetic fixtures and look like a working Local
app. Current `bundled_runtime::start` refuses everything except arm64 macOS.
The package **does not enable that path on Linux**. Explicit fixture/help modes
remain available; explicit `--local` retains the existing external-daemon
contract, never starts a bundled daemon, and is not used by these checks.

The source-owned Local profile contract remains unchanged: permanent SQLite
lease, reserved listener, exact build/source/profile live challenge, activation
before service graph admission, no replay and honest refusal/Unknown. The
launcher never chooses another profile/port, adopts a legacy owner, starts a
second daemon, stops/replaces/migrates one, or claims protocol-only compatibility.
No Linux retention, launch or confinement contract is inferred from macOS.
Installer and auto-update remain disabled, as does native visual execution.

## Native checks and evidence boundaries

The existing shared Linux Rust CI job already builds both production binaries,
uses private outputs and the mbx CPU2/4GiB wrapper. Its additive
`linux-gui-check` phase reuses those debug binaries, moves them to a path with
spaces, checks relocated help and the no-compositor refusal even with DISPLAY
set, audits **every ELF** via readelf/ldd, then launches only a synthetic fenced
message against an owned headless Weston compositor and software Mesa. It
requires actual Wayland `get_toplevel` and a `wl_surface.attach` rendered-buffer
request, not merely a successful compiler or living process. No X server is
started; inherited user/Pilot/Node/provider/network configuration is excluded.
Only the two exact owned fixture processes are terminated and reaped.

`target/ci-linux-gui-fixture.json` is printed in the CI log and binds the tested
commit/tree, binary sizes/hashes, resolved dependency paths, required GLIBC and
GLIBCXX symbol versions and exact observations. Unresolved libraries, absolute
dependencies, escaping RUNPATH and wrong ELF architecture fail. System X11
libraries may be linked transitively by GPUI; this does not enable its X11
backend. Runtime startup still selects WAYLAND only after a real socket connects.
There is no distro-wide minimum ABI claim: recorded versions are requirements
of those exact binaries on that exact runner, not the headless runtime's ceiling.

For explicitly authorized workstation qualification when Weston is unavailable,
the native probe accepts `--existing-wayland-socket /run/user/UID/wayland-0`.
This shows a short-lived synthetic window, with its own HOME/config/data, on the
explicit absolute same-user socket. The probe never starts, stops, owns or
reconfigures that compositor. The receipt distinguishes this mode from owned
headless Weston; software rendering is still selected. CI keeps its owned
compositor default. Neither mode is a live daemon or performance test.

**The initial source-only slice executed no native Linux qualification.** Its
host was macOS arm64; its Docker daemon was also
Linux arm64, not the required native x86_64 target. Existing historical Wayland
evidence is not evidence for these new package bytes. CI registration is not a
passing CI receipt. A green fixture receipt still is not full runtime evidence.

The later native workstation run is recorded in
[Linux GUI package evidence](../evidence/linux-gui-package.md). It supersedes the
environment limitation above for the exact binaries tested there, not for
unbuilt packages, other distributions or the disabled platform capabilities.

Remaining acceptance gates:

1. Separately qualify any Linux bundled-launch/retention/ownership integration
   with source-owned fixture profiles, lease contention, compatible reuse,
   legacy refusal and activation uncertainty before changing the platform guard.
2. Qualify native visual confinement separately. Keep refusal until then.
3. Real Wayland GPU/distribution, keyboard/IME and frame-pacing acceptance remain
   outstanding. Headless Weston software buffers do not establish those.
4. Installer/update design and implementation need separate qualification. Do
   not publish/install this candidate or relabel it as a production update.

macOS packaging and retained-runtime integration remain owned by the existing
[bundled runtime](bundled-runtime.md) and
[runtime retention design](runtime-retention-design.md) contracts.
