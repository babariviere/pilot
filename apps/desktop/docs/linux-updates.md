# Linux GUI updates

Linux uses the same app-owned update controller and **Settings → Updates** as
macOS. Automatic checks follow the saved preference; checks and downloads never
authorize installation. **Install and restart…** reuses the existing editor,
draft/outbox/preferences durability checkpoints, preedit/pending/Unknown vetoes
and admission fences. Ordinary Quit never installs. Development builds without
an explicit trust configuration remain unconfigured.

## Signed full payload

The Linux release asset is `Pilot-Next-linux-x64.zip` (see [releases](releases.md)),
with exactly one
`Pilot Next/` root. It contains the GUI, visual helper, update helper, Node and
the entire daemon/kernel/resources/dependency runtime, using the existing
`bin/`, `libexec/`, `runtime/` layout. It is not the old headless archive.

`desktop-linux-x64-update.json` uses the existing signed envelope and maintained
ring Ed25519 verification. The signed object additionally requires `source`
(40 lowercase hexadecimal digits), `platform:linux`, `architecture:x86_64`,
the exact Linux asset name, size and SHA256, identity and monotonically ordered
build. macOS names and its native signing policy remain separate.

Linux additionally verifies a detached base64 Ed25519 signature in
`linux-gui-package.sig` over the **exact** `linux-gui-package.json` bytes. The
compiled public key is the same as the outer envelope's, never a downloaded key.
The inventory includes all payload paths, modes, file sizes/digests and relative
symlink targets; only the inventory itself and its detached signature are
excluded. Extra/missing/changed objects fail closed. The signed package has:

- `kind:linux-gui-distribution`, existing runtime `build` object unchanged;
- `application_id`, `bundle_build` and `short_version`;
- matching immutable source/target in the runtime and Rust input receipts;
- updater helper and its exact-source `updater-inputs.json` receipt;
- `bundled_launch`, `installer`, `updater` true, native visual execution false.

These booleans describe the package. They do not bypass runtime ownership or
native visual confinement. The Linux compiled code requirement is explicitly
`signed-linux-inventory-v1`, not a macOS Security requirement. GUI/helper builds
must share the approved key/repository/application/build configuration. No
production key or credentials are inferred, generated or rotated.

The assembler's production arguments are `--updater`, `--bundle-build`,
`--application-id` and repeatable `--accepted-capsule`. Development assembly
without them retains its existing unqualified package policy. The release
signer owns sealing the inventory and outer update metadata.

## Install, daemon preservation and recovery

Only an owned, writable install with safe ancestors is supported. No sudo,
system package-manager replacement or permission repair is attempted. The
extracted `Pilot Next` directory may be renamed or moved (for example to
`~/.local/opt/pilot-next`): the signed inventory identifies the install, not its
name, and updates replace it in place under the same name. Staging
and the permanent per-target lock use the existing installer journal. Linux
uses `renameat2(RENAME_EXCHANGE)` for a same-volume atomic whole-directory
exchange, persisting both directory parents and retaining the old payload.
Unsupported kernels/filesystems refuse instead of using a non-atomic fallback.

The installed helper requires its actual GUI parent, same-user private socket
and inherited lock. Linux pins the parent with `pidfd_open` and waits for an OS
exit event, never PID polling or a kill. It cannot install without the explicit
durable COMMIT. It verifies the archive and re-extracts/reverifies the complete
signed payload after actual parent exit. No COMMIT, cancellation, busy work,
expired reservation or unconfirmed safety leaves the installed app unchanged.

The existing private daemon owner proof and nonrenewable idle reservation bind
boot, process, profile, policy and exact retained runtime root. Linux capsules
use `runtimes/<SHA256 exact package inventory>/payload/runtime`. The candidate's
signed `update-runtime-policy.json` must admit that exact capsule digest.
Release packaging admits the runtimes of the newest published Linux releases
(see [releases](releases.md)). When no process holds the profile lease any more,
startup uses the app's own runtime instead of the recorded one.
Legacy/app-root/unproven runtimes refuse, rather than being moved or declared
independent. No daemon is stopped, restarted, replaced or migrated; no second
daemon may use its data. Existing history/profile data stays outside replacement.

Relaunch uses the new native executable directly, preserving the desktop-session
environment and the receipt-bound profile/policy. Spawn success is not startup
success. Only the GUI's actual durable startup checkpoint acknowledges the
transaction. Interrupted/uncertain installs preserve journals and both payloads
for contextual recovery inspection. There is no automatic rollback or cleanup.

## Native fixtures

`verify_update_lifecycle.py` supports native x86_64 Linux as well as arm64 macOS.
It compiles old/new **synthetic fixture applications** and the real helper with
public test-only trust, then uses private temporary apps, profiles, owned Node
processes and the actual owner/reservation sources. This verifies OS parent
exit, swap, relaunch ACK, cancel and expiry. It is not a production GPUI/full
runtime acceptance claim. `ci.sh updater-linux-tests` separately executes native
signature/full-inventory, source/platform, ACL, pidfd and atomic exchange tests,
plus the shared durability/preedit/pending/Unknown and recovery tests.

Full GUI/Wayland and bundled runtime qualification must be reported separately
with exact source and actual results. No test may use a real user profile or
install/restart the user's actual app/daemon.

`linux_update_native.py` exercises the actual GPUI application, complete produced
runtime, controller, draft writer, helper and startup acknowledgement. Build the
GUI with `native-probes` and helper with `native-linux,fixture`, using only the
script's public synthetic identity/key. Assemble source-matched old `100.1` and
new `101.1` packages; the new policy must admit the old inventory digest. Pass
`--old`, `--new`, an explicit owned `--wayland` socket and `--case` (`success`,
`wrong-signature`, `wrong-platform`, `wrong-hash`, `wrong-source`), and optionally
`--install-name` to install under a renamed directory. The fixture transport
replaces network input only, accepts only anonymous requests like the public
release, and is absent from normal distributions.
It refuses other compiled identities/keys and nonprivate temporary targets.
Keep closed fixture evidence on private disk: one full run uses about 2.6 GiB,
and `/tmp` may be memory-backed. The script reaps only its owned descendants.

Native x86_64 Wayland qualification passed all five cases on exact-source builds,
both debug and optimized (`--release`, with the test-only `native-probes`/`fixture`
features): actual old/new GPUI buffers, signed
whole-payload exchange after explicit COMMIT and OS parent exit, durable startup
ACK, retained Unicode draft/history, and one unchanged daemon boot/process/root
until startup ACK. After the ACK the new app pauses the old daemon's tools
(`POST /api/update/pause`), stops that exact process and starts its own runtime;
the success case checks that exactly one daemon, on the new runtime, remains.
Each invalid candidate affirmatively failed without installation or GUI exit.
These ran on a temporary filesystem, not distro-wide, power-loss, physical IME
or production-feed qualification.
`release.yaml` publishes the Linux GUI beside macOS on stable releases.

Two cross-binary regressions are covered: public trust fingerprints serialize a
fixed-order struct (GUI and helper may enable different JSON map features), and
an empty queued autosave wake cannot invalidate an unchanged durable checkpoint.
Real edits still invalidate that checkpoint and require a fresh acknowledgement.
