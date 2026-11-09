# Pilot Day Today, Rust-only counterpart

The same mock Today screen as the TSX spike (`../`), written in Rust only, for
the stack comparison. It is stack evidence, not the production app. It runs no
JS VM and connects to no daemon, account or user data. The GPUI and Swift
apps, their build and `apps/desktop/nsh`'s pin do not change.

It uses the same upstream NSH revision as the TSX spike
(`530b73170f61e5bf16380959de9e622f8ce130cd`), with no patches, forks, Cargo
cache edits or WebViews. `Cargo.lock` started from `../native/Cargo.lock`.

## What is shared, and what is not

Both screens use one read model, one set of rules and one mock coordinator:
`pilot_day_native::fixture::world(Scenario)`, `Desk` and `MOCK_LATENCY`
(350 ms). Only the UI layer differs. This crate depends on `../native` as
plain Rust and never calls `TodayFeed`.

## Parity matrix

| Aspect             | TSX (`../`)                                                                | Rust (`rust/`)                                                                                | Status                                                           |
| ------------------ | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| NSH                | 530b7317, QuickJS VM, TSX screen + `pilot-day/native` crate                | 530b7317, Rust root, no JS VM in the generated runner                                         | Same revision; the VM is the difference under test               |
| Data               | `fixture::world`, `Desk`                                                   | Same values, same `Desk`                                                                      | Same                                                             |
| Worlds             | `App`, `Quiet`, `Trouble`, `Large`, `Pulse` `.tsx`                         | `TodayApp`, `QuietApp`, `TroubleApp`, `LargeApp`, `PulseApp`; `TodayRoot { scenario, pulse }` | Same                                                             |
| Theme, window      | `theme.json`; 1100 × 820, min 420 × 480                                    | `../theme.json`; same window keys                                                             | Same                                                             |
| Layout and copy    | `TodayScreen`, `DecisionCard`, `ui.tsx`                                    | `screen.rs`, `card.rs`, `ui.rs`, part for part                                                | Same structure, Tailwind scale and text (see literals below)     |
| Controls           | `nsh/base` Button, Toggle, Radio, RadioGroup, Input                        | `nsh_base` button, toggle, radio, radio_group, input                                          | Same components                                                  |
| Native states      | hover, active, focus, disabled, aria-pressed, checked as classes           | Same as typed styles                                                                          | Same, with three noted exceptions                                |
| Update path        | Rust posts the whole `Today` to JS; one signal `set`; keyed `Each`         | Clone of the whole `Today`; one signal `set` that always notifies; keyed `each`               | Same shape: whole model per change, no diff                      |
| Update workload    | `Pulse.tsx`: `feed.pulse()`                                                | `PulseApp`: `Day::pulse()`                                                                    | Same `Desk::pulse`, 100 ms × 300 by default                      |
| Lists              | `Each` in one `Scroll`, no virtualization                                  | `each` in one `scroll`, no virtualization                                                     | Same; Large renders 203 missions in both                         |
| Intents            | Typed objects, checked at run time (`TypeError`)                           | Rust types, checked at compile time                                                           | Same rules; checking time differs                                |
| Unknown, no resend | `Desk`: lost confirmation stays unknown; only a read-only check settles it | Same `Desk`                                                                                   | Same, tested on both                                             |
| Intent lifetime    | A `TodayFeed` task                                                         | A task of the root, not of the card                                                           | Same: a send settles after its card leaves the front (Rust test) |
| Screen state       | Module signals keyed by decision id                                        | Store signals keyed by decision id                                                            | Same                                                             |
| Sandbox            | `nsh.json` `"capabilities": {}` denies network, sockets, files, processes  | Native code: no sandbox                                                                       | Not comparable; TSX only                                         |
| Edits              | TSX hot update                                                             | Rebuild and restart                                                                           | The iteration difference under test                              |

Exceptions in state styles. Rust's typed styles have no `group-checked:`,
`group-aria-pressed:` or combined `checked:hover:` state:

- The radio dot and ring follow the checked option through `style_when`
  bindings, where TSX uses native `group-checked:` states.
- A help chip's text color follows `pressed` through a binding, where TSX
  uses `group-aria-pressed:`.
- The checked option row uses `.app_class("checked:bg-selection
  checked:hover:bg-selection")`: the radio's `checked` method is its prop,
  and hover outranks checked.

Literal values that match TSX classes: column width 672 pt (`max-w-2xl`),
line heights 1.25, 1.625 and 1.375 (`leading-tight`, `-relaxed`, `-snug`),
and -0.75 pt letter spacing on the 30 pt headline (`tracking-tight`).

## Run and test

`cargo test` runs from `experiments/nsh-day/rust`. The CLI commands run from
`experiments/nsh-day`: `nsh.sh` is the TSX spike's pinned CLI, and it changes
to its own directory first, so it takes this app's path.

```sh
(cd rust && cargo test)                      # 11 headless flows (tests/today.rs)
./nsh.sh check rust/nsh.json                 # cargo check --all-targets
./nsh.sh build rust/nsh.json -o rust/.nsh/out  # validates the root, theme and window
./nsh.sh test rust                           # cargo test through the CLI
./nsh.sh run rust/nsh.json                   # TodayApp, visible: not for benchmarks
```

Give `build` its `-o`: the default `.nsh/out` is the TSX app's.

`tests/today.rs` repeats the TSX `App.test.tsx` flows with the same window
(1100 × 900, macOS desktop idiom), selectors, steps and expected text, plus
two Rust checks: a question typed while one is on its way is kept, and a send
settles after its card leaves the front. The TSX-only checks (exact intent
typing and the sandbox) have no Rust counterpart.

## Hooks for the comparison

Nothing here measures. The comparison owns the rubric and the numbers. These
are the entry points it can use, all hidden unless marked visible:

| Need                                  | TSX                                                   | Rust                                                                             |
| ------------------------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------- |
| Headless flows                        | `./nsh.sh test App.test.tsx`                          | `(cd rust && cargo test)`                                                        |
| Headless commits and timings per step | `./nsh.sh test App.test.tsx --trace`                  | `EngineConfig { trace: true, .. }` in a Headless test (`nsh::perf` log)          |
| Scripted steps on one entry           | `./nsh.sh test Large.tsx --trace` with steps on stdin | `./nsh.sh test rust/nsh.json --trace` with steps on stdin (root `TodayApp` only) |
| Update workload                       | `Pulse.tsx`                                           | `PulseApp`, or `root(Scenario::Large, true)`                                     |
| Change the workload                   | `feed.pulse(everyMs, count)`                          | `Day::pulse_with(every, count)`                                                  |
| Visible window                        | `./nsh.sh run Large.tsx`                              | `./nsh.sh run rust/nsh.json` (change `root` for other worlds)                    |

`--target macos` and `nsh run` open visible windows; use them only with the
user's approval. Headless runs prove behavior and commit work, not native
drawing, hardware scrolling, IME composition or memory of a real window.
`pilot_day_rust::root(scenario, pulse)` gives a themed `Root` that a hidden
host could load into an ordered-out window; no such host is built here.
