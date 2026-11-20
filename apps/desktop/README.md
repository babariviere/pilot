# Shared desktop tools

This directory is not a desktop app. [Pilot Day](../day/README.md) is the only
desktop app, on Apple Silicon macOS. Linux desktop is deferred.

| Path                                                           | Role                                                                                                                                              |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`Cargo.toml`](Cargo.toml), [`visual-worker/`](visual-worker/) | Cargo workspace for the shared visual worker. It uses the [macOS C visual engine](../macos/README.md).                                            |
| [`updater/`](updater/)                                         | Standalone Cargo workspace, excluded from the parent workspace. Day's native host uses its verification and lifecycle code.                       |
| [`scripts/`](scripts/)                                         | Shared runtime assembly, native helpers, and Day package inputs and checks. See [Day package inputs](../../docs/technical/day-package-inputs.md). |

Pilot Next GPUI was removed from the repository. Its [implementation contracts](docs/)
remain at their original paths as historical evidence. For the old app and its source
references, see the [pre-cutover source tree and README](https://github.com/babariviere/pilot/tree/094f295850010f2217bdd7f47f1397ab0319d1f0/apps/desktop).
These are not current build, install or release instructions. The repository change
does not uninstall apps or alter user data.
