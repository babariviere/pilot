# Inbox hierarchy and state guidance

## Grounded discrepancy checklist

Accepted source: `e9fa025d3ddf1823609ac06c0356bd4b5c64c079`.
The existing Inbox is bounded and functional; this is not a new Inbox backend.

- `src/inbox.rs` still uses generic Kit text sizes instead of the shared app
  title/body/metadata roles used by Overview. Adopt existing `ui::text`/header.
- Row content duplicates the passive title/detail layout already defined by
  `ui::ResourceLabel`. Keep the original ListItem and canonical callbacks; do not
  add an interactive wrapper or a new status-icon column.
- Two permanent explanatory captions precede every actionable list. Keep one
  visible, truthful loaded-Local qualifier and place secondary availability
  guidance below the working area rather than competing with its hierarchy.
- Loading and empty copy describes implementation support instead of the user's
  next context. Distinguish these states without claiming all Inbox sources are
  clear. Keep exact project filtering and the partial-source boundary visible.
- Missing-project and project-list-error text has the same treatment as routine
  metadata. Use the existing passive Notice/semantic tone, retaining loaded rows,
  exact unavailable IDs and all native filter/IME guards.

Swift grounding: `InboxRows.swift::InboxRowLabel/NeedsYouRow` uses a title and
quiet reason line, no extra leading status column. The dithered corner carries
state. Swift's complete clear-state claim is not copied to a loaded-summary-only
viewer. Existing public attention labels, bounded detail and full tooltip remain.

## Direction using the existing design system

System type family, shared Title22/Body13/Caption11; never reset editor/Markdown
or global metrics. Use current semantic roles, not new literal colors:
page `#ffffff/#262626`, sidebar `#fafafa/#202020`, text `#262626/#d4d4d4`, metadata
`#6b6b6b/#9a9a9a`, card `#ffffff/#303030`, tray `#f5f5f5/#2c2c2c` (light/dark).
Keep the current physical spacing/radii, neutral selection and existing corner.

```text
Inbox                              [All projects]
Loaded Local chats; opening does not mark them reviewed.
[localized project notice, only when relevant]

Needs you                                   count
  Existing title / complete reason in tooltip
  Existing title / reason

Ready to merge                              count
  Existing title / reason

Quiet secondary source-availability guidance
```

Plan critique: no decorative cards, hero metrics, color-coded pill taxonomy,
extra spinner/clock, or new actions. The hierarchy is for acting on existing
attention, not for a generic dashboard. Home already adopts shared page/header
roles; this chooses one more bounded everyday surface rather than restyling
Home, navigation, Settings and tools at once.

## Baseline and implementation

Only `inbox_probe.rs` and this document are changed before the BEFORE capture;
production `inbox.rs` remains accepted-source-identical. The existing four native
Inbox cases retain their canonical filtering/selection, native keyboard/pointer,
IME, draft/reader, hidden-publication and capacity assertions. A longer synthetic
title/reason and extra selected/error/missing/loading/empty captures expose the
relevant states. No real reads/writes or payloads. The same frozen fixture must
be used for AFTER; capture source/hashes are recorded before each admitted run.

The valid BEFORE checkpoint is
`537dddbef60cbadbae47fc60d9223b966c967612`. It completed formatting, strict native
Inbox Clippy and the original four native cases, producing 32 captures.

Production now reuses the shared reading column/title/text, passive resource row
and Notice. The original ListItem, exact-ID pointer/keyboard handlers, picker
entities/220pt bounds, selected identity, urgency projection and corner owner stay
in place. The text lane reserves an existing shared spacing gutter, not a hole or
new geometry in the corner paint. Section counts read quieter; zero sections do
not add headings. There is one loaded-Local qualifier and a quiet availability
footer. Empty/loading guidance remains explicitly partial. A project refresh
failure says "Couldn't refresh projects" because cached names may still exist;
an unavailable exact filter remains unavailable rather than silently broadening.

## Verified source and checks

Final executable/test source:
`d4b471bd116fc32f60fa5a6cf37bb716905e0d91`, macOS author checks 2026-10-23.
Each run had a frozen source ID, clean-tree proof and pre-build SHA-256 manifest,
using the actual serial verification slot and bounded Cargo/mbx wrapper.
The final publication adds documentation evidence only after that freeze.

| File | SHA-256 |
| --- | --- |
| `src/inbox.rs` | `de23fce579f64252c3ce3bb7302bfad46ba13fd18715a9dc8897a3087c9a93af` |
| `src/inbox_probe.rs` | `708e126084935f24579a2c498a0003de43a1be7665cc24560ccf4d21c00ddd9b` |
| Shared `src/ui.rs` (unchanged) | `a54e3be1da55b33a4b7ee285b288ba84dad7590d52f6fc2a1c8eb01edefe2b44` |

Before/after use byte-identical probe/fixture source, fixed 680/1100 windows in
light/dark and 600pt height. There are **32 native PNGs per side**: selected
populated/long content, picker confirmation/filter, project refresh error,
unavailable exact project, loading and empty. Actual narrow light populated and
missing-project, wide dark error, and narrow empty images were inspected. Raw
captures/logs stay ignored; capture-time PNG byte identity is not invented.

Successful final commands from `apps/desktop`:

```sh
bash scripts/cargo.sh fmt --all -- --check
bash scripts/cargo.sh build --locked -p pilot-visual-worker
bash scripts/cargo.sh clippy --locked --workspace --all-targets --features native-probes -- -D warnings
bash scripts/cargo.sh test --locked -p pilot-desktop --lib -- --test-threads=1
PILOT_NEXT_INBOX_DIR="$PWD/evidence/local/inbox-polish-after" \
  bash scripts/cargo.sh test --locked --features native-probes --test inbox
bash scripts/cargo.sh test --locked --features native-probes --test navigation
bash scripts/cargo.sh test --locked --features native-probes --test workbench
```

Library: **161 passed, 0 failed, 2 existing ignored** isolated disk-observation
tests. Inbox tests include a mounted 496/868pt body-width check for glyph-free
aligned text, reserved gutter, exact 220pt filter, qualifier/footer containment
and truthful empty/loading copy. Native Inbox retains four real production-root
cases: canonical pointer/keyboard selection, scope/history, search/preedit fences,
same-owner drafts/reader, no write or mark-reviewed actions, hidden publication
quiescence and 1,000-chat/256-project bounds with fewer than 64 visible corners.
Navigation and workbench native cases pass in all four width/theme combinations.

The initial AFTER compile failure was a missing `FluentBuilder` import; it is
fixed, not suppressed. A focused pass preceded the final error-wording refinement;
the complete final gate and new captures cover that refined source. No earlier
pass is silently transferred to changed executable bytes.

Author source review confirms presentation-only changes: eligibility, sync,
identity, filtering, activation and persistence/authority paths are unchanged.
No independent approval is claimed here. These are local receipts, not executed
new-head remote CI; known inherited workflow validation remains separate.

## Explicitly retained gaps

This one Inbox slice does not finish app-wide polish: broader Home/navigation/
menu hierarchy, further Swift tool-presentation differences and real visible
motion/performance acceptance remain separate. Full Inbox sources/actions,
Settings, appearance/lifecycle, composer76/34, reader/draft behavior, updater,
shared CI/scripts and motion/slider harnesses are not modified. Static native
captures are appearance evidence, not smoothness, OS IME/AX or CPU/RSS proof.
