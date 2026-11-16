# Native Today qualification, 2026-11-16

This slice reuses the connected app, not a replacement renderer or a fixture
dashboard. It does not install, update, register or change the default app, stop
the owned service, start provider work, or retire legacy code.

## Existing delivery and audits

The linked Knowledge records remain source audits, not native acceptance:

| Record (revision)                                                             | Reused behavior and remaining boundary                                                                                                                                                       |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Day navigation, `106568be-6e24-4782-80e8-02fcac7ac5f3` (2), DAY-01–06/21–22   | `App.tsx` → `Connected.tsx`, native-selected service, All projects default, passive reads, explicit freshness and window-local drafts. Old mock Today delivery is not live-service evidence. |
| Distribution, `c655ce0d-1dda-45e8-8afa-c29a01ff2210` (2), DIST-04–09/14/16–17 | Existing exact-release CLI, native bootstrap, source-matched package checks and separate connected candidate. Neither unsigned CI inputs nor `nsh run` replace a sealed connected bundle.    |
| Ownership, `9e36a7c1-ecef-48cd-aced-307358ff6cc0` (2), DO-01–05/13–15         | Existing profile lease, daemon/lineage identity, native capability and verified package boundary. A successful connection is not update/handoff qualification.                               |
| Artifacts, `a44866e2-60aa-4eb5-a002-38c8ce3dea56` (2)                         | Saved outputs and shared artifact/visual helpers remain separate from Today transport and rendering. This slice does not qualify their execution.                                            |
| Power, `62571769-1a1d-4bf5-b22c-af6a210302ec` (2), POW-01/06–11               | Keep-awake, sleep preparation, connectivity and selective recovery belong to the service/native helpers. A GUI launch does not replace or qualify them.                                      |
| Old-task reconciliation, `a1f18464-5433-4aae-adee-dd45fd1d6c35` (2)           | The 205-task index distinguishes implementation, reported checks and missing acceptance. Old Done statuses are not new native results.                                                       |

The existing Today transport is `native/src/host.rs`; `host/bridge.rs` owns
typed JSON calls and `connection.ts` mirrors them. Loopback HTTP reads supply
data. WebSocket events invalidate reads; they do not supply authoritative
content or prove writes. Credentials stay native. `todayScope.ts` preserves
unknown counts and unavailable sections instead of showing zero or examples.

## Actual package provenance

The initial native check reused the already installed
`~/Applications/Pilot.app`, without replacing it:

- App/runtime source: `034eced46e94489f0a485a50e83766163757ec13`.
- App build: `20261116.8`; runtime version: `1.125.0`; Node: `24.21.0`.
- Native target: `aarch64-apple-darwin`; release profile; Rust `1.99.1`
  (`58cf8f9c35b355199727627d07ae34a4e2846d67`).
- Compiled input recipe:
  `0f3963137f708a98c3e8b10d234a3b151a7771f47043f7fb7d7413416f1d322f`.
- NSH: unmodified `longbridge/nsh` v0.5.0,
  `f4d68f7f9f31eb7b3ecc8a4cbc31096d5c6238a1`. The sealed
  `gui-resources.json` records this release and the app source.
- The installed CLI reports `nsh 0.5.0 (f4d68f7)`; executable SHA-256:
  `694ab2f1e4b97871e42399ae55a916f4fb528df8319eb2c0965f9c68331ebdb8`.
- The app source's native manifest pins NSH crates to `=0.5.0`, with no
  NSH patch section. Its lock matches the qualification checkout byte for
  byte, SHA-256:
  `b676a688d12c732b212422b55a810d0fa432151bf18ab6ddd98535d3e3550fda`.

The source object was read from the user's original checkout, read-only.
The compiled `--build-input-receipt`, runtime build metadata, GUI resource
inventory, bundle inventory and `codesign --verify --deep --strict` were
checked. Pre-seal executable hashes in input receipts are not final signed
executable hashes: codesign changes those bytes. The final code seal binds
the executable and resources. Private ad-hoc signing is not Apple notarization.

The existing service answered on loopback port 4319 with protocol 1,
`dayOverview: 1`, independent execution and the expected daemon/lineage pair.
Its reported version was 1.125.0. No credential or ownership secret belongs
in this evidence document.

## Native observations and discovered failure

An explicit native launch used the existing profile/service and a fresh
private journal under TMPDIR. Direct shell-process launch connected, but the
user could not see its window. Retrying with `open -n` brought up a separate
window. The user then reported: **“Visible, Today and input work”**, after
being asked to inspect real Today, type an unsent New draft and try Command+K
and Escape. This is a limited user-reported native check, not broad product
acceptance or an IME/screen-reader result.

A second fresh-journal window deliberately selected unused loopback port
4318. The real service remained running on 4319. The user reported the window
stuck on **“Reading your projects...”** and supplied a screenshot. Native logs
showed repeated Offline failures, then `IdOutOfRange(201028)` and a stopped
surface. The header's “Service not answering” did not make this loading state
honest. This was a failed native check, not a passing unavailable-state demo.

`fail()` notified listeners on every identical failed read. Each notification
made the connected window read its project scope again, which failed and
notified again. The fix suppresses unchanged freshness notifications while
keeping the authority epoch and enrollment invalidation on every failed read.
It does not retry writes, weaken permissions or alter NSH.

The regression in `native/tests/support/today_refresh.rs` uses the real
`NativeHost` → `Bridge` → `Connected.tsx` path with a synthetic private
capability and no listening service. Before the fix it reproduced the exact
loading text. After the fix it shows “Pilot could not reach its service.”,
settles without new Today revisions, and shows neither mock work nor an
all-clear. This is headless behavioral evidence. A newly sealed candidate's
native unavailable-state recheck remains separate.

## Ownership before any future removal

| Keep independently                                                     | Current consumer                                                                                                            |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Daemon/kernel/protocol, durable history and ownership records          | Both desktop clients; canonical work is not owned by a renderer.                                                            |
| `apps/desktop/updater` and native daemon credential reader             | Day's native bootstrap, update helper and service controls.                                                                 |
| `apps/desktop/visual-worker`, shared C engine and artifact host        | Full Day bundle and artifact pipeline. A minimal connected candidate omits unused helpers, not their full-app requirements. |
| `apps/power`, SystemEvents Swift helper, PowerSupport/tests            | Daemon power, sleep and platform notifications; not obsolete Swift GUI.                                                     |
| `apps/macos/Package.swift`, runtime/release scripts and assets/notices | Helper-only package and shared package/runtime consumers. Preserve attribution.                                             |
| GPUI renderer, its launcher and exclusive probes                       | Current usable fallback until separately qualified and approved retirement. Preserve its saved state.                       |

No directory or legacy path was removed. Complete Mac daily-use acceptance,
signed update/recovery qualification, IME, accessibility and physical Linux
qualification remain outside this Today slice. The installed app is unchanged;
the discovered fix needs a separately built candidate before native rechecking.
