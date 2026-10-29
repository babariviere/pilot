# Bundled Local runtime

The macOS arm64 development bundle contains its own Node24, daemon, kernel,
protocol, production workspace dependencies, bundled tools/skills/profiles,
generated usage worker, artifact libraries, Rust visual worker and native
Power/System Events helpers. It does not find an installed Swift app, external
Node, Homebrew runtime, checkout or development `node_modules` at launch.
Host tools used by agents (such as Git, jj and language toolchains) remain host
capabilities, not newly bundled or newly authorized software.

This is ad-hoc development packaging, not a production release, notarized app,
signed update feed, launchd installation or production updater activation. The separate
identity is `com.babariviere.pilot-next`; the native event helper uses
`com.babariviere.pilot-next.system-events`, not Swift's application identity.
No signing secrets, existing application identifiers or permissions are changed.

## Build from one immutable source

Run on a macOS arm64 **build/CI host**. Native helper builds use the standalone
Rust `apps/power` crate and direct Swift compilation of retained `PilotSystemEvents`
via `scripts/build-native-helpers.sh`, not the Swift GUI package/build/vendor closure.
The Swift compiler is still required for System Events. See
[`apps/power/PORTING.md`](../../power/PORTING.md) for protocol/grant compatibility
and the injected-test versus hardware-qualification boundary.
Rust executables must have `manifest.json` identifying the same immutable
40-character commit, configuration and binary hashes. The `rust` subcommand builds
unconfigured development inputs from git objects using the pinned Rust/mbx tools.
Linux CI executables cannot be relabeled as macOS inputs.

```sh
SOURCE=<full-40-character-commit>
python3 apps/desktop/scripts/bundle_runtime.py runtime --source "$SOURCE" --output /fresh/runtime
python3 apps/desktop/scripts/bundle_runtime.py native --source "$SOURCE" --output /fresh/native
python3 apps/desktop/scripts/bundle_runtime.py rust --source "$SOURCE" --output /fresh/executables
python3 apps/desktop/scripts/bundle_runtime.py bundle --source "$SOURCE" \
  --runtime /fresh/runtime --native /fresh/native --executables /fresh/executables \
  --output '/fresh/Pilot Next.app'
python3 apps/desktop/scripts/bundle_runtime.py verify '/fresh/Pilot Next.app'
```

`runtime` and `native` extract `git archive` objects to private temporary source
trees. Runtime assembly reuses Swift's production-runtime installer, never live
workspace modules. Its smoke uses a temporary HOME/config/data and faux providers,
with inherited broker/Node hooks removed. Native helpers are rebuilt from the
same source, not copied from an installed app. Existing destinations are refused.
Both development and production macOS bundles use the shared plane icon at
`apps/macos/Resources/AppIcon.icns` from that same source snapshot, not the
generated N development mark. Retain this shared asset (or move it with both
packaging callers) when retiring the Swift app; the Next bundle identity stays
`com.babariviere.pilot-next`.
Native closure verification rejects the wrong architecture and unexplained
non-system dynamic-library dependencies. Ad-hoc leaf signing precedes inventory
generation; the outer app seal comes last, without `--deep` re-signing helpers.
The main executable cannot hash its own resource seal; its exact-source receipt
is checked before assembly and the outer signature seals the completed bundle.

`Contents/Resources/bundled-runtime.json` records the full payload inventory,
relative link targets, permissions, sizes and SHA256 digests. Runtime build
metadata binds source, daemon version, protocol, platform/architecture and exact
Node version. Counts and expanded bytes are bounded (30,000 entries,2GiB;
256MiB per file;8MiB manifest). Hashes establish integrity, **not publisher
authentication**. Production authentication/installation remains the updater's
separate signature and platform-security contract.

## Launch modes and ownership

- A bundle-shaped no-argument executable launch uses the bundled runtime.
  A damaged/missing manifest fails visibly instead of silently opening fixtures.
- `--bundled` explicitly requests that same path on arm64 macOS. The separate
  [Linux Local contract](linux-local-runtime.md) covers x86-64 Wayland packages.
- `--local` and `--local-check` keep their existing, explicit external-daemon
  behavior. They do not start, stop, upgrade or attest a daemon. Existing Local
  chat reads are still unauthenticated loopback reads, not newly authenticated API.
- Unbundled no-argument/explicit fixture modes retain synthetic behavior.

On macOS, a retained-owner selection refusal offers **Connect to existing daemon**.
This is an explicit existing-daemon connection, never an automatic fallback or
acceptance of an unknown capsule. A GET-only check pins the configured profile's
daemonId/lineageId and the existing Local protocol/capability requirements before
opening the ordinary Local client. A changed identity, incompatible hello or
missing daemon refuses the connection without starting a replacement. This is
loopback identity pinning, not request authentication or retained-runtime proof.
The connection does not publish capsules or modify the daemon profile.

Current `--local` already supports user-driven chat actions, including create,
Send and Stop, with its existing identity/delivery guards. The new choice uses
that same client, not a read-only viewer and not a new mutation permission.
`--local-check` remains read-only. The window and Updates identify the new
connection as externally managed. App-only installation is independent of daemon
management: normal verified updates and explicit local UI reloads may replace the
app, then reconnect through the receipt-bound profile/port/identity flow. They
never pause, prepare, reserve, upgrade or replace that daemon. A changed identity
or incompatible hello refuses relaunch without starting a replacement. Update
receipts select this path only when explicitly prepared for an external connection;
managed retained receipts never silently fall back. Bundled exact-capsule validation
and all other startup refusals remain unchanged. See [UI iteration](ui-iteration.md).
The separate confirmed daemon-upgrade action has independent native ownership
checks; see [Explicit daemon upgrade](daemon-upgrades.md).

Settings' **Install and restart…** replaces only the GUI. The separate explicit
[daemon upgrade](daemon-upgrades.md) supports a narrowly verified macOS Swift
launch agent, preserving its label, ownership and profile. Startup never upgrades
a daemon automatically. Other external owners remain externally managed.

Bundled launch uses the existing configured Local home/port. It does not silently
select a new profile, import Swift state or retarget retained drafts/operations.
An existing legacy/unproven profile is refused **without enrollment or migration**.
The separate, explicit [stopped legacy service migration](daemon-upgrades.md#stopped-legacy-service-migration)
can replace a stopped Swift launch agent's runtime while preserving that profile;
it is never invoked automatically at startup.
The user must explicitly arrange a compatible guarded runtime, choose a genuinely
fresh configured profile, or use existing-daemon mode. No automatic recovery
deletes owner files, guesses a PID, starts on another port or replaces a daemon.

All current daemon entry launches acquire a permanent `.daemon-owner.sqlite`
exclusive transaction before service-graph import, migration, credentials,
databases or work restoration. The OS releases the lease after process death;
the lease inode is never unlinked. The configured TCP listener is reserved at
the same boundary. Until initialization completes it returns503, not API success.
Ordinary explicit daemon launches may guard their existing profile, but mark it
ineligible for later automatic bundled start. A compatible running guarded daemon
can still be reused. This does not retrofit the contract into old running binaries;
their unproven profiles/listeners are refused, never stopped or adopted.

Startup and GUI update ACKs never request a daemon replacement or schedule an
upgrade retry. Only the separately confirmed [daemon upgrade](daemon-upgrades.md)
may hand off a supported, proven owner. A tool-boundary `pause.ready` is not proof
that jobs, PTYs or child work are absent. Both service adapters require the daemon-safe reservation
and exact ACK/Unknown handling documented there.

A private0600 owner record contains a per-boot random proof key, nonce, profile
hash, port and build. A bounded read-only challenge proves live possession of that
boot key, binds the response to the exact requested profile/build and verifies
the canonical hello/lineage files. The lease must still be held. UUIDs, stale
records and PID values alone are not proof and never authorize signals. This is a
same-user private-profile ownership proof, not authentication against a malicious
process that can already read/replace that user's private files, and not a native
action, credential or general lifecycle-control capability.

## Service registration and activation

Packaged startup verifies the bundle/retained capsule off the GUI thread and
connects to the exact compatible live boot. It never launches a detached daemon,
registers a service or activates a version, including during GUI update relaunch.
A fresh/stopped service requires explicit **Register or start service…** consent,
including login enablement. Existing external/Swift owners can be connected
without management; switching a proven service is a separate confirmed action.
See [daemon upgrades](daemon-upgrades.md) for registration, selected-version crash
restart, exact daemon-safe reservation and Unknown handling.

The service executes normal bootstrap on immutable retained Node/main.ts paths,
without parent IPC or `--bundled-runtime`. The full closure includes workers,
imports and PilotPower. GUI close/quit/replacement never stops or switches it.
The old parent-bound launcher remains a daemon-layer fixture/legacy entry, not
the packaged GUI's product startup path. No daemon distribution/feed/signing
split, power-setting change, root service or linger policy is introduced.

## Verification and limits

The `rust-macos-bundle` job in `tests.yaml` is a non-release full-payload
assembly/relocation smoke route. It uses the exact checked-out source (the tested
merge commit for PRs), pinned Rust tools and Node24, production dependency
closure, and real source-matched Swift Power/System Events helpers. It calls
`verify_macos_bundle.py`, which is CI-only and refuses another source, a
non-arm64 host, or an existing/output path outside `RUNNER_TEMP`.

The helper runs the existing `runtime`, `native`, `rust`, `bundle`, and `verify`
stages with private HOME/config/data/cache/temp directories. Builds use two jobs
(the existing Rust wrapper's CPU2/~4GiB policy is a scheduling target, not a
macOS hard memory limit). Rust updater inputs remain **unconfigured**. Only
ad-hoc code seals are created; no production keys, feeds, release workflow,
qualification acknowledgements, Launch Services, installed apps or existing
daemons are used. The complete app is moved to a path with spaces and the three
staging inputs are deleted before inventory, seal and native dependency/minOS
verification. The relocated runtime runs the existing faux-provider/offline
smoke; the real GUI binary is executed only with `--help`, which returns before
window/profile/daemon startup.

CI retains seven-day logs, command durations, source identity, source-matched
input receipts, full payload inventory hash and the sealed GUI hash under
`desktop-macos-bundle-smoke-<tested SHA>`. Failed steps remain failures with
partial logs/report retained. These are assembly-smoke records, not release
artifacts or an acceptance ACK. `passed` means only that these specific commands
completed; `full_acceptance` and `gui_startup_executed` remain false.

**Source wiring and mocked orchestration tests do not prove hosted execution.**
Actual hosted bundle results and hashes still need observation. Real offscreen
GUI fresh-profile startup, retained-capsule publication/startup timings, configured
synthetic GUI checkpoint/preedit/admission/update lifecycle and recovery,
supported-version hosts, Gatekeeper/notarization and rollback acceptance remain
separate, unqualified work. No performance claim follows from build durations
or `--help`.

```sh
node --test --test-concurrency=1 packages/daemon/src/runtime-owner.test.ts packages/daemon/src/runtime-launch.test.ts
python3 -m unittest discover -s apps/desktop/scripts -p test_bundle_runtime.py -v
# Native packaging mechanics, five C stubs, no Swift/app/daemon execution:
PILOT_DESKTOP_BUNDLE_NATIVE_TEST=1 python3 -m unittest discover -s apps/desktop/scripts -p test_bundle_runtime.py -v
# Actual startup view, injected result lane and memory-only Local fixture:
PILOT_NEXT_RUNTIME_DIR=/tmp/startup-captures bash apps/desktop/scripts/cargo.sh run --locked --features native-probes --example bundled_runtime_probe
```

Fixtures use fresh temporary profiles and owned faux processes only. They cover
lease contention, ready/starting, exact-source reuse, version/identity spoofing,
stale records, missing resources, relocation, metadata/hash corruption,
preactivation cleanup, postactivation preservation and bounded diagnostics.
Portable packaging tests mock signing; they are not native bundle, notarization,
Gatekeeper, native helper authorization, live service or user acceptance evidence.
Moving a bundle before launch is supported. Moving/replacing it while its daemon
is using its runtime is not an authorized update flow. Production signing,
release/upload, updater activation and coordinated safe replacement remain separate.

The [immutable runtime retention proposal](runtime-retention-design.md) compares
safe future layouts and required identity/admission receipts. It is design only,
not an implemented retention, compatibility, cleanup or installation contract.

The startup-view probe exercises the real GPUI entity at680/1100pt in both
appearances, including loading/unconfirmed wrapping and control bounds,
closed-worker errors, immediate window-close cancellation and the Local-view
handoff through a network-/disk-free factory. It does not launch the bundled
daemon or discover a user profile. A filtered window-close subscription cancels
before retained frames/entities are collected; `Drop` remains the fallback.
Actual GPUI captures are synthetic-content verification, not live installation,
OS permission/IME, motion, performance or full Swift-parity acceptance.
