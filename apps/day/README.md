# Pilot

Pilot Day is the upcoming Pilot desktop app, built with Native Shell (NSH)
TSX and a Rust core in `native/`.

The default entry (`App.tsx`) runs `Connected.tsx`. It shows only what the
window's native root reads from an existing Pilot service, never examples, and it
does not replace the shipping GPUI app. The root comes from the production native
host in a separately verified distribution. Its
[connected launch requirements](../../docs/technical/day-package-inputs.md#connected-launch)
include explicit native selection and a compatible existing daemon. Build inputs
are not a connected daily-driver candidate.
The native launcher selects the profile/service, not a project or model. Today
defaults to All projects and keeps its header filter per window. The window acts
on one project at a time: the one chosen in that filter, or the project of the
mission last opened. Other projects' rows open their missions and plans.
New starts with no project; choose one to read
its configured model and trusted planning setup. Plan a mission and Start as one
chat remain separate explicit actions. Saved drafts keep their chosen project.
Command+K opens a palette over any screen. It goes to Day's places and to the
missions Today and Planning list; it only navigates and never starts work.
Use the [connected candidate recipe](../../docs/technical/day-connected-candidate.md)
to prepare the real native app without installing or updating it.
For personal connected use, see [installation preparation](../../docs/technical/day-install.md).
It reuses the same profile, hands off the daemon and offers explicit legacy retirement.
Opening `Pilot.app` from Finder reuses the last launcher selection
(`~/Library/Application Support/Pilot Day/launch.json`) or discovers the profile like GPUI,
with the journal in that folder. Logs: `~/Library/Logs/Pilot/day.log` (`.1`-`.3`) and `pilotd.log`.
New Day distributions are named `Pilot.app`, display Pilot, and can install at
`~/Applications/Pilot.app`. Legacy app paths and all profile/service identities stay unchanged.

## Run

Prerequisites: macOS arm64, Command Line Tools, Rust 1.99.1, installed
NSH 0.5.0 (`f4d68f7`), and mise-managed `mbx` on `PATH`. `NSH_DAY_CLI` can
select a local official distribution without changing a global installation. Prepare the
workspace dependencies before running checks. Cargo may download locked crates.
Day CI sets `NSH_DAY_CARGO_MODE=direct` to run the selected real Cargo directly.
The default for local development remains the MBX adapter.

From the repository root:

```sh
apps/day/nsh.sh run
```

`nsh run` gives the window no native root, so it says Pilot is not connected
and shows nothing else.

Mock worlds are test fixtures for the headless tests: `MockApp.tsx`, the other
scenario and `*Fixture.tsx` entries, `mockFeeds.tsx`, `mockSession.ts` and
`*Demo.ts`. Every record in them is invented, and their header says Mock data.
To look at one, pass its entry file:

```sh
apps/day/nsh.sh run MockApp.tsx
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
