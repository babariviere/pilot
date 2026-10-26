# Bounded Local resource jumps

Cmd/Ctrl-K is a read-only jump palette, not a general action launcher or full
Swift palette replacement. It projects existing loaded Local pages, configured
project IDs and chat IDs only. It never treats folder equality as identity.
No transcript scan, new endpoint/subscription, private review marks, provider
reasoning, canonical write or inferred authority is involved in building/search.

## Behavior and boundaries

- Pages: global Home, current-scope-preset Inbox, global All chats and current
  configured project's Overview. Projects switch the existing browse-only scope,
  restoring its existing state. No cwd/permission/creation authority is inferred.
- Search follows Swift's grouped best-token score direction: title above context,
  prefix/word-boundary above substring, equally good resources before chat groups,
  exact chat titles not artificially demoted, stable source order for ties.
  Unicode NFKD/combining-mark removal/lowercase handles case, accents and width;
  this is not a claim of every locale-specific Foundation folding equivalence.
- Empty search shows pages/projects and up to three recent writable, nonarchived
  chats other than the selected reader. Explicit queries can find archived or
  retained read-only chats; existing reader/write restrictions remain unchanged.
- Up to256 projects/1000 summaries, at most1259 catalog entries and six rows per
  each ordinary group (18 text matches), virtualized. Exact PR matches form a
  leading group containing every matching catalog chat, not a six-row subset. Queries stop at240 scalars or32
  words, with explicit refusal rather than truncated-prefix matches. Normalized
  labels/indexes are built off-thread; bounded search also runs off-thread.
- The palette exists only while open, uses existing feeds and creates no timer or
  hidden subscription. Cancellation drops pending work; weak allocation identities
  fence source reuse without retaining obsolete full summary/cwd payloads.
- Async results are ticketed. Source/scope/selected-owner and current live query
  are checked before activation. Pointer closures capture the rendered destination
  and ticket, not a changing index. Refresh retains keyboard identity or clears
  a missing selection, never selecting its replacement by row number.
- Opening refuses editor/folder/sidebar-search and active Inbox project-picker preedit. Palette preedit refuses
  Enter, Escape, toggle and pointer navigation before focus can change. Ordinary
  typing and clipboard shortcuts stay native; Tab stays in its sole search focus.
  Existing guarded navigation captures draft/reader state only on an explicit
  jump. Closing restores previous focus, without changing the reader/history.
- Search/opening the palette does not create, send, Stop, approve, retry, check
  receipts, mark read, archive, merge or reconfigure anything. Only explicit
  destination activation uses the existing reader contract (project focus may
  restore its last chat), including possible server-side PR
  refresh. Loopback + Origin rejection/identity pinning is not authentication.

## Verification

Focused commands (synthetic/faux channels only):

```sh
cd apps/desktop
bash scripts/cargo.sh test --locked --lib jump:: -- --test-threads=1
bash scripts/cargo.sh clippy --locked --all-targets --features native-probes -- -D warnings
bash scripts/cargo.sh test --locked --features native-probes --test jump
bash scripts/check.sh
```

Focused catalog tests and all four native palette scenes passed. The native
matrix verifies Unicode search, keyboard/project and pointer/Inbox jumps, draft
text preservation, per-key preedit refusal, Tab/Cmd-F/Cmd-L containment,
programmatic navigation refusal, old-rendered-ID pointer activation after a feed
change, long-query refusal, exactly one explicit faux chat read, zero canonical
write commands,1259-entry/18-match capacity and entity release after close.
Search input is driven natively, not by assuming `set_value` emits Change.
Empty-section measurement and accepted-versus-requested query selection have
defensive guards; preedit is captured in the action phase before Input Escape
can unmark it. The initial palette source added no dependency patch or global
timer. The picker correction below adds an explicit, exact-source Select seam.

The initial complete macOS gate passed on frozen source
`08a6da7f78cd23b7d5354b18419dfe07f13c3946`: **147 library tests passed,2 ignored**,
strict all-target/native/app/helper, the entire existing fixture/browser/chrome/
visual/disclosure/style/composer/slider/history/Home/navigation/Inbox matrix and
all4 palette scenes. Four mocked Python runner tests, locked app/helper builds
and engine-symbol separation passed. The helper has no Rust unit tests; the
existing `block0.1.6` future-compatibility notice remains. Earlier failing
diagnostic iterations are superseded, not counted as successful evidence.

## Inbox picker opening boundary

Correction source is frozen at `ffb2ed2725b5e20b4a2c65323042028411b69316`.
Before creating/focusing the palette, the active Inbox checks its actual Select
search input. Marked text refuses navigation without changing focus, text,
marked range or selection. After composition ends, explicit navigation retires
only the transient picker popup/query, restores the committed selection cursor
and focuses its mounted trigger before saving the palette's return focus.
The existing synchronous palette focus path is unchanged. No deferred-focus
callback, timer, global key-dispatch or default Select blur behavior is added.

Kit0.8 keeps that input private, so the tracked component patch adds a small
read-only input accessor and an explicitly called `prepare_navigation` method.
It has24 exact edits; original archive checksum/version and the base29-edit
patch are unchanged. Component spec SHA-256:
`df0d3f56231f2f23deb9b9fdabe86be7bed2a238e791d5f62247aaf3b6026390`.
Generated/registry sources are not edited or committed. No lockfile or worker,
store, canonical reader/transcript, backend, Swift or shell-design change is
part of this correction.

Strict all-target/native checks and all four strengthened native palette scenes
passed at680/1100pt in light/dark. The real mounted searchable picker owns focus;
synthetic preedit followed by Cmd-K creates no palette. After settling, exact
text, marked range, focus, actual filter value, draft, reader entity and history
cursor remain unchanged, with no faux read or canonical write. After unmarking,
native search/Command-K hands focus to the palette; existing per-key IME,
stale-source pointer, capacity and release assertions still pass. Removing only
the Inbox opening guard intentionally fails the new pre-blur refusal assertion.
The guard was restored before the final gate. The complete gate passed on the
frozen correction source: **147 library tests passed,2 ignored**, strict
all-target/native/app/helper checks and the entire native matrix, including all
four strengthened palette and all four Inbox scenes. Four mocked Python tests,
locked app/helper builds and app/helper engine-symbol isolation passed. The
existing `block0.1.6` warning remains. This synthetic regression is not OS IME
or visible performance acceptance.

## Visual evidence and remaining gaps

Actual production GPUI synthetic680light/1100dark frames were inspected for
readability, rounded containment and unclipped resource rows/footer. The captures
are from the same native fixture; optional `PILOT_NEXT_JUMP_DIR` output remains
ignored and is never a real/private capture. This is not the separate SwiftUI
mock, motion acceptance or a measured CPU/RSS improvement. Source/catalog work
is bounded and off-thread, but large-data counts and cleanup checks do not prove
performance parity. No full replacement/ready-by-CI claim is made.

Native scenes
exercise the production root at680/1100pt, light/dark, and never open a visible
window or access real Local/private state. The separate SwiftUI artifact is a
labelled static reference, not GPUI/rendering or acceptance evidence. Offscreen
checks do not establish OS IME, macOS15 hardware, visible smoothness, full Swift
parity or a CPU/RSS win. HTML/browser, shaders, terminal, Linux verification,
updater/release/default switch and Swift removal remain excluded.

## PR-number discovery

Swift audit: `PilotCore/CommandPalette.swift` recognizes bare and hash-prefixed
numbers and prioritizes `linkedPullRequests` owners. Its chat catalog navigates
by session ID. The existing protocol summary already carries `pullRequest`,
`pullRequests` and explicit `boundPullRequests` URLs. Rust previously discarded
these association fields. The bounded Chat projection now retains only valid
number/repository pairs, deduplicated per chat, not PR titles or opener targets.
Object numbers must agree with their HTTP(S) PR URL; malformed entries are
ignored. Explicit bound PR URLs also work before health metadata arrives.
No endpoint, GitHub request, title/branch inference or URL-opening action added.

Bare `123`, `#123`, `PR123`, `PR 123` and `PR #123` prefer exact numeric PR
associations. `1234` is not a metadata match for `123`. Ordinary title/context
matching continues in separate capped groups, including numeric chat titles.
Every exact matching catalog chat remains independently selectable, including
same-title, same-PR and archived/read-only entries. The row detail leads with
the matched PR number and owner/repository (plus host for non-GitHub domains),
then existing project/state context. Selection and activation remain canonical
chat IDs, with existing draft, IME, source and query-epoch guards unchanged.

Coverage remains the existing loaded Local catalog (first1000 summaries and256
projects), not a complete server/GitHub/archive search. Missing metadata cannot
be discovered. The existing `secondary-k` binding is Command on macOS and
Control elsewhere in the pinned GPUI implementation; no platform guard changes
or Linux qualification are implied.

Focused verification uses `check-scoped.py --unit jump::tests --test jump
--native-probes --lint`. This covers matching/projection plus the mounted real
palette and strict library/native lint/build, using shared serial admission,
CPU2/4GiB mbx and workspace-private outputs. No broad performance gate is needed
for this summary-only feature. Native assertions cover PR ambiguity, arrows,
retained selected ID across summary refresh, old-query Enter refusal, PR Enter
canonical destination and existing IME/draft/stale-source guards at680/1100 in
both themes. Captures are synthetic offscreen GPUI, not a SwiftUI mock, OS IME,
visible-motion/performance acceptance or Linux proof.

Final focused qualification: **4/4 library tests and4/4 native scenes passed**,
strict Clippy with warnings denied and selected test/native builds passed.
`rustfmt --check` for the changed focused sources and `git diff --check` passed.
The existing `block0.1.6` future-compatibility warning remains. The first build
caught a missing restored-draft initializer, then an added Escape assertion
incorrectly inspected backing draft state rather than the live textarea. Both
were corrected; neither failing run is counted as successful evidence. The final
run removed an unnecessary URL-length cap under the simpler-code decision.
No new state machine, subscription, transport request or recovery layer added.
