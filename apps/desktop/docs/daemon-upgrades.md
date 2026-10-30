# Daemon upgrades

On macOS, GUI installation verifies and swaps the app without pausing agents.
On the next successful GUI startup, Pilot checks the connected managed daemon
and publishes its bundled runtime as one immutable candidate before upgrading at
a safe work boundary. The daemon executes from **one active immutable runtime
copy**, not the mutable installed app. During handoff there can be one additional
candidate. It verifies the replacement boot before removing obsolete GUI/runtime
files. There is no rolling version history or capsule allowlist in this path.
Cleanup proves the old app is unused by other processes too. A later GUI download
retries terminal cleanup under its lock, without polling or replaying installation.

Startup attempts this once after restoring durable GUI state and acknowledging
the GUI update receipt. It does not retry on reconnect or Settings open.
Incomplete GUI installation or daemon handoff state blocks automatic replacement.
An exactly matching authenticated runtime tuple stays running, regardless of its
immutable root. An equal-version runtime upgrades if its full build tuple changes.
Newer daemon versions are never downgraded.

The GUI remains usable while active tools finish. Automatic preparation waits
up to ten minutes, with cancellation, then defers. Active jobs, terminals,
unknown child processes, transfers, mutations or failed resource inspection
block replacement. Drained, job-free subagents checkpoint and exit, then resume
unfinished inputs after replacement. No completed tools are replayed.
**Settings → Updates → Daemon → Upgrade daemon…** remains an explicitly confirmed
manual option. Cancel is effective until shutdown begins.

## Supported ownership

The adapter manages only the current user's known
`com.babariviere.pilot.daemon` launch agent and connected private profile.
Custom services and external connections do not acquire lifecycle authority.
Automatic handoff requires `PilotNextManaged=true`; initial adoption of a known
Swift launch agent remains manual. Its profile's managed/enrollment flag, daemon
and storage identities, working directory, logs and service label are preserved.
The replacement runs normal `main.ts`, never `--bundled-runtime`.
Supported Next roots use the exact private
`~/Library/Application Support/Pilot Next Service Runtime/<identity>/Pilot Next.app`
layout. The legacy `Pilot Next Runtimes` layout remains recognized for live
ownership and migration, without an allowlist or old-file verification.
Existing direct-installed-app services must migrate to immutable execution before
GUI swap; the GUI update guard refuses that unsafe arrangement.

Old runtime files are not the ownership authority. A live HMAC challenge binds
the exact private owner record's boot, original build tuple, runtimeRoot, PID,
daemon and lineage identities. The private launch agent must have the exact
supported two-argument bundled layout and loaded launchd definition/PID.
The OS process must belong to this user, and **that same PID** must hold the
profile's permanent SQLite lease. A native kqueue watch binds its eventual exit.
No process command line or unrelated held lease substitutes for these checks.

This works when a prior retained capsule has disappeared. Neither
`proc_pidpath` nor dynamic code-signature lookup reliably works after unlink on
macOS, so managed ownership does not depend on reopening or verifying obsolete
files. The **new target** must still be a canonical immutable candidate with the
compiled release's exact signature/build and valid runtime stamp. Legacy manual
Swift adoption additionally checks its live executable path. Unstamped runtimes
cannot gain private updater authority from a `build:null` proof.

A private `.plist.next-owner` claim prevents updated Swift lifecycle paths from
mutating a service after Next takes ownership. Previously installed Swift
binaries cannot be patched by that claim and must not be used to repair/restart
the service during coexistence.

Linux keeps its separately qualified retained-runtime/systemd adapter, exact
unit/MainPID/profile/cgroup checks, and existing host logout policy. The macOS
simplification grants no general PID-signaling, sudo or service-management power.

## Explicit registration and GUI independence

First registration and starting a stopped service remain explicit, not startup
side effects. **Register or start service… → Enable and start** enables the known
login launch agent with the verified immutable copy of the installed app runtime.
An existing stopped Next definition is updated to that runtime; Swift/custom
definitions require migration instead. No enrollment, parent IPC or GUI lifetime
lease is required. launchd can restart the immutable runtime after the GUI quits.

Registration records one `registering` intent. Missing startup acknowledgement
is Unknown and blocks another start, rather than silently bootstrapping twice.
LaunchAgents remain scoped to the GUI login session.

## Stopped legacy service migration

The helper can explicitly adopt an unloaded known Swift service, including one
whose old app is missing, without moving chat data:

```sh
# Unloading interrupts agents and terminals; inspect their state first.
launchctl bootout "gui/$(id -u)/com.babariviere.pilot.daemon"
"/Applications/Pilot Next.app/Contents/Helpers/pilot-desktop-update-helper" \
  --migrate-stopped --app "/Applications/Pilot Next.app" --confirm
```

Migration requires the exact private definition, an unloaded service, unused
listener, released profile lease and no interrupted handoff. It verifies the
installed target, publishes one immutable candidate, saves the original plist in one private backup slot, records
intent, replaces the definition and starts once. After verified completion it
retires that backup. A post-intent failure is Unknown: inspect the backup,
journal and actual service state. No automatic rollback or replay occurs.

## Verified handoff and interrupted state

1. Verify/publish the immutable candidate and live ownership above, take the permanent
   per-profile handoff lock, and attach the native exit watch.
2. Reach the existing tool-boundary pause and prepare the signed daemon-safe
   reservation below. Revalidate the unchanged private plist, exact loaded
   service/PID, OS ownership, same-PID lease and HMAC boot.
3. Verify the exact reservation receipt before recording `stopping` durably.
   Stop only that launchd service, then require the watched process exit and
   released lease before atomically replacing its definition.
4. Reverify the immutable candidate and bootstrap once. Require a new HMAC boot,
   unchanged daemon/lineage, exact selected runtime build/root, native executable,
   exact loaded service and held lease.
5. Replace interrupted evidence with a small completion marker, then attempt
   obsolete-file cleanup. Cleanup failure does not undo a successful handoff.
   An exactly matching, revalidated immutable runtime may also permit GUI cleanup.

GUI exchange never changes the active runtime's lexical module/resource paths.
Keeping the old GUI rollback alone would preserve executable inodes but could
redirect lazy JavaScript imports into new files while jobs defer handoff. The
separate immutable active copy prevents that mixed-version window. Publication
never overwrites an active root. Uncertain use consumes the bounded candidate
capacity rather than deleting files speculatively.

There is one overwritten `<profile>/.daemon-upgrade.json`, not an upgrade history.
Only an interrupted attempt retains its previous/next definitions and receipt,
never the HMAC secret. An incomplete journal blocks further handoffs.
Pre-shutdown refusal leaves the daemon running. Any failed/lost acknowledgement
after shutdown may have begun is **Unknown**, never permission to stop/start
again, delete evidence or automatically restore an old app.

## Daemon-safe admission prerequisite (service adapter contract)

`pause.ready` proves a tool boundary, not the absence of jobs, PTYs or child
processes. Both service adapters require the stronger **opt-in** reservation
below. Their journals retain the exact receipt, without the private boot key.

After the exact process has acknowledged `POST /api/update/pause`, use the
existing private `POST /__pilot_runtime_update/v1` channel, not a new restart API:

```json
{"boot":"<pinned boot>","nonce":"<fresh 64 hex>","action":"prepare","receipt":{"operationId":"<new UUID>","purpose":"daemon-upgrade"}}
```

The existing `x-pilot-update-proof` is HMAC-SHA256 over `update/v1\n` followed by
the exact request bytes, using the private owner record's boot key. Validate the
response MAC over `update/v1\n` plus the exact `body` bytes, then pin its nonce,
boot, home hash, port, build and runtime root. This is the existing same-user
owner proof, not public API authentication. A successful `body.receipt` is:

```json
{"schema":1,"operationId":"<same UUID>","token":"<opaque 64 hex>","purpose":"daemon-upgrade"}
```

- Require the exact echoed purpose. Old daemons may ignore the requested field
  and return a GUI-only receipt. Missing support, a missing runtime root, failed
  owner proof or any refusal must defer, never fall back to `pause.ready`.
- One shared reservation slot excludes GUI and daemon reservations. All runtime
  admissions freeze synchronously **before** async inspection. The daemon uses
  the full `RuntimeResources` set, including session jobs/descendants and all live
  PTYs (even detached or closing), transfers, mutations and setup/import work.
  After tool-drain ACK, each kernel receives `checkpointUpdate`. The pinned
  subagent supervisor checkpoints only owned children with no running/unknown
  jobs or OS children. Each child must acknowledge storage closure and exit
  cleanly before the unchanged parent jobs/native-child census can pass.
  Failed checkpoint proof stays failed until resume/recovery; an empty later
  census cannot turn a missing ACK into success. Cancellation joins all started
  checkpoints before child dispatch resumes. No job or unknown process is killed
  to make inspection pass. Missing/failed/changed worker inspection is Unknown
  and blocks. Inspection times out after 10 seconds.
- Send `action: "verify"` with the complete exact receipt immediately before the
  adapter's durable stop intent. Validate the same signed identity and receipt.
  `inspect` alone is not an admission ACK. Native owner/service/executable/exit
  proofs, permanent handoff lock and singleton lease checks remain mandatory.
- The nonrenewable hold expires 180 seconds from **before** prepare inspection.
  Keep a conservative local deadline measured before sending prepare, and refuse
  a delayed stop. Verification never extends this deadline. A repeated operation
  ID cannot prepare again in that daemon boot, including after failure/expiry.
- Before stop intent, `action: "cancel"` with the exact receipt releases the
  hold. Wrong tokens/purposes do not release it. Errors/timeouts during inspection
  and server shutdown release their hold. Legacy tool pause resumes within its
  existing 30-second cycle once no independent maintenance hold remains.
- Transport disconnect/lost ACK is **not** cancellation: a helper may already be
  acting. An orphaned successful hold stays until expiry or daemon shutdown.
  Persist adapter intent and the exact receipt before acting. Lost prepare ACK
  means no stop; lost ACK after stop intent means Unknown, inspect only. Never
  replay stop/start or automatically roll back. A new daemon boot cannot verify
  an old receipt; the backend does not restore or replay handoffs.

Omitting `purpose` retains the existing GUI-only contract, which intentionally
permits paused workers, jobs and open terminals because pilotd survives. No
public protocol/Swift mirror, service registration, signals, release policy or
agent authority is added by this backend prerequisite.

Synthetic coverage lives in `daemon-upgrade-reservation.test.ts` and
`update-reservation.test.ts`; existing `update-pause.test.ts`,
`runtime-admission.test.ts` and `runtime-owner.test.ts` cover tool recovery,
resource composition and boot-bound private proofs. These tests use temporary
profiles and fake workers/process inventories, never live user jobs or services.
`subagent-pause.integration.test.ts` also exercises real offline child checkpoints,
same-parent cancellation recovery and replacement recovery with exact conversation
identity and no completed-tool replay. `subagent-checkpoint.test.ts` covers a failed
peer while another checkpoint is still closing, and retained missing-ACK refusal.

## Verification boundaries

Focused updater tests cover ordered single-start handoff, preflight/busy/cancel
and changed-identity refusal, every post-intent partial failure, exact loaded
service parsing, custom/profile/enrollment refusal, and signed null-build boot
proof with wrong MAC/identity/changed-boot rejection. Hidden native UI checks use
injected workers, not launchctl or a real profile.

The opt-in `native_launchd_handoff_preserves_external_profile_and_service` test
uses a random synthetic launchd label, private temporary signed old/new apps,
copied Node, the actual source-owned runtime lease/proof, native process exit,
definition replacement/bootstrap and verified new boot. It checks unchanged
`managed=0`, retained service label, two arguments (no enrollment) and a retained
draft marker. It also checks the actual backend reservation against synthetic
job/terminal/child/transfer/mutation/Unknown blockers despite `pause.ready`, exact
cancellation, lost prepare ACK (no stop), and prior-Next crash restart.
It then removes the entire old capsule and verifies automatic handoff to one
immutable candidate without an allowlist. Finally it replaces the GUI with a
same-version changed-source app while the daemon stays on its immutable copy.
A late runtime-file read still sees the active old version while a job defers
handoff; the next verified candidate then replaces it. A substituted lease-holder
PID refuses. Completed state contains no previous definitions.

`native_launchd_registration_offline_seed_and_singleton` covers explicit fresh
registration from one immutable runtime copy, singleton refusal and explicit
restart. Both use private definitions
and random labels. The registration fixture deliberately skips `launchctl enable`
so it never changes the user's login-domain override database; production's
separately confirmed registration enables the established label.
`native_launchd_offline_migration_missing_swift_preserves_profile_and_starts_once`
uses a separate random label and temporary profile with a missing old app. It
checks retirement of the single private plist backup, unchanged identities,
profile/lease inodes and `managed=0`, one bootstrap and repeat-migration refusal. This is
isolated native evidence, not a blanket live-user migration qualification.
Run these fixtures with an explicit Node 24 executable:

```sh
PILOT_DAEMON_UPGRADE_FIXTURE_NODE="$(node -p 'process.execPath')" \
  bash apps/desktop/scripts/cargo.sh test --locked --manifest-path updater/Cargo.toml \
  --features native-macos daemon_upgrade::macos::native_tests:: \
  -- --ignored --nocapture --test-threads=1
```

This is genuine synthetic launchd handoff evidence, not a live user upgrade or
production full-runtime acceptance. The small fixture's tool-drain response is
injected; actual kernel durability/tool-boundary tests remain separate. Neither
the user's installed app/service nor their profile is modified.

Linux source was compiled and its reservation/coordination contracts tested in a
CPU2/4GiB unprivileged ARM64 Linux container using Rust1.98.1/mbx1.26 and private
target/cache paths. This is not x86-64 systemd user-service, cgroup, login or
crash/GUI-close qualification. No reachable user manager/D-Bus was available for
that native evidence. The older detached-launch native harness is not evidence
for this adapter. A separate opt-in absent-manager fixture proves refusal before
profile/service changes. The broad Linux updater suite's ACL fixture additionally
needs `setfacl`, absent from that container; focused service checks are separate.
