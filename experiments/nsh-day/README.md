# Pilot Day Today, NSH TSX spike

An isolated **mock-data** Today screen written in Native Shell (NSH) TSX, with
its read model and rules in a Rust crate. It is stack evidence, not the
production app. It connects to no daemon, account or user data, and it does not
change the GPUI or Swift apps or their build.

## Upstream pin

- NSH **0.4.0**, upstream `main` HEAD `530b73170f61e5bf16380959de9e622f8ce130cd`
  (committed 2026-11-09T18:17:26+08:00), rechecked with `git ls-remote` on
  2026-11-09. This is 184 commits after the `7571948` pin of `apps/desktop/nsh`,
  which this spike does not change.
- Every NSH crate, and the `nsh` CLI, comes from that one revision. No patches,
  forks, Cargo cache edits or WebViews. The CLI's generated workspace
  (`.nsh/rust`) adds `[patch]` entries that point at Cargo's own checkout of the
  same revision, so hosts and the app share one `nsh-core`. That checkout was
  compared with a fresh clone: no differences.
- `native/Cargo.lock` started from upstream's lock. Without it, Cargo resolved a
  newer `rolldown` that does not build with this revision.

## Run and test

`./nsh.sh` clones the pinned revision into `.tools/nsh` (ignored), refuses a
modified checkout, builds the CLI and runs it. `NSH_DAY_SOURCE` may name an
existing unmodified checkout.

```sh
cd experiments/nsh-day
./nsh.sh run                     # the decisions world, in a native window
./nsh.sh run Trouble.tsx         # also Quiet.tsx, Large.tsx, Pulse.tsx
./nsh.sh check && ./nsh.sh build # types against the Rust declarations, class check
./nsh.sh test App.test.tsx       # headless flows, boundary and sandbox (11 tests)
./nsh.sh test Native.test.tsx --target macos  # native captures and input, in output/
(cd native && cargo test)        # Rust rules and generated declarations
```

`rust/` holds the same screen written in Rust only, for the stack
comparison: [rust/README.md](rust/README.md) has its parity matrix and hooks.

## What it shows

Today follows the selected D design: the coordinators' headline, one decision
in front with "Up next" below it, missions split into Moving and Not moving,
results since the user last looked, and what is coming up. A decision card has
"Say it simpler", "More context", and a question answered inside the card. The
user picks an option (Pilot's recommendation is preselected) and presses Decide,
Confirm or Approve, or puts the decision off with Later. Worlds: `decisions`
(default), `quiet`, `trouble` (a lost confirmation and an unconfirmed push) and
`large` (203 missions, 123 results). `Pulse.tsx` runs the large world with the
shared update workload: `Desk::pulse` moves the next moving mission on every
100 ms, adds a result every fourth time, and publishes the whole read model,
300 times. `TodayFeed.pulse` is for measurements only, not a user intent.

Not in this spike: keyboard triage, decision visuals ("Show me"), the day
switcher, New, rituals, Changes, Automations and the sky dither.

## Boundary

| Owner | What |
| --- | --- |
| Rust (`native/`) | The `Today` read model, every rule for changing it (`Desk`), revisions, delivery state (idle, sending, unknown, checking), and the mock coordinator where a daemon adapter would sit |
| TSX | Layout, copy, and screen state: picked option, open help, question drafts, the decision in front |

TSX imports one class, `TodayFeed`, from `pilot-day/native`. Its generated
declarations (`.nsh/types/pilot-day/native.d.ts`) are the whole contract:

- Read: `snapshot(): Today` and `onChange(listener): () => void`. TSX mirrors the
  model in one signal that only the listener sets.
- Intents: `decide(DecideIntent)`, `later(DecisionRef)`, `check(DecisionRef)` and
  `ask(AskIntent)`, each returning an `IntentOutcome` (accepted, stale, rejected,
  unknown). Intents are `#[prop(exact)]`: an unknown key or a wrong type is a
  `TypeError` in the call, before Rust acts.
- An intent names the decision's revision. A changed decision is `stale`. A
  second send is refused. A lost confirmation leaves the decision `unknown`; only
  a read-only check can settle it, and nothing resends.

`nsh.json` declares `"capabilities": {}`, so the screen's VM may not use the
network, sockets, files, processes or host calls. `BoundaryProbe.tsx` tries a
loopback `fetch`, a socket, a file read and a process; the test checks that all
four fail with `ERR_ACCESS_DENIED`.

`pilot_day_native::fixture::today(Scenario)` and `Desk` are plain Rust. A
Rust-only Today screen can render the same read model for the comparison.

## Findings

- **Feasible.** Typed read models and intents cross with no NSH changes:
  `#[class]`, `#[derive(JsObject)]`, `#[derive(PropEnum)]`, `Callback` posts and
  `Stop` cover the boundary, and `nsh check` type-checks TSX against Rust.
- **Capabilities must be declared.** Without a `capabilities` key, TSX has
  unrestricted network access, including the loopback daemon. Sockets, files,
  processes and host calls are denied either way.
- **Entries must sit next to `nsh.json`.** The bundler reads capabilities and the
  theme from the `nsh.json` beside the entry. An entry in a subdirectory
  silently ran with network allowed and the default theme. All entries here
  are at the app root.
- **The sandbox fences screen code, not the crate.** Rust exports are the
  authority. A production boundary must keep the export list small and free of
  transport, paths or credentials (`native/tests/boundary.rs` checks this).
- **Whole-model updates.** Each change posts the full `Today` to TSX. Today
  keeps at most 20 results, so this stays small here; the cost with live,
  frequent updates is unmeasured and belongs to the comparison.
- Every test run warns that the status bar is not granted. It is harmless on
  the desktop.
- Headless tests prove behavior, not the look. Captures from
  `--target macos` are mock captures, not production acceptance. Hardware
  keyboard, IME composition and real scrolling were not exercised.
