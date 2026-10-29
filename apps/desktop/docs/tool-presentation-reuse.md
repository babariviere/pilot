# Selective tool-presentation reuse

## Pinned audit and adopted scope

This slice follows the existing calm native workbench, not a renderer/framework
replacement. References were read directly at immutable public revisions through
GitHub/raw files. No competing app was launched and no reference clone was made.

| Reference | Exact revision/file | Finding |
| --- | --- | --- |
|Zeron|`dd0c36fa3ec1e269a630562179e655b1ed26f0a0`, `crates/ui/src/transcript.rs:2079–2126,8025–8114`|Keep the design of a compact semantic work header and lazy hidden bodies. Do not copy its proto-dependent summary, thought chips, fold/arrival state or measured-height animation. Our tool IDs/privacy/anchors remain authoritative.|
|Zeron|same revision, `crates/ui/src/motion.rs`|Reject adoption: global pulse clock, reduce-motion APIs and custom easing are coupled to its framework. Existing Kit/shared lifecycle stays; no new clock.|
|Zeron|same revision, `crates/ui/src/badges.rs`|Reject for this slice: composer/message context extraction and hover-card entities, not tool summaries.|
|Zeron|same revision, `crates/ui/src/surface_chrome.rs`|Reject copying: sidebar/material/blue-focus styling would fork our shared tokens and neutral focus rules.|
|MonoCode GPUI preview|`d9e6e230b0005bff492a18cd2d3404d199e441f1`, `crates/monocode-gpui/src/transcript/tools.rs:7–31,156–215`|Adapt the small std-only command-label helper when useful; preserve the MIT notice and exact adapted range. Keep compact semantic caption/progressive-detail design. Reject core CommandStep/runtime/task/file-opener coupling and blanket noise filtering that could hide a failure.|

Zeron root `LICENSE` is MIT, copyright2026 Wing. MonoCode root `LICENSE` is MIT,
copyright2026 Nick. Selected tool-helper source has no overriding file header.
MonoCode's GPUI preview, not its Tauri main, was inspected. Its Cargo manifest
pins gpui-pre0.3.9 but also includes custom renderer/platform, terminal/editor/
WebKit/native-execution dependencies; none is adopted. Zeron's engine/proto/UI
types and framework-specific animation APIs are not interchangeable with Kit0.8.
Root app licensing is not permission to copy unrelated vendored renderers/assets.

Source hashes (UTF-8 bytes):

- Zeron transcript.rs: `f0aeb01af7b97ce3cdcf56712e880548c664ca218207032a8a63b1886d2d2254`.
- Zeron surface_chrome.rs: `37b656da67fb47d7bbcb195c7506ba7107ca199244b1ce7edd953857e37056ee`.
- MonoCode tools.rs: `42876feed7ec5c967187ba5a25adc2430184eb61fa69ff29333dedd81d4d27e2`.

The only adapted code is MonoCode `tools.rs:17–31` →
`src/tool_presentation.rs::command_label`, std-only caption formatting. The full
unchanged MIT notice is retained in `licenses/MONOCODE.txt`; the source comment
pins revision, file/range and copyright. No foreign assets, frameworks, execution
helpers or dependencies are copied. Zeron contributes design inspiration only,
not code. `command_subject` is app-owned, conservative display formatting around
that helper, not a shell parser: complex operators, assignments and quoted
programs retain the bounded original line. Never use a caption for execution,
authorization, deduplication or as a substitute for the original command.

## Discrepancies addressed in this slice

- A collapsed step combines verb, subject, edit counts and status in one muted
  truncated string; the meaningful target and failure state compete for space.
- An automatically opened group limits to the latest four steps, which can hide
  an earlier failure despite its group count. Keep failures findable without
  discarding chronological or canonical identities.
- Command/script details present generic JSON wrappers, where Swift leads with
  readable command/code. Keep complete arguments intentionally reachable, exact
  Copy, output/diff detail and bounded lazy parsers.
- Nested guide lines, button padding and repeated code borders compete with
  conversational hierarchy. Keep semantic glyphs, calmer rows and one intentional
  detail surface rather than copying another app's cards/pills.

## Implementation within existing tokens

Use the system family and existing Body/Label/Caption roles, not a new typeface
or global font reset. Page/card/tray/code and ink/metadata remain existing light/
dark roles (`#ffffff/#262626` page, `#ffffff/#303030` card,
`#f5f5f5/#2c2c2c` tray, existing foreground/muted colors). Error ink is reserved
for actual failure; completed work gets no new green checkmark. No palette fork.

```text
> Worked   read3files, ran2commands                  1failed
  glyph  Ran      cargo test                        Failed
  glyph  Edited   parser.rs                         +3 −1
  > Command / code (on intentional step expansion)
    Output (bounded, exact Copy)
    Arguments (secondary, still reachable)
```

Keep the existing canonical work/tool entities, explicit expansion choices,
selection/copy and disclosure anchor callbacks. Do not animate transcript height,
infer reasoning from history, alter grouping IDs or create per-row clocks. Before
production edits, capture the same synthetic production-root fixture at680/1100
light/dark, including an early failed call and long output; retain immutable
source/input receipts. Static images establish appearance, not visible smoothness.
Broad polish, new host capabilities and full tool/parity acceptance remain outside
this first slice.

The production disclosure now uses shared `ui::Text` roles, separate verb/target
and fixed metadata/status slots. A long caption cannot truncate the failure count.
The automatic group preview keeps four recent steps plus at most one earlier
failure (or an unknown result if there is no failure), in original order. All
hidden steps remain reachable with Show more; explicit group choices stay final.
Changes to the critical preview shape/unknown count also request remeasurement.
No tool or group entity is duplicated or replaced to make the preview.

Expanded bash/codemode calls lead with the complete original command/code;
arguments have their own intentional disclosure, with exact Copy for both.
Preparation happens with argument projection, not per output render.
Full already-received arguments and prepared command/code are retained outside the
2 MiB metadata/output/diff preview reserve. There is no argument byte cutoff in
live capture, partial string deltas or cold-history projection. The 40 KiB output
and 256-tool limits are unchanged. Upstream omissions remain inspectable as received.
Hidden bodies do not create/update parsers;
cached parser entities, selection and disclosure anchor callbacks remain owned by
the original canonical step. No animation or performance improvement is inferred
from static comparison images.

## Full received arguments

The former 12 KiB omission was client-only in three places: live
`local_model::slim_message`, partial `toolcall_delta` string application, and
`Tool::describe` (pretty JSON could cross the threshold even when compact JSON
did not). Those cutoffs are removed. The aggregate preview reserve also no
longer clears arguments or prepared command/code.

The Local history reader passes the decoded JSON through after its existing
hello identity checks. Daemon `chat-streams.ts` splits snapshot frames by entries,
not argument strings. Neither path introduced this 12 KiB omission. No backend,
protocol, image, transport/backpressure or identity guard changes are needed.
Missing/null arguments and upstream `viewerOmitted` evidence remain as received;
the client cannot reconstruct bytes upstream never supplied. JSON argument copy
uses the full pretty serialization of the received value; command/code copy uses
the exact received string, including Unicode and newlines.

Existing call disclosure, source preparation, shared selectable code text,
nested scrolling and clipboard handlers are unchanged. Hidden fixture:
`PILOT_NEXT_TOOL_ARGUMENTS_DIR=/tmp/tool-args python3 scripts/check-scoped.py --test disclosure --lint`.
It renders the production root at 680/1100 widths in light/dark, checks bounded
pane geometry and exact clipboard equality after history and live delta updates,
and captures only synthetic content. Pure tests cover small, >12 KiB and >2 MiB
arguments, paging, commit/reconnect, preview pressure and missing/omitted payloads.
This does not claim arbitrary-source virtualization or an RSS ceiling.

## Baseline provenance

The valid BEFORE is `5ff8a780e5ebdfd0176ec23c3caea5682f4f6955`, with unchanged
production UI and the `semantic-work-v2` synthetic fixture. Its pre-build clean
tree/SHA manifest, fmt, strict disclosure Clippy and four 7-phase native capture
cases passed. Captures use fixed 680/1100 logical window widths, light/dark,
1040 logical height and the real synthetic LocalViewer root (not a mock renderer).

An earlier v1 fixture incorrectly nested the error flag in an ignored `result`
property. Its captures are **not** failure-visibility evidence. V2 uses the real
top-level `isError` and `entry.model` result envelope, and asserts an actual
`Work.failures == 1` before opening the window. Before/after comparison uses v2
only, including the same live/collapsed/expanded/detail/stream/copy/settled inputs.
The capture selector is bounded evidence, not a pass of the original 720-frame
disclosure/anchor matrix. That matrix remains intact and is a separate check.

## Verified source and review limits

Author checks on macOS, 2026-10-23, used frozen source
`f5866c844bbbd88412a622adbba8cffebfad8aa3`, preceded by a clean-tree proof and
SHA-256 manifest. Verification used the shared serial admission wrapper and the
normal bounded Cargo/mbx wrapper. The following commands completed successfully
from `apps/desktop` (each Cargo invocation uses `bash scripts/cargo.sh`):

```sh
bash scripts/cargo.sh fmt --all -- --check
bash scripts/cargo.sh build --locked -p pilot-visual-worker
bash scripts/cargo.sh clippy --locked --workspace --all-targets --features native-probes -- -D warnings
bash scripts/cargo.sh test --locked -p pilot-desktop --lib -- --test-threads=1
PILOT_NEXT_TOOL_PRESENTATION_DIR="$PWD/evidence/local/tool-presentation-after" \
  bash scripts/cargo.sh test --locked --features native-probes --test disclosure
# Without the capture selector: complete original disclosure regression.
bash scripts/cargo.sh test --locked --features native-probes --test disclosure
bash scripts/cargo.sh test --locked --features native-probes --test history
bash scripts/cargo.sh test --locked --features native-probes --test rendering
```

- Library: **159 passed, 0 failed, 2 existing ignored** isolated disk-workload
  observation tests, not newly skipped checks. All six work interaction tests,
  eleven tool projection tests and the bounded-preview unit test passed.
- Native disclosure: **720 sampled frames** over 18 actions at two widths,
  not 720 independent test cases. Header anchoring, explicit expansion,
  rapid toggling, streaming, prepend, remount, wheel and Latest assertions pass.
  Transient-thinking and the v2 semantic-work fixtures also execute.
- Native history and rendering: passed with faux read channels/synthetic data,
  retaining selection/entity, paging and anchor assertions. No real sends,
  creation, Stop, approvals, remote execution or canonical-data writes.
- Comparison fixture: the same source bytes before and after; **28 PNGs per
  side** (680/1100, light/dark, seven phases). Author visual inspection of the
  narrow light preview and wide dark detail confirms failure findability and
  code-primary disclosure. Raw captures/logs are not committed.

Executable/test source SHA-256, unchanged by the final documentation fold:

| File (`src/`) | SHA-256 |
| --- | --- |
| `disclosure_probe.rs` | `e647f048337eae289aad89486234ec27849a213937dbe89340303726dbef08e7` |
| `tool_presentation.rs` | `1083ee6b4eb2046721dc6f0bbff5824d0f0325469c42d3e070043f84425deba6` |
| `tool_presentation_tests.rs` | `0396f9e4ad2cccb169f3cdbfd881dc8946aaa0c53e830a6d863d3490df3c067a` |
| `work_view.rs` | `17a7e50bd3af14abbcdf1b581452e842a0503e521fc6b7a4f6a7550d6df437d1` |
| `work_tests.rs` | `aec4bdb87058b24893e7033c85e06b125ab3856aecc7c554980b6bb7ade17194` |

The author source review checks canonical entity ownership, explicit choices,
bounded source accounting, conservative captions, lazy parsers, exact Copy and
the absence of new I/O, clocks, dependencies or authority. This is author review,
not an independent approval. No known blocking finding remains in this slice.

These checks establish the scoped presentation/interaction change, **not** full
Swift parity, visible smoothness/frame pacing, representative before/after CPU
or RSS improvement, OS IME/AX acceptance, Linux/Wayland verification, production
release or a default switch. Existing native body styling/renderer is retained.
No height animation or new activity clock was introduced. Broader polish and
performance acceptance remain separate. New-head remote CI is not inferred from
these local receipts or from another commit's status.
