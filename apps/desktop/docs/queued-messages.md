# Queued user messages

The chat header's contextual **Queued (n)** opens a focused native popup. It
lists only `queue_update.items`, never automatic input or held-system controls.
The main composer, transcript, selection and Stop remain mounted. A captured
message has its own retained native textarea, delivery selection and receipt.
Save preserves its delivery mode unless the user explicitly selects another.
Remove requires a second confirmation. Empty text never means Remove or Send.

## Safety contract

- Hello must match the pinned Local daemon and lineage and advertise
  `guardedQueue`. Missing support means no write and no legacy fallback.
- A worker-generated opaque SHA-256 precondition covers the exact submission
  ID, mode and full payload. The kernel checks it inside the same transaction
  that serializes consumption, editing and removal. This is a captured-row
  equality precondition, not a monotonic revision, authorization or replay key.
- The route also checks the requested daemon/lineage. The response echoes that
  guard, operation ID, exact session/submission and action only after the worker
  and session metadata save complete. The client accepts only that exact ACK.
  This is an acknowledgment, not a new fsync/durability guarantee.
- Guarded edits use literal captured queue text, already expanded at original
  admission. They do not invoke native input extensions again before checking
  a stale capture. Legacy unguarded behavior is unchanged.
- A row consumed, removed or changed since capture is never re-submitted as a
  new send. A stream/GET equality match cannot settle a lost response. Pending,
  acknowledged and uncertain operations cannot be replayed from the form.
- Structured/image-bearing or oversized content remains intact and cannot be
  edited as text. Exact removal remains possible. Text edits cap at64KiB; queue
  projection caps at128 rows/512KiB; receipts cap at4KiB. Over-limit or malformed
  queue snapshots disable mutation, never silently truncate an editable payload.

Drafts and receipts are retained without lifetime message/chat count limits in
this window, not across app restart. Close does not cancel an admitted operation.
Completion updates only its immutable operation, without reopening or taking
focus. Preedit is guarded before blur and across internal pointer actions;
plain Return remains text, Command-Return explicitly saves, Escape closes only
outside composition. No global delivery or keyboard defaults change.

## In the conversation

A sent message appears at the end of the conversation at once, never only after
the agent consumes it. Each stage uses the owner that already holds it:

- **Sending…**: Return/Send hands an ordinary chat message to the conversation
  ([chat_sending.rs](../src/chat_sending.rs)). The composer shows an empty editor
  while that exact draft revision is in flight or reserved; the durable draft keeps
  the text until Local accepts it. Refusal before reservation or a rejected receipt
  returns the exact text to the composer. An unknown outcome stays in the
  conversation as **Not confirmed**, with the composer's existing Resolve actions;
  a known acknowledgment whose receipt was not saved reads Sent/Sending/Not sent.
  Typing during delivery edits only the composer. Stop, new-chat creation and
  question replies keep their existing composer behavior.
- **Queued / Queued to steer**: every `queue_update.items` row is shown after
  history ([local_model.rs](../src/local_model.rs)), keyed by its submission ID, so
  edits keep the row. Automatic input is not shown here.
- **History**: the committed user entry replaces the queued row.

The Local wire has no operation or submission ID on queue rows or history entries,
so reconciliation is presentation only and never settles a delivery. The sending
row hides once a queue row or user entry newer than when it first showed has the
same exact text ([submit_visibility.rs](../src/submit_visibility.rs)). The queue and
history arrive on separate streams: a history entry that arrives first hides its
queued row (exact content, oldest first) until the queue update; a row that leaves
the queue first stays until its history entry, a run end, or 250 ms. A removed or
withdrawn row can therefore linger that long. Appending these rows follows the
existing tail behavior and never moves a reader who scrolled into older history.

Checks: `local_model::queued_rows_tests`, `chat_editor::sending`,
`submit_visibility` and the `queued_message` native target, which drives real
Return in the production root through Sending, reservation, queue echo before and
after the ACK, both stream orders, lost ACK, refusal, older-history reading and
navigation at 680/1100 light/dark.

## Audit and verification

Swift `QueuedMessageEditor`, `QueuedMessageEditing` and `ComposerState` separate
queue drafts from the main draft but use ID-only availability, text replacement
and steer/follow-up submission shortcuts. They are not a safety precedent for
the popup. Existing server queue routes serialize disappearance correctly but
had no captured-row precondition; the opt-in guard preserves legacy callers.
Session metadata persistence/errors can follow the kernel mutation, so all
post-dispatch failures remain Unknown, not automatically retryable.

Scoped checks: `queued_message` library state/transport filter and native target,
kernel `queue-guard.test.ts` plus existing queue tests, queue-only server route
tests, TypeScript typecheck and matching changed-source lint. Native checks use
the actual production popup/root in680/1100 light/dark, synthetic HTTP only,
including preedit-beforeblur, retained main draft, default mode, missing capture,
explicit removal and exact late ACK. Offscreen captures are not OS IME, native
GPU smoothness, live daemon writes, Linux or product acceptance evidence.
