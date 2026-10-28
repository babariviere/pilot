# Synthetic draft and operation retention qualification

This is a regression-test qualification, not full daily-use or OS lifecycle
acceptance. No production implementation changes were needed. All disk state is
in UUID-named temporary directories; HTTP uses the existing faux loopback daemon.
No real profile, running app or daemon is read, restarted, installed or signalled.

## Dedicated coverage

`src/interaction_retention_tests.rs` reuses the existing courier/store fixtures:

- Twelve restart cases: new-chat/existing-chat operations, daemon Pending,
  lost accepted response, or lost request before admission, each ending through
  explicit Close or ordinary sender disconnection.
- Before exit, enqueue newer Unicode text, another owner's draft and a stale
  same-owner navigation capture. On restart assert exact operation retention,
  revision 3/newer text and independent other-owner text.
- Process a local checkpoint after restart and compare the entire faux HTTP
  request log. Startup and checkpoint must perform no lookup, resend or create.
- Only an explicit Check/Retry proceeds: Pending and accepted receipts do not
  execute again; missing admission retries the byte-identical serialized envelope
  (ID, destination, target, payload and hash), with one daemon execution.
  Late acceptance must leave newer and other-owner drafts intact.
- Inject a failed newer autosave: both unsaved drafts remain in the mailbox,
  the writer is faulted, settlement returns an error, and disk bytes remain the
  previous committed snapshot. Reopening restores only committed text plus the
  original operation, never claims the unsaved edits survived.
- Inject failed late-acceptance persistence after newer text is durable:
  reopening retains that text and the unresolved exact operation, not a false
  created-chat receipt. Subsequent successful local adoption preserves newer text.

Existing courier/store tests additionally exercise failed Close without a false
flush acknowledgment, disconnection after failed writes, missing/corrupt/foreign
state, private file ownership, stale revisions, uncertain Stop, and exact question
reply retention. Existing mounted navigation/new-chat probes cover native input
retention across page changes. The dedicated courier test's owner changes model
draft mailbox traffic, not actual native navigation.

## Reproduction and limits

Use the pinned wrapper/shared verification slot:

```sh
python3 apps/desktop/scripts/check-scoped.py --unit interaction::tests --native-probes --lint
python3 apps/desktop/scripts/check-scoped.py --unit delivery_store::tests --native-probes
python3 apps/desktop/scripts/check-scoped.py --test navigation --test new_chat_view
```

The unit commands compile the application library/harness, not a standalone
storage mock. Native probes are synthetic/offscreen, not OS window interaction.
No design or recovery UI is changed here; delivery diagnostics remain separately
owned.

Observed on macOS arm64: 34 courier tests passed (one opt-in workload ignored),
36 store tests passed (two opt-in workloads ignored), selected library Clippy
passed with warnings denied, and both native executables exited successfully.
Navigation emitted eight assertion records spanning 680/1100pt, light/dark and
canonical-reader checks; new-chat runs its assertions without summary output.
The pinned compiler built the selected harnesses and visual helper. The existing
`block 0.1.6` future-incompatibility warning remains. This is not an all-target
Clippy or release-build claim.

Restart here means releasing the courier/store and reopening from its real
temporary snapshot. It does not kill/relaunch an OS application. It does not
qualify Dock Quit, force-quit, crash/power loss at fsync/rename boundaries, disk
full/physical device failures, sleep/wake, real transport outages, Linux native
behavior, or real provider delivery. Injected write failure occurs before the
atomic writer, not at every filesystem crash boundary. Unsaved edits can be lost
on force-quit; successful committed operation retention is not an exactly-once
execution claim for arbitrary server behavior.
