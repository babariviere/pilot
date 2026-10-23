# Native Settings integration

Implemented and locally verified. This is a real GPUI feature, not the earlier HTML layout mock.
The scoped checkpoint supports Appearance only, not full Settings or replacement acceptance.

## Source and ownership

The explicit source contract joins the pure preferences foundation
`dbe41d71ae105f5668392b2a93d0f4260341d1eb` with the shared component source
`db02c27dcfd20ebd914e14ce1b50994976ff4f3d`, both on accepted main
`46923720ea3a23f8e3d7f3f48e0005fffecfab6c`. The component API also has a public docs-only
successor `e83a36581ef8fa3c0db498cd4dbe3b19d8732b51`. Those dependencies are not authored
Settings UI changes. Their prior evidence is not a new combined-source pass.

Both dependencies are now merged on accepted main `ad2d9d94a2013c182a12426bfe2a3250fd98af5a`.
The owned eleven-path Settings delta was replayed onto that main with an explicit path allowlist,
zero-fuzz patch application and complete Rust/test/Cargo/patch hash identity before/after.
The separate CI correction `715280a4e7ae8752b9c359961184cb187e9fe8e9` is an explicit PR
parent, not a foreign Settings diff. Moving only the owned Settings commits onto it preserved
those complete compiled inputs. This change adds only the new native `settings` registration
and assertions to its CI seams; merged catalog/foundation registrations belong to that parent.
Current D33 Linux-CI restructuring is independently owned; this ledger claims no Linux pass.
After the full gate ended, the exact published D33 handoff
`0d53ad6a600d4275d5bb4deb73c1ede29e6d0eae` replaced that CI parent. All 140 non-CI
inputs in the frozen manifest remained byte-identical, including every Rust/test/Cargo/helper
input. Only `tests.yaml`, `ci.sh` and `test_ci.py` changed. Fresh light verification passed
47 tests on that final combination. This is qualified reuse of unchanged macOS code, not
a claim that the full gate ran again on a new revision or that Linux/remote CI passed.

New feature modules: `settings_view.rs`, `settings_worker.rs`, `settings_probe.rs` and
`tests/settings.rs`. Existing edits are limited to module/test registration, the guarded
Local viewer/sidebar entry and Cmd-comma, plus the committed appearance hook. No changes to
`ui.rs`, the catalog, Overview, editor, draft store, daemon, runtime or updater are made here.
The component owner retains its source; the foundation PR/history is preserved separately.

## Actual supported behavior

- Local's sidebar **Settings…** and **Cmd-comma** open one native Settings window. Existing
  transcript/composer entities remain mounted; opening does not select a different chat,
  project or working directory. The same existing marked-input/picker checks refuse opening
  during preedit. Closing restores the previous focus; category and preferences state belong
  to the retained owner, not a discarded render tree.
- Appearance uses shared `ui::page/header/FieldRow/Notice/action/Surface` presentation and real
  Kit ButtonGroup/List controls. System/Light/Dark are real edits, not fake toggles. Changes
  apply only after **Save changes** or **Cmd-S**, and Revert uses the last acknowledged baseline. Loading,
  saving, disabled, missing/default, error/retry and unconfirmed state stay distinct.
- One background thread owns the private store. Its input/output queues each hold at most one
  message. The UI sends the captured opaque SaveRequest payload and receives owner-generation
  fenced load/save replies. No filesystem work runs in render or on the UI event path.
- Construction is side-effect-free. Opening/loading does not create settings or import Swift
  defaults. If the Next-owned parent does not exist, only an explicit Save may create that one
  private parent, after lexical/ancestor/ownership checks, without recursive mkdir, chmod repair,
  acquiring `owner.lock` or opening `state-v1.json`. An intervening external snapshot is a conflict.
- Store and model survive Settings window lifetime together. Unconfirmed writes retain the exact
  request and cannot be hidden by reload/revert/close. Successful acknowledgments alone apply a
  committed theme. The existing GPUI `App::set_window_appearance` API supplies macOS native chrome
  overrides; System clears it and resumes the OS observer. Manual choices ignore OS changes.
- Managed close/quit is refused while appearance changes remain unsaved/unconfirmed or saving.
  The existing chat draft close/flush guard remains authoritative after that check; this does
  not add updater install/restart/quit machinery.
- **Updates** explains that integration is unavailable, with no working check/install/schedule
  controls. **Other settings** lists the remaining gaps and their existing authority. Core
  Appearance does not wait for updater work. Synthetic viewers have an explicitly readonly,
  memory-only Settings destination and never resolve a production preferences path.

Storage and authority details remain in `../docs/settings-parity.md`. The initial screen is
not full Swift Settings parity, notification/project/connection/model/diagnostic/energy/terminal
editing, updater integration or production preference migration.

## Verification ledger

Initial frozen integration source: `131ab640ad957fbc793b2665f1f3ade62eadd078`.
The focused job records a complete pre-build Rust/test/Cargo/patch source SHA-256 manifest,
uses the shared serial verification slot and mbx CPU2/4GiB, with a private target directory.
Existing pinned toolchain/mbx binaries are reused; there is no global installation.

The synthetic native probe uses actual production LocalViewer and SettingsView, recording
clients and private temporary state only. It checks 680/1100 light/dark, pointer/keyboard
opening, preedit refusal and commit, exact retained reader/chat/project/draft/focus identity,
real failed save/retry/restart, committed-only theme changes, close guards, unavailable
category behavior, long-label containment, loading/saving/disabled/default scenes and settled
idle. Staged model-only states are explicitly synthetic state presentation, not real I/O timing.

Capture names describe the actual theme at capture time: the save test changes to the other
theme, verifies it, then returns to the declared theme through another real durable Save before
capturing further states. Images are network-free synthetic GPUI renders, not a user's chats,
not the HTML mock and not visible animation/OS IME/performance evidence.

### Completed full macOS integration gate

Job `a0d4975f-2521-4da1-bf37-b1b4470e5366` exited 0 on frozen source
`0bfea704bde7c6f82aff7bd894273516303d347a`, then based on CI source `715280a4`.
The 143-file input manifest was written before launch, printed in the durable command log
and matched again after completion. `settings-screen-inputs.json` retains that manifest
and the original synthetic PNG hashes/dimensions. The serial slot is released.

- Standard `scripts/check.sh`: pinned helper build, fmt, strict helper/app Clippy, 162 app
  library tests passed, 2 explicitly opt-in disk observations ignored, 17 pure preference
  integration tests passed, and all 16 ordinary native probe targets executed successfully.
  The native targets were rendering, chrome, visuals, disclosure, style, icons, motion,
  controls, history, shell, navigation, inbox, jump, workbench, catalog and settings.
- Additional strict **all-targets with native-probes** Clippy and locked normal desktop build
  passed. Helper test invocation had zero tests, not a fabricated helper-test count; its
  real lifecycle/confinement coverage executed among the app library's macOS runtime tests.
  Native engine symbols were absent from the normal desktop and present in the helper.
- 37 Python runner/orchestration tests passed on that frozen source. After the CI-only D33
  parent handoff, the new combined light suite passed 47, including source-backed test
  discovery and explicit new Settings compile/execution registration. Mock Cargo is not CI.
- Actual production Settings windows passed all four 680/1100 light/dark flows with both
  viewport and mounted-root geometry asserted. Native pointer/keyboard entry, guarded
  marked-input commit, Cmd-S Save, durable failure/retry/restart, acknowledgment-only theme
  application, category navigation, retained reader/draft/focus and same-path project-removal
  identity checks passed, with **zero canonical read/write commands** in recording channels.
- Generated 32 synthetic captures: chat before opening plus Appearance, long label, failed
  save, unavailable Updates, loading, saving and missing/default scenes in each size/theme.
  All four primary views and representative long-label/error/loading/saving images were
  visually inspected. Correctly sized captures have no old crop/black-extent defect.

Loading/saving scenes are deliberately staged model states, not I/O latency measurements.
Idle assertions cover settled synthetic render notifications, not visible frame cadence.
Headless marked-text tests are not actual macOS IME candidate-window proof. Native platform
appearance API wiring is not a screenshot of macOS titlebar chrome. No real preferences,
account data, daemon actions, installer/restart, Linux GUI, release or default switch was used.
Actual visible smoothness, OS IMEs, wider Settings parity and updater integration remain gaps.

### Explicit changed-parent restack

The published branch was automatically rebased to `4e5a96c8` on CI parent `b6689248`.
That remote delta was inspected before adoption. The subsequent explicit CI test handoff
`3fab660e82d42122d94566b1ead15ce30926be12` changed only inherited test harnesses/guards
and their evidence. Only the four owned Settings commits were restacked onto it, with no
foreign descendants or branches rewritten and no authored Settings code changes.

Focused job `330c20af-b095-499f-8517-761a0b14aadf` exited 0 on actual combined source
`34c412b5b86400acdce043d954de1f2ecdf5356d`, preserving its new 143-input manifest before
and after execution. It passed fmt, strict all-target native-feature Clippy, 50 light tests,
17 preference tests, 4 worker tests, 2 owner tests, the committed-theme test, native catalog,
all four real Settings flows and the updated native controls target. This is a fresh focused
combined-source check, not a repeated full suite or a Linux CI pass.

The inherited controls test delivered 480 pointer inputs per case, with 464–470 gaps under
25ms and peaks of 236–256 inputs per actual second. Its 360-fast-gap, >30/s pressure and
real virtual/wall/window/capacity/latest-value guards stayed enabled. The shared oracles
actually rejected both test-instance `Unpaced` and `OldestQueued` mutations. These are
synthetic test-driver pressure observations, not application frame-rate or speedup claims.
No production pacer/runtime behavior was changed. The non-macOS refusal regression is
compiled out of this macOS run and still requires actual Linux CI on the new source.

The original full-gate manifest remains intact; `restackVerification` in the input receipt
records the newer focused manifest/captures separately. Parent baseline Linux success does
not qualify this updated Settings branch automatically. Remote CI remains independently tracked.

### Shared macOS workflow-contract follow-up

Run `39988886108`, macOS job `120535756963`, failed two inherited Node contract assertions:
they expected a blank `workflow_call` and exactly one macOS job despite the approved optional
release input and distinct native/release lanes. That job explicitly reported `Swift checks: false`;
this failure was not Settings code or actual Swift compilation. The exact upstream correction
`e5fedc134daa4818cef306d8f3a73c661bdd7ab5` changes only the contract test and inherited CI
evidence. Owned Settings commits were restacked onto it without editing those upstream files.
All 143 source inputs from the successful focused gate remain byte-identical. Fresh verification
on the actual combination passed all 18 workflow-contract Node tests and 50 light tests through
the shared Node slot. No Cargo/native/full suite was repeated for this test-only parent change,
and no new Linux/remote-CI success is claimed.

### Retained earlier failures and qualification correction

Corrected focused job `980c9cea-38b1-43df-8c45-4e68c428bc2c` exited0: strict/fmt,
17 state +4 worker +2 owner +1 theme tests and all4 native behavior flows passed; source
manifest remained unchanged. Visual review nevertheless caught a probe geometry error:
headless `Window::resize` changes platform bounds without notifying layout. The root stayed
780pt while screenshots were cropped/expanded to680/1100. Those images and that geometry
qualification are rejected. The probe now constructs its actual production Settings window
at the intended fixture size and asserts viewport AND mounted root size, without framework
patches or a production geometry change. The full gate above supplied fresh geometry/pixels.
Initial focused job `f2c4a927-3ec5-485e-b50f-27f0e2e6cee3` exited101 at strict compilation,
before any test/native execution. Own new-view opaque return lifetimes captured mutable
borrows under Rust2024; helpers now return their concrete owned `Div`. Unused imports and
one needless unit expression were corrected without suppressing warnings. This failed run
is retained, not described as a native pass.
Launcher `e2a17631-0974-4518-aebe-5e6488d12ded` failed before Cargo (missing private
temporary script path, exit127). Its corrected replacement is the successful full job above.
The independent parallel Rust CI workflow correction belongs to its existing owner. Merged CI
source or mocked orchestration tests are not passing Rust CI or proof a runner executed Cargo.

### Final exact-parent integration and one-feature publication

The old published head `bb68ce58702efd35799f5716f3c6830759705345` failed remote
native job `120540074475` in run `39990195894`, before catalog/Settings execution.
The inherited motion sampler missed intermediate opacity at 1100 Light. Its old sample
readbacks were [297,596,853,1156,1399] ms around the unchanged 280ms production fade.
This was not a Settings source failure. Other completed results on that exact old snapshot
included real Rust Linux success (155 library +17 state tests, 2 intentional ignores);
they are not fresh CI results on the new head.

After the explicitly requested local main rebase, the subsequent exact verified lower-source
handoff superseded it: parent `d709467d0b167cd8210d850ce518b8f56842586b`.
Only the owned feature was restacked. The e5-to-d709 tree delta is inherited
`motion_probe.rs` and its CI ledger, not Settings production changes. Its motion SHA-256 is
`36ce688d40157acf564eca668189e0084b926269ef198685b283175ffb524137`.
The test harness warms the actual final native text/readback, captures a genuine prefix-only
baseline before append, and samples paint/readback in one update. It retains pixel/idle,
entity/copy/geometry oracles and executes a real initial-FULL instant-appearance negative
control through the same appended-ink mask. Production fade, pacer and clocks are unchanged.

The earlier one-feature candidate `b85157e849de43a87ea07d636339bda4fa87a64b`
and original bb68 full tree/receipts were preserved. Frozen combined candidate
`18e773c4e06779f03f7c3e521cdffde8fa86b9d2` differs from b851 only in those two
inherited files. All 16 authored Settings paths were byte-identical. Among the 143 native
verification inputs, only motion_probe changed. No other branch or foreign history was rewritten.

Fresh focused job `f74f3b76-0065-41b6-8571-889c9bac97a0` exited 0 on that actual
combined candidate, with the 143 pre/post input hashes identical. It acquired the real serial
verification slot immediately, used existing pinned tools and mbx CPU2/4GiB, and released it:

- 50 Python light contracts, fmt and strict all-target native-feature Clippy passed.
- 17 preference, 4 worker, 2 owner and 1 committed-theme test passed.
- Actual native motion, catalog and all four Settings flows passed at 680/1100 light/dark.
  The motion intermediate-pixel counts were 3690,3618,3682,3607; every real initial-FULL
  negative control yielded zero. Draw starts inside the fade were [95,193], [94,189],
  [95,244], [94,240] ms. Draw/readback timestamps are not exact GPU paint times.
- Geometry/entity, exact copy, unchanged prefix ink and zero idle transcript renders remained
  asserted. Settings retained reader/draft/focus and produced zero canonical commands.
- 32 fresh Settings and 24 motion PNGs were retained with hashes/dimensions separately in
  `finalParentVerification`. Representative 680 Light and 1100 Dark Appearance captures were
  visually inspected and retain valid mounted geometry, with no prior crop/black-extent defect.

Only this receipt and ledger were amended afterward, into the same one feature commit;
compiled inputs remain exact. Original full and focused receipts are retained verbatim above.
This is not another full suite, a local Linux pass, inherited-parent CI as child CI, visible
smoothness, OS IME/titlebar proof or release/replacement acceptance. New-head remote results
are tracked independently; the old bb68 native failure is not declared green retroactively.

### Changed stacked base and conflict resolution

A later automatic follow-up found actual stack divergence/conflicts: the lower PR's remote
head had become `8176409163ed3f26ca902b38b09dcddc5f47c76b`, now based on accepted
main `953e17332996362f009c3ac7459b70befda57cee`. The lower owner supplied that exact
handoff. Independent comparison confirmed its net feature patch is byte-identical to d709's
(SHA-256 `6a40f2db32bbfd9826469f1b160cb9c9a5f12bbd7ef1f3eb27f80d0773fe8cef`).
This does not make their complete app trees or CI results identical.

Only the owned Settings feature `698c94c4` was restacked onto exact817, producing frozen
candidate `644f1694bf9cf57a0ab87b3837a6344f01afeb12`, still one feature commit. All16
owned Settings paths remained byte-identical before the evidence amendment. Nine compiled
inputs inherited from main changed: app_shell, disclosure_probe, inbox, inbox_probe,
shell_probe, tool_presentation, tool_presentation_tests, work_tests and work_view.
No parent/foreign branch or merged history was rewritten.

Focused job `29d055ef-e633-42b5-b88c-b6f7784da7f4` exited0 on actual644+817 with
all143 pre/post source hashes identical. It acquired the real serial slot immediately,
used existing mbx CPU2/4GiB tools, and released the slot:
- 50 Python light contracts, fmt and strict all-target native-feature Clippy passed.
- 53 focused Rust tests passed:17 preference,4 worker,2 owner,1 committed-theme,12 under the
  work_tests substring filter (6 transcript work plus6 private faux-socket network tests),
  11 tool-presentation,3 Inbox and3 workbench.
- Native disclosure retained its complete720 phased samples and ran28 semantic-work states.
  Native shell, Inbox and all4 Settings flows passed at680/1100 light/dark, retaining
  project/draft/reader/focus/preedit guards and zero canonical write commands.
- 32 fresh synthetic Settings captures retain hashes/dimensions in stackConflictVerification.
  The 680 Light and 1100 Dark Appearance PNG bytes exactly match the already inspected f74
  captures. This is not a new app-wide visual/motion acceptance claim.

After completion only the two owned evidence files were amended into the same feature commit.
Original full/focused/d709 receipts remain intact and historical. Unchanged motion was not
rerun; earlier f74 is not relabeled as a run on this new app source. Standalone updater and
Swift changes are inherited from main, not this PR's source or locally repeated verification.
This focused combination is not another full suite, Linux/Swift execution, parent CI as child
CI, OS IME or visible smoothness proof. Fresh exact published-head runner results remain
independent readiness evidence.
