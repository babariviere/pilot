# Install Pilot from apps/day

The prepared installer stages a verified full app, updates the existing daemon,
and offers separate, explicit old-app/runtime retirement. It launches no GUI.
Source and isolated checks are not signed installed qualification. No live
installation, launch, restart or removal was run during implementation.

This is the personal dogfood path, not a public release or full-parity gate.
The user accepts that cancellation and known process exit may leave escaped
descendants (D96). Report that uncertainty. Still save state, fence admissions,
cancel/stop known owned work and verify the old daemon's exit. Never substitute
this risk acceptance for signatures, durable history or successor verification.

## Data reuse, not database migration

Both apps use the same canonical daemon/profile. Source and target profile must
be identical canonical paths. Do not export/import or copy SQLite, WAL files,
transcripts, summaries, artifacts or credentials. Projects, chats/history,
missions/tasks/decisions, Knowledge, preferences, artifacts/revisions and daemon
settings remain in canonical storage. Day may not expose every old editor.

GPUI's local saved drafts, pending sends and GUI settings remain in
`~/Library/Application Support/Pilot Next` on macOS. They are **not imported into
Day**. Keep that data even when removing the old app/runtimes. Day keeps its own
saved drafts, selection and pending operations in `window-journal` beside its
installed app. Never replay GPUI pending sends or clear uncertain Day operations.

Native credentials stay in the existing profile, outside TSX. Read-only
preflight checks the private capability and makes two authenticated loopback GET
requests (hello). The selection, launcher and output contain no token.

## Bundle and driver prerequisites

Use Node 24+, macOS arm64 and Python 3 only for the **existing** bundle verifier.
No new Python orchestration, builds or dependency installation run here.
Select a configured code-sealed **full** Day distribution, including its own
runtime and source-matched NSH resources. The runtime-free connected candidate
cannot update the daemon. Current CI `Pilot-Day-unsigned.zip` is unconfigured
unsigned evidence, not an installable connected bundle. Never silently seal it
or weaken trust. Pin the approved **target** updater public key explicitly; the
dedicated Day key need not equal GPUI's old key. Repository/app/code requirements
remain compatible with the verified old app.

The bundled `--daemon-handoff` native driver reuses global preparation and the app-relative
`daemon_upgrade::bundled_service` handoff. It owns exact service/boot/PID/lease,
durable interruption records, known process shutdown, successor verification,
selective resume, rollback and Unknown recovery. No second daemon manager,
`launchctl`/`kill` shell shortcut or generic recursive cleanup is supported.
The earlier independent-descendant-proof restriction is relaxed for dogfood;
it is not a remaining absolute gate. Build the full configured bundle from a
source containing this installer's `retire` entry when optional cleanup is wanted.

## Explicit selection and commands

Create a private selection file outside the profile. Use absolute canonical
paths and actual connection values. The source is the full immutable commit;
the digest is the sealed executable's `shasum -a 256` result.

```json
{
  "app": "/absolute/input/Pilot Next.app",
  "trustFrom": "/absolute/installed/Pilot Next.app",
  "source": "FULL_40_CHARACTER_COMMIT",
  "build": "NUMERIC_DOTTED_BUILD",
  "binarySha256": "FULL_64_CHARACTER_SHA256",
  "updaterPublicKey": "APPROVED_TARGET_BASE64_PUBLIC_KEY",
  "operationId": "EXPLICIT_STABLE_UUID",
  "savedState": "/Users/you/Library/Application Support/Pilot Next/state-v1.json",
  "sourceProfile": "/absolute/existing/pilot-profile",
  "targetProfile": "/absolute/existing/pilot-profile",
  "installDirectory": "/Users/you/Applications/Pilot",
  "port": 24680,
  "daemonId": "EXACT_DAEMON_ID",
  "lineageId": "EXACT_STORAGE_LINEAGE"
}
```

Use the existing profile's `daemon-id` and `storage-lineage` values and actual
configured port (the example port is illustrative). Opening the global dashboard
requires no project or planning model. Choose a project explicitly when starting
new work. The installation parent
must exist, belong to you and not be writable by others. Choose a fresh directory
outside the profile and both apps.

Keep the same operation UUID across retry/inspection. `savedState` must be the
caller's already saved private GUI state, not a fabricated empty capture. The
native driver requires mode 0600 and at most 1 MiB. It hashes/fsyncs that file;
it does not convert it. Larger captures are an explicit unsupported limit.
GPUI's existing state file can exceed that limit, so check before scheduling
the actual handoff. Keep its original file regardless. Do not copy a live DB.

```sh
node scripts/day-install.ts preflight /absolute/selection.json
```

Save and close GPUI normally through its existing owner, then explicitly install:

```sh
node scripts/day-install.ts install /absolute/selection.json --gui-closed
```

`--gui-closed` acknowledges your completed save/close. It is not a native close
receipt, and the native no-use inspection still refuses a known running old
GUI/runtime or uncertain use. The script never sends a quit/kill to GPUI.
Installation copies to a fresh private staging directory, checks the copied
seal, then publishes only the separate install directory. It calls the new
app's native driver, not a GPUI updater or another service manager. The existing
daemon is fenced/paused, known work canceled, handed off and selectively released.

After success, open `Pilot/Launch Day.command` when separately ready to launch.
Always use that launcher on reopen: it supplies the exact profile/service identity
and same Day journal. Do not double-click the bare app without native selection.

Historical selection files may still contain project/model fields. The installer
keeps those bytes in its exact selection binding for recovery but does not use
them for launch or preflight. Do not edit an entered installation's selection or
operation UUID to retry it. Inspect its original operation instead.

After a failed/lost reply, inspect the **same** operation:

```sh
node scripts/day-install.ts inspect /absolute/selection.json
```

A durable installer entry is saved before possible native effects. Repeated
install invokes only native inspection, even after completion, never another
apply. Rollback completion is not successor success. Unknown or missing evidence
never authorizes removal. Keep the installation, original app/runtime and state
records for recovery; do not reset the marker or invent a fresh UUID to retry.

## Recovery from a pre-global-update daemon

The daemon at source `bf005fd7` supports base protocol 1, but not the native
`globalUpdate` envelope. The original installer accepted its base handshake and
staged the app before native preparation returned HTTP 409 (`ActiveWork`).
That name does not establish that jobs caused the refusal. This legacy handler
reads a missing top-level operation ID and rejects before admission/checkpoint
effects. The installer now checks the separate `globalUpdate: 1` capability.
Native service preflight alone does not establish this wire compatibility.

For this diagnosed legacy source only, the prepared user-run recovery is:

```sh
node scripts/day-recover-legacy.ts inspect /absolute/original/install-attempt.json
# Save and close the old GUI normally. Stop other installation/update tools.
node scripts/day-recover-legacy.ts recover /absolute/original/install-attempt.json --gui-saved-and-closed
```

The recovery verifies the installed seal, original entered selection, exact old
runtime source bytes, service definition, PID, boot, profile lease and signed
native hello. It preserves the latest saved GUI state and original plist in
separate private files beside the installed app. It exclusively records recovery
entry before any shutdown. It never resends global preparation, changes the
original UUID/selection/markers or writes a false original completion.

It uses the old daemon's **ordinary launchd SIGTERM shutdown**, not an unavailable
global-update protocol or a cooperative model pause. That shutdown fences new
admissions, closes workers and joins pending saves. It provides no all-chat
global preparation receipt and does not reconcile old broken lifecycle records.
Interruption is expected. Durable Stop/user/mission holds and Unknown effects
remain governed by the existing daemon/Harness recovery rules, not rewritten by
this script. Escaped descendants and a clean flush of every worker are not
independently proven. No Force, unrelated PID kill or lock unlink is used.

Only after service unload, old PID exit, release of the unchanged permanent
profile lease and a free listener does it replace that same service definition's
two runtime paths and PATH entry. It keeps every other field, including profile,
port, policy and logs. It bootstraps once, then requires a new boot, exact
source/runtime/build, service PID, lease ownership and authenticated native
hello. This is separate successor evidence, not original handoff success or an
agent-resume/release receipt. A repeated invocation only reads recovery records,
even after a lost reply. Every failure keeps the original apps, runtimes, state
and recovery evidence; inspect rather than retry or automatically roll back.

No GUI is launched and no app/runtime is retired. Open the existing installed
`Launch Day.command` only after a verified successor. Retirement after this
legacy transition needs separate qualification; the original installer's
`retire` still correctly refuses its uncompleted global handoff.

## Optional old-app/runtime retirement

Install does not remove the old app. After verified successor release and safe
GUI close, a separate explicit command performs retirement:

```sh
node scripts/day-install.ts retire /absolute/selection.json --gui-closed
```

1. Verify the full bundle, selected profile, old app and native service ownership.
2. Stage the new app, save GUI state and fence/pause/cancel known work natively.
3. Hand off the existing daemon to the new app's own runtime. Verify actual
   successor identity/build/protocol, not just a version string.
4. Resume only update-owned eligible work, preserving user holds and Unknown.
5. Retire the exact old Pilot Next app and its obsolete runtime copies only
   after successful handoff and safe GUI close. Never delete profile/draft data.

Known runtime stores are `~/Library/Application Support/Pilot Next Service Runtime`
and legacy `~/Library/Application Support/Pilot Next Runtimes`. Native cleanup
checks live and other-profile users. Unknown/live remnants must be reported,
not erased to claim “all runtimes removed”. Keep rollback inputs until the
successor is verified. After old-app removal, GPUI fallback requires reinstalling
a compatible app; it is not a database rollback. Day writes remain canonical.

Retirement binds the exact old app path and its full byte identity from the
original handoff. It rechecks the same live successor boot/PID, accepted release,
old seal and native bundle-user census before deleting that app (never its
parent). Runtime cleanup uses the existing native adapter, at most four roots
per store per attempt. It keeps permanent locks, stages/history and unknown
entries. Inspect output `removed`/`preserved` and errors; do not claim every copy
was removed. Entered retirement without completion is inspect-only, not a reason
to replay deletion. Completed repeats return kept observation, not new cleanup.

## Checks and limits

`node --test scripts/day-install.test.ts` uses temporary opaque profile files,
a fake loopback daemon and a synthetic signature adapter. It covers read-only
checks, data/WAL/draft preservation, repeat staging, copied-verification failure
and retry, identity/protocol refusal, native flag pins, complete successor/release,
rollback and lost-ACK lookup-only recovery. These are
not genuine signing, service handoff/removal, installed/native UI or daily-driver
acceptance checks. No production DB fixtures or visible launch are used. Broader
coverage stays in CI.
