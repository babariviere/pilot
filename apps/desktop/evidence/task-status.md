# Exact task status confirmation

Synthetic-only scoped verification on macOS arm64. No production Local writes,
agent starts, profile installs, release or default switch were tested.

## Change → check

- Immutable exact Local home/mission/task/status intent and bounded single-PATCH
  transport → `--unit task_status` (6 passing tests). Covers foreign home,
  stale task, all mission lifecycles with an assigned chat, status-only payload,
  wrong/missing/error/redirect ACK and no replay, stored phase-gated status,
  backward-rank warning and operation/late-result identity fences.
- TaskPane detail action and retained confirmation → `--test task_status` (2
  passing real mounted Browser cases, 680 light and 1100 dark). Choice/Enter
  do not submit, explicit pointer confirmation sends exactly one request,
  Close/Escape restore mounted task focus, navigation retains exact choices,
  late ACK/Unknown stay with the captured operation, matching refresh cannot
  settle Unknown, and acknowledged refreshed data supports an explicit new
  intent. The 680 case verifies a real sibling textarea's marked input stays
  focused/composing when the status entry is clicked, before blur.
- The same production/native selection passes Clippy `-D warnings`, with the
  shared slot, existing CPU2/4GiB admission and private worktree outputs:

  ```sh
  PILOT_NEXT_TASK_STATUS_DIR=/tmp/task-status-final-captures \
    python3 scripts/check-scoped.py --unit task_status --test task_status \
      --lint --report /tmp/task-status-phase-ime.json
  ```

  Observed command times: Clippy 2.55s; test invocation 19.51s, including
  compilation/link/Cargo. These are not runtime performance measurements.
  All 238 source/test/script/manifest/lock inputs were identical before/after.
- Registry integration → 46 Python CI wrapper tests and 21 scoped-wrapper
  tests pass; edited Rust rustfmt and diff whitespace checks pass. The native
  registry also retains `chat_rename`, which was present in the inherited
  manifest but missing from its CI execution list. No target is removed.

## Receipts and limits

`/tmp/task-status-phase-ime.json` is the final scoped wrapper result;
`/tmp/task-status-verified-inputs.json` records its frozen source digests.
Earlier bootstrap/catalog-fixture failures and their logs were retained;
bootstrap and the fixture were corrected, not suppressed. No full Rust/Swift
or native sweep ran. CI remains broad.

The attached screenshots are actual offscreen GPUI renders with synthetic
content, not SwiftUI mockups, OS pointer/motion qualification or full parity
acceptance. Light/dark hierarchy, readable effect warnings and form bounds
were inspected. The seven contextual status choices use existing shared
buttons; only the final explicit change is primary.

See [task-status authority audit](../docs/task-status.md). Existing status
effects are disclosed, not removed: delegation metadata clears, backward
moves permanently opt out of PR sync, phases/managed progress reconcile and
notices may resume the existing coordinator. The endpoint has no conditional
write/no-wake option. Read preflight does not establish atomic safety, and
HTTP200 is an operation ACK, not a crash-durability receipt.
