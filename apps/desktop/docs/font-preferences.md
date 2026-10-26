# Conversation font preferences

Appearance offers installed chat families, common installed monospaced code families,
half-point chat sizes (11–22 pt) and code sizes (9–20 pt). The native preview changes
immediately; existing conversations change only after the existing explicit Save receives
its acknowledgment. Revert restores the saved snapshot. **Restore font defaults** stages
only font defaults, preserving the selected appearance and every unrelated preference.

## Ownership and adoption

- `settings_state.rs` adds `FontPreferences` to the existing strict v1 preferences schema.
  Each family is at most 96 UTF-8 bytes, without control characters. Empty is the app default.
  Optional sizes are integer half points, range-checked on decode, edit and save. Legacy
  appearance-only snapshots load unchanged with unset font overrides. New snapshots remain
  within the existing 1024-byte cap. An older build that cannot read `fonts` refuses the file
  rather than overwriting it. No Swift defaults are read, copied or changed.
- `settings_view.rs` keeps the retained preferences owner, one background storage worker,
  captured save receipts and generation/error/unconfirmed/retry rules. Failed or uncertain
  saves never apply staged fonts. An exact retry confirms the original payload before a
  newer edit can be saved. The bounded Save command now boxes the larger immutable payload.
- `typography.rs` owns the semantic content roles, not a second chrome type scale. Family
  enumeration runs once on the background executor, with at most 4096 retained names and
  at most 256 native chooser entries. Common installed families lead; the installed saved
  choice remains reachable even outside that shortlist. Rendering never enumerates fonts.
  Controls disclose loading. Missing families use the app default without replacing their
  stored names; Settings discloses the fallback. Restart after changing installed fonts.
- Real `TranscriptView` TextViews use Chat or PlainChat (safe literal user/automatic input),
  while `StepView` uses Code for command/arguments/output and Chat for Markdown notes.
  Fenced/preformatted code uses the selected code size/family. Inline code uses the same
  committed code family through Kit's existing typography projection, retaining its native
  proportional chat size. No parser, selection entity, Unicode source or motion policy is
  replaced. Font changes remeasure existing virtual rows with the item-anchor API.
- Unset sizes/families preserve the original default render metrics. No app base-font/rem
  reset, composer change, daemon request, font installation or system-setting write occurs.

## Focused verification

Run from `apps/desktop`, using the existing serial shared slot and CPU2/4GiB Cargo wrapper:

```sh
python3 scripts/check-scoped.py --test settings_state --native-probes --lint
python3 scripts/check-scoped.py --unit settings_ --native-probes --lint
PILOT_NEXT_FONTS_DIR=/tmp/fresh-font-captures \
  python3 scripts/check-scoped.py --test fonts --native-probes --lint
```

The 20 pure preference/store tests include legacy load, font bounds, roundtrip, font-only
defaults, invalid-file preservation and exact uncertain-font retry with newer edits.
The 6 Settings owner/worker tests retain generation fencing, nonblocking errors, restart,
storage conflicts and no implicit preference writes. The focused native target mounts real
Settings, transcript and tool views in offscreen 680-light/1100-dark windows over private
synthetic state. It exercises native family-menu keyboard selection and size buttons,
preview-only staging, durable Save/reopen, increased real prose/code/user/tool metrics,
Unicode selection/copy, restored exact default heights, unavailable-font disclosure without
rewriting saved values, and a 64-row virtualized reading anchor through font remeasurement.
Theme/chrome and reduced-motion policy remain unchanged. The native target is registered in
the existing broader macOS CI/check gates; those full gates are not routine local checks.

These are real headless GPUI renders, not SwiftUI mockups. Static captures do not establish
visible animation smoothness, OS IME/AX acceptance or Linux/Wayland support. No live Local
mutation, Swift build, full desktop suite or benchmark is part of these checks.
