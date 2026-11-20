# Shared macOS support

The Swift GUI is gone. [`apps/day`](../day/README.md) is the only desktop app.
This directory contains shared helpers, assets and runtime tooling, not an app
entry point.

## Kept consumers

| Path | Consumer |
| --- | --- |
| `Sources/PilotSystemEvents` | `apps/desktop/scripts/build-native-helpers.sh` builds the authenticated system-event helper used by the daemon and packaged apps. |
| `Sources/PilotPowerSupport` | `apps/power/src/tests.rs` compares Rust sleep handling with the shared Swift implementation. Production power handling is in `apps/power`. |
| `Package.swift`, `Tests/PilotPowerTests` | Dependency-free helper-only package and shared power-support tests, not a desktop app target. |
| `Sources/PilotVisualEngine` and `include` | `apps/desktop/visual-worker/{engine.c,build.rs}` compile the shared C visual engine and header. |
| `Resources/AppIcon*`, `scripts/icon*` | Day runtime packaging and icon generation. |
| `Resources/LegacyApp` | Historical images and notices from the old app. Keep their credits. |
| `scripts/{bundle-runtime,check-runtime}.sh`, `runtime-build.mjs` | Immutable runtime assembly, offline relocated-runtime checks and source receipts for Day. |
| `scripts/release_metadata.py`, `finalize-release.sh` | Release metadata and draft finalization tooling. These are not private Day install steps or authorization to publish Day. |
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

Use the [Day checks](../day/README.md#check) for native app changes. No full local
Swift GUI suite remains. Removing this source does not uninstall an app, change
user data, stop services, select Day as default or qualify a live update.
