# Standalone NSH AppKit conversation study

An isolated **Rust-only** macOS experiment, not another application or a
replacement startup path. The user requested conversion of the initial TSX
screen to Rust. `src/screen.rs` now owns the presentation; the NSH `js` features
are disabled. There is no TSX compiler, QuickJS, browser, daemon connection,
account, downloaded content or production dependency change.

## Run

From the repository root, with the existing Rust toolchains:

```sh
# Interactive synthetic window, explicitly launched by you.
bash experiments/nsh-chat/run.sh nsh

# Same backing history, Markdown, Unicode, PNG and 100-tick replay on GPUI Kit.
bash experiments/nsh-chat/run.sh gpui

# Hidden native interaction diagnostics and captures. No desktop activation.
bash experiments/nsh-chat/run.sh nsh --checks

# Strict, isolated functional regressions. No benchmark or shown window.
bash experiments/nsh-chat/run.sh nsh --checks --undo-only
bash experiments/nsh-chat/run.sh nsh --checks --anchors-only

# Completed edit notification + simulated marked Escape, not OS IME.
bash experiments/nsh-chat/run.sh nsh --checks --marked-only

# Raw setter control (missing editing notification), expected nonzero.
bash experiments/nsh-chat/run.sh nsh --checks --marked-raw-only

# Exact static copy control (pass) versus list identity repro (nonzero).
bash experiments/nsh-chat/run.sh nsh --checks --selection-static-only
bash experiments/nsh-chat/run.sh nsh --checks --selection-only

# Isolate selection from fixture changes and ordinary held growth.
# All three must reach the tail within 1.8s, before the resize control.
bash experiments/nsh-chat/run.sh nsh --checks --latest-only
bash experiments/nsh-chat/run.sh nsh --checks --latest-fixture-only
bash experiments/nsh-chat/run.sh nsh --checks --latest-selection-only

# Historical replay commands, not a fair comparison. Functional gates must pass first.
bash experiments/nsh-chat/run.sh nsh --bench
bash experiments/nsh-chat/run.sh gpui --probe
python3 experiments/nsh-chat/summarize.py

# Focused source checks. Tests are sequential because the optional probe bus
# belongs to one standalone fixture window per process.
python3 experiments/nsh-chat/prepare-patches.py
cargo test --locked --manifest-path experiments/nsh-chat/Cargo.toml -- --test-threads=1
cargo clippy --locked --manifest-path experiments/nsh-chat/Cargo.toml --all-targets -- -D warnings

# The patched list implementation and focused anchor regression.
(cd experiments/nsh-chat && CARGO_TARGET_DIR="$PWD/target" cargo test --offline \
  --manifest-path output/patched/nsh-core/Cargo.toml --lib core::list::tests -j 4)
```

`--probe` combines interaction checks and replay; `--checks` omits the six
replays. Automation is hidden by default. `--visible` can show an automated
window without requesting activation, but requires separate user permission
before an agent runs it. Hardware IME and focused presentation qualification
are not implied by showing a window.

Builds, app wrappers, logs, images and JSON diagnostics stay under ignored
`target/`, `gpui/target/` and `output/`. No global CLI is needed. The installed
`nsh 0.1.1` CLI was inspected, not changed or used as the runtime. The GPUI
runner uses the project's existing bootstrap/mbx and generated Kit patches,
with a separate target directory. `prepare-patches.py` stages the source-pinned
dependency patches under ignored `output/patched/`, never in Cargo's shared
checkout. See `patches/` and FINDINGS for their scope and qualification.

## What is implemented

- `src/model.rs`: Rust-owned 10,000/1,000-message histories, per-chat drafts,
  stable IDs, prepend, local echo and deterministic growing Markdown. It reuses
  `apps/desktop/fixtures/reply.md`. One response has 100 updates at 30 Hz,
  seven Unicode characters per update; its PNG is admitted at update 75.
- `src/screen.rs`: native Rust NSH components, recycling virtual list, streaming
  TextView, delayed-size image, AppKit multiline editor, source inspector with
  a native bar visual, and an in-memory mission edit form. The window owns
  replay tasks; navigation cannot leave a timer writing disposed row signals.
- Existing D80 light/dark palette, embedded Inter and JetBrains Mono, neutral
  navigation, right-aligned user bubbles and white/card composer on gray tray.
  No looping sidebar state decoration or custom animation was added.
- `gpui/`: separate comparison using the existing patched GPUI Kit TextView,
  MessageScroller and Textarea, and the **same** model/replay/PNG. It is a
  matched-primitives diagnostic, not the full production Pilot screen or a
  claim of identical rendering/feature coverage. The NSH inspector/form are
  not reimplemented in the GPUI adapter.

NSH is pinned to `c7b249970c2f9a15e20c5a461a7324ea9227c08f`, not a floating
release. Both Cargo lockfiles are checked in. NSH uses Rust 1.99.1; the GPUI
adapter retains the project's Rust 1.98.1, Kit 0.8.0 and GPUI 0.3.9 tooling.
The font and fixture files remain in their existing locations and retain their
existing licenses. The small generated PNG is original synthetic data;
`generate-image.py` reproduces it using Python's standard library.

## Verification and interpretation

The automated native report deliberately records failed gates rather than
turning unsupported behavior into a passing benchmark. Exit zero means the
diagnostic completed, **not** that every interaction gate passed. Inspect its
`checks`, not only its exit code. See [findings](FINDINGS.md).

`--undo-only` checks exact native/Rust draft agreement after navigation, undo,
redo, authoritative restoration, Unicode paste/undo/redo and Send. It exits
nonzero on failure. `--anchors-only` independently checks the one-point
prepend/held-growth gates and also exits nonzero. The older `--undo-repro`
flag remains accepted with `--checks`; undo now runs in ordinary diagnostics.
Hidden undo probes drive the real native manager directly. They do not qualify
the active application's Edit menu. `--responder-undo` separately attempts
native responder routing, which a hidden window may not deliver to this editor.

The additional `*-only` modes are strict and write their named JSON report.
`--selection-static-only` uses two static native TextViews; `--selection-only`
uses 200 single-line rows with the same renderer and stable list keys, then
recycles cells and prepends. It asserts whole-document ordered Copy and retained
selection, not just successful native selection dispatch. Its current failure
is intentional evidence, not an accepted behavior. Copy clears the pasteboard
before every readback.

`--marked-only` explicitly calls `didChangeText` after the synthetic marked
setter, then checks exact text/marked-state agreement and no Send after Escape.
`--marked-raw-only` omits that notification and preserves the old failing
simulation as a control. Neither is a genuine OS input-context interaction.
The three `--latest-*-only` variants separate ordinary replay, simplified tail
content and native selection. They assert the unchanged one-point tail limit
after 1.8s, then record a resize control without using it to satisfy the gate.

`NSH_CHAT_BASELINE=1` stages unpatched pinned sources for attribution only.
It can terminate this synthetic process on a native exception. Run separately
from every other build/probe, then restore default staging before verification.

The native probes use actual AppKit views, NSTextInputClient marked-text
calls, native insertion/paste, synthetic responder mouse events and native
document copy. They do not switch OS input sources, generate hardware input,
or prove active-app menu routing. Captures use the actual view tree, not a
mockup, but are static/offscreen and cannot prove smooth presentation.
