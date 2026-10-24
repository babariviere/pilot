# Agent-aware Mac sleep

Settings → Energy controls the daemon, so the policy still applies after quitting the GUI.
Keeping the Mac awake while agents work is enabled by default. The display may sleep and the
screen may lock. Live background jobs and subagents hold an assertion. After the last active work
finishes, Pilot keeps the Mac awake for another 60 seconds so completion notices can reach the
coordinator and start follow-up work. New work cancels that countdown; the next idle transition
starts a fresh one. Already-idle chats do not start a countdown on daemon startup or status updates.
This grace period also retains eligible closed-lid mode, but never delays a sleep pause, unsafe
closed-lid conditions, disabling keep-awake or daemon shutdown.

**Keep going with the lid closed** is opt-in and needs administrator approval once. It permits
closed-lid work only when external power **and** a usable Wi-Fi path are present. Disconnecting
either while the lid remains closed pauses agents, restores normal sleep and requests sleep.
Without that option, ordinary lid sleep still pauses work for the next wake.

While agents work with closed-lid mode enabled, AC power and Wi-Fi connected, macOS ignores
**Apple menu → Sleep**, even with the lid open. Turn off **Keep going with the lid closed**
(or wait for agents to finish and the 60-second grace period to expire) before choosing Sleep.
The override blocks the sleep request before Pilot receives a sleep notification; it does not
trigger an agent pause.

Pilot does not lock the screen or change macOS password/lock-delay settings. With closed-lid
keep-awake on, whether the Mac locks depends on macOS and your settings, such as requiring a
password after the display turns off. Suppressing lid sleep can bypass its normal locking path;
do not assume closing the lid locks the Mac while this option is on.

Pausing closes kernels without sending Stop/abort. The durable Harness retains its pending work.
Native commands and background jobs interrupted by teardown are not automatically rerun. Their
handles/results report interruption; agents can inspect what happened when they resume. This is
not OS process hibernation. Queued messages keep their original admission IDs.

Only a **later full wake with connectivity** resumes a policy pause. With the lid still shut,
closed-lid work must be enabled and both AC power and Wi-Fi must be present. Reconnecting
Wi-Fi while the lid is still closed, display wake, dark wake, screen unlock and daemon restart on
the same wake do not count. A later wake observed after a daemon restart does count. On a desktop,
an absent lid is treated as open. Archived chats and stopped/idle chats do not automatically restart.
New messages submitted during a pause are saved for wake. History remains readable without starting
a kernel. Stop remains available during a pause: it saves cancellation without reopening a kernel or
resuming other chats. At the next eligible wake, cancellation drains before recovered model requests
or tools can run. Undelivered daemon messages return to the composer immediately; messages already
queued in the kernel are withdrawn when cancellation drains. A paused chat can also be archived to
opt out of automatic resume.

## Implementation and authorization

- `PowerService` in `packages/daemon/src/power.ts` serializes and coalesces policy decisions.
- `SessionManager` commits `power-pause.json` before detaching/closing kernels. Kernel admission,
  mission notices, PR follow-ups and subscription reopening respect this latch. It is cleared only
  at a qualifying wake, or when the user explicitly disables the policy. Every detached chat's recovery
  marker is saved before sleep preparation completes. OS sleep acknowledgement waits for this durable
  preparation, not the serial batches of process exits. Wake and update readiness still wait for full
  teardown, so a suspended old worker cannot race its replacement for storage.
- `PilotPower` is a pipe-connected native executable, independent of the GUI. IOKit supplies AC/lid
  and sleep notifications. Network.framework supplies Wi-Fi and connectivity booleans, without
  SSIDs, scans, location access or provider requests. It holds only a system-idle assertion, never
  a display assertion. Requested system sleep gets a five-second fallback on the native notification
  queue, independent of daemon responsiveness, process teardown and guardian commands. Normally the
  daemon acknowledges as soon as durable preparation finishes, before releasing activity assertions.
  Replies carry a sleep generation, so an old reply or timer cannot release a later sleep. The fallback
  permits OS suspension even if persistence stalls; preparation/recovery continues after wake, with
  admissions still fenced. This is not a guarantee against power loss during a failed disk write.
- Closed-lid work uses `pmset disablesleep 1/0`, the same mechanism documented by
  [Vorssaint](https://github.com/vorssaint/vorssaint-utils). This implementation is independent, not
  copied from its GPL source. The setting is **system-wide and persistent**, not a process assertion.
  While armed it blocks Apple-menu Sleep as well as lid sleep, even with the lid open. Keep ventilation clear.
- A one-time, explicit administrator dialog installs `/etc/sudoers.d/pilot-power`, granting the
  current numeric uid only `/usr/bin/pmset disablesleep 1` and `0`. Subsequent calls use `sudo -n`.
  Neither Pilot nor its daemon runs as root. No administrator password is retained.

An independent guardian owns the global override. Pipe EOF (daemon/helper death) or a missed
20-second heartbeat lease restores it. A per-user exclusive lock prevents development daemons
from competing, and an ownership marker is written **before** enabling the override. Recovery on
the next helper launch covers abrupt termination of both processes. An existing override owned by
another app is not adopted or cleared. Clearing the flag with the lid already closed is followed
by a bounded IOKit sleep request, respecting docked-display and live lid-specific protections.
If power or Wi-Fi disappears with the lid shut, the monitoring helper also bounds pause preparation
to 20 seconds, even when daemon heartbeats continue.

No software can clean up if every guardian is killed simultaneously, or if its sudo permission is
removed while the override is active. Recovery retains its marker on failure and surfaces an error.
For manual recovery, an administrator can run `sudo /usr/bin/pmset disablesleep 0`. To remove the
grant, first turn closed-lid work off, then remove `/etc/sudoers.d/pilot-power` as an administrator.

## Verification

Automated tests use synthetic state, temporary stores and injected override writers. They do not
install sudoers entries, alter this Mac's power settings, call sleep/lock APIs, or use model accounts.
The 10,000-update streaming regression verifies unchanged activity generates no additional native
writes. Fake-clock regressions cover the exact grace deadline, new-work cancellation, safety
overrides and shutdown. A real mission-notice scheduler fixture delivers a child's completion after
its 30-second debounce, holds coordinator admission for another ten seconds, and verifies that
sleep prevention never drops during the handoff. These tests do not sleep the physical Mac.
Activity updates track active IDs without scanning the entire session registry, with one
evaluator and at most eight pending native requests. Native sensors are event-driven; the only periodic work is the five-second safety lease.

Physical hardware still needs an opt-in smoke check on a test Mac:

1. Run a faux-provider chat, lock the screen, and allow display sleep. Confirm work continues.
2. Approve closed-lid mode, connect AC and Wi-Fi, close the lid and confirm progress without a display.
   Repeat with an external display attached. Confirm Pilot does not initiate a lock or change the
   user's lock settings; authentication behavior is left to macOS and those settings.
3. Repeat unplugging AC, then disconnecting Wi-Fi. Confirm pause precedes override restoration and sleep.
4. Open on a new wake while offline. Confirm no resume until a connection returns. Confirm dark wakes,
   display wake and same-wake daemon restart do not resume work.
5. With a disposable chat, terminate the daemon, then the monitoring helper separately. Confirm the
   guardian restores sleep. Terminate the guardian separately and confirm the helper recovers it.
6. Check a docked external display, permission cancellation/revocation, and helper relaunch recovery.

Do not perform these destructive power/lifecycle checks on a Mac running real work.

### Agent handoff grace verification (2026-10-24)

The idle-release timer is a single unreferenced timeout, armed only when the tracked active-ID
set becomes empty. New activity, policy disable, a sleep pause, helper loss and shutdown cancel it.
Unchanged streaming/status updates cannot renew it, and there is no new polling or persistence.

An offline macOS arm64/Node 24.21.0 probe compared `b41bedbc` with the grace policy using five
alternating pairs after warmup. Each sample delivered 100,000 unchanged activity updates across
1,000 live idle-parent summaries, each with 100 working child summaries. Median wall time was
3.45 ms before and 3.53 ms after; median CPU was 3.47 ms and 3.54 ms. Both produced zero extra
native writes. This isolates in-memory activity handling, not provider streaming, history loading,
GUI responsiveness, actual sleep latency or notice delivery under arbitrary system load.

### Sleep acknowledgement investigation (2026-10-15)

Installed 1.36.1 (953.1) observed will-sleep at 18:01:05 CEST, entered software sleep at
18:01:25, and woke at 18:04:04. `pmset -g log` attributes a 20,174 ms sleep-notification
delay to PilotPower. Main `60453b09` still had the release's 20-second native fallback and
byte-identical daemon power policy. The newer session-lock change did not alter acknowledgement.

The old daemon awaited all worker exits (four at a time, with an eight-second forced-exit
deadline per batch), then the activity/guardian reply, before acknowledging sleep. Synthetic
blocked-worker tests reproduce that acknowledgement dependency without sleeping the host. The
recorded duration is consistent with exhausting the fallback, but the historical evidence does
not identify which teardown/guardian operation consumed the window. No host sleep, network,
daemon lifecycle or power-setting changes were performed for this investigation.

Regression tests now hold nine synthetic worker exits indefinitely: all recovery markers become
durable before acknowledgement is eligible, while wake still waits for every exit. Native policy
tests cover one-shot acknowledgement, wake cancellation and stale generations. A user-operated
hardware retest should compare the next sleep's notification delay in `pmset -g log`; the synthetic
checks do not establish real-device latency or a hard real-time scheduling guarantee.
