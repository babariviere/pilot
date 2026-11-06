# Desktop untangle decisions

Scope: private desktop helpers only. Keep UI behavior, user copy, public APIs,
wire fields and storage names unchanged.

- Move ECMAScript trimming and display truncation into a private text module.
  Share the whitespace predicate with chat rename to avoid per-character allocation.
  Keep FEFF removal, U+0085 preservation, UTF-16 validation order, UTF-8 boundaries,
  ellipsis bytes and the existing small-cap truncation quirk.
- Share streaming JSON response mechanics for mission creation, task creation and
  updates. Keep each feature's byte limit and exact error strings in its wrapper.
  Keep admission, status handling, ACK checks and one-shot POST ownership separate.
- Share the close-on-drop receiver guard. Keep its scope inside each worker,
  including initialization failures and unwinding. Do not merge reader loops,
  cancellation, request replacement or generation fences.
- Clarify private title-limit and frozen-operation reader names. Change no user copy.

Kept exceptions: whole mission-detail reads have no byte ceiling. Submission and
outcome state machines remain feature-owned. Pending and Unknown attempts stay
non-replayable. Stable element IDs and GPUI subscriptions, focus and entity
lifetimes do not change. No UI redesign or native visual artifact is needed.

Verification: characterize text quirks, response error categories and limits, and
channel closure with another receiver alive. Run the affected library suites via
`apps/desktop/scripts/cargo.sh`; use native probes only if interaction ownership
changes. Build and long test execution are delegated to the parent agent.

## Verification results

- The first library test compilation failed because `provider_usage_tests.rs`
  inherited a module import removed from its parent. The fixture now imports
  `crate::local_model` explicitly. The new response test also limits the entire
  client/server exchange to five seconds.
- The parent rerun passed 396 tests, with 1050 tests outside the selection skipped,
  in 9.403 seconds after compilation. Nextest run ID:
  `39060228-c389-4187-abd7-645cf4951f34`. Result log:
  `8e82bf94-fe43-4847-8b06-077a728a8508.log`.
- The selected suites include `knowledge_tests` and `mcp_status_tests`; their
  reader-module names alone do not select those tests. Reproduce from
  `apps/desktop` with the expression below. The log records the result, not the
  invocation; this expression records the parent's selected suites.

```sh
bash scripts/cargo.sh nextest run --locked --lib --no-tests=fail \
  -E 'test(text::) | test(response_json::) | test(close_on_drop::) | test(mission_) | test(chat_rename) | test(queued_message) | test(scoped_models) | test(jump) | test(session_jobs) | test(github_event) | test(knowledge_reader) | test(mcp_status_reader) | test(project_memory) | test(provider_usage) | test(scheduled_messages) | test(session_file_view) | test(usage_overview) | test(insights_settings) | test(task_edit) | test(local_model) | test(knowledge_tests) | test(mcp_status_tests)'
```

Leaf formatting, diff whitespace checks and the standalone text characterization
passed. The latter checked every Unicode scalar and eleven truncation cases.
The first `bash scripts/cargo.sh clippy --locked --lib --tests -- -D warnings`
failed. It found the new response test's unchecked read amount and existing test
and default-feature fixture issues. The response fixture now reads complete HTTP
headers in a 4096-byte loop, handles partial reads and EOF, and keeps the five-second
exchange deadline. Existing restore assertions avoid a clone and a redundant
lookup; automatic-delivery tests end their mutex guard scopes before awaiting.

Call-site review confirmed that the three Insights readiness helpers, mission
fixture respond/hold/release methods, knowledge pin fixture, Slack fixture restart,
and automation fixture Conflict variant are used only by native probes. They now
use the same `native-probes` feature gate as their callers. No native coverage or
lint suppression was added or removed. The root module ordering was leaf-formatted
with child traversal disabled.

The final nextest rerun added chat-action, automatic delivery and automation-hook tests. It passed
447 tests, with 999 outside the selection, in 9.066 seconds after compilation. The final expression
adds `test(chat_actions) | test(interaction::tests::automatic) | test(automation_hooks)` to the
selection above. Result log: `56999bc6-ac73-4f66-b9d6-ceb17d6ca52b.log`.

Default library/test clippy and native-probe library clippy run with `--locked` and `-D warnings`.
Both passed after the fixes. Formatting and whitespace checks also passed. No native visual
acceptance or live-daemon workflow was run or claimed.
