# Home chat-row context

## Concrete discrepancy and scope

Accepted baseline source: `e9fa025d3ddf1823609ac06c0356bd4b5c64c079`.
`Overview::chat_row` displays only a title and generic signal label. Home mixes
projects, so the row cannot distinguish two projects with the same folder and
does not show the already-projected public attention reason. The Inbox and Swift
row vocabulary name project/context rather than asking users to infer ownership.

This slice changes only the content of existing Home/Overview chat rows, not
sections, eligibility, order, counts, project grouping or navigation. Reuse the
passive `ui::ResourceLabel`; keep the original Button IDs, canonical Chat event,
52pt row frame and loaded-only qualifier. Resolve project names by exact project
ID, never cwd/path/prefix; explicitly name missing/unassigned projects. Omit the
redundant name in a focused project. Use public attention text when present and
preserve the existing signal-label fallback. Full tooltip/accessibility text keeps
the untruncated context; no new actions, icon column, clocks or row entities.

## Existing visual direction, not a new layer

System family, shared Body13/Caption11 roles and existing spacing/radii. Palette
stays page `#ffffff/#262626`, sidebar `#fafafa/#202020`, ink `#262626/#d4d4d4`,
metadata `#6b6b6b/#9a9a9a`, card `#ffffff/#303030`, tray `#f5f5f5/#2c2c2c`.
Left-aligned title/context, no badges, cards or global font changes:

```text
Existing chat title
Exact project · existing public reason/state
```

Plan critique: this uses information the user already has, in its existing place.
It does not decorate generic rows or copy another product's framework/workflow.
Swift grounding is the shared Inbox/Home row line described in `DESIGN.md` and
`InboxRows.swift`; broader Home ordering/status behavior is deliberately retained.

## Baseline and implemented slice

Production `app_shell.rs` is unchanged at this preparation point. Only this note
and an opt-in bounded production-root fixture in `shell_probe.rs` are prepared.
It has two exact project IDs sharing one cwd, working/question/failure/unassigned
and missing-project summaries, long Unicode content, global/focused/removed
catalog/loading/empty cases, at680/1100 light/dark with fixed1000pt height.
The same fixture bytes must be used before and after.

`PILOT_NEXT_HOME_CONTEXT_DIR` selects only that capture fixture. Its pass is NOT
the original full shell/reader/IME/navigation matrix; run that separately for the
final regression qualification. No transport or writer exists in the fixture.
The valid BEFORE source is `8f4aaa3424cc00dea00977184bd2927274645801`.
Production now uses the existing ResourceLabel and a small display-only context
helper. It resolves the exact project ID against the loaded catalog, never cwd,
path, prefix or case folding. Public attention text is preferred; the existing
signal-label fallback remains for working, background, quiet or unknown states.
No completion/review status is manufactured. Global rows name an unavailable or
unassigned project explicitly; focused Overview rows do not repeat their project.
The original Button ID, 52pt frame and exact Chat event callback are unchanged.
Full tooltip/accessibility context is prepared from the same untruncated text.

## Verified source and evidence

macOS author verification, 2026-10-23, at frozen executable/test source
`5f1ec00a5a8f5e3f3cbfa869b484ec1e5c4c92ae`. The published feature adds only this
documentation ledger after the verified code freeze. Runs used actual serial
verification-slot admission and the normal bounded Cargo/mbx wrapper.

| File | SHA-256 |
| --- | --- |
| `src/app_shell.rs` | `7bf66e2911846e20a82d81810658e7dc2e7fd860ebc1708bfcc92229debc667a` |
| `src/shell_probe.rs` | `800975b8b1f3f639b6a2e15a78dd4c91a85d42f3da26819336d7696381773303` |
| Shared `src/ui.rs` (unchanged) | `a54e3be1da55b33a4b7ee285b288ba84dad7590d52f6fc2a1c8eb01edefe2b44` |

The before/after probe bytes are identical. **24 native PNGs per side** cover
global, focused, global-again, removed catalog entry, loading and empty, at two
widths in both themes with the same fixed window size. Actual narrow light global
and wide dark focused/removed-catalog images were inspected. Images are real
offscreen production GPUI, not mocks. Raw images/logs are ignored, not committed;
no capture-time PNG byte identity or independent approval is invented.

Successful commands from `apps/desktop` (the selector run is distinct from the
original full shell run):

```sh
bash scripts/cargo.sh fmt --all -- --check
bash scripts/cargo.sh clippy --locked --workspace --all-targets --features native-probes -- -D warnings
bash scripts/cargo.sh test --locked -p pilot-desktop --lib app_shell::workbench_tests -- --test-threads=1
PILOT_NEXT_HOME_CONTEXT_DIR="$PWD/evidence/local/home-context-after" \
  bash scripts/cargo.sh test --locked --features native-probes --test shell
bash scripts/cargo.sh build --locked -p pilot-visual-worker
bash scripts/cargo.sh test --locked -p pilot-desktop --lib -- --test-threads=1
# No HOME_CONTEXT/SHELL capture selector for the original full regression.
bash scripts/cargo.sh test --locked --features native-probes --test shell
bash scripts/cargo.sh test --locked --features native-probes --test navigation
bash scripts/cargo.sh test --locked --features native-probes --test workbench
```

Full library: **161 passed, 0 failed, 2 existing ignored** isolated disk-workload
observation tests. The three app-shell tests cover unchanged counts, exact project
and public reason semantics, and mounted 496/868pt body widths with 52pt rows,
aligned/contained labels, no icon column and one exact canonical pointer event.
Keyboard/IME, scope, reader selection/pixel anchor, draft/backpressure and retained
owner/cursor guards remain in the separately executed full shell/navigation cases.
All native width/theme combinations pass. The original large shell scene retains
256 projects, 1,000 canonical chats, bounded previews and shared metadata rather
than deep clones; no timing/RSS improvement follows from that functional check.

Pre-build source IDs/hashes are emitted in retained logs. Clean-tree checks and
commands are recorded in the author run/ledger; no stronger independently observed
CLI or atomic pre/post whole-tree attestation is claimed. Post-terminal publication
checks confirm code bytes still match the frozen source. Formatting/strict checks
and the full gate compose on those same bytes, not a different executable head.

Author source review is limited to the row helper/content/test/probe changes.
ProjectList, sync, routing, sections, order, eligibility, counts, project-row glyph
IDs and header are unchanged. Lookup work is bounded by existing visible-row and
project-catalog limits (at most 17 rendered chat rows and 256 projects); there is
no new persistent cache, parser, I/O, clock or row entity. Representative CPU/RSS
and visible pacing are not measured here. Local results are not new-head remote
CI, and standard green checks alone do not establish executed Rust/native CI.

## Retained gaps

Broader Home/status/corner polish, duplicate section membership, sidebar/menu
hierarchy and further Swift tool parity remain separate. This is not full app-wide
acceptance, visible smoothness, CPU/RSS improvement or release/default switch.
Settings/lifecycle/appearance, shared UI/lib/Cargo/CI/scripts, Inbox, updater,
reader/drafts and composer76/34 remain untouched. No copied foreign source/assets.
