# Explicit user-authored mission update

Synthetic-only verification on macOS arm64. No production Local mutations,
agent starts, backend edits, service installation or release/default switch.

## Change → check

- Immutable pinned home/mission/text intent, ECMAScript trim/UTF-16 limits,
  exact operation completion and single-POST transport → `--unit mission_update`:
  8 passing state/transport tests. Valid201, foreign home/absent canonical source,
  error-status/redirect/lost/malformed/oversized/wrong-source ACK cases,
  no replay and explicit pre-send retry are covered. Payload is exactly
  `{text, kind:"update"}`; no actor/session/health/handoff fields are sent.
- Production Browser/activity form → `--test mission_update`: four actual native
  scenes (680/1100, light/dark), plus one mounted LocalViewer Root journey.
  Tests exercise native clipboard/Unicode/cap rejection, ordinary Enter versus
  explicit pointer/Cmd-Enter, marked-text caret and sibling pre-blur guards,
  root navigation/palette/settings/project guards, per-source draft retention,
  duplicate-submit fencing, hidden exact ACK/Close, explicit confirmed new
  update, Unknown/reopen/no retry, matching timeline Refresh without settlement,
  Copy text and mounted activity focus restoration.
- Matching production/native Clippy `-D warnings` passes. The existing shared
  verification slot, CPU2/4GiB admission and private target/incremental outputs
  were used. No profile, pin, shared cache policy or release behavior changed.

  ```sh
  python3 scripts/check-scoped.py --unit mission_update --test mission_update \
    --native-probes --lint --report /tmp/pilot-update-183/fourth.json
  # After two view-handler fixes and the stronger matching-refresh assertion:
  python3 scripts/check-scoped.py --test mission_update --native-probes --lint \
    --report /tmp/pilot-update-183/final.json
  ```

  The pure/transport files are byte-identical to the eight-test passing run.
  Final Clippy observed7.42s and native test invocation35.22s, including
  compilation/link/Cargo; these are not runtime performance measurements.
  All1955 tracked file digests stayed identical across each passing frozen run.
- Registry integration: 46 CI-wrapper and21 scoped-wrapper Python tests pass.
  Edited Rust files pass rustfmt; edited shell syntax and diff whitespace pass.
  The inherited `lib.rs` has unrelated baseline formatting differences in
  task-status/fonts blocks; these were not rewritten. New registry additions
  preserve all existing targets, creation/forms and additive marked guards.

## Receipts and limits

Private `/tmp/pilot-update-183/{fourth,final}.json` hold successful wrapper
receipts, with corresponding `*-pre.json`/`*-post.json` full tracked-file digest
sets. Earlier failed compilation/lint receipts are retained, not suppressed.
Final source differs from the last passing run only by README/evidence text.
No routine full Rust/Swift/native sweep or live send/create/update test ran.
Broad CI registration remains intact.

Attached images are actual offscreen synthetic GPUI renders, not SwiftUI
mockups, native OS IME/pointer qualification, motion/performance proof or full
parity acceptance. Light/dark bounds, retained text, contextual recovery and
the unchanged user-or-system timeline attribution were visually inspected.
No new hot-path clocks, polling, decoding or transcript updates are introduced.

See [authority and delivery audit](../docs/mission-update.md). The current
server holds mutation response completion behind `store.durable()`, but event
JSON has no independent fsync receipt. A complete valid201 acknowledges the
specific request; an event seen by GET never settles a missing ACK. Memory-only
forms retain drafts/receipts through navigation, not process restart.
