# Initial Linux runtime setup over SSH

`PilotCore.LinuxSSHBootstrap` is an app-callable setup API, not onboarding UI or a runtime updater.
It uses the system OpenSSH alias, existing authentication and host-key policy from
[the managed transport](ssh-transport.md). No cloud access flow, model chat, global tool upgrade or
credential transfer is involved. This implementation has disposable fixture coverage, not a deployed
devbox claim. Stable signing configuration and complete release assets remain operational gates.

## Calling contract

1. Obtain authenticated stable GitHub release metadata through the existing update access layer.
   `LinuxRuntimePackage.download` selects only the three named uploaded Linux assets, reads
   `PilotLinuxRuntimePublicKey` from the signed app bundle and reuses `UpdateFeed.resolve` so GitHub
   credentials go only to the configured repository's API asset URLs, never SSH or the CDN. The caller
   supplies the expected app version/tag, an unused local archive destination and the update token.
   Missing signing configuration/assets fail before SSH. Exact manifest signatures, protocol/platform,
   version/tag and archive size/SHA256 are mandatory. No source/unsigned fallback exists.
   `LinuxRuntimePackage.verified` supports already-downloaded assets with a host-configured pinned key,
   including disposable signed fixtures. Never obtain its key from a release asset or remote host.
2. Call `LinuxSSHBootstrap.install(configuration:package:hostId:pinnedHost:)` after explicit setup
   authorization. Initial service setup uses the distribution interface's fixed loopback port 4319.
   The API rehashes the local archive before transfer and sends only archive bytes plus the bundled
   helper. Python 3.9+ is a detected setup prerequisite, not a global Node/package-manager requirement.
3. The remote helper serializes setup with a private flock, verifies transfer size/hash, rejects unsafe
   archive paths, special files, privileged modes and escaping/link-ancestor entries, then publishes
   one complete content-addressed runtime under `~/.local/share/pilot/runtimes/<archive-sha>/runtime`.
   Expanded bytes/entry counts and local SSH output/time are bounded. Files never extract into data
   or credential locations. Interrupted marked uploads are discarded on the next setup; complete
   runtime directories are reused, never overwritten.
4. The packaged `service.mjs` probes actual capabilities, runs the native smoke, installs/enables only
   its exact unit, and starts it without restarting an active service. A different/foreign unit is a
   blocker requiring the separate safe update/repair flow. Setup verifies the active PID, persistent
   enablement, linger and durable daemon/storage identity. No rollback stops the remote service.
5. The unit runs `linux-coordinator-probe.ts --output <runtime>/coordinator-preflight.json` as an
   `ExecStartPre` in the actual service user's environment and policy, including administrator drop-ins.
   Its failure is recorded without preventing daemon startup. Setup treats an unavailable/missing
   result as a separate sandbox blocker, not daemon failure. SSH-shell binary detection is insufficient.
6. Only after `ManagedSSHTunnel` acknowledges ownership of its forward does its hello validator check
   protocol, Linux x64, exact runtime version, independent execution, both persistent identities and
   **separately** `coordinatorIsolation`. Nothing returns a usable connection before this gate.

`LinuxBootstrapConnection` returns a candidate `HostRef` and the owned `ManagedSSHTunnel`. The caller
owns explicit user-confirmed enrollment/persistence, then must supply the saved pin on every retry.
An identity mismatch/missing previously pinned identity fails before install/start. Never silently
re-pair a restored/cloned/different host. Consume `tunnel.states()` and recreate host-qualified clients
on reconnect, not from a retained first forwarded URL. Await `disconnect()` on ordinary teardown.
Remote agents/service remain independent. The [lifecycle layer](remote-lifecycle.md) owns explicit
enrollment, offline summaries and receipt reconciliation. Independent provider setup terminals are
a separate integration, not implicit setup side effects here.

## Failures and recovery

`LinuxBootstrapFailure` provides a small code/detail plus optional structured JSON plans. SSH
diagnostics are discarded, never logged/persisted. Unknown/changed host keys or interactive auth must
be repaired outside the app. Python detection reports the available dnf/apt-get/yum argv plan.
Service probes report actual missing capabilities and explicit package/linger privilege plans.
Private Node/loader/ABI errors reference the signed manifest's libc/C++ floors, not a distro name.
Unknown package managers require explicit manual prerequisite setup, not guessing a distribution.

For a sandbox blocker, review the service-policy probe detail, install bubblewrap if missing using the
reported manager (including dnf), and inspect per-service namespaces/AppArmor/SELinux/seccomp policy.
The installer never executes sudo or disables global policy. An administrator must approve package,
linger or policy changes separately. A later explicit safe restart may be required after policy repair;
this initial setup API never restarts an active daemon or interrupts live jobs/terminals itself.

An SSH timeout/drop is an ambiguous setup outcome, not an agent failure. Repeat the **same authenticated
package** to reconcile staging, unit enablement/start and final identity/hello. Concurrent setup reports
busy rather than stealing a lock. A lost success response is harmless: replay keeps the service PID and
identities. A different runtime is deliberately not an update transaction. No API execution mutations
or chat creation are replayed by setup.

## Verification

- `scripts/linux/test_ssh_bootstrap.py`: bounded extraction/transfer, partial/lost-reply reuse, unsafe
  archives/links, path ownership, pinned mismatch, explicit dnf/linger plans and separate sandbox gate.
- `LinuxSSHBootstrapTests.swift`: local trust/package gates, SSH policy, bounded owned-process input/
  output/deadlines and complete hello validation. Existing tunnel fixtures cover owned-forward
  acknowledgment, collisions, finite reconnects and cleanup.
- Linux production CI: extracted real production package delivered over disposable SSH, missing-linger
  plan, real service-policy sandbox probe, repeat setup without PID change, logout/reconnect, orderly
  stop and persistent identity across service/user-manager restarts. Sandbox permissions in this fixture
  are scoped to its system bwrap executable, not global userns policy weakening.
- Full Node, native Swift tests and app bundling run in CI. No real devbox writes or release deployment.
