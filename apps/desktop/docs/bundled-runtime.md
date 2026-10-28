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

Run on a macOS arm64 **build/CI host**. Native helper builds use the existing
Swift build wrapper and its shared slot; do not run them in a no-local-Swift lane.
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

Bundled launch uses the existing configured Local home/port. It does not silently
select a new profile, import Swift state or retarget retained drafts/operations.
An existing legacy/unproven profile is refused **without enrollment or migration**.
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

Once a packaged app is running (after startup ACK for an update relaunch), it
replaces a daemon on an older runtime from its own retained store: the lease must
be held, the record's PID must run that runtime's Node, and `POST /api/update/pause`
must report the same PID as ready (tools paused). Only then is that process sent
SIGTERM; the app waits for the lease to be released and starts its own runtime.
Busy daemons are retried every five minutes. Development, Swift-app and current
runtime daemons are left alone.

A private0600 owner record contains a per-boot random proof key, nonce, profile
hash, port and build. A bounded read-only challenge proves live possession of that
boot key, binds the response to the exact requested profile/build and verifies
the canonical hello/lineage files. The lease must still be held. UUIDs, stale
records and PID values alone are not proof and never authorize signals. This is a
same-user private-profile ownership proof, not authentication against a malicious
process that can already read/replace that user's private files, and not a native
action, credential or general lifecycle-control capability.

## Activation, cancellation and resource bounds

One app-owned worker validates files and starts one short-lived bundled-Node
launcher, off the GUI thread. Its environment does not inherit Node injection,
SDK broker authority or unrelated credentials. Only configured Local/profile
paths, HOME, explicit read-only/retention/idle/environment-setup policy and fixed
system/bundled-node PATH reach the startup process. In particular,
`PILOT_MODEL_SCOPE_READ_ONLY` and `PILOT_MCP_SETUP_READ_ONLY` are preserved exactly;
sanitizing credentials must never remove these denial policies.
The result pipe is capped at4096bytes; daemon stdout/stderr are discarded rather
than retained or shown. Existing bounded daemon diagnostics remain independent.

The owned child first claims its lease/listener, then waits on its inherited
parent IPC channel. Only an explicit activation commits to importing services.
Before that boundary, cancellation/disconnect/timeout may close/reap the exact
owned child. **After activation might have been delivered, never kill it for a
startup timeout:** it may already be restoring durable work. Report Unconfirmed
and leave it running; a later launch checks the existing owner rather than
starting a competitor. The app's lifetime pipe also closes on abrupt app exit.
The daemon is independent of the GUI after activation; closing the app is not a
request to stop active work, install a service or restart/update anything.

Validation and launch together have a45second cancellation/deadline budget.
On failure the app closes the launcher's lifetime pipe, allowing its `finally`
path to reap its exact preactivation child. A bounded structured receipt reports
no owned child, preactivation reaped, or activation possible. The app joins the
helper with a separate2second cleanup bound. It does not force-kill a cleanup
owner or a process group: missing receipts/timeouts stay unconfirmed, and the
helper is left to finish its owned-child cleanup. No independently activated
daemon or PID read from a record is signaled.
The Node launcher waits at most20seconds, with a10second preactivation handshake,
100ms readiness spacing and1second/16KiB read-only probes. Existing owned but
unready/incompatible/corrupt profiles fail truthfully. Startup has no background
retry timer, idle polling, service installation or PID cleanup.

## Verification and limits

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
