# Composer controls evidence

Synthetic only. No real Local send/create/Stop, profile, service, release or
default switch. New isolated workspace starts at accepted main
`90d2661ec9d9a1897ee6e6730bafc573d33785b6`; old/quarantined workspaces and
their output/locks were untouched. CPU2/4GiB `cargo.sh`, shared serial
verification slot, private pinned tools/target/incremental outputs.

## Change to check mapping

- Ordinary Send/Return steering and explicit Option-Return follow-up:
  two `composer_controls` faux-courier tests passed. They cover idle and running
  chat payloads, Unicode content, exact canonical target and zero Stop requests
  from sends; explicit Stop executes no send and keeps withdrawn queued text
  separately from newer typing. Backend, store and courier implementation are
  unchanged.
- Removed toggle, contextual named native Stop, retained input owner and guards:
  four actual production-composer native cases passed at **680/1100 light/dark**.
  They exercise Return/Option-Return in both turn states, pointer Send, native
  Tab/Space Stop, role Button with no checked state, preedit refusal,
  readonly/error/pending guards, empty input, selected Unicode draft restoration,
  immutable Unknown envelope and zero automatic/duplicate commands. The tray is
  exactly **76pt**, single-line editor **34pt**, and Send/input/tray bounds stay
  identical across idle/working transitions.
- Question safety: the existing **25** question model/store/courier/mounted
  cases and **four** actual question-native cases passed on this feature.
  Later changes only add ordinary pending metadata text and choose the shared
  native secondary/circular Stop presentation. Question data/confirmation,
  inputs, focus, discard and courier code are otherwise byte-identical.
- Matching production-library/selected-native Clippy with warnings denied,
  whole-owned-file rustfmt, diff whitespace and Bash syntax passed. The two
  fake native-registry CI checks, including macOS system Bash3.2, passed with
  the new target present. Existing idle style/model geometry probes now observe
  the reserved slot; the chat-menu idle-pending oracle asserts no Stop. These
  minimal oracle adaptations compile in the native-feature library; their
  unrelated full journeys were not repeated.

## Exact-source receipts and reuse

Private receipts include each PRE/POST tracked-source hash manifest. First
compile errors (Checkbox import, input-event trait/context) and failed native
attempts remain failed, never relabelled passing. A native assertion caught an
83pt tray from a fixed-pixel slot; Kit-small sizing corrected it without
loosening the 76/34 gate. Two navigation-fixture failures were resolved by
settling the native input subscription before programmatic selection and by
allowing only legitimate private `RetireEmpty`, never a send/Stop.

The initial faux two cases passed with 1875-input identical PRE/POST records.
The question25 pass and subsequent native question4/composer4 pass also had
1875-input identical PRE/POST records. These results are reused by source
mapping rather than routine full reruns. Final own-native4 and matching Clippy
passed on source `e0516f544df53ebd81034258be6185018483c6d3`, tree
`63bfaa0a745d5b60aeae36c6c056ad44625fbb7d`, with **1876** tracked-source
hashes identical before/after. The only later edits add this evidence document;
qualified runtime/test/helper bytes remain unchanged.

Twenty actual final offscreen PNGs cover idle, working, pending, error and
Unknown in both widths/appearances. Representative final light/dark working,
pending and Unknown images were inspected and attached as image artifacts.
They are actual synthetic GPUI, not SwiftUI/HTML mocks. White editor/gray tray
and the corresponding dark hierarchy, compact action treatment and waiting
feedback were reviewed. Existing Unknown recovery-row layout is retained.

No motion timing/lifecycle changes or per-control clock were introduced.
Static captures and offscreen input checks do not establish visible smoothness,
OS IME/accessibility, performance, Linux/Wayland, full parity or user acceptance.
No full desktop/all-native/all-target/Swift suite or CI polling was run.

## Contextual Recovery refinement and current composition

The user subsequently requested removing the Discard/recovery action wall and
showing it only when needed, plus pushing main. The feature now uses a native
source-keyed popover (`chat_recovery.rs`). Ordinary drafts have no recovery
chrome. Unknown/error status stays visible; relevant actions require explicit
disclosure. Operation-backed uncertainty never mounts the irrelevant Stop
acknowledgment. The guards, store and courier contracts are retained. Pending
metadata now stays beside mounted model controls, not instead of their subtree.

The feature was composed onto accepted main
`cf8a4f962a310c94715f07ccde397402bbaaec1b`, preserving the published exact task
browser and kernel/Linux changes. The only conflicts were three append-only
registries, resolved as fresh upstream plus the unique composer target.
Source `d2ac2eca90a01ad4038faef4d68d5fb682539348`, tree
`2583aedd3396d152326c4486e79403031d978815`, passed:

- Own four native cases, four question-native cases, four delivery-diagnostic
  cases, and four scoped-model Settings cases, with matching selected Clippy.
  Recovery is absent for an ordinary draft, keyboard-reachable when applicable,
  bounds-constrained, explicit-only and dismissed by Escape with focus restored
  after keyboard opening. Question Discard safety and memory-only ACK diagnostics
  remain intact through the new disclosure path.
- Both faux send/Stop routing cases again, and the existing project-creation
  target, including lost-create explicit Check and actual root chat-model
  controls at 680/1100 light/dark. This additional target covers the concrete
  changed Recovery entrypoint and retained model subtree, not a routine sweep.
- Four Discard mounted/store/courier cases passed on identical runtime; later
  edits only fixed the native keyboard test setup. Registry fake-CI tests,
  including system Bash3.2, and Bash syntax passed on the composed registry.

Both final batches had **1889** tracked-source hashes identical PRE/POST.
The final source changes after those checks update only README, documentation
and this evidence. Every qualified code/test/helper byte is preserved by hash.
The superseded model-focus run was cancelled by incoming user input, never
called passing. An invalid-manifest composition preflight, incorrect tuple-ID
compile, and pointer-open focus expectation remain failed receipts. Native
popover pointer opening restores prior focus; keyboard-open testing now uses
the real Tab-focused trigger and verifies Escape restoration.

New actual contextual PNGs were inspected. The earlier Unknown action-wall
artifact was replaced and repinned to revision2, and the clean ordinary draft
was attached separately. These remain synthetic actual GPUI, not acceptance,
visible-motion or OS IME proof. No Working/tool disclosure files were changed.
