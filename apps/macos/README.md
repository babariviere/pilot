# Shared macOS support

The obsolete Swift desktop GUI and its dependencies are removed. The current
GPUI app lives in [`apps/desktop`](../desktop/README.md); the next Native Shell
app lives in [`apps/day`](../day/README.md). This directory is **not** an app
entry point and must not be deleted as a unit.

## Kept consumers

| Path | Consumer |
| --- | --- |
| `Sources/PilotSystemEvents` | `apps/desktop/scripts/build-native-helpers.sh` builds the authenticated system-event helper used by the daemon and packaged apps. |
| `Sources/PilotPowerSupport` | `apps/power/src/tests.rs` compares Rust sleep handling with the shared Swift implementation. Production power handling is in `apps/power`. |
| `Package.swift`, `Tests/PilotPowerTests` | Dependency-free helper-only package and shared power-support tests, not a desktop app target. |
| `Sources/PilotVisualEngine` and `include` | `apps/desktop/visual-worker/{engine.c,build.rs}` compile the shared C visual engine and header. |
| `Resources/AppIcon*`, `scripts/icon*` | GPUI/Day runtime packaging and icon generation. |
| `Resources/LegacyApp` | Unchanged images and notices from the old app. GPUI's `home_sky.rs` uses the day/night images; keep their credits. |
| `scripts/{bundle-runtime,check-runtime}.sh`, `runtime-build.mjs` | Immutable runtime assembly, offline relocated-runtime checks and source receipts for GPUI/Day. |
| `scripts/release_metadata.py`, `finalize-release.sh` | Shared macOS/Linux release metadata and signed GUI draft finalization. These are not Swift app publishing paths. |
| `Tests/Fixtures` | Backend logical-mission producer and workspace-terminal regressions, plus the loopback WebSocket test harness. |

The SystemEvents helper still uses Swift. It does not depend on SwiftUI,
Ghostty, Sparkle, MermaidKit or the removed SwiftPM GUI package. Packaged daemons
resolve helpers from their own runtime bundle. Source-only development requires
an explicit `PILOT_SYSTEM_EVENTS_HELPER_APP` pointing to an assembled helper app;
it no longer searches an obsolete Swift GUI build. Power development uses the
standalone Rust helper.

## Checks

From the repository root:

```sh
python3 -B -m unittest discover -s apps/macos/scripts/tests -p 'test_*.py'
node --test apps/macos/scripts/tests/*.test.mjs
for script in apps/macos/scripts/*.sh; do bash -n "$script"; done
```

Use the desktop/Day verification wrappers for native changes. No full local
Swift GUI suite remains. Removing this source does not uninstall an app, change
user data, stop services, select Day as default or qualify a live update.
