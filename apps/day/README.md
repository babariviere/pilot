# Pilot

Pilot Day is the only Pilot desktop app. It uses Native Shell (NSH) TSX and a Rust
core in `native/`. The desktop target is Apple Silicon macOS; Linux desktop is deferred.

The default entry (`App.tsx`) runs `Connected.tsx`. It shows only what the
window's native root reads from the Pilot service, never examples. The root comes from the native
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
For private use, follow [installation and setup](../../docs/getting-started.md).
The repository cutover does not install Day, uninstall Pilot Next, change user data,
or publish a new Day release.
Opening `Pilot.app` from Finder discovers the profile like GPUI. Every launch without `--journal`
keeps its window and drafts in `~/Library/Application Support/Pilot Day/window-journal`.
Logs: `~/Library/Logs/Pilot/day.log` (`.1`-`.3`) and `pilotd.log`.
Settings has separate local-count and remote-reporting consent, retained-copy details,
and **Ask about Pilot**, an on-demand read-only specialist. Day logs start only after
verified local diagnostic controls arrive. Clear reports the service and this app
writer separately; OS logs, service stdout, exports and prior agent replies can remain.
The private install is `~/Applications/Pilot.app` and displays Pilot.
Legacy app paths and stored profiles are not changed by this source cutover.

## Run

Prerequisites: macOS arm64, Command Line Tools, Rust 1.99.1, Cargo on `PATH`,
and installed NSH 0.6.1 (`2f51d86`). `NSH_DAY_CLI` can
select a local official distribution without changing a global installation. Prepare the
workspace dependencies before running checks. Cargo may download locked crates.
Local commands use the Cargo on `PATH`, including [huacnlee/cargo](https://github.com/huacnlee/cargo)
if installed. The fork ignores target directory overrides. NSH finds the fork's outputs in each generated
workspace's `.nsh/rust/target` instead of the app's `target`.
For an explicit target directory, set `NSH_DAY_REAL_CARGO="$(rustup which --toolchain 1.99.1 cargo)"`
to select stock Cargo, as CI and the package input build do.

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
`nsh check` is Day's TypeScript check. `scripts/typecheck.sh` checks the
workspace packages only, not `apps/day`.

### Screen captures

`*Visual.test.tsx` files capture screens on the macOS host.
`TodayVisual.test.tsx` is the model: it opens a mock-data entry in light and
dark, at 1100 and 480 points wide, and saves PNGs under `output/`.
Headless runs draw nothing:

```sh
apps/day/nsh.sh test TodayVisual.test.tsx --target macos
```

### Before and after captures

For a change users can see, capture the real views before and after it. Write or reuse a capture test that calls
`app.screenshot("output/<name>.png")` on a fixture (see `Native.test.tsx`), then run:

```sh
apps/day/scripts/before-after.sh -r <landed revision> --filter '<test name>' Native.test.tsx
```

It runs that test from the landed revision in two temporary jj workspaces, at the revision and at its parent
(`--before` picks another base), with the macOS host. It prints each pair of PNGs, or `new` when a screen
has no Before. A Before run that fails part way keeps the PNGs it wrote. It opens windows on this Mac and builds
the native crate in each workspace. Captures show fixture data only.
For a new screen with no Before, use `--new-screen` to avoid building an unused base workspace.

## Development

- [AGENTS.md](AGENTS.md) has the shared development rules.
- `native/` owns read models, rules and native service access.
- TSX files hold the screens. They compose parts from the design library in
  `ui/` ([guide](ui/README.md)) and write no look classes.
  [DESIGN.md](../../DESIGN.md#pilot-day) has the design intent.
- `theme.json` holds the colour, radius and font tokens for light and dark.
  Screens reach them through `ui/` parts.
- `fonts/` bundles Geist and Geist Mono under the SIL Open Font License
  (`fonts/OFL.txt`). `ui/fonts.ts` registers them.
- NSH artifacts import the same library from `pilot-day/ui`
  ([Day design system](../../docs/technical/day-design-system.md)).
- `fixtures/` contains optional comparisons and design prototypes, not app code.
