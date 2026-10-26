# Exact chat-row action qualification

Scoped source for native Local Archive/Restore and the existing confirmed
chat-to-mission flow. No real daemon action, production app restart, Swift
change, backend change or broader parity/acceptance claim.

## Source and authority

The complete audited contract and bounds are in `../docs/chat-actions.md`.
Swift sidebar/archive/mission actions and the actual daemon handlers were read,
not inferred from labels. Archive ACK is HTTP 200 with exact identity/state,
not file/directory-fsync durability: this existing route uses `save`'s default
`durable=false`. Archive clears MCP attention and may fail removing scratch
after save. Every ambiguous post-dispatch outcome stays Unknown; no automatic
retry or GET/WS receipt inference. No implicit Stop/delete/draft discard or
mission membership move.

Source was composed first onto `cd1806580b750560e1bf50010181772cb17bfb0c`,
preserving its draft-discard implementation byte-for-byte. It was then composed
onto `1b50dba776543f1727d7e1fbf9ec0b0bb960ec16`. That upstream delta changes
six non-desktop watch-notice/read-isolation files only. All 774 inputs recorded
by the final focused Rust/native run remained byte-identical after composition,
before this documentation-only evidence update. No runtime tests were blindly
transferred across different desktop bytes.

A final remote advance was caught before any bookmark move/push. The feature
was then composed onto `c79e8c9bbc2778721efe564d427972c8343b07dc`, preserving
`227dd5527a1df8cadaa41856f1fbe4acdf775e0e` (PR follow-up policy) and the later
kernel direct-delivery policy correction. Those deltas change no desktop input,
archive/restore route, conversion guard or storage contract used here. The
complete frozen desktop/runtime/test input map remains exact; only this evidence
and the documented `docs/chat-actions.md` update differ from the run receipt.

## Change to checks

| Change | Relevant check |
| --- | --- |
| Canonical host/home/endpoint/session/project targeting and metadata stamp | Policy/faux tests, including case-sensitive IDs, stale title/cwd/state/permission/timestamp, malformed/capped metadata and wrong hello identity |
| One empty-body archive/restore POST | Faux HTTP method/path/body, no implicit mutation, post-commit error/lost/wrong ACK, later readback without replay/settlement, late completion |
| Production row/More and original-source MissionForm seam | Actual mounted GPUI 680/1100 light/dark, right-click unselected, Tab to real button/Return, Escape, reorder/offline refusal, marked input before blur, Archive/Restore and Cancel/confirm |
| Preserved selected working conversation and private delivery | Same editor/transcript/draft/reader/Stop, plus a real private Unknown envelope serialized identically after other-row actions and writer flush |
| Pre-ACK inspection fence | Deliberate red assertion, then exact known-ACK-at-GET-admission token; pre-ACK/old-operation/foreign-home/Unknown refused |
| Closed pending conversion ownership | Deliberate red assertion, then exact target/request completion while closed without title/focus change; real delayed 201, closed sheet and blocked other-row/header retarget |
| Selected idle archive permission | One actual production-row journey: pending -> ACK before WS remains read-only -> Restore with received permission -> lost ACK/Unknown; same draft/editor/reader and no send/Stop/open |
| Native registrations | Own target in Cargo/check/CI, two fake-tool registry contracts under PATH Bash and system Bash 3.2 |

## Actual receipts

Private receipts are under `/tmp/chat180-*`, retained rather than overwritten.
These paths describe this author run, not files required at runtime.

- `pass1`: initial compile failure (own imports); original 272 source inputs
  unchanged. Initial patch preparation added 496 generated `.patched` inputs,
  correctly reported as a PRE/POST mismatch, not retrospectively green.
- `pass2`: seven policy/faux tests and lint passed; native fixture wrongly
  assumed Return on the wrapper restored by Escape activates the real Button.
  Corrected to the actual Tab-to-Button/Return contract.
- `pass3`: eight policy/faux tests passed; native selector was ambiguous with
  the existing header's same label. Scoped every menu query to `popup-menu`.
- `pass4`: core four native layout journeys ran; final extra assertion assumed
  a Kit MenuItem AX-disabled bit that its source does not emit. Replaced it with
  real disabled pointer/keyboard no-POST/no-form proof, not a Kit patch.
- `pass5`, `pass6`, `pass7`, `pass8`: actual EXIT0 focused batches, eight units
  (zero ignored), production lib/native Clippy, four layout journeys; later
  batches include private pending-envelope preservation. `pass8` additionally
  proves closed pending conversion cannot be replaced before its delayed ACK.
- `red9`: actual assertion failures for stale pre-ACK inspection releasing the
  editor fence and closed-form completion latching busy. Eight other tests
  passed; all 773 PRE/POST inputs unchanged. Not compile/timeout failures.
- `green10`: actual EXIT0, ten units (zero ignored), matching lib/native Clippy,
  only two selected native journeys: wide-light delayed conversion and selected
  idle archive/restore/Unknown. All 774 PRE/POST inputs unchanged. Normal shared
  slot waited 329 seconds; no bypass, duplicate suite or frozen-source edit.

Final relevant command:

```sh
PILOT_NEXT_CHAT_ACTIONS_CASE=review PILOT_NEXT_CHAT_ACTIONS_DIR=/tmp/chat180-native10 \
  python3 scripts/check-scoped.py --unit chat_actions --test chat_actions --lint
```

The full four-layout matrix and private-envelope scene are reused from `pass8`,
not claimed to have been rerun by `green10`. The changed old-inspection and
closed-completion paths have their own red/green units and selected native
coverage; unchanged row geometry/styles have actual offscreen captures in
`/tmp/chat180-native8`. Final selected captures are in `/tmp/chat180-native10`.
These are real GPUI synthetic pixels, not SwiftUI mocks. Native theme and root
viewport bounds were asserted, not guessed from a pre-window theme request.

No full desktop/all-native/all-target sweep, Swift test/build, performance
profiling, remote-CI polling or live create/archive/restore/send/Stop occurred.
No new motion or claimed speedup. OS IME, visible smoothness, dedicated AX,
release acceptance and Wayland remain unqualified. The remaining Swift menu
actions have a separate source-backed checklist, not enabled placeholders.
