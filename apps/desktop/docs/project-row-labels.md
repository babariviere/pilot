# Home project row context

## Concrete discrepancy and plan

The accepted source has a bespoke two-line Home project label while Home chat and
Inbox rows reuse `ui::ResourceLabel`. Its visible detail says "Loading chat
activity…" before summaries load, but its accessible name already says "0 loaded
chats". Long truncated names/counts have no full tooltip. Swift's project row
retains complete name/activity context and help.

Use the existing passive resource content inside the same Button, with one
loaded/loading detail shared by visible content, accessible name and tooltip.
Keep the project glyph, 52pt frame, leading inset, canonical IDs/callback,
hairlines, exact count/scope rules and sort/caps. Shared Body/Caption and the
physical Control gap replace local styling copies. No new theme or framework,
state, fetch, clock, cache or row entity. `ProjectList`, chat rows, sync, section
order, header, composer and reader are out of scope.

The approved palette/system family and left-aligned reading column remain as
documented in `design-system.md`. No card, accent, new control or entrance motion.
The restrained change improves consistency, not a redesign or performance win.

## Evidence fixture

`PILOT_NEXT_PROJECT_ROWS_DIR` selects only a bounded production-root synthetic
capture matrix from the existing shell target. It is not the original full shell
regression. No Local client, writer, auth, private state or real send/create/stop.

Two long Unicode project names share the same folder but have different exact
IDs. Loading, loaded, retained refresh failure and empty states are painted at
680/1100 light/dark, fixed 1000pt height. Native bounds retain 52pt rows, the
one-rem glyph and original leading inset; the gap is measured from the respective
before/after contract, never widened to mask a failure. A canonical project click
asserts exact scope, two non-archived rows and shared metadata, not folder inference.
The fixture is frozen unchanged before and after the production patch.

## Implementation and baseline

The project row now uses ResourceLabel, with its existing Project glyph,
Body/Caption roles and physical 8pt Control gap (the former app half-rem gap was
7pt). One ephemeral context tuple feeds the visible detail and full Button
tooltip/accessible label. Before chat activity loads it says "Loading chat
activity…", including when stale nonzero summaries exist; confirmed loaded zero
counts still say "0 loaded chats". No retained model or cache was added.

Valid BEFORE: `36c6d62b6a4ece8de47411e802726ca45a61d713`, actual admitted
baseline job `79ba8f7e`, terminal exit0: formatting, strict native shell Clippy,
16 captures and exact-project interaction checks. Production `app_shell.rs`
was byte-identical to accepted source. The earlier launcher `59c5ad25` exited2
at shell setup, before any build/check; it is not baseline evidence.

The original shell and workbench test queries now locate canonical resource
parts within the same stable Button IDs. Bounds, glyph/rem/inset, containment
and exact Control-gap assertions are retained, not removed or loosened. The
new mounted unit covers both widths/themes and loading states, with exact
keyboard/pointer project events. A pure context test covers full Unicode text,
unloaded zero/stale counts and confirmed loaded counts.

## Verification ledger

macOS author verification, 2026-10-23. Frozen executable/test source
`4a2fb43a5645f1433cfe3fb80f2048f45f5f9d64`, tree
`58db5fc81c8ca259cce4eeec5b35d36987a85aa7`. Publication folds only this evidence
document afterward, not another executable/test change.

| Source file | SHA-256 |
| --- | --- |
| `src/app_shell.rs` | `8c3bb405bcd20c696fbaf122beae9ca195234118707584a4af48f60edc4194d7` |
| `src/shell_probe.rs` | `def08cd1d386e17b5c33372f90ae1989c4796cbeff56d86cbbe3e87a156ded9f` |
| `src/workbench_probe.rs` | `d4e99ae62d5faea9cad5a75cbbd74dbd9ed68837449cbf4e7a6550ed24f3b9e8` |
| `src/ui.rs` (unchanged) | `a54e3be1da55b33a4b7ee285b288ba84dad7590d52f6fc2a1c8eb01edefe2b44` |

The bounded project fixture function is byte-identical before/after, body SHA-256
`2d570305031805b86fcd36e93aca3d2aa08732afe251edd9ae1a879b6c7398c1`.
Both sides contain **16 actual native captures** (two widths, two themes, four
states), not mocks. All 24 nonempty AFTER row observations report canonical
shared resource parts. Narrow light loaded and wide dark loading images were
inspected; representative before/after pairs are published separately. Raw PNGs,
logs, build outputs and private state are not committed. No capture-time image
byte attestation or independent approval is invented.

- Focused `70fca6fb`, exit0: formatting, strict workspace/all-target native Clippy,
  all **five** app-shell tests, and matched native AFTER captures/interaction.
- Final `0b86c2fc`, exit0, **same source**: helper preparation/build, complete
  desktop library (**165 passed, 0 failed, 2 existing ignored** disk-workload
  observation tests), original full shell, navigation and workbench native tests.
- Each run actually enters the shared serial verification slot and normal
  CPU2/4GiB Cargo/mbx wrapper. Logs echo exact commands, source/tree IDs, relevant
  file hashes and successful tracked-tree diff checks **before and after**.
  These are emitted author-run receipts, not an atomic/hermetic build attestation.
- The original shell run explicitly unsets all three shell capture selectors.
  Its scope/reader selection and pixel-anchor, Unicode draft/preedit, queue
  backpressure, hidden publications and canonical no-write guards pass across
  680/1100 light/dark. The capacity case retains 256 projects/1,000 canonical
  chats, eight project previews, bounded chat rows and shared metadata through
  32 scope changes; this is functional evidence, not CPU/RSS performance proof.
- Navigation's canonical reader/generation/cursor and keyboard history guards,
  and the original workbench's scope, chooser/palette and containment guards pass.

Successful reproduction commands from `apps/desktop`, each admitted through the
shared serial wrapper (do not run concurrently with another native gate):

```sh
bash scripts/cargo.sh fmt --all -- --check
bash scripts/cargo.sh clippy --locked --workspace --all-targets --features native-probes -- -D warnings
bash scripts/cargo.sh test --locked -p pilot-desktop --lib app_shell::workbench_tests -- --test-threads=1
env -u PILOT_NEXT_HOME_CONTEXT_DIR -u PILOT_NEXT_SHELL_DIR \
  PILOT_NEXT_PROJECT_ROWS_DIR="$PWD/evidence/local/project-rows-after" \
  bash scripts/cargo.sh test --locked --features native-probes --test shell
python3 scripts/prepare-visual-worker.py
bash scripts/cargo.sh build --locked -p pilot-visual-worker
bash scripts/cargo.sh test --locked -p pilot-desktop --lib -- --test-threads=1
env -u PILOT_NEXT_PROJECT_ROWS_DIR -u PILOT_NEXT_HOME_CONTEXT_DIR -u PILOT_NEXT_SHELL_DIR \
  bash scripts/cargo.sh test --locked --features native-probes --test shell
bash scripts/cargo.sh test --locked --features native-probes --test navigation
env -u PILOT_NEXT_WORKBENCH_BASELINE -u PILOT_NEXT_WORKBENCH_DIR \
  bash scripts/cargo.sh test --locked --features native-probes --test workbench
```

Author source review is limited to project-row content/helper/tests and the
necessary test-part query migrations. `ProjectList`, chat-row context, sync,
routing, sections/header/order/counts/caps, shared components, Settings, updater,
CI/registration and composer/reader behavior are unchanged. There is no new
persistent work or I/O, and context formatting remains bounded to eight rendered
project previews. No whole-UI redesign or full Home/tool parity follows.

Original full shell/navigation/workbench guards remain separate. Static images
are not visible motion, CPU/RSS, native OS IME/AX or full Home/app acceptance.
Local checks do not establish new-head remote CI; no old-head result transfers.
Node/Swift, Linux/Wayland and visible performance suites were not run locally.
