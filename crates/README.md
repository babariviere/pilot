# Shared Rust crates

Each crate has its own manifest and committed lockfile. There is no parent Cargo
workspace. Day's native host has its own lockfile under [`apps/day/native`](../apps/day/native/).

| Crate                          | Role                                                                                   |
| ------------------------------ | -------------------------------------------------------------------------------------- |
| [`updater`](updater/README.md) | Signed update verification and app and daemon update lifecycle.                        |
| [`power`](power/PORTING.md)    | `PilotPower` daemon helper. Provides macOS sleep handling and the Linux D-Bus backend. |

## Checks

From the repository root, put `rustup` and the mise-managed `mbx` on your PATH.
Run [`bootstrap.sh`](scripts/bootstrap.sh) to install the pinned Rust toolchain and
nextest under `crates/.tools`. Run the relevant
[`ci.sh`](scripts/ci.sh) checks on Apple Silicon macOS 15+ or Linux x86-64:

```sh
bash crates/scripts/bootstrap.sh
bash crates/scripts/ci.sh updater-check
bash crates/scripts/ci.sh power-check
```

The updater also has platform checks: `updater-mac-tests` on Apple Silicon macOS,
and `updater-linux-tests` on Linux x86-64. These are source and fixture checks,
not install or release qualification.

For a focused Cargo check, [`cargo.sh`](scripts/cargo.sh) runs from `crates/`,
so pass a manifest relative to that directory:

```sh
bash crates/scripts/cargo.sh test --locked --manifest-path updater/Cargo.toml --lib
```

Use the [Day guide](../apps/day/README.md) for app checks and
[`apps/day/scripts`](../apps/day/scripts/) for
[native helpers and package inputs](../docs/technical/day-package-inputs.md).

The old [`pilot-visual-worker`](https://github.com/babariviere/pilot/tree/753b2f5cca1119d4c185c04fe60844d21431c928/apps/desktop/visual-worker)
and its [native C engine](https://github.com/babariviere/pilot/tree/753b2f5cca1119d4c185c04fe60844d21431c928/apps/macos/Sources/PilotVisualEngine)
are retired. Day builds [`pilot-artifact-host`](../docs/technical/nsh-artifact-source.md#availability-and-remaining-gates)
from its own native crate for NSH artifacts. The [Node retained-visual worker](../docs/technical/retained-visual-precheck.md)
is separate and remains host-only.
