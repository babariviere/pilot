# Linux production runtime

The package is native **Linux x86-64**, not a distribution/release target. CI builds in a pinned
older-libc toolchain, audits every shipped ELF's architecture, GLIBC/GLIBCXX symbol requirements,
relative search paths and resolved libraries, and executes the extracted production tree after
deleting its staging tree. It then installs the relocated package for a disposable non-root CI user
through a real SSH/PAM login. The check ends all SSH sessions, verifies the same service PID remains
alive, reconnects, stops cleanly, restarts and checks the durable daemon identity. Source-tree runtime
tests alone do not meet these checks. This is not proof of deployment on any user's machine.

## Artifact and client contract

- `Pilot-linux-x64.tar.gz` contains one `runtime/` directory, private Node 24.21.0, static-musl jj
  0.46.0, production workspace/dependencies, built artifact libraries and `bin/pilot-runtime`.
  Native PTY dependencies build against the bundled Node headers in CI. No pnpm, compiler, global Node
  upgrade or build is needed on the destination.
- `runtime-manifest.json` schema 1 binds application version/tag/commit, platform/architecture,
  protocol range, private Node ABI, measured minimum glibc/libstdc++ versions and archive name/size/SHA256.
- `runtime-manifest.json.sig` is a base64 Ed25519 signature over the **exact manifest bytes**.
  `runtime-abi.json` inside the archive records every audited ELF. The manifest is the trusted checksum
  authority; an unsigned checksum downloaded beside a package is not authentication.
- `release.yaml` builds and validates these assets once from the stable tag's commit (never a newer
  main), then signs and uploads that same artifact after checking its commit matches the tag. PRs build
  and validate the package without signing it. Uploads run in parallel with the Mac update. A final `publish` job
  releases the draft only once both
  platforms' assets are uploaded. PR builds never access signing secrets or publish.
  Failed packaging, service or signing checks block publication. Retry through the existing main-only
  `release_tag` input. Published releases cannot be overwritten by this path.

Configure a dedicated Ed25519 PEM private key as the Actions secret `LINUX_RUNTIME_PRIVATE_KEY` and its
raw 32-byte public key (base64) as repository variable `LINUX_RUNTIME_PUBLIC_KEY`. Keep the private key
out of the repository. For example, generate it privately with `openssl genpkey -algorithm ED25519` and
derive the raw public bytes from the final 32 bytes of its DER SPKI public export. Never log the private
key. The signing script requires a matching pair. The Mac bundle pins the variable as
`PilotLinuxRuntimePublicKey`. Key rotation requires a trusted new Mac bundle, not an asset-supplied key.

`PilotCore.LinuxRuntimeManifest.verified` verifies the signature, expected app version/release tag and
protocol before accepting metadata; `verifyArchive(at:)` checks exact size/SHA256 before extraction
with bounded memory, off the UI actor.
Select only the three named, uploaded assets from the authenticated GitHub release via
`UpdateRelease.linuxRuntimeAssets()`, download using `UpdateRepository.assetURL(id:)`, and reuse the
existing credential/redirect policy. Do not pass GitHub credentials over SSH or trust download URLs
from the manifest. The installer must stage/extract safely, reject unsafe archive entries, probe
the target, and wait for an owned SSH tunnel's hello identity/protocol validation before mutations.
Automatic SSH delivery is provided by `PilotCore.LinuxSSHBootstrap`; see
[the initial setup API](../../docs/ssh-bootstrap.md). Onboarding UI remains separate.

## Service and prerequisite contract

Extract a verified package into a private, versioned directory. Run its **bundled**
`runtime/bin/pilot-runtime probe`. JSON schema 1 lists each requirement, package-manager plan and
explicit privilege/linger setup command; unmet requirements exit 2. `install` fails before writing
when prerequisites or the production native smoke fail. There are no sudo prompts, implicit package
installs, credential transfers, login-file sourcing or shell-profile changes.

Required capabilities: Linux x86-64, compatible ELF loader/libc/C++ runtime, dedicated non-root account,
git, bash, a reachable `systemctl --user`/D-Bus manager, and `loginctl` reporting `Linger=yes`.
The helper discovers dnf, apt-get or yum and returns an argv package plan for **explicitly approved**
administrator setup. In particular dnf installs git/bash/systemd/dbus-daemon/util-linux/libstdc++, not
Node/pnpm/jj. An unknown package manager is an explicit manual-prerequisite case, not a guessed distro.
Administrators must separately approve `sudo loginctl enable-linger <user>` (allows user services to
start at boot and outlive logout); the production helper never executes it. If the user manager is
still unavailable, its D-Bus/session setup must be fixed explicitly. Kernel/security-policy sandbox
capabilities remain a separate gate from service checks, consumed from daemon hello. A running
service does not imply coordinator isolation is available.

The unit's non-fatal `ExecStartPre` runs `linux-coordinator-probe.ts` under the real service policy and
records `coordinator-preflight.json` in the private runtime. Setup requires that result and separately
requires `hello.capabilities.coordinatorIsolation`. Missing tooling/policy is not a daemon outcome.

`install` atomically writes/enables `~/.config/systemd/user/pilotd.service` without starting it.
`start`, `status`, and `stop` only control a unit whose complete content matches that runtime's expected
unit. Existing foreign/different units are never overwritten, shadowed or implicitly restarted.
The unit uses absolute private tool paths, private umask, user data at `~/.local/share/pilot`, journal
logs (`journalctl --user -u pilotd`), loopback-only daemon binding and on-failure restart. SIGTERM gives
the daemon up to 120 seconds to persist/drain sessions; remaining processes are then killed together.
Live jobs and PTYs do **not** survive a stop. Planned updates must separately gate on their blockers and
drain, not call this initial installer to overwrite a running service. An SSH disconnect performs no
service operation. Logout/reboot persistence requires verified linger plus the enabled default target;
boot survival is configured here, while CI directly exercises logout and service-manager restart.

The separate [safe update flow](../../docs/safe-remote-updates.md) stages another signed runtime,
uses an independent `pilot-update.service`, fences daemon startup and admissions, and waits for
actual terminal/job/transfer clearance before changing the owned unit. Production-package CI
exercises its SSH delivery, real resource blockers, updater crash recovery and retained receipt.
