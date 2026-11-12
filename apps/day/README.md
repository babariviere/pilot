# Pilot

Pilot Day is the upcoming Pilot desktop app, built with Native Shell (NSH)
TSX and a Rust core in `native/`.

The default app uses **mock data**. It connects to no daemon, account or user
data, and does not replace the shipping GPUI or Swift apps. `Connected.tsx`
supports native-host integration, but selecting a live service and production
packaging are not ready.

## Run

Prerequisites: macOS arm64, Command Line Tools, Rust 1.99.1, installed
NSH 0.4.0 (`e626a8d`), and mise-managed `mbx` on `PATH`. Prepare the
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
