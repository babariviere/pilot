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
