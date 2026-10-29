# Explicit daemon upgrade

Daemon upgrades are separate from **Install and restart…**, which replaces only
the GUI. Neither launching Pilot Next nor acknowledging a GUI update upgrades a
daemon automatically.

**Settings → Updates → Daemon → Upgrade daemon…** asks for explicit confirmation.
Agents pause after their current tool calls finish. Chats, queued work and drafts
are retained. Active jobs, terminals, child work, transfers or mutations defer the
upgrade, as does missing or failed resource inspection. Work is not interrupted. Cancel is effective
before shutdown begins; once shutdown may have begun, the handoff finishes or
reports an unknown outcome instead of attempting rollback.

## Supported ownership

The initial supported transition is the current user's macOS Swift-managed
`com.babariviere.pilot.daemon` launch agent, including a prior explicit upgrade of
that same launch agent to an immutable Next capsule. It retains the original
launchd label, logs, working directory, environment, and data profile. Only its
verified runtime paths change; the profile is pinned explicitly and Node is first
on PATH. Modern Swift runtime assembly snapshots committed runtime inputs and stamps
`runtime-build.json` before the enclosing app is signed. That gives ordinary
Swift bootstrap the private boot-bound build/root proof needed for the same
strict reservation. Older installed/unstamped Swift runtimes still defer; the
adapter never manufactures a stamp or falls back to tool pause on the live app.
The profile's `managed` flag is not changed, and the replacement is not
started with `--bundled-runtime`. This is not enrollment or profile migration.

Linux uses the known `pilotd.service` user unit with exact retained runtime, profile,
policy, loaded fragment, MainPID, command line, native executable and separate
cgroup proof. A reachable systemd user manager/D-Bus is required; there is no
foreground fallback, sudo or linger change. Custom services, drop-ins, unknown
definitions and unverified payloads refuse. Linux service lifecycle native
qualification must be reported separately from source/contract checks. This feature does not acquire a general service-management or
PID-signaling capability. The existing external Local connection remains usable
without upgrading its daemon. The Swift app remains installed. A private `.plist.next-owner` claim is persisted
before stop intent and the replacement plist carries `PilotNextManaged=true`.
Updated Swift lifecycle/update paths take the same permanent handoff lock and
refuse writes or signals after that claim, even when its contents are incomplete.
This source guard cannot patch previously installed Swift binaries. Those older
binaries must not be used to restart/repair the service during coexistence.


## Explicit registration and GUI independence

A packaged GUI startup only verifies/connects. It never registers, starts,
restarts or activates a daemon, including after an update ACK. On a fresh/stopped
profile the startup view offers **Register or start service…**, with a separate
**Enable and start** confirmation that includes login enablement. Registration
publishes the complete verified immutable bundled seed and executes normal
`main.ts`, without `--bundled-runtime` or parent IPC. The profile managed flag is
preserved (fresh normal service profiles are not auto-enrolled).

macOS uses the established label/logs/Interactive QoS/backoff and Linux renders
`scripts/linux/service.mjs` with the selected retained runtime, explicit profile,
port and restrictive policy. Linux's preflight report is outside the immutable
runtime. Crash restart remains on the selected version, independent of GUI
close/quit/replacement. A stopped selected version is not replaced by the newest
GUI seed. Existing Swift definitions are never overwritten by first registration;
connect externally, then use the separately confirmed safe upgrade instead.

Registration has its own durable `registering` intent in the existing journal.
Missing startup ACK is Unknown and blocks another start. Inspect first; neither
startup nor registration replays an incomplete handoff. LaunchAgents are scoped
to the GUI login session. Linux logout/reboot survival depends on existing host
policy, not a new linger or power-setting grant. Bundling remains the offline
seed; no daemon feed, signing or self-update activation is introduced.

## Verified handoff

1. Obtain exact durable editor/outbox/question and Settings checkpoints. Preedit,
   unresolved deliveries, secondary forms and incomplete visual cleanup veto the
   action without discarding work. Hold the existing input/admission fence.
2. Verify and publish this GUI's complete current runtime using the existing
   compiled trust, signature, source and immutable-capsule contract. No downloaded
   key, source checkout, mutable app runtime or PATH-provided Node is substituted.
3. Pin the canonical private profile, random boot, daemon/lineage identity, actual
   Node executable and exact loaded launchd definition. Attach a native kqueue
   exit watch before any shutdown. A `build:null` HMAC proof establishes live
   identity only, not retained-runtime proof or private updater authority.
4. Use the existing tool-boundary pause API and check its exact process response.
   Prepare the signed daemon-safe reservation described below, then revalidate
   native ownership. Verify the complete exact receipt immediately before durable
   stop intent. A local 175-second deadline is measured before prepare and never
   renewed. Missing backend support is a refusal, not a weaker fallback.
5. Under a permanent per-profile handoff lock, durably record `stopping` before
   `launchctl bootout`. Require the watched OS process exit and released permanent
   profile lease before replacing the definition. Never unlink either lock.
6. Atomically persist the preserved definition with the verified capsule's Node
   and daemon entry. Bootstrap that same service once. The daemon's existing
   exclusive profile/listener admission still runs before service-graph imports.
7. Require a new live boot, unchanged daemon/lineage, exact runtime build/root,
   native executable, loaded service definition and held profile lease before
   reporting completion. A launchctl success alone is not completion.

## Failure and inspection

Pre-shutdown refusal leaves the daemon unchanged. A failed or lost acknowledgement
after shutdown may have begun is **Unknown**, not a retry instruction. The GUI
keeps its checkpoint fence. It does not send another stop/start, delete evidence,
restore the old definition, or infer success from an HTTP response alone.

The private `<profile>/.daemon-upgrade.json` journal retains the phase, identities,
capsule and previous/next service definitions, without the owner proof secret.
An incomplete journal blocks another upgrade across GUI restarts. Inspect it and
the service's actual state before arranging deliberate recovery. Ordinary Local
startup never replays this journal. There is no automatic rollback or recovery
installer in this slice.

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
  Missing/failed/changed worker inspection is Unknown and blocks. Inspection
  times out after 10 seconds. Neither inspection nor refusal stops any work.
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
cancellation, lost prepare ACK (no stop), prior-Next verification, and selected
runtime crash restart after removing both GUI seeds.

`native_launchd_registration_offline_seed_and_singleton` covers explicit fresh
registration, normal bootstrap, offline seed removal, singleton refusal and
explicit restart of the selected retained version. Both use private definitions
and random labels. The registration fixture deliberately skips `launchctl enable`
so it never changes the user's login-domain override database; production's
separately confirmed registration enables the established label.
Run these fixtures with an explicit Node executable:

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
