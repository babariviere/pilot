# Energy status contract audit

Source-only reconciliation, 2026-10-30. No native Energy page is added. The
existing passive read is useful as a **cached daemon report**, but does not meet
this slice's requirement for current authoritative observations with explicit
freshness and platform limitations. This is not permission to expand the backend.

## Existing owners and reads

- `packages/daemon/src/server.ts`: `GET /api/power` synchronously returns
  `PowerService.status()`. It does not start, refresh, configure or reconnect a
  helper. The initial control-WebSocket `power` event and change broadcasts use
  the same report. Without the service, GET returns 503, not an idle observation.
- `packages/daemon/src/daemon.ts` separately starts the service when daemon
  capabilities permit it. `power.ts` owns saved policy, work tracking, sleep
  preparation and the 60-second idle grace. `power-helper.ts` owns the private
  helper pipe and recovery. A GUI must not call these owners directly or launch
  another helper. Closing the GUI does not establish or end inhibition.
- `packages/protocol/src/power.ts` exposes global daemon policy and status, not
  project preferences. `settings.keepAwake` and `settings.closedLid` are
  configuration, never evidence of active inhibition. `paused` is the daemon's
  sleep-pause latch, not a subscription pause or proof of hardware sleep.
- Historical `apps/macos/Sources/Pilot/EnergySettings.swift` combines this report
  with toggles through `loadPowerStatus` / `updatePowerSettings`. The latter is
  `PATCH /api/power`, which can authorize privileged commands and persist policy.
  It is expressly outside this read-only slice, including when presented as setup
  or recovery rather than a toggle.

## Why not label this as current power state?

| Report | Source and limit |
| --- | --- |
| `available` | Last helper sample, or false when absent. There is no observation timestamp, sequence or sample-age signal. A successful GET only dates the read of that cache. |
| `keepingAwake` | On macOS, daemon bookkeeping after an acknowledged activity command. Rust `runtime.rs` acknowledges only after `set_awake` succeeds; it is not an independent query of the current OS assertion. KDE additionally requires the sampled active inhibition. Preserve these distinctions rather than infer from policy. |
| `closedLidActive` | Last helper-reported override state, not proof that the lid is closed or work can safely continue now. The public report omits lid state. |
| `connectedToPower`, `wifiConnected`, `authorized` | Default to false when the sample is absent. False cannot always mean observed battery/no Wi-Fi/denied permission. KDE deliberately supplies false for power/Wi-Fi without those observations. |
| `error` | Preserved service problem or Linux qualification warning. Other booleans can coexist with an error; they must not silently become a healthy/current label. Error prose is not a stable capability or freshness discriminator. |

The delivered Rust macOS helper (`apps/power/src/{runtime,macos}.rs`, #402)
preserves the protocol, assertion/guardian cleanup, acknowledgements and saved
closed-lid opt-in policy. Ordinary idle prevention does not override manual sleep.
The opt-in closed-lid policy retains its existing system-wide Apple-menu Sleep
restriction while working, per D100; this audit changes neither policy.

The Linux helper (`apps/power/src/linux.rs`, #405) requires KDE Wayland,
PowerDevil and logind delay permission. It reports `backend: kde`,
`qualification: unqualified`, `networkKnown` and `inhibitionActive` internally.
`PowerService.status()` drops those structured capability/unknown fields. A
cookie alone is not active inhibition, closed-lid override is unsupported, and
hardware behavior remains unqualified. Other Wayland compositors are not made
supported by this read. No X11/compositor changes or hardware tests follow.

## Remaining scope and approval boundary

A future current-status page needs a narrowly approved read-contract change for
structured platform/capability/unknown distinctions and observation validity,
including the meaning of an unchanged sample and helper loss. A timestamp added
at GET time would not establish sensor freshness. This audit does **not** propose
sensor polling, a new helper command, controls, grants or setup, and does not
wait for approval to deliver this reconciliation.

Any eventual reader must retain the app's Local hello/daemon/lineage pinning and
global scope, generation/cancellation fences, bounded response handling and
same-scope retained stale errors. Loopback identity pinning is not authentication.
Do not create polling or a second dashboard to compensate for missing metadata.
Actual controls remain under parent #153; hardware qualification remains separate.

## Isolated regression evidence

`packages/daemon/src/server-power.test.ts` characterizes GET before service start,
after injected KDE samples, on repeated reads and after injected helper loss.
It checks exact public reports, enabled-versus-active separation, no helper
start/reconnect/command amplification and no settings file creation. All transport
is ephemeral loopback with a fake helper; no native power APIs, settings, grants,
services or user data are accessed. Existing tests cover explicit PATCH separately.
No UI was added, so hidden GPUI captures and Rust/Swift builds are not applicable.
