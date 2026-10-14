# Agent-aware Mac sleep

Settings → Energy controls the daemon, so the policy still applies after quitting the GUI.
Keeping the Mac awake while agents work is enabled by default. The display may sleep and the
screen may lock. Idle chats do not hold an assertion; live background jobs and subagents do.

**Keep going with the lid closed** is opt-in and needs administrator approval once. It permits
closed-lid work only when external power **and** a usable Wi-Fi path are present. Disconnecting
either while the lid remains closed pauses agents, restores normal sleep and requests sleep.
Without that option, ordinary lid sleep still pauses work for the next wake.

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
a kernel. A paused chat can be archived to opt out of automatic resume.

## Implementation and authorization

- `PowerService` in `packages/daemon/src/power.ts` serializes and coalesces policy decisions.
- `SessionManager` commits `power-pause.json` before detaching/closing kernels. Kernel admission,
  mission notices, PR follow-ups and subscription reopening respect this latch. It is cleared only
  at a qualifying wake, or when the user explicitly disables the policy.
- `PilotPower` is a pipe-connected native executable, independent of the GUI. IOKit supplies AC/lid
  and sleep notifications. Network.framework supplies Wi-Fi and connectivity booleans, without
  SSIDs, scans, location access or provider requests. It holds only a system-idle assertion, never
  a display assertion. Requested system sleep gets a bounded 20-second preparation window, not an
  indefinite veto. A slow/failing teardown cannot prevent macOS from sleeping indefinitely.
- Closed-lid work uses `pmset disablesleep 1/0`, the same mechanism documented by
  [Vorssaint](https://github.com/vorssaint/vorssaint-utils). This implementation is independent, not
  copied from its GPL source. The setting is **system-wide and persistent**, not a process assertion.
  While enabled it can affect other system-sleep requests too. Keep ventilation clear.
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
install sudoers entries, alter this Mac's power settings, call sleep APIs, or use model accounts.
The 10,000-update streaming regression verifies unchanged activity generates no additional native
writes. Activity updates track active IDs without scanning the entire session registry, with one
evaluator and at most eight pending native requests. Native sensors are event-driven; the only periodic work is the five-second safety lease.

Physical hardware still needs an opt-in smoke check on a test Mac:

1. Run a faux-provider chat, lock the screen, and allow display sleep. Confirm work continues.
2. Approve closed-lid mode, connect AC and Wi-Fi, close the lid and confirm progress without a display.
3. Repeat unplugging AC, then disconnecting Wi-Fi. Confirm pause precedes override restoration and sleep.
4. Open on a new wake while offline. Confirm no resume until a connection returns. Confirm dark wakes,
   display wake and same-wake daemon restart do not resume work.
5. With a disposable chat, terminate the daemon, then the monitoring helper separately. Confirm the
   guardian restores sleep. Terminate the guardian separately and confirm the helper recovers it.
6. Check a docked external display, permission cancellation/revocation, and helper relaunch recovery.

Do not perform these destructive power/lifecycle checks on a Mac running real work.
