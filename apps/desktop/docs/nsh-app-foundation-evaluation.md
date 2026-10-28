# NSH as a shared desktop and mobile foundation

Source review, 2026-10-28. **Keep GPUI + GPUI-Kit for the current product;
consider standalone NSH, not GPUI embedding, for a separately authorized
comparative chat slice.** NSH is a credible shared-UI candidate, not just an
artifact engine. Its native editors, retained updates and TSX iteration could
reduce Pilot's input and UI-development burden. There is not yet evidence to
justify a whole-app migration, nor evidence that rules it out.

No installs, builds, prototypes, benchmarks or product/runtime changes were
performed. Upstream source and tests were read, not executed. This is a proposal,
not a change to the approved Rust/GPUI stack or deferred iOS scope.

## Decision in one minute

| Choice | Recommendation | Reason |
| --- | --- | --- |
| Current GPUI + Kit | **Keep** shipping/parity work | Existing guarded workflows, design system, native visual renderer and regression probes remain valuable. No mobile backend, and input/layout/performance work remains app-owned. |
| NSH embedded over GPUI | **Do not choose as the shared foundation now** | Can retain Kit/custom GPUI elements and add TSX regions, but adds a second UI/state system, requires GPUI dependency reconciliation, and does not deliver platform-native editors or an iOS renderer. |
| Standalone NSH AppKit/GTK/UIKit | **Best candidate to test** | Common semantic components and TSX/Rust logic with genuinely different desktop/mobile renderers and layouts. Avoids the GPUI type conflict, but replaces substantial UI integration and needs real chat qualification. |
| Selective adaptation | **Useful independently** | Keep explicit component contracts, keyed state and native-service ownership; TSX is most promising for forms, mission views and navigation, with Rust for data-intensive work and native extensions. |

The next decision should be whether to fund one synthetic comparative chat
slice, not whether to rewrite Pilot. If that succeeds, migrate one low-risk
screen before considering the transcript or shell. If native chat behavior or
maintenance cost disappoints, keep the existing stack without stranded data.

## Evidence and trust distinction

Read alongside [the artifact assessment](nsh-artifacts-evaluation.md). That review
examines **untrusted generated programs**. A reviewed first-party shell already
has application authority. Running its engine on an in-process thread, allowing
explicit native modules, and giving it app-owned assets are normal architectural
choices, not automatic shell blockers. Trusted shell code need not be forced
through the artifact protocol or recover after every callback like hostile code.

The shell still needs good failure handling and must not give transcript text,
downloaded content or generated artifacts its capabilities. Package signing
establishes origin, not correctness; generated artifacts retain their existing
confinement regardless of which framework draws the shell. The artifact review's
asset-path and hard-cancellation concerns matter at that untrusted boundary, not
as a blanket rejection of NSH application code.

Reviewed pins, independently checked against remote HEAD:

- NSH [`c7b249970c2f9a15e20c5a461a7324ea9227c08f`](https://github.com/longbridge/nsh/tree/c7b249970c2f9a15e20c5a461a7324ea9227c08f).
  Newer than published v0.3.0; do not assume HEAD features ship in that release.
- Benchmark [`d3359cccff48d37b276ed9551d7ac29c6ea9261f`](https://github.com/longbridge/nsh-perf-bench/tree/d3359cccff48d37b276ed9551d7ac29c6ea9261f).
  Its measured NSH is older `d3655d3` plus patches, not this review's NSH HEAD.
- Pilot baseline `16edcfc468bb193fab803dd02e5e5540fc39a768`, Kit 0.8.0,
  active `gpui-pre` 0.3.9. See `src/transcript_view.rs`, `src/ui.rs`,
  [design contracts](design-system.md) and [inline visuals](inline-visuals.md).

The [framework comparison](https://nsh.dev/docs/comparison/#cross-platform-frameworks)
is an upstream capability matrix, not a compatibility or performance acceptance
report. The [Longbridge announcement](https://x.com/huacnlee/status/2115269822804099132)
says it **plans** to replace mobile H5 progressively with NSH. This is encouraging
investment intent, not evidence of a completed production migration.
The iOS assessment (#310) and interactive-artifact task (#311) are still todo,
with no additional results available. This document supplies their shared-stack
context, not device qualification or artifact adoption approval.

## Three architectures, not one rendering promise

NSH's shared core maintains a reactive graph, shadow tree, text/layout and mount
batches on an engine thread. TSX compiles to native runtime calls, not React or
DOM. Platform main threads apply mounts; input goes back to the engine. Rust
components can use the same core without a JS VM. Retained updates avoid some
whole-view reconstruction, but text, layout, mounts and drawing still cost work.

| Concern | GPUI + Kit now | NSH over GPUI | Standalone NSH |
| --- | --- | --- | --- |
| macOS | GPUI-drawn controls, Kit input | NSH-drawn tree and custom editor through GPUI input handler | AppKit views/layers, CoreText display text, NSTextField/NSTextView editing |
| Linux | Current native Wayland path | GPUI Fast backend; upstream enables both X11 and Wayland | GTK 4.14+ widgets/GSK/Pango; GTK text editors; qualify with Wayland-only selection |
| Future iOS | No GPUI backend | Must use a different NSH backend | UIKit/CoreText, UITextView input, safe areas/keyboard and touch navigation |
| Sharing | Existing desktop Rust components | TSX/core components can also target UIKit, but GPUI-specific extensions cannot | Shared UI set, models and intents; platform adapters and intentionally different layouts |
| Reuse cost | Lowest | Keep GPUI shell, adapt themes/focus/overlays and host modules | Rebuild shell chrome, design-system bindings, menus, lifecycle and rendering adapters |

**Native input needs precise wording.** NSH's GPUI `text_input.rs` explicitly
implements its own editor using the shared Windows editing model. GPUI supplies
IME calls and caret geometry; this is not NSTextView or UITextView. AppKit,
UIKit and GTK backends really do use their platform editors. Display-text
selection is separately implemented by NSH, even on those platforms. Native
editors help with IME, undo and editing menus; they do not automatically solve
cross-message selection, list recycling, scroll anchoring or Pilot drafts.

The GPUI embedding API uses `gpui-fast` 0.1.9 types; Pilot uses `gpui-pre` 0.3.9.
This is a real **embedding integration obstacle**, not a standalone NSH blocker.
A port or a separately approved fork switch would need input/rendering regression
work. Do not make that switch just to run a first experiment. Standalone GTK can
use Wayland without a browser, but enforce `GDK_BACKEND=wayland`, refuse absent
Wayland and prove the actual connection. Disable WebView features. Existing
unconditional engine net/shader features also need inventory and appropriate
feature separation before product integration, not a browser/X11 fallback.
A compositor serving other X11 clients is not a Pilot backend failure.
The GPUI backend also documents ignored zoom-scroll props and untried native
macOS/Windows integration areas despite CI coverage. Embedding would need its own
image zoom/pan and native-platform qualification, not just a successful build.

## Simplicity, coverage and maintenance

**Potential benefit:** TSX gives shorter declarative screen code, fine-grained
signals, keyed views, flex/grid, theme utilities and a hot-update loop without
recompiling Rust for ordinary layout/copy changes. Shared mission/task controls,
notices, model pickers and source inspectors are plausible cross-device assets.
Rust remains available for aggregation, stream parsing, custom drawing and
platform-specific views. NSH exposes UI sets/native modules and native component
registration; it is not limited to prepackaged widgets.

**What is not free:** `nsh/base` is an unstyled behavioral foundation, not Kit's
styled catalog. Navigation, menus/dialogs, controls, lists, tables, text/editor,
images, plots and canvas provide substantial coverage, but Pilot still owns
its tokens, spacing, states, icons, shortcuts and interaction contracts.
React hooks, arbitrary React components, browser CSS and DOM packages do not
transfer. Existing Rust view code cannot simply be recompiled for NSH. Reusing
domain structs and tests is easier than reusing GPUI entities or Kit TextView.

Prefer one product UI set with desktop/mobile compositions over two parallel
design systems. Desktop keeps sidebar, keyboard commands, resizable panes and
inspectors; phone uses a chat list, pushed conversation, sheets and keyboard-aware
composer. Share domain identity, validation and actions, not identical geometry.
Keep the current calm hierarchy, source inspection and meaningful error/Unknown
states; a framework change is not permission to redesign everything.

NSH adds a compiler/bundler, QuickJS-JIT/stdlib for TSX, reactive core, Taffy,
platform backends and package/update tooling. A hybrid adds bridge debugging and
cross-thread event ordering; shared ownership can reduce duplication, but cannot
be assumed to reduce total maintenance. Apache-2.0 is compatible in principle;
transitive license/dependency review remains necessary. Active source, platform
docs, hot-update tests and compatibility tooling are positive signals. However,
`docs/dev/compatibility.md` explicitly says **no release, including 0.3.0, is
recorded/frozen yet**, and Rust embedding APIs are not that TSX compatibility
contract. Pin source and own a small adapter rather than adopting moving HEAD.

Migration cost is qualitative: forms/mission screens are moderate; transcript,
composer and artifact integration are high; whole-shell lifecycle, packaging and
multi-platform qualification are high. NSH Rust avoids JS but also forfeits the
main live-TSX benefit. A practical candidate is trusted TSX presentation over
stable Rust services, not moving all data processing into JS.

## Critical chat and whole-app fit

These are source-supported mechanisms and remaining validation work, **not
claims of Pilot parity**.

| Workflow | Evidence and implication | Required validation/adaptation |
| --- | --- | --- |
| Streaming chat | Signals/batched ops update retained nodes; text prepares off-main. Native streaming APIs exist. | Keep existing transport/data owner; coalesce display updates. Measure growing Markdown, code blocks and tool disclosures while typing/scrolling, not just numeric labels. |
| Long history | Core virtual list uses measured sizes/Fenwick sums, recycled cells, keyed splices and paced overscan. Row-local state travels with recycled cells. | Store disclosure/draft/selection state by canonical message ID outside cells. Preserve bounded history windows, Earlier/Latest semantics, errors and reconnect identity. Test tall rows and fast flings for blanks. |
| Growth/anchoring | List core has measurement compensation, pinned scroll targets and `follow_end`; TSX exposes `maintainVisibleContentPosition`. Parent-viewport lists disable inverted/follow-end behavior. | Use the list's own scroll owner initially. Verify prepend, stream growth and late image decode both following and reading older content. Preserve message-ID + intra-row anchor, not just raw offset. |
| Selection/copy | `View selectable` and shared SelectionModel support selection across mounted text descendants on all reviewed native routes, including GPUI. | This is promising, not an absent feature. Recycled/unmounted history, streaming edits, Markdown source fidelity, attachments and grapheme/bidi boundaries need tests. Do not assume offscreen rows join Copy All. Existing Pilot also has explicitly scoped cross-message selection tests, not universal document selection. |
| Composer/IME/focus | Native backends use system editors; GPUI has custom IME-aware editor and edit counters rejecting stale values. | CJK composition Return/Escape must never send or navigate; verify emoji/combining text, undo/paste, focus restoration and sibling clicks. Flush current input before submit/navigation; persist drafts/attachments by chat identity outside the view. |
| Artifacts | Images, plot/table/canvas primitives and native extension points are available. | Keep images and existing native visuals primary. Preserve api-1 semantics, exact revision/source/history/provenance and bounded decode. Existing GPUI visual/Mermaid code needs an adapter or renderer port, not reclassification as executable TSX. Generated NSH remains a separate isolated optional format. |
| Missions/forms | Base controls, navigation, tables and native modules suit structured screens. | Reuse guarded domain intents, validation, retained edits and explicit confirmations; platform widgets do not supply mutation safety or durable acknowledgment. This is the best first migration surface after chat feasibility. |
| Commands/menus | Keymap, desktop menus, focus and overlays exist; native platform responder behavior differs from GPUI. | Test menu/shortcut precedence, command palette, Tab, Escape and disabled actions while editing/composing. Do not give global shortcuts precedence over IME. |
| Motion/glass | Native animations avoid per-frame JS; AppKit supports NSVisualEffectView backdrop blur. GPUI backend does not draw backdropFilter; GTK also documents missing backdropFilter. | Retain reduced motion and current transition intent; app-owned native glass can be an extension. Matching the exact macOS material everywhere is optional, not a cross-platform shell blocker. Smooth resize/disclosure/streaming is a functional acceptance concern. |
| Lifecycle | AppView/native runners provide platform integration, not Pilot session durability. | Preserve close/Quit draft flush, reopen, hidden/minimized idle, offline/reconnect and sleep behavior. UIKit keyboard/safe area and scene background/termination require real-device tests; background agents stay on desktop, not in a phone UI process. |

## What the vendor benchmarks actually establish

The pinned benchmark README, results/SOURCES and Metrics implementation were
reviewed. Four implementations share a deterministic workload: TSX, TSX with
Rust compute, NSH Rust, and direct Kit/GPUI Fast. Scenarios include a 500-row,
10-column virtual quote table, 200/1000 animated boxes, synthetic row/tab/filter
interactions and sorting/aggregation/JSON. Quotes arrive in 10 ms batches;
notification/flash scheduling differs between implementations.

The published Linux native-backend run is **one** full run per combination on
i7-13700KF/RTX 3060 Ti, Hyprland 144 Hz, floating 1600x1000, GTK 4.24. At 1000
quotes/s, NSH Rust/direct GPUI Fast used 18.0%/20.2% of one core; at 20,000/s,
73.1%/25.1%. NSH TSX used 77.9% at the latter load. Logic-driven 1000-box animation
was 51.5% TSX, 39.9% NSH Rust, 14.8% direct GPUI; native animation reduced NSH to
about 22%. These support competitive ordinary load and a dense-update/rendering
advantage for direct GPUI, not a universal winner. Rust compute greatly reduces
JS compute cost, but does not eliminate NSH layout/mount/render work.

Important limitations:

- This compares GTK NSH against GPUI **Fast**, not Pilot's baseline GPUI,
  not embedded NSH at current HEAD, and not UIKit. Historical macOS results
  used the GPUI backend; full AppKit comparative runs were still pending.
- The direct app is intentionally stripped down (`uniform_list`/divs, not Kit
  Table/theme/hover); it notifies its whole view, unlike granular NSH signals.
  Fast versions differ (0.1.10 direct versus 0.1.9 NSH GPUI route).
- The measured NSH includes a runaway-update fix and diagnostic patches and
  a counting allocator. Source metadata includes then-uncommitted changes.
  Linux has no variance estimate and no memory measurement, not zero memory.
- Draw-time alone excludes engine work for NSH and is not comparable across
  architectures. FPS reflects redraw scheduling as well as refresh limits;
  idle zero FPS is desirable. AppKit frame hooks can count commits and animation
  ticks separately, even above display refresh.
- Tick-to-frame pairs applied updates with draw completion, not physical scanout
  or actual OS pointer/keyboard input. Diagnostic version checks found little
  misassociation in that workload, but do not establish input-to-photon latency.
  Startup starts at main; memory peaks are phase-end samples, not continuous peaks.
- Fixed-height quotes, synthetic interaction and boxes do not test variable-height
  chat, growing Markdown/images, composition, cross-row copy or selection retention.

The broader NSH performance notes contain useful platform-specific optimizations
and caveats (loaded machines, focus throttling, Xwayland versus Wayland). None
are Pilot measurements. Do not forecast Pilot CPU or smoothness from these ratios.

## Stable native ownership and dynamically updated UI

Live TSX is a development advantage, but **development HMR is not durable app
state migration**. Source/tests show unchanged components keep state; edited
components remount. Top-level signals/navigation persist if their initializer
matches. New imports, capability changes, wrong base or patch failure trigger
full reload. Release development-server builds reload rather than use HMR.
Errors can leave an edited component empty. There is no reviewed Pilot-compatible
transactional shell update, draft migration or rollback adapter.

A later integration should keep these responsibilities native and stable:

1. Daemon discovery/hello identity pinning, singleton/lease/runtime ownership,
   transport/reconnect and read models. Never restart/replace an existing daemon
   to recover a UI, and never treat loopback identity checks as remote authentication.
2. Durable drafts/attachments, canonical project/chat/message/artifact IDs,
   pending operation identity and delivery/Unknown evidence. Native domain commands
   retain current validation, confirmations and acknowledgments.
3. Artifact store/source/history/provenance and confined generated-code helpers;
   bounded image decode, native visual semantics and exact-revision admission.
4. Platform window/scene lifecycle, credentials, picker/clipboard/open-link policy,
   notification/power integration and existing whole-payload updater trust.

Expose narrow typed services such as observe-chat, save-draft and explicit
submit/stop/task-edit intents, with existing identity/revision/intent fences where
required. Do not expose generic filesystem, process, shell, daemon HTTP or a broad
native object graph to presentation code. A first-party module may legitimately
invoke these services; data displayed by it never becomes code or authority.

For later dynamic production delivery, use a simple pinned bundle/native-contract
pair first, not an independent OTA system. Check runtime/compiler/host API/state
schema compatibility before activation. Keep source, source maps and bundle
identity for diagnosis. Persist drafts and navigation/reader IDs outside JS;
selection/composition is transient. Defer swaps during IME or an unresolved user
submission, and never replay an unknown operation after reload.

Stage and validate the new UI, then activate at a safe boundary from a host-owned
snapshot. On load failure restore the last compatible bundle from that snapshot;
after a process crash restore durable native state and offer the existing UI.
Do not migrate authoritative history or destructively rewrite draft schemas.
Keep rollback-readable state (or an untouched previous snapshot) during a trial.
NSH signatures/build-number anti-rollback do not by themselves implement this;
any rollback design must obey the existing trust policy, not bypass verification.
Independent downloaded UI, key/feed changes and live updates need separate approval.

Future personal iOS still needs signing/provisioning and a separately designed
authenticated phone connection. Sharing UI does not expose the desktop loopback
daemon safely, grant remote access, or provide background execution. Leave device
signing/renewal and NSH-versus-SwiftUI device assessment to #310.

## Smallest separately authorized comparison

**One synthetic conversation screen in a standalone AppKit NSH host**, compared
with the existing GPUI screen using the same fixture. TSX presentation, Rust fixture
replay/data ownership, no real daemon/account/network, no package delivery service.
One conversation list, composer, source inspector, image and native visual fixture;
one small mission edit form tests shared controls without a shell rewrite. Use
current tokens/fonts and a few app-owned NSH components, not a new design system.
Do not add the GPUI embedding fork problem to this experiment.

Start on macOS. Only after its functional gate, separately exercise the same
components with a compact UIKit composition on a personal device and GTK under
native Wayland. Provisioning/installation and any visible measurement windows
require explicit approval; do not silently launch them. No NSH-over-GPUI third
implementation unless a concrete retention need justifies its extra cost.

Representative fixture/replay:

- 1000 messages, then 10,000 backing-history messages with bounded visible windows;
  short text, tall Markdown/code/tables, Unicode/bidi and delayed-size images.
- Idle, one streaming response at 30 display updates/s plus a burst trace,
  typing while streaming, fast scroll, older-page prepend and Latest.
- Read older content while the tail grows, resize while images decode, select
  across messages, recycle/remount selected rows, open/close inspector and form.
- Navigate between chats with unsaved drafts, paste large input, exercise CJK IME,
  undo, shortcuts, focus restoration, interrupted load and close/reopen.

Measure paired baseline/candidate runs in alternating order, same release profile,
hardware, viewport/fonts/content and refresh rate, warmups plus five recorded runs.
Include an idle-to-input case (CPU ramp), not only warmed continuous work. Record:

- OS-event-to-present p50/p95/p99 and missed display deadlines at 60/120 Hz;
  label draw-only/headless results separately. Track update sequence through mount
  and presentation so a fast stale frame cannot count as success.
- Main/engine/worker CPU, per-frame text/layout/mount/draw/upload cost, stream
  backlog, scrolling throughput and settled idle wakeups.
- Total process/helper RSS/footprint, continuously sampled peak, incremental cost
  for history/images, and recovery after navigation/close. Use the same memory
  metric per platform; do not compare Linux RSS directly to macOS footprint.
- Edit-to-visible time for copy/style, component and native-service changes;
  clean/incremental native build cost, lines/adapters touched, debugging failures
  and time to implement the same mission-form change. Include maintenance work,
  not only the fastest HMR edit.

### Acceptance gates, proposed before any prototype

1. **Correctness is non-negotiable:** no lost drafts, misdirected/duplicate send,
   false Saved/Done, accidental composition submit, selection identity transfer,
   history/provenance loss or daemon lifecycle changes. Test failure/reload as
   well as happy paths. Transcript anchors stay within one logical pixel after
   settling when older content grows/prepends; following remains at the end.
2. **Interaction quality:** real IME, keyboard/focus, touch selection/keyboard on
   iOS, zoom/pan, Unicode and cross-message copy pass an explicit checklist.
   No recycled-row blanks during the representative scroll or source-copy loss.
   Unsupported behavior must be visible, not silently omitted for good timings.
3. **Responsiveness:** on matched hardware, proposed screen p95 frame work fits
   the display budget (8.33 ms at 120 Hz, 16.67 ms at 60 Hz); p95 input-to-present
   is no more than one refresh worse than baseline, with no recurring p99 stalls
   above 50 ms. Baseline failures remain failures, not a waiver. Record misses
   and tails, not just average FPS.
4. **Resources:** no sustained streaming backlog or continuing post-close growth;
   idle settles without continuous rendering except intentional motion/caret.
   Proposed initial budget: CPU and settled/peak memory no more than 20% above
   baseline on the matched slice. A trade-off needs explicit acceptance and a
   concrete interaction/development benefit, not a vendor efficiency claim.
5. **Worth migrating:** demonstrate a repeatable UI-only iteration advantage and
   one genuinely shared desktop/mobile component contract without proliferation
   of backend branches. Review the native extensions and total adapter cost.
   Do not migrate solely because TSX has fewer lines.

These are proposed decision gates, not measured results or approved product
budgets. If a gate fails, document the smallest fix and cost; stop rather than
expand into a framework fork or broad optimization campaign.

After a successful slice, a separately approved incremental path is: one
noncritical mission/settings screen behind an explicit local choice, compatible
state/fallback retained; then composer/transcript only after native chat gates;
then shell/lifecycle and platform packaging qualification. Keep images/native
visuals, old sources and Swift throughout. No default switch or full migration
without user acceptance. A failed experiment should be removable UI code, not a
data conversion or a second daemon.

## Reproducible upstream source map

Paths below are relative to the pinned [NSH tree](https://github.com/longbridge/nsh/tree/c7b249970c2f9a15e20c5a461a7324ea9227c08f):

- `docs/dev/{architecture,embedding,compatibility,components,text,elements,performance}.md`:
  threading/layout, extension APIs, unfrozen compatibility, coverage and selection.
- `website/docs/{comparison,dev-server-and-debugging,ios}.md`:
  vendor comparison, precise HMR resets/fallbacks, UIKit/device requirements.
- `crates/nsh-core/src/core/list.rs`: recycling contract, measurement/splice
  anchoring, follow-end and parent-viewport restrictions, with unit tests.
- `crates/nsh-platform-{macos,linux,ios}/src/{text_input,selectable_view}.rs`;
  `crates/gpui/nsh-platform-gpui/src/{text_input,selectable_view}.rs`:
  platform versus custom input and cross-text selection implementations.
- `crates/nsh-engine/src/lib.rs` (`EngineControl::hot_update`),
  `crates/nsh-engine/tests/engine/hot.rs`: development reload request and tests
  for unrelated state/navigation preservation, not durable migration tests.
- `docs/dev/{macos,linux,gpui}.md`, platform Cargo manifests:
  native glass, missing effects, dependency/features and backend restrictions.
- Pinned [benchmark tree](https://github.com/longbridge/nsh-perf-bench/tree/d3359cccff48d37b276ed9551d7ac29c6ea9261f):
  `README.md` sections 2–9, `results/20261021-212102/{SOURCES.txt,REPORT.md}`,
  `core/src/lib.rs` Metrics and `docs/PERFORMANCE-ANALYSIS.md`.
  These expose workload, counters and limitations, not Pilot acceptance evidence.
