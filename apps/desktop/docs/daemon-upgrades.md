# Daemon upgrades

## Daemon menu controls (macOS)

**Reload** is a separate app-wide pi configuration action, not a service restart.
It sends one `POST /api/pi/reload` through the Local courier's effect fence,
with an echoed operation UUID and identity checks. `GET /api/pi/reload` and
`pi.reload` control messages are passive observations. Fan-out is bounded to two
workers, waits for committed idle/job/subagent boundaries, and preserves each
worker, durable conversation and draft owner. Parked chats are not opened.
The kernel fences input/model/subagent admissions around SDK shutdown/reload/start;
a partial extension load blocks new work until a successful explicit reload.
Host tools, Ask restrictions and Harness-only generation remain in force.
Pending work is event-driven and not replayed after daemon shutdown. Lost HTTP
acknowledgments remain unconfirmed, never an automatic retry. Menu progress is
configuration-load status, not proof of successful MCP connections.

**Pilot Next → Daemon** contains Start, Stop and Restart for an already
Next-managed Local service. It is an ordinary app-menu submenu, not a tray icon.
Each explicit action runs its stages automatically; the submenu retains progress
and errors. **Check Status** refreshes the last-checked state without changing the
service. Unpackaged, external, custom and unregistered connections do not gain
controls. No mutation is available without a Pilot window.

Start bootstraps the existing private definition and its verified selected runtime.
It does not register, migrate, enable login, publish a runtime or rewrite the
definition. Stop uses the existing reserved service-handoff stop, then requires
the exact watched process exit, free listener and released profile lease. The
service stays unloaded for the current login session despite KeepAlive. Its
unchanged login policy still applies on the next login. Restart follows that same
safe stop and starts the **same** sealed runtime, never the GUI's newer candidate.
Missing runtime files prevent Start/Restart rather than substituting another build.

Stop/Restart use distinct, exactly echoed `daemon-stop`/`daemon-restart` receipt
purposes on the private channel. Explicit lifecycle preparation signs and echoes
`interrupt:true`. It freezes admissions, durably records recovery metadata, closes
kernels, interrupts owned shell jobs/terminals and joins their exits before the
full-resource reservation. Shell commands are never automatically rerun. Kernel
close has bounded owned-process escalation; failure to checkpoint stays a failure.
Legacy and automatic startup preparation remain noninterrupting. The permanent
handoff lock, private ownership claim, exact definition, boot/HMAC, selected
profile/identities, same-PID lease and native exit proofs remain mandatory.

The existing single `.daemon-upgrade.json` records native intent and exact receipt;
the daemon's `.daemon-lifecycle.json` retains interruption recovery before shutdown.
The native journal is saved
before any service effect. Cancellation works only before that boundary. A failed
or lost result after possible effect is Unknown, inspect-only, with no replay or
rollback. Check Status cannot clear an Unknown in the GUI or an interrupted journal.
Ordinary Quit, window close and GUI update never call these controls. A completed
or uncertain menu action suppresses the automatic startup upgrade for that GUI lifetime, so
Start/Restart cannot immediately turn into a version change. Acknowledged Start
reconnects the startup screen without registering or starting again.
Cancelled or refused requests do not change that startup policy.

The menu uses the existing native-menu owner. Hidden verification substitutes a
memory driver, never a live profile or native alert. Service verification uses the existing opt-in random-label
launchd fixture. Linux lifecycle/UI support is not added by these controls.

Focused verification: `check-scoped.py --unit daemon_menu --test native_menus --lint`
exercises actual AppKit menu dispatch/enabled state with no window and with a
hidden window, plus one-shot activation, progress/cancellation and Unknown/no-replay
through a memory-only driver. The existing application-Quit corpus separately
checks the real Local root and native Close/Quit/termination paths. Its native
Quit lookup is title-based, so adding the submenu cannot retarget Quit to About.
`native_launchd_registration_offline_seed_and_singleton` also covers real private
service Start/Stop/same-runtime Restart, explicit interruption, legacy busy refusal, stale boot,
lost prepare ACK and missing replacement-ready ACK with inspect-only recovery.
No fixture enables login or operates the installed service. These isolated tests
are not full packaged GUI/service, hardware PilotPower or Linux qualification;
there is no visible-menu screenshot or live-user acceptance claim.

## Runtime upgrades

On macOS, GUI installation verifies and swaps the app without pausing agents.
On the next successful GUI startup, Pilot checks the connected managed daemon
and publishes its bundled runtime as one immutable candidate before upgrading at
a safe work boundary. The daemon executes from **one active immutable runtime
copy**, not the mutable installed app. During handoff there can be one additional
candidate. It verifies the replacement boot before removing obsolete GUI/runtime
files. There is no rolling version history or capsule allowlist in this path.
Cleanup checks for old bundled executables and observed cwd, descriptor, fileport
and mapping users, including other profiles. Unrelated external executables with
permission-denied resource inspection no longer veto cleanup. Unknown executable
identity, malformed inspection and exhausted budgets still preserve the bundle.
A later GUI download retries terminal cleanup under its lock, without polling or
replaying installation. Supported consumers execute bundled binaries; this scoped
check does not promise global absence of future reads by external interpreters.

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
**Settings → Updates → Daemon → Upgrade daemon** and **Daemon → Upgrade** are
one-shot explicit actions. They checkpoint and interrupt running work automatically,
then verify the intended replacement runtime. Cancel works before shutdown begins.

When an upgrade is refused as busy, Settings shows a bounded, read-only
blocker inventory with chat titles and **Open chat** links where available.
**Refresh blockers** observes current work without pausing or checkpointing it.
Missing inspection and overflow remain visible, not evidence of safety.
The inventory remains diagnostic, not a requirement to stop each chat manually.
Its per-chat Stop remains separate and is never automatically replayed. A Stop
acknowledgment is not exit proof: replacement still requires the runtime, storage,
ownership and singleton checks above.

## Project-proposed coordinated updates

The `pilot_update` tool is proposal-only and restricted to the configured Pilot
source project (`github.com/babariviere/pilot`). It supplies a local signed build
directory, exact source/build and summary. It cannot accept a proposal, install,
restart, signal processes or release maintenance. Ask, investigate, specialist,
shared-context and mission reviewer/explorer sessions do not receive this tool.
The daemon derives chat/project authority from its supervised worker and rechecks
it after asynchronous origin lookup.

The proposing chat shows a native update card with its build, summary and
**Accept update** / **Dismiss** actions. It never appears in a different chat or
becomes a synthetic transcript message. Acceptance remains a native action,
not an agent tool or a chat reply. Its controls bind the exact proposal ID,
phase and originating chat, and stay disabled while busy or disconnected.
Status, bounded blocker categories and errors remain in the same card.
Settings → Updates retains the same owner and recovery controls.

Native **Accept update** authorizes the coordinated path:
freeze new admissions, drain tools and owned subagents, verify the complete
resource census, save the existing exact GUI writer checkpoint, replace/restart
the GUI, then use the existing daemon handoff. Jobs, PTYs, unknown children and
uninspectable resources block; none are killed to make the census pass. The
durable maintenance record survives both process replacements. Ordinary GUI-only
updates do not acquire this coordinated drain or change their reservation scope.

Native checkpoints use the existing private app capability and exact proposal
ID/phase. The native updater, not request JSON or public hello, owns signed
manifest, full candidate/runtime-stamp, helper COMMIT, writer-close and observed
exit validation. The backend binds the reported checkpoint to its durable target
and verifies its replacement daemon identity from process-captured ownership.
The private HMAC reservation additionally binds the same proposal and target;
the coordinated freeze is not a general bypass for ordinary reservations.

Cancellation is available before installation intent. A lost or uncertain
lifecycle acknowledgement retains evidence and stays inspect-only, never an
automatic retry, rollback or permission to thaw. Successful completion requires
durable release authorization and both exact target identities. Pre-install
cancellation releases only its own maintenance hold. A passive snapshot or Refresh
does not prove installation, process exit or durable GUI state.

A payload-free `runtime-update.changed` control-stream signal invalidates the
native snapshot. Discovery is an authenticated passive GET, coalesced across
busy requests; reconnect and explicit chat opening also refresh it. There is
no polling or automatic approval, progress request or lifecycle retry. Ordinary
chat-stream content cannot signal native proposal changes.

This source integration must be verified with temporary profiles, synthetic
signed candidates and hidden native probes. Implementation checks never install
or restart the user's app/service, modify live trust/feed configuration or
publish a build. Isolated checks are not live-user update qualification.

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
unit/MainPID/profile/cgroup checks, and existing host logout policy. Distribution
defaults for every user service (`/usr/lib/systemd/user/service.d/*.conf`, such as
Fedora's `10-timeout-abort.conf`) are accepted; pilotd-specific, administrator and
user drop-ins still refuse registration and upgrades. The macOS
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
