# Explicit daemon upgrade

Daemon upgrades are separate from **Install and restart…**, which replaces only
the GUI. Neither launching Pilot Next nor acknowledging a GUI update upgrades a
daemon automatically.

**Settings → Updates → Daemon → Upgrade daemon…** asks for explicit confirmation.
Agents pause after their current tool calls finish. Chats, queued work and drafts
are retained, but running jobs and terminal processes end when the daemon exits.
Busy tools defer the upgrade, rather than being interrupted. Cancel is effective
before shutdown begins; once shutdown may have begun, the handoff finishes or
reports an unknown outcome instead of attempting rollback.

## Supported ownership

The initial supported transition is the current user's macOS Swift-managed
`com.babariviere.pilot.daemon` launch agent, including a prior explicit upgrade of
that same launch agent to an immutable Next capsule. It retains the original
launchd label, logs, working directory, environment, and data profile. Only its
verified runtime paths change; the profile is pinned explicitly and Node is first
on PATH. The profile's `managed` flag is not changed, and the replacement is not
started with `--bundled-runtime`. This is not enrollment or profile migration.

Foreground/custom services, unknown definitions, unverified payloads, and Linux
owners refuse. This feature does not acquire a general service-management or
PID-signaling capability. The existing external Local connection remains usable
without upgrading its daemon. The Swift app remains installed; explicitly using
its own Restart command may restore its own runtime definition.

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
   Refresh after potentially slow code verification. Refuse an expired lease.
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
draft marker. Run only this fixture with an explicit Node executable:

```sh
PILOT_DAEMON_UPGRADE_FIXTURE_NODE="$(node -p 'process.execPath')" \
  bash apps/desktop/scripts/cargo.sh test --locked --manifest-path updater/Cargo.toml \
  --features native-macos native_launchd_handoff_preserves_external_profile_and_service \
  -- --ignored --nocapture
```

This is genuine synthetic launchd handoff evidence, not a live user upgrade or
production full-runtime acceptance. The small fixture's tool-drain response is
injected; actual kernel durability/tool-boundary tests remain separate. Neither
the user's installed app/service nor their profile is modified.
