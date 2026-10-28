# Findings, 2026-10-28

**Keep GPUI for the product. Keep/adapt the NSH Rust slice as an experiment;
do not migrate the transcript on this evidence.** The screen is runnable and
pleasant, but the correctness and presentation gates are not all met.

## What changed after the first prototype

At the user's request, the delivered version is all Rust. `screen.rs` uses
NSH's native component, signal, TextView and virtual-list APIs. The `js`
features are disabled, and the normal Cargo graph contains no `nsh-js`,
QuickJS, `nsh-bundler`, OXC or Rolldown. It does not serialize the history
through a TSX bridge on each update. That is a verified architectural
simplification, **not a measured TSX-versus-Rust speedup**. The initial TSX
version was not retained as a second implementation.

The implementation fixes prototype-owned failures: replay tasks belong to the
window, not recycled/disposed rows; chat navigation retains drafts and can
continue a synthetic replay; the delayed PNG uses its decoded aspect ratio
and measured width instead of collapsing to zero height. No upstream fork,
production transcript fix or migration layer was added.

## Interaction evidence

| Case | Result and boundary |
| --- | --- |
| 10,000 backing messages, 1,000 initially exposed | Pass, native virtual list, with a second 1,000-message chat |
| Unicode drafts across navigation | Pass in Rust/engine tests and actual AppKit native insertion diagnostics |
| Navigate while replay runs | Pass, focused engine regression, no writes to disposed row signals |
| Mission form edit/save/reopen | Pass in engine tests; saved only in this synthetic process |
| CJK Return/Escape | Native marked-text calls did not send a message. Actual OS Japanese/Chinese input-source interaction is **unavailable**, not passed |
| Large Unicode paste | Pass through the real NSTextView/clipboard path, 3,000 repeated Unicode lines |
| Undo after draft restoration | **Blocked.** The diagnostic reproduced an AppKit `NSRangeException`, range `{0,36}` against length 17, in `NSTextStorage(NSUndo)` / `NSUndoTyping`. Earlier runs also changed native text without updating the Rust draft. This is an integration/upstream candidate, not a proven complete root-cause attribution |
| Cross-message selection/copy | **Unqualified.** Earlier visible exploration drew a cross-message selection. Final hidden Rust windows did not reliably receive posted mouse gestures. A stale clipboard cannot count as a copy or recycling pass; the report uses a sentinel and marks the prerequisite unavailable |
| Selected/recycled rows | **Unqualified**, because final cross-message native copy was not established. No claim that a stale clipboard proves retained selection identity |
| Prepend / hold while text and image grow | **Gate failed in the native diagnostic.** Content and row/layer positions moved, rather than demonstrating the proposed one-pixel anchor. Precise attribution still needs a smaller upstream reproduction; no speculative framework patch was made |
| Latest, then resize 1180×820 → 860×720 → 1180×820 | Pass for reported tail gap within one point after settling; static image growth was captured |
| Keyboard focus / menus / undo / real IME | Partial only. Native focus and insertion are exercised, but hidden programmatic calls do not qualify active-app key equivalents or the full focus/IME checklist |
| Failure reload / close-reopen durability | Not implemented. State is intentionally process-local; this is not a durable product shell |

`--checks --undo-repro` retains the failing undo sequence as an explicit
process-terminating reproduction, not a routine test. Default diagnostics
record this known gap without intentionally crashing before the other checks.
The successful cargo tests verify our model, navigation, streaming ownership
and form code; they do **not** turn these native gaps into acceptance.

## Measurements, with honest boundaries

Machine: Apple M3 Pro, arm64, macOS 27.2 (26B123). Viewport 1180×820 points,
same embedded fonts, model, Markdown and PNG. All final paired runs used
**development profiles and hidden native windows**, sequential NSH then GPUI,
one warmup plus five recorded 100-update replays. They were not release builds
or alternating independent trials. Work on the rest of the machine was not
controlled. Earlier shown-window exploration is not a final-source focused
presentation benchmark.

| Reading | Final local diagnostic |
| --- | --- |
| NSH native edit → Rust callback while streaming, 20 samples | p50 4.55 ms, p95 6.54 ms, max 8.87 ms. Includes main-queue admission and callback delivery, **not OS-event-to-present** |
| NSH whole-process CPU / sampled peak physical footprint | 8.0% of one core / 59.0 MiB |
| GPUI whole-process CPU / sampled peak physical footprint | 19.2% of one core / 147.1 MiB, rechecked after the concurrent production follow fix |
| GPUI synchronous update + draw p95, five recorded runs | 5.22, 13.11, 14.08, 13.71, 13.77 ms. Layout/prepaint/paint boundary, **not presentation latency** |
| NSH native main-work counter | Offscreen rolling p95 retained 20.7–128.8 ms, max 156.4 ms. Hidden display callbacks and the shared rolling 120-sample window make this unsuitable as a per-replay frame budget |
| OS input-to-present p50/p95/p99, missed display deadlines, stale frame ACK | **Unavailable** |
| Release-profile resource budget, settled post-close recovery, 20% gate | **Unqualified** |

The CPU readings are deliberately **not a speed ranking**: GPUI explicitly
draws every replay update into an offscreen renderer; hidden NSH performs
engine/layout/mount work but AppKit is not presenting/drawing each update the
same way. Its on-screen monitor is also enabled for diagnostic counters.
Both resource samples include all process threads (no child helpers), use
`CLOCK_PROCESS_CPUTIME_ID` for CPU and `proc_pid_rusage` physical footprint,
and sample memory every 100 ms. A sampled peak is not a continuously observed
allocation peak. The shared replay completed, but final-source focused real
window/input/presentation acceptance remains unavailable.

Local raw JSON/captures are generated under ignored `output/`; run the commands
in README to reproduce and summarize them. Different timing boundaries remain
separate in `summarize.py`.

## Development and maintenance

The first TSX version compiled its single module in roughly 14–89 ms, but
there was no qualified edit-to-visible/HMR trial. The delivered Rust version
requires a native incremental build. Recent small native rebuilds took about
2–4 seconds; this is incremental Cargo output, not an edit-to-visible timing.
The first source-pinned NSH debug dependency build took 1m51s; a later
Rust-only feature change recompiled dependencies and took about 35s. GPUI's
first isolated dependency build took about 2m45s. These are different cache
states, not a controlled clean-build comparison.

Rust removes the VM/compiler and one language boundary, but more presentation
builder code and native input qualification remain. No repeatable developer
iteration advantage, shared mobile contract or complete native-shell savings
has been demonstrated. There was no GTK/iOS build, global installation,
release, account/network replay or live app/daemon operation.

## Smallest next decision

Do not fund a migration on lower apparent offscreen memory or native-editor
branding alone. If this direction remains interesting, separately isolate the
undo/restoration behavior and list anchor failure, then qualify real IME,
keyboard copy/selection across recycling and a matched, explicitly approved
non-disruptive presentation run. Until those succeed, retain GPUI and the
existing Swift app. Rust NSH is a credible removable experiment, not an
accepted replacement.
