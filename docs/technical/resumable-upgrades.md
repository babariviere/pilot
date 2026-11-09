# Resumable upgrade checkpoints

The daemon keeps its existing signed reservation, admission freezes, durable kernel/child storage and native
service handoff. An explicit daemon upgrade adds exact checkpoint ownership. It does not create a new service
manager, authorize live updates or change app-only update behavior.

## Durable ownership and recovery

`SessionManager.checkpointLifecycle(operationId, purpose, replacement?)` requires frozen admissions. It joins
admitted preparation and input drains. Before interrupting workers, it durably saves a private per-session
`LifecycleCheckpoint` in `meta.json`. The record pins the operation, process boot/worker incarnation, session
creation identity, input/Stop and input-control generations, prior running/hold state and known child identities.
The bounded inventory admits at most 128 workers and 256 children per worker.

The closing kernel reads the jobs registry after the harness joins tools, before extension shutdown detaches
that registry. It then closes extensions and inspects OS children. It sends final conversation/child identities
and both census observations, qualified by the exact operation and request ID. Only its close ACK, clear census
and joined worker exit can set
`quiescent`. An ACK without that inventory, remaining processes, failed inspection or lost ACK stays Unknown.
The aggregate `.daemon-lifecycle.json` checkpointed record includes the affected-session manifest. Per-session
records are the recovery authority if that aggregate write is interrupted. These files are private host state,
not display DTOs or native service-management grants.

The states are distinct:

- `checkpointing`: durable ownership precedes interruption.
- `checkpointed`: final inventory, census, close ACK and worker exit were saved.
- `resume-admitted`: recovery admission was saved before opening a replacement kernel.
- `resume-acknowledged`: that kernel's ready ACK and its receipt were saved. This is not proof of model progress.
- `stopped`: a later user Stop wins. It retains its original ownership generation.
- `unknown`: inspection is required. Do not resend a checkpoint, resume or fresh continuation input.

Recovery checks the saved session and input-control generations. It preserves current sleep, quota and user
holds. A later wake or explicit quota Force can release its own hold without changing checkpoint ownership.
A parked Stop saves its generation and abort under the maintenance fence without starting a worker. Later
recovery opens with `stopOnOpen`, so the abort reaches durable history before any recovered model/child work.
Replies to an already-admitted Stop remain available while its exact worker is closing. Daemon shutdown joins
the full admitted Stop before its final save barrier and profile-lease release, including a Stop received after
the upgrade checkpoint ACK.
An interrupted Stop intent also cannot be cleared by fresh input until the matching generation's abort ACK is
saved. This prevents reopening a pre-Stop run if interruption happened between saving Stop intent and its abort.

New explicit macOS upgrades bind the candidate's exact runtime root and full runtime-build stamp into the
signed reservation. Recovery uses the process-captured profile-lease owner's identity, not `/hello` or owner
JSON presence. The original live boot may recover a cancelled attempt. A different boot must match the exact
candidate. Restarting the old runtime after interrupted replacement does not grant selective resume.
Unknown resume admissions are not automatically replayed after restart.

## Mission Pause integration boundary

Mission Pause is a separate service. This upgrade protocol does not implement its member fan-out, schedules,
queued work, owned jobs/children or mission Resume operation. Its integration hook is:

```ts
SessionMissionBridge.upgradeResumeFence?(sessionId: string): {
  missionId: string;
  pauseGeneration: number;
  stopGeneration: number;
  held: boolean;
} | null;
```

The mission controller supplies current durable controls and canonical current membership. `null` means no
membership; unavailable state must throw, not masquerade as an empty scope. Install this hook before loading
recovery or enabling Mission Pause. Upgrade checkpoints pin its snapshot and recheck it after durable resume
admission and before creating a worker, including after asynchronous native isolation preparation.

A later mission Pause, Stop, Pause-then-Resume, moved membership or held state vetoes upgrade-owned resume.
Missing/unavailable controls cannot recover a previously pinned fence. Installing the provider cannot invent
missing historical upgrade authority either. The mission controller must own any later explicit recovery.
Stop-only reopening can still deliver its saved cancellation under `stopOnOpen`; it does not resume work.
The optional hook preserves compatibility before mission-pause support exists, not permission to activate
mission controls without wiring their durable generation fence.

## Native host APIs

The reusable crate is `apps/desktop/updater` (`pilot-desktop-updater`), independent of GPUI and Swift UI.
`lifecycle::DaemonLifecycle` accepts an existing `app_update::Connection`, which pins `Location`, daemon ID
and storage lineage. It extracts the backend selection previously held in the desktop integration:

```rust
let lifecycle = DaemonLifecycle::new(connection);
let needed = lifecycle.needed(app_root, &trust, &cancel)?; // read-only, macOS
lifecycle.upgrade(&published_capsule, &trust, UpgradeMode::Explicit, &cancel)?;
// UpgradeMode::Startup keeps the existing noninterrupting startup policy.
```

`upgrade_coordinated(capsule, trust, cancel, binding)` retains the exact durable proposal binding. The native
backend still verifies the service definition, signatures, exact PID/boot, OS exit and released profile lease.
The existing GPUI integration now calls the same adapter. There is no second registrar or subprocess launcher.
Use existing `daemon_upgrade::register` for an explicitly confirmed registration and
`runtime::publish_service` for immutable macOS capsules. Published roots are never renamed by this adapter.

For an independent app-only update, use the existing `worker::Worker::for_running_app(wakeup)` and
`app_update::ExitGuard::prepare_external(connection, target, transaction, build, trust)`. This route takes no
daemon reservation and leaves unrelated daemon work running. Keep `Safety`'s exact draft/delivery/settings
`Flush` acknowledgements, preedit capture, admission fences and runtime qualification. The native host must
save all forms automatically and report real save errors. A nonempty draft is not itself a failed flush.

TSX receives read models and permission-checked host intents, never these native credentials or direct daemon
management access. NSH screens and all-form/native input restoration remain separate integration work. The
current trusted helper/layout still expects the existing packaged executable identity. Packaging NSH must
qualify that identity consistently, not bypass verification or require the GPUI app to run.

## Recovery limits and verification

The adapter does not retry Unknown native writes, install rollback bytes or infer startup success from launch.
Retained old bundles are recovery evidence, not rollback compatibility proof. Any future rollback must prove
app/runtime/storage compatibility before it can restore execution. Existing immutable-root and helper/startup
receipt protections remain unchanged.

Focused daemon/kernel tests cover exact ownership, stale generations, parked Stop and Stop during close,
final child inventory versus ACK/census, quota/sleep holds, lost checkpoint/ready ACKs, interrupted replacement
identity and recovery without synthesized input. The real child fixture checks identity and exact effect counts
across lifecycle close/reopen. Updater library tests cover native identity, independent app-only access,
draft-flush failure, interrupted swap, startup receipts and immutable roots. These isolated checks are not a
live NSH update, all-form restoration or native UI acceptance claim.

Upstream NSH 7571948 also has `nsh-updater` and `docs/dev/updater.md`: `Config::check`, verified downloads,
`Installation::install`, then native restart. Its install swaps before old-process exit; it is not a drop-in
replacement for this application's durable post-exit handoff/startup receipts and daemon proof. No upstream
NSH changes or alternate updater activation are part of this protocol.
