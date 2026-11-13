# Pilot

Pilot Day is the upcoming Pilot desktop app, built with Native Shell (NSH)
TSX and a Rust core in `native/`.

The default app uses **mock data**. It connects to no daemon, account or user
data, and does not replace the shipping GPUI app. `Connected.tsx`
uses the production native host through a separately verified distribution.
Its [connected launch requirements](../../docs/technical/day-package-inputs.md#connected-launch)
include explicit native selection and a compatible existing daemon. Build inputs
or a demo Preview are not a connected daily-driver candidate.
Use the [connected candidate recipe](../../docs/technical/day-connected-candidate.md)
to prepare the real native app without installing or updating it.

## Run

Prerequisites: macOS arm64, Command Line Tools, Rust 1.99.1, installed
NSH 0.5.0 (`f4d68f7`), and mise-managed `mbx` on `PATH`. `NSH_DAY_CLI` can
select a local official distribution without changing a global installation. Prepare the
workspace dependencies before running checks. Cargo may download locked crates.

From the repository root:

```sh
apps/day/nsh.sh run
```

For a separate demo installation, see [Local Pilot Preview](../../docs/development-preview.md).

To explore another mock scenario, pass its entry file:

```sh
apps/day/nsh.sh run Trouble.tsx
apps/day/nsh.sh run Interview.tsx
apps/day/nsh.sh run Changes.tsx
apps/day/nsh.sh run Update.tsx
```

## Check

```sh
apps/day/scripts/typecheck.sh
apps/day/nsh.sh check
apps/day/nsh.sh build
apps/day/nsh.sh test App.test.tsx
(cd apps/day/native && ../scripts/cargo test --locked)
```

Run the matching `*.test.tsx` file for the feature you change. Headless tests
check behavior, not native appearance, keyboard input or IME support.

## Development

- [AGENTS.md](AGENTS.md) has the shared development rules.
- `native/` owns read models, rules and native service access.
- TSX files hold the screens; `theme.json` holds shared theme tokens.
- `fixtures/` contains optional comparisons and design prototypes, not app code.
