# Immutable runtime retention for app updates

Status: **design only, not implemented or accepted**. The user authorized this
design after the whole-bundle replacement audit. It does not authorize backend
implementation, a weaker source gate, daemon lifecycle actions, production
configuration, installation, signing-key use or rollout.

## Existing source contract

Audited against source base `74e1d0e496a7a1e1ab53d1f907d00fbbde1cc206`.
The separate updater cfg-only repair changes compilation availability, not these
contracts.

- [bundle_runtime.py](../scripts/bundle_runtime.py) places Node, daemon, kernel,
  dependencies and resources at `Contents/Resources/runtime`; Power and System
  Events helpers are siblings under `Contents/Helpers`.
- [bundled_runtime.rs](../src/bundled_runtime.rs), `start`, validates that bundle
  and launches its Node/launcher directly from the installed app path.
- [runtime-launch.ts](../../../packages/daemon/src/runtime-launch.ts),
  `launchRuntime`, deliberately leaves an activated daemon independent of GUI
  lifetime. Only its exact preactivation child may be reaped on cancellation.
- [runtime-bootstrap.ts](../../../packages/daemon/src/runtime-bootstrap.ts)
  binds source, package version, protocol, platform, architecture and exact Node
  version. [runtime-owner.ts](../../../packages/daemon/src/runtime-owner.ts)
  additionally proves boot/home/port/hello identity and a held profile lease.
  Reuse currently requires **exact build equality**, including source.
- [sessions.ts](../../../packages/daemon/src/sessions.ts), `forkWorker`, uses
  the module-relative kernel entry and Node fork. Future worker starts, lazy
  imports and resources still need their original paths after GUI exit.
- [power-helper.ts](../../../packages/daemon/src/power-helper.ts) and
  [system-events-helper.ts](../../../packages/daemon/src/system-events-helper.ts)
  derive helper paths from the enclosing `Contents/Resources/runtime` prefix.
  Retaining only the Node executable or loaded modules is insufficient.
- [installer.rs](../updater/src/installer.rs), `apply_after_exit`, swaps the
  complete app and retains its old inode at a *different path*. Its journal
  tracks bundle identity/phases, not runtime retention or client durability.
- [hello.ts](../../../packages/protocol/src/hello.ts) exposes protocol1,
  minimum-client protocol1 and feature capabilities. Neither a matching protocol
  nor `independentExecution` proves exact resource retention or safe reuse by a
  different source build.
- [update-gate.ts](../../../packages/daemon/src/update-gate.ts) and
  `SessionManager.prepareUpdate` provide a 30-second admission lease, not an
  exit-spanning ownership receipt. `pauseForUpdate` drains workers. Swift's
  `Daemon.pauseAndStopForUpdate` stops a launch agent. Neither is a permitted
  substitute here.

Consequently, a daemon already launched inside the replaceable app cannot be
retroactively made independent by copying/moving its files. Keep that app in
place and refuse install while its ownership/resources are unproven. No stopping,
migration, second daemon, alternate data home or guessed PID is a recovery path.

## Layout alternatives

| Alternative | Benefits | Safety/cost |
| --- | --- | --- |
| Keep current app and swap/rename it into backup | Smallest packaging change | Reject: existing absolute paths now resolve to new payload or disappear. Open executable descriptors do not preserve later imports/helper starts. |
| Copy a complete verified app to a stable content-addressed runtime capsule **before activation** | Preserves signed closure, current relative paths and helper lookup; no mutation of active runtime | Recommend initially. Duplicates GUI bytes but avoids inventing a new runtime signing/container format. Never launch its GUI/update helper. |
| Extract a smaller separately sealed runtime/helper capsule | Lower retained bytes | Later option: requires new closure/signature format, helper lookup and native signing verification. Not minimal. |
| Versioned GUI apps plus a mutable launcher/alias | Stable version roots | Changes installation/Launch Services/default-app and updater semantics. Defer. |

Recommended illustrative layout, under a separately scoped private Next support
directory, **not** the daemon data home and not a generic purgeable OS cache:

```text
RuntimeStore/
  .store.lock                    permanent inode, never unlink
  <capsule-id>/Pilot Next.app/    immutable verified copy, never renamed/replaced
  records/                       bounded durable publication/reference receipts
Installed/Pilot Next.app/         GUI and app-owned update helper, replaceable
```

The capsule ID binds canonical inventory digest, exact build tuple and verified
code identity. A bare source SHA is not a complete payload identity. References
must not use a mutable `current` symlink. The app still ships the complete
coherent runtime for offline fresh startup; a capsule is published from verified
bytes before launching Node, never reconstructed from live checkout modules.
The app-owned visual worker/framework must be classified separately: GUI-owned
instances must finish/cancel and join before replacement, or also use a proven
retained closure. No claim of independence based only on the daemon path.

## Identity and compatible reuse

Keep four identities separate:

1. **GUI release**: Next application ID/channel, monotonic build, short version,
   exact source, full bundle signature requirement and signed archive identity.
2. **Runtime capsule**: full exact runtime build tuple, canonical inventory
   digest, signature/code identity and canonical retained-root inode identity.
3. **Live owner**: canonical profile/home, port, random boot, process identity,
   daemonId/lineageId, profile lease and challenge-bound proof.
4. **Installation attempt**: operation/generation, configuration digest, old/new
   GUI and capsule identities, stage/target inodes and durability receipts.

Do not replace exact source equality with version ranges, protocol equality,
`record.build` copied into an expected value, or a feed-provided trust key.

A later, explicitly authorized compatibility contract could let a signed GUI
declare a bounded **exact allowlist** of supported runtime tuples and capsule
digests. Initially allow only its own runtime. Supporting a prior runtime needs
separate synthetic compatibility evidence for that exact pair, protocol bounds
and every required capability, while the owner proof still checks its own exact
source/runtime tuple. No general cross-version compatibility is inferred.
Signing/manifest schema changes need review; v1 denies unknown fields today.
The declaration must be covered by the trusted app seal/signed update contract,
not discovered from writable owner records or the network.

Possible results: reuse the proven supported owner; wait for its startup;
refuse unsupported/unproven/changed owner. Only a proven vacant managed profile
may start the selected capsule through the existing exclusive profile-lease and
listener reservation. A competing start loses admission before service import.
A new app may truthfully report "App updated; running daemon unchanged" only
after startup/durability succeeds; do not relabel that daemon's version.
An incompatible running owner leaves install deferred, not a promise that restart
will repair it. Existing `--local` is not an automatic bypass for failed proofs.

## Publication, lifetime and cleanup

Publish under a private same-volume staging directory with a bounded inventory,
create-new/no-follow writes, internal relative links only, native signature and
closure validation. Flush files/directories, then atomically publish the
never-overwritten content-addressed capsule under a store lock. Record its exact
identity durably before launch. Revalidate a pre-existing matching ID rather
than replacing it. Store contents must never inherit writable ACL grants.

Launch daemon and all resource-dependent descendants from that canonical stable
root. Proposed owner attestation must bind root/capsule identity and proof
schema, and distinguish legacy app-root launches without adopting/migrating them.
The startup receipt binds the capsule actually executed, not just the selected
one. A GUI disconnect must not release runtime retention.

**Minimal first implementation has no automatic garbage collection.** Bound
retained publication (proposed four capsules / 8GiB total, subject to existing
per-bundle 2GiB limit); exhaustion refuses a new publication/update rather than
evicting anything. Retain incomplete/uncertain publication evidence for recovery.
Count/timeouts/PIDs, absent GUI clients, or a stale reference file never prove
that a capsule is unused. Durable references are diagnostic retention claims,
not permission to delete.

Future explicit cleanup needs a separately designed exclusion/lease contract
covering daemon, workers, helpers, outstanding launches and update/recovery
references, including orphan descendants and reboot. Holding one daemon lease
alone does not prove all descendants have exited. Unknown means retain. Never
unlink profile/store lock inodes or open/close unrelated descriptors on the
SQLite leased inode. No automatic cleanup/rollback is included in this proposal.

## Install preparation and receipts

Retained paths solve resource replacement, **not** user-state durability or the
task's active-work/preedit veto. Keep these requirements:

1. Verify candidate signature/archive/full bundle/config and its supported
   runtime policy. Pin current owner/capsule and prospective GUI identities.
2. Fence app input, new operations, navigation that can write, and all relevant
   Settings/forms. Preserve mounted preedit/unsaved text; veto rather than
   discarding, force-submitting, cancelling tools or clearing Unknown delivery.
3. Capture exact acknowledged edit/outbox/preferences revisions after final
   writes. Failure, pending save, Unknown durability, active work or preedit
   defers installation. An ordinary Close flush or 200ms quit timeout is not a
   receipt. Hold fences through helper preparation, COMMIT and process exit.
4. A **new, separately authorized** idle-only daemon admission contract is
   needed if an exit-spanning active-work fence remains required. It must
   atomically bind home/boot/runtime/source and operation/generation, veto busy
   or Unknown, cover all admission sources, and never pause/stop running work.
   The current 30s ready boolean is insufficient. Specify bounded expiry,
   helper ownership transfer and crash release before implementation; expired
   or lost receipts cannot authorize a late COMMIT. Do not introduce an
   unbounded orphan freeze or renew a timer and call it durable.
5. Helper independently validates exact source/config/generation, staged and
   retained capsule identities, target inode and held ownership receipts.
   Revalidate fresh client revision ACKs before explicit durable COMMIT.
   A lost COMMIT ACK remains RecoveryRequired with fences held. Ordinary Quit
   sends no COMMIT and must not install.
6. After OS-observed parent exit, swap only the GUI app. Do not move/change a
   capsule, signal a daemon, release its profile lease or start a replacement.
   Relaunch with an exact transaction receipt. New app durably loads its own
   stores, validates the actual retained owner/capsule and only then ACKs
   startup. GUI-loaded, daemon-compatible and runtime-started are distinct
   outcomes; `open` success is none of them.

Do not use `Runtime::Independent` until the entire replaced-path exclusion is
proved, or `SharedStopped` without a permitted actual producer. The current
Safety type is not itself proof and needs integration-owned non-forgeable
receipt validation. No existing daemon lifecycle mutation is authorized here.

## Crash, recovery and security

- Before capsule publication: discard only proven owned unpublished staging;
  never erase ambiguous references or install journals.
- Published capsule, before activation: retain it. Existing preactivation
  cleanup can reap only the owned child, with its established cleanup receipt.
- After activation: daemon/capsule survive GUI/helper death unchanged.
- Before COMMIT: original app stays installed; cancellation/ordinary Quit
  cannot arm replacement.
- After COMMIT or swap ambiguity: inspect exact journal/target/stage identities;
  no blind retry, second swap, cleanup or automatic rollback. Retain old app
  and both capsule references. Stale startup arguments cannot ACK another
  generation. Recovery UI must distinguish pending, committed, swapped,
  startup-unconfirmed and acknowledged states.
- Reject hostile ancestors, symlinks/hardlinks, writable POSIX/ACL paths,
  wrong user/device/inodes, escaping links, corrupt/duplicate/oversized
  manifests, unrecorded payloads and native non-system dependency escapes.
  Recheck held descriptors versus names at mutation boundaries.
- A private same-user owner proof is not remote authentication or protection
  against that user intentionally mutating their own files. Preserve loopback
  restrictions and existing denial/environment policies. No broader credential
  lookup, token storage, Swift identity/feed reuse or permission migration.

## Required synthetic qualification

Use fixture keys/network/temp profiles/bundles and owned children only:

- Assemble real arm64 macOS15+ closure including Node/kernel/native helpers,
  GUI/update helper, visual worker/framework and source/hash receipts. Launch
  from a retained capsule, relocate/replace the installed GUI, then trigger a
  new kernel import/helper/resource read from the *unchanged exact old paths*.
- Prove exact supported-owner reuse and unsupported-source/capability refusal;
  concurrent starts still reserve one profile/listener before import. Legacy
  app-root owners block install. Never test using the user's daemon.
- Exercise capsule publication/collision/inode/path/ACL/signature tampering,
  bounded exhaustion without eviction, concurrent GUI references and orphan
  descendants. Kill fixture owners only within fixture cleanup authority.
- Run actual helper preparation through fresh durability/preedit/busy/error/
  Unknown vetoes, generation changes, cancellation, expired ownership, COMMIT,
  parent exit, swap, relaunch and startup receipt/recovery. Inject failures
  before/after every fsync/rename/ACK. Preserve uncertain evidence.
- Mount real Updates Settings light/dark at680/1100 with keyboard/focus/IME,
  pending/cancel/deferred/error/recovery states. Static mocks alone do not
  qualify lifecycle, motion, OS signing/Launch Services or acceptance.
- Compose standalone updater CI registration and retain strict cfg/platform
  checks. Linux tests are not macOS native/OS qualification. No CI polling.

## Implementation authority still required

Proposed implementation seams, not approved changes:

| Owner | Expected source boundary | Narrow responsibility |
| --- | --- | --- |
| Packaging/client | `scripts/bundle_runtime.py`, `src/bundled_runtime.rs`, new private runtime-store module | Verify/publish full sealed capsule, launch only from its fixed root, pin publication receipts. Preserve sanitized environment and startup cleanup. |
| Daemon bootstrap/proof | `packages/daemon/src/runtime-bootstrap.ts`, `runtime-owner.ts`, `runtime-launch.ts` | Versioned capsule/root attestation and exact supported-pair selection; preserve exclusive pre-import admission and legacy refusal. Requires backend authorization. |
| Idle admission | `packages/daemon/src/sessions.ts`, `update-gate.ts`, `server.ts`, resource admission owners | A separately reviewed, helper-owned exit-spanning reservation, no active-work pause/stop. Audit all mutation/admission sources before claiming completeness. Requires backend authorization. |
| Shared protocol | `packages/protocol/src/hello.ts` and related types, matching `apps/macos/Sources/PilotCore` types if public fields change | Optional versioned capability/proof/receipt fields, legacy callers unchanged. No inference from protocol1 alone. Requires protocol/backend authorization. |
| Updater | `updater/src/manifest.rs`, `installer.rs`, `helper.rs`, `worker.rs` | Authenticated policy/config/source binding, retention references, exact reservation/staging receipts, startup/recovery journal schema. No blind v1 journal upgrade. |
| GUI lifecycle | app startup/Settings/quit and editor/outbox/preferences owners | Non-forgeable exact-revision receipts, preedit/unsaved/active-work veto and admission fence, explicit COMMIT, receipt-aware startup. Coordinate editor ownership before edits. |

The exit-spanning reservation's transfer, bounded lifetime and atomic
revocation rules remain a protocol-design blocker, not an invitation to add a
longer polling lease. A backend timeout must never silently release ownership
while the helper can still commit a late installation. The implementation
proposal must provide a state machine proving this exclusion under delayed
messages, helper death and GUI death, or continue to refuse install.

Recommended next approval is a narrow implementation proposal covering capsule
publication/startup selection, proof-schema/root binding, exact supported-pair
compatibility policy, helper journal/receipt extension and the idle-only
exit-spanning admission contract. Enumerate changed backend/protocol/native
files and synthetic fixtures first. Backend implementation, changed runtime
reuse, new automatic cleanup, production feed/signing, live install/restart and
default-app changes remain **unauthorized**. The integrated safe-install task
remains blocked pending that contract, not completed by this design.
