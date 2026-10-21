# Message-local selection correction

Scope: existing fixture only, preserving A1, manual return-to-tail behavior,
Kit 0.8.0, baseline GPUI 0.3.9 and Rust 1.98.1. No fading, transport, production
UI/data changes, global tool configuration, registry/cache edits or publishing.

## Ownership and patch

The fixture already owns one retained TextViewState per stable message ID,
bounded by its 128-message limit. It now opts these states into message-local
selection retention. Native parsed inline/source byte ranges remain authoritative
across row recycling. No offscreen row is kept mounted or force-rendered.

`patches/gpui-base-0.8.0.json` adds an opt-in retention policy to the existing
selection participant. When a selected row leaves the frame, its weak identity
and detached metadata remain available for logical copy/clear, but geometry cannot take part
in hit testing. On remount, existing logical ranges are projected rather than
reselecting from stale window coordinates. A drag is confined to its starting
message. New clicks clear the previous range, including unmounted selections.

Published archive SHA-256:
`d5cd7de73d5b2d3d18b94a928abf343922091fa77bc472f77b7d2e7e8b1823a7`.
Exact preimages/counts are tracked. `scripts/prepare-patches.py` materializes
only into ignored `.patched/gpui-base-0.8.0`; the original archive and registry
remain unchanged. The normal Cargo wrapper verifies generated fingerprints.
`patches/README.md` documents provenance, ownership and reproduction.

## Reproductions and checks

Original/opt-out behavior failed
`selection_and_copy_survive_unmount_prepend_and_remount`: the window copy query
returned an empty string once its selected row unmounted. The opt-in patch
passes this case without altering the rich renderer or disabling virtualization.

Focused passing UI regressions exercise the production view and real Kit input:

- Actual drag selection, exact source ranges and actual clipboard copy before,
  while unmounted, and after remount/prepend.
- Unicode with accented characters, combining marks, flags, ZWJ emoji, modifiers
  and Hangul; source offsets remain valid UTF-8 boundaries.
- Assertions that the selected row's copy button is absent while unmounted.
- Another message streaming while the old selection is unmounted, with no
  adoption by a new message ID.
- Selection in the streaming message itself, subsequent source growth and
  later unmount with identical source range/clipboard content.
- Cross-row pointer drag remains in the original message, not a global range.
- Clicking the composer clears both the window query and all document ranges.
- A1 prepend/tail/reading-position and marked-text tests remain in the suite.

Actual clipboard output is compared with the same shortcut before recycling.
Kit's window-wide query serializer can add a paragraph newline while its
focused TextView Copy shortcut does not; these are checked separately rather
than silently changing formatting. Table TSV/list-prefix/source-format parity
is not claimed or redesigned by this correction.

Commands from the repository root:

```sh
bash apps/desktop/scripts/cargo.sh test --lib --locked selection -- --test-threads=1
bash apps/desktop/scripts/check.sh
bash apps/desktop/scripts/cargo.sh build --locked
```

The final strict run passed rustfmt, all-target Clippy `-D warnings`, all **15**
tests and native Metal offscreen rendering. The locked normal binary rebuild
also passed after the production selection change. Raw job logs remain session-local.

## Limits

No intrusive visible session was launched. Synthetic UI event tests and native
offscreen rendering do not establish real OS clipboard/IME/AX behavior or
scrolling smoothness. Real Wayland, three-viewport held drags, all copy formats,
large histories and giant-message scaling remain unvalidated. The existing
fixture's parser-state lifetime bound is unchanged, not promoted as a production
cache design. A source replacement invalidates parser ranges rather than
transferring selection to a different message; the fixture does not replace
message identities during streaming.

This local patch requires upstream review before live integration. No full
framework fork, selection-semantics expansion, parser/highlighting overhaul or
production migration is implied.
