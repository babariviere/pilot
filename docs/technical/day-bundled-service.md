# App-owned daemon handoff

For the executable dogfood handoff interface and reusable isolated driver, see
[Day daemon handoff](day-daemon-handoff.md). Its exited-kernel uncertainty policy
replaces the earlier absolute descendant-proof requirement below. Signature,
known shutdown, profile ownership and Unknown/no-replay checks remain required.

The NSH update path uses the verified GUI app's own
`Contents/Resources/runtime`, not a published GPUI capsule. The small native
adapter is `daemon_upgrade::bundled_service` in the renderer-independent updater
crate. This is service authority, not presentation code or a TSX capability.

## Inputs and ownership

`Runtime::verify` checks the app's code seal and exact GUI build, the runtime
source/build stamp, canonical fixed Node/daemon paths, and the whole bundle
inventory. It keeps these inputs in an opaque native value. The final runtime
path is relative to the installed GUI app, never chosen by TSX or restored from
an installing record. It requires NSH bytecode and the native GUI executable.

The official NSH installer owns the app swap. Global update preparation owns
draft capture, admissions, all-chat pause/notification and job cancellation.
The service adapter only inspects that original operation through the signed
native owner channel. It requires its exact accepted target and fresh independent
resource evidence. Healthy and interrupted chats use the same boundary; no model
acknowledgement is required. A cancellation, root exit, or process-group ACK is
not descendant-exit proof.

## Ordered native effects

1. Verify target and existing managed launch-agent definition, exact selected
   profile, daemon/lineage, boot, PID and permanent profile lease.
2. Hold the existing permanent handoff lock and an OS process-object exit watch.
   Keep the actual lease inode open. Refuse unfinished handoff evidence.
3. Verify original-operation preparation again. Save stop intent before bootout.
4. Stop only that existing service. Require both the watched process exit and
   release of the same, still-present lease inode. Never register a second daemon.
5. The native owner runs the official NSH installer while the daemon is stopped.
6. Consume the fresh stopped capability once. Recheck the installed signed bytes,
   change only the existing definition's app-relative runtime/profile/PATH, start
   once, and verify the exact successor boot, PID, lease, executable and runtime.
7. Save completion. This is not permission to resume agents. Global release must
   separately verify startup and resume only its own eligible pauses.

There are no Drop-time service effects. Ordinary GUI close does not stop the
daemon. A fresh stopped capability can instead start the verified restored old
runtime. An uncertain successor start consumes that capability; it cannot be
retried or turned into a rollback start.

`official_update::VerifiedApp` now supplies the verified candidate runtime to
the global preparation payload and runs this sequence around the official NSH
installer. `VerifiedRollback` resolves the actual running signed app's runtime
lazily, not during ordinary GUI bootstrap. A confirmed successor completion
can be consumed once for explicit rollback. The module rechecks that same boot,
PID and completion, stops it, runs the official restore, and starts only the
exact original runtime. It refuses stale or already-used rollback evidence.

## Recovery and limits

The existing private durable handoff journal stores the original immutable
operation, target, old definition and observed completion. Lookup requires the
exact operation and selected profile/daemon/lineage. It performs no effects and
cannot reconstruct a stopped capability. Interrupted stop, swap, start, failed
verification, or lost persistence replies stay Unknown. Do not reset the journal,
resend an operation, infer success from a version-only GET, or replay canceled work.

Normal saving remains the default. Force consent can waive state preservation
only, never code trust, process safety, or the original-operation recovery rule.
Broken persisted agent state is reconciled by update preparation/recovery, not
by this service adapter or an ordinary GUI open.

## Acceptance gates

Isolated tests cover verified fixed paths, full-byte identity, tampering,
source/build mismatch, preparation pins, ordered one-shot effects, injected
storage/exit/start failures, original-operation lookup, and real process-object
exit plus POSIX lease ownership/release/inode replacement. Faux seals test the
verification seam; they are not signed-distribution acceptance.

Real signed app/rollback archives, joined service/official-install execution,
startup/global release and native end-to-end qualification remain separate gates.
The windowless Day entry now supplies the dogfood policy after verifying the full
signed runtime. OfficialRoot permits fresh consent only after signed input checks;
this is not a claim that the GUI update action is fully connected. An empty host
registry must not erase uncertain descendant history. No native
registration, live pause/update/restart, visible window or production cutover is
authorized by these tests. Ordinary read-only bootstrap still needs only the
running app's code seal and selected connection, not a full update distribution.

See [global preparation](day-global-updates.md) and the
[historical pipeline audit](day-update-pipeline.md). Its capsule/proposal input
supplier is the old orchestration boundary, not the NSH app-owned direction.
