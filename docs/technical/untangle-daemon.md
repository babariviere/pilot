# Daemon untangling decisions

## Scoped fixes

- `source-mcp.ts` mixes pure tool rules and error classes with worker creation and sign-in.
  Move rules to `source-tool-rules.ts`; workers and Slack helpers import their owner directly.
- `project-origin.ts` imports pure GitHub parsing through the GraphQL/subprocess module.
  Move parsers and their repository type to `github-url.ts`; remove forwarding exports.
- Slack user, channel and timestamp regexes repeat in reaction ownership, start and tool rules.
  Share exact syntax predicates in `slack-reaction-owner.ts`, not provenance decisions.
- Ask recovery tests accept either mode for every corruption and serialize summaries to read mode.
  Assert each corruption's exact recovered mode directly.

## Kept exceptions

- Keep merge-target and linked-PR policies separate: enterprise hosts and port rules differ.
- Keep identifier maximums, authenticated-profile provenance, fixed reaction arguments,
  error class identity, bounded decoding and structured-only `no_reaction` handling.
- Keep authorization checks around asynchronous reads, durable-before-ACK behavior,
  lost-reply receipt reuse and inactive execution-boundary tests.
- No persisted or wire schema changes. No new execution architecture.
- Backpressure and server changes belong to the parent. The only change here to
  `mission-service.ts` is its GitHub parser import.

## Verification

Run focused Node tests with inherited `PILOT_*` variables removed. Cover source rules,
Slack ownership/start/removal, sign-in workers, GitHub parsing/discovery/merge,
project navigation and Ask recovery. The parent runs typechecking.

Focused verification passed: 212 distinct tests across 15 files, with two files
at a time and inherited `PILOT_*` variables removed. This includes Slack reaction
and managed Linear synchronization, plus PR sync and delivery consumers.
The parser extraction is byte-equivalent. Comparing the extracted source rules
shows only substitutions of the shared identifier predicates.

### Exact focused test evidence

Counts include nested tests. Every listed test passed, with no failures, skips or
cancellations. `github-url.test.ts` ran twice (two extra passing executions).

| Tested file | Distinct passing tests |
| --- | ---: |
| `packages/daemon/src/slack-reaction-owner.test.ts` | 2 |
| `packages/daemon/src/github-url.test.ts` | 2 |
| `packages/daemon/src/source-mcp.test.ts` | 8 |
| `packages/daemon/src/slack-removal-route.test.ts` | 4 |
| `packages/daemon/src/ask-sessions.test.ts` | 10 |
| `packages/daemon/src/slack-start.test.ts` | 10 |
| `packages/daemon/src/github.test.ts` | 16 |
| `packages/daemon/src/pull-requests.test.ts` | 28 |
| `packages/daemon/src/project-origin.test.ts` | 4 |
| `packages/daemon/src/pull-request-merge.test.ts` | 9 |
| `packages/daemon/src/source-sign-in-worker.test.ts` | 1 |
| `packages/daemon/src/slack-reactions.test.ts` | 19 |
| `packages/daemon/src/mission-linear-sync.test.ts` | 48 |
| `packages/daemon/src/pull-request-sync.test.ts` | 22 |
| `packages/daemon/src/github-delivery.test.ts` | 29 |
| **Total** | **212** |

Each batch used `node --test --test-force-exit --test-concurrency=2`, with all
inherited `PILOT_*` variables removed. To reproduce the complete distinct set:

```sh
python3 - <<'PY'
import os
import subprocess

files = [
    "slack-reaction-owner.test.ts", "github-url.test.ts",
    "source-mcp.test.ts", "slack-removal-route.test.ts",
    "ask-sessions.test.ts", "slack-start.test.ts",
    "github.test.ts", "pull-requests.test.ts",
    "project-origin.test.ts", "pull-request-merge.test.ts",
    "source-sign-in-worker.test.ts", "slack-reactions.test.ts",
    "mission-linear-sync.test.ts", "pull-request-sync.test.ts",
    "github-delivery.test.ts",
]
env = {key: value for key, value in os.environ.items() if not key.startswith("PILOT_")}
for offset in range(0, len(files), 2):
    subprocess.run(
        ["node", "--test", "--test-force-exit", "--test-concurrency=2",
         *("packages/daemon/src/" + name for name in files[offset:offset + 2])],
        env=env, check=True, timeout=180,
    )
PY
```
