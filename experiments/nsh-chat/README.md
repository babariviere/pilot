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

# Hidden replay diagnostics, one warmup plus five recorded responses each.
bash experiments/nsh-chat/run.sh nsh --bench
bash experiments/nsh-chat/run.sh gpui --probe
python3 experiments/nsh-chat/summarize.py

# Focused source checks. Tests are sequential because the optional probe bus
# belongs to one standalone fixture window per process.
cargo test --locked --manifest-path experiments/nsh-chat/Cargo.toml -- --test-threads=1
cargo clippy --locked --manifest-path experiments/nsh-chat/Cargo.toml --all-targets -- -D warnings
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
with a separate target directory. There is no vendored upstream source tree.

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

`--checks --undo-repro` is an **intentionally unsafe, opt-in reproducer** for
the observed upstream AppKit undo range exception after draft restoration.
It may terminate only this synthetic process. Do not use it as a routine
smoke test, and do not assume ordinary undo/draft restoration is qualified.

The native probes use actual AppKit views, NSTextInputClient marked-text
calls, native insertion/paste, posted synthetic mouse events and native
document copy. They do not switch OS input sources, generate hardware input,
or prove active-app menu routing. Captures use the actual view tree, not a
mockup, but are static/offscreen and cannot prove smooth presentation.
