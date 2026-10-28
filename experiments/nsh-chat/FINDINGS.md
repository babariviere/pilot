# Findings, 2026-10-28

**Keep GPUI for the product. Keep/adapt the NSH Rust slice as an experiment;
do not migrate the transcript on this evidence.** The screen is runnable and
pleasant, but the correctness and presentation gates are not all met.

## Follow-up qualification

This follow-up remains an isolated Rust experiment. No production GPUI source,
live daemon, account, installation or release was touched. All new native runs
were hidden. **Functional acceptance is incomplete, so no new paired performance
comparison or speed ranking was attempted.** The measurements below are historical.

### Attribution and narrow fixes

- The no-IME minimal navigation/restore/undo sequence reproduced the native
  `NSRangeException` (range `{0,38}`, length 26). It was not caused by CJK input.
  NSH's multiline editor used the window's undo history, and authoritative
  `setString` replacements did not invalidate old edit ranges. The pinned AppKit
  patch supplies a per-input manager through `undoManagerForTextView:` and clears
  only that manager on authoritative replacements, not on unchanged edit echoes.
  Undo remains enabled. Native Undo/Redo notifications synchronize changed text
  back to Rust, without double-reporting an already observed edit.
- Directly messaging `undo:` to `NSTextView` was a probe error: that selector is
  not implemented there. Responder-chain dispatch succeeds but does not edit this
  hidden non-key window. The passing hidden tests drive its actual undo manager;
  they do **not** qualify the active-app Edit menu or keyboard equivalents.
- The list failure is upstream ordering, not a missing custom scroller. A prepend
  already shifts the held offset before `anchor_end` compares it to the old end.
  That can falsely look like a reader near/beyond the tail and pull them down.
  The core patch rebases that comparison by the same anchoring delta. It leaves
  inverted-list policy unchanged and includes a focused core regression.
- Copy diagnostics previously targeted a descendant view, whose weak surface
  reference is unset. Only the NSH surface root owns event/Copy dispatch. Probes
  now dispatch there, use the actual coordinate orientation, and distinguish
  parked recycling cells from the mounted row when choosing geometry. Those are
  harness fixes, not proof that recycling selection works.
- The remaining Escape discrepancy had two causes. A direct `setMarkedText`
  call did not complete an editing notification: Rust was already stale before
  Escape. `--marked-raw-only` preserves that failing control. Explicit
  `didChangeText` first establishes exact native/Rust `中文`, composing=true.
  Then the upstream Escape callback blurred the editor and reported false
  while native marked text remained. The pinned patch declines the app's
  leave-field shortcut while marked, leaving cancellation to AppKit/input
  context. `--marked-only` now includes the explicit edit notification and
  passes with the native marked state preserved. This is callback consistency,
  not Japanese/Chinese OS IME qualification.
- Latest was not an incorrect end offset. A selection-free held replay reached
  the tail; adding native selection left the resolved ScrollTo waiting in the
  platform queue. Temporary tracing showed 49 queued batches. The hidden-window
  frame watchdog updated its own last-display-tick timestamp on each fallback
  frame, repeatedly imposing another 100ms stall wait instead of its intended
  16ms cadence. The pinned patch lets only real display-link ticks reset that
  timestamp. The same strict `--latest-selection-only` replay now reaches zero
  gap within the original 1.8s settling budget, without resize. No larger
  settling allowance, custom scroller or visible-window result is substituted.

`patches/{nsh-core,nsh-platform-macos}.patch` are applied only to generated local
copies of revision `c7b249970c2f9a15e20c5a461a7324ea9227c08f`. There is no vendored
fork, shared Cargo-cache edit or upstream mutation. `prepare-patches.py` resolves
inherited manifests and preserves inherited feature unions. Run staging before
direct Cargo checks. `NSH_CHAT_BASELINE=1` stages unpatched copies for attribution,
never alongside a build/probe using the same stage.

### Minimal reproductions and acceptance matrix

Commands are in README. `--checks --undo-only` is a strict native regression for
navigation, exact native/Rust agreement after Undo/Redo, authoritative restore,
Unicode paste/Undo/Redo and Send/Undo. `--checks --anchors-only` strictly checks a
stable message identity and its viewport y before prepend and after 100 replay
updates including image admission. These exit nonzero on failure. Full `--checks`
records failures instead of treating diagnostic completion as acceptance.

| Gate | Result | Boundary |
| --- | --- | --- |
| Navigation, native Undo/Redo, Unicode paste, authoritative restore, Send/Undo | Pass | Actual hidden NSTextView and native manager; not active-app menu routing |
| Held prepend and tail/image growth | Pass | Same message at the same viewport y before/after both operations in the isolated native repro, zero drift against the 1pt limit |
| Simulated marked Return | Pass | Native marked-text API commits without Send, exact Rust/native text agreement |
| Simulated marked Escape, completed edit notification | Pass | Exact native/Rust text and marked state; app does not blur a marked editor; not OS IME |
| Raw marked-text setter without edit notification | Fail (harness control) | Rust is stale before Escape; retained as `--marked-raw-only`, not an OS input-context simulation |
| Cross-message drag/Copy | Unmeasured | Synthetic drag still produced an empty selection, not an established OS pointer interaction |
| Native Select All and Copy | Fail | Selection is established, but Copy repeats beta before alpha rather than copying each message once in order |
| Retained selection across recycling/prepend | Fail | Copy changes from duplicated beta to an unrelated older message after holding/prepending, without a new selection |
| Static two-TextView Select All/Copy control | Pass | Exact alpha then beta, once each; no list recycling |
| Minimal virtual-list Select All/Copy | Fail | 200 single-line rows, no replay/images; mount order, omitted backing rows and recycled identities |
| Latest after selection/held growth | Pass (hidden) | Fixed fallback watchdog, zero gap within unchanged 1.8s budget; no visible presentation claim |
| Genuine Japanese/Chinese OS IME, active-app keyboard/menu Undo/Copy | Unmeasured | Hidden API calls do not establish OS input-source or focused responder behavior |
| Fair matched performance comparison | Unmeasured | Withheld until functional gates pass; historical offscreen counters remain incomparable |

Both marked probes are direct `NSTextInputClient` simulations, not exercised OS
input-context sessions. The raw control exits nonzero; the completed-edit probe
passes. The report records native/Rust state before notification, before Escape
and after Escape so a missing notification cannot masquerade as an IME bug.

The native Copy reproduction uses the two final rows, `Selection alpha…` followed
by `Selection beta…`, then root Select All/Copy, Hold/Earlier and Copy again, all
within `--checks`. Beta appeared twice before alpha; after recycling the first
copied text became an unrelated older message. This is real native selection/
clipboard output, not a retained sentinel. Upstream `selectable_view::walk` collects
mounted/recycling nodes in mount order, and `SelectionTexts::key` uses native node
IDs, not message identity. The follow-up's `--selection-static-only` control uses
the same native TextView renderer and passes exact alpha/beta copy. Its
`--selection-only` list contains 200 single-line Unicode rows, stable `.keys`,
no images and no replay. It still copies out of order. After a jump to the start
and a prepend, the same native row addresses name different logical messages,
and Copy changes without reselection. `selection-only.json` records full copy
strings and native addresses/labels/geometry/hidden state before and after.
Copy clears the pasteboard first, so a lost selection cannot pass by leaving
the previous clipboard value untouched.

Three focused `selection_contract` tests pin the platform-independent contract:
the model copies the supplied order and duplicates; recycled keys retarget a
selection; logical item keys follow prepend but clear selection when those texts
are unmounted. The Rust list's `.keys` preserve list data identity, not native
text-node identity. The backend sees generic scroll/cell views, not backing
message IDs or offscreen text. Therefore geometry sorting or skipping hidden
spares alone cannot satisfy retained selection or whole-document Select All.
It would need a logical text-order/identity contract through list binding and
selection retention independent of mounted cells. **That exceeds a small,
maintainable patch. Stop here rather than introduce a selection framework,
snapshot clipboard workaround, message-label identity hack or broad fork.**

Selection remains a concrete qualification blocker. Genuine OS IME, active-app
menu routing and visible presentation remain unmeasured. Do not replace
selection with a broad custom framework, weaken assertions or claim a
stack-adoption/performance result. The undo patch and one-point anchor gates
remain in place.

## Original prototype evidence (before follow-up fixes)

### What changed after the first prototype

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
