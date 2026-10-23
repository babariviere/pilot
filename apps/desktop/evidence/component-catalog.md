# App-owned component vocabulary

## Source and adoption

Verified code: `db02c27dcfd20ebd914e14ce1b50994976ff4f3d`, on
`46923720ea3a23f8e3d7f3f48e0005fffecfab6c`. A documentation-only publication
successor adds this ledger without changing compiled inputs.

`src/ui.rs` composes Kit rather than replacing it: existing semantic typography,
Space/Radius and icon mappings; color-only surfaces; reading page/header/section;
native action/icon-action factories; passive resource labels; caller-owned
field/control layout and validation; truthful notices/status tones. No component
fetches, persists, mirrors values, creates a view entity or owns a clock.

Overview uses the real page/header, section headings and All chats action
factory, retaining geometry, IDs and the guarded event callback. This is real
adoption, not just a catalog. It is not a transcript/editor/controller rewrite.
The three existing metric structs and semantic icon enum become public solely
for the app-owned API. No dependency or vendor change.

Agent guide: `docs/design-system.md`, including chooser, source-indexed compiled
patterns, state/accessibility/IME contracts, exceptions and verification commands.
`AGENTS.md` supplies a short discovery pointer. The actual catalog implementation
is `src/catalog_probe.rs`; run `--features native-probes --test catalog`.

## Completed focused verification

Job `8155f788-8f70-4376-b51e-fd43fac7c166`, exit **0**:

- Frozen source, clean-tree check and changed-file SHA256 manifest printed BEFORE
  compilation, not reconstructed from a later snapshot.
- Full formatting check and strict ALL-targets Clippy with native probes.
- Semantic scale test: seven roles route to the existing constants. Radius
  ordering is compiler-asserted, not silenced or widened.
- Actual native GPUI catalog at680/1100 logical width, light/dark,1280pt height.
  Mounted long-label/field/control bounds, rem-sized glyph slot and exact gap,
  actual SVG strokes, opaque Card/Tray contrast and exact34/76pt example frames.
- Real native Button disabled/loading guards reject callbacks; enabled pointer
  and keyboard callbacks execute. The caller owns the callback/state.
- Real Kit Input entity receives Unicode, combining marks and Japanese preedit;
  owner rerender retains focus, entity and marked range; actual insertText commit
  produces the expected value and Change notifications, without implicit submit.

Earlier source checkpoints stopped before native tests: one had the wrong Kit
button import path; the next hit Clippy's constant-assert diagnostic. Both are
fixed. No earlier interrupted invocation is counted as a successful native run.

## Actual captures

All four captures were inspected. They are synthetic actual GPUI, not a SwiftUI
mock, and were taken after callback/input checks and clearing the pending flag.
The visible “Pending example” label is a catalog specimen, not a live operation.

| Capture | SHA256 |
| --- | --- |
|680 light|`117b195bfbfd2d3db8705789b07d43d1d90fb6404b5aaf9b5d6f9c2f6de40145`|
|680 dark|`19a098bc45a2aa661a37ad33674ad85c6d01de52e21193d9a6cc27598d3e13d9`|
|1100 light|`3a2e2fe492e20cf64a5c2bbbd62c34683b72051c45499b624f79015c40ad4949`|
|1100 dark|`ae2d3231f4dce9ef586f82169268bdc0ce8a514161c4c856c63bb1fc68afc99b`|

Raw captures/logs/build products remain ignored. No real chat, settings or account
data was read or written. No local Swift mock compilation was performed under the
no-local-Swift constraint; the actual GPUI images are the visual check here.

## Explicit remaining gates and limits

At this checkpoint, the broad regression/full gate is **pending**, including
production Overview shell/workbench checks. Focused success does not inherit old
head readiness or claim full app parity, actual Settings delivery, OS IME/
candidate-window validation, native platform accessibility acceptance or visible
smoothness/CPU/RSS improvement. The catalog adds no motion implementation; it
delegates existing Kit loading and input behavior. Shared activity/motion lifecycle
regressions remain a separate production-root check, not proven by static images.

The existing `block`0.1.6 future-compatibility warning remains. Settings/updater/
packaging/lifecycle integration is separate, with no authority expansion, real
install/restart/release, default switch or Swift removal here.
