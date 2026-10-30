# One-time scheduled USER message creation: blocked contract

The existing API preserves message/session/epoch bytes and can acknowledge a
durably created row, but cannot fence creation to the daemon/lineage checked by
the client. Next therefore exposes **no creation action** in this slice. Settings
→ Scheduled messages remains the [passive roster](scheduled-messages.md).
No composer, attachment, draft, focus or default-action behavior changes.

## Exact blocker

`POST /api/schedules` accepts a `ScheduleRequest`: optional title, trigger and
epoch milliseconds, plus a message target containing only `sessionId` and
`message`. There is no expected daemon/lineage, expected project, target
generation or client attempt ID in this contract. The route calls
`ScheduleService.create` directly. It does not use the ordinary durable-operation
destination fence. `GET /api/hello` is a separate request, not a reservation.

The isolated HTTP test `schedules-create-contract.test.ts` demonstrates:

1. Hello and session preflight succeed through one fixed loopback URL for home A.
2. That endpoint is switched to synthetic home B before the POST. B has a
   different daemon, storage lineage and project but the same session ID/title.
3. The unchanged message request receives 201 and is committed in B, not A.
4. Postflight hello detects B, **after** its executable pending row exists.

A second fixture keeps the same project ID in B and switches the endpoint back
to A before postflight. Pre/post hello and the returned target/message/time/
project all match the capture, while only B contains the created row. Thus even
an exact-body ACK plus two matching hello reads cannot prove the receiving home.

Both backends use the real HTTP route and SQLite worker; a fixture gateway
deterministically represents endpoint rebinding. This is not a claim that real
session IDs normally collide or that a real daemon changed during this audit.
It proves that this endpoint does not enforce the captured home when it does.
`daemonId` is a data-home identity, not a process/boot identity; an ordinary
same-home restart alone does not imply this mismatch.

A native generation fence can prevent a stale form/result from changing the
visible chat. It cannot stop the replacement daemon from creating that row.
Another preflight only moves the gap. Postflight refusal/Unknown does not undo
creation; automatic DELETE would add an unapproved cancel action and can lose
to dispatch. A list match, title match or a guessed identity query/header cannot
provide the missing precondition. Do not add such client workarounds.

The existing `/api/operations` journal does check destination daemon/lineage,
but its admitted kinds do not include schedule creation. Sending a fabricated
schedule operation there would require new backend admission and recovery
semantics, not reuse of an existing contract.

**Required next decision:** narrowly authorize a mutation-time captured
daemon/lineage precondition for one-time message creation, enforced before any
schedule becomes executable. If captured project/generation is to be an atomic
condition, that too must be explicit server contract. Do not infer it from the
current API. No backend change, new receipt framework or scheduler-policy change
is implemented or authorized by this audit.

## What the existing contract actually guarantees

| Concern | Inspected behavior and consequence |
| --- | --- |
| Target | Exact `sessionId` lookup in the receiving daemon. Missing session is 404. Project is copied from that session, not supplied or compared with the client's captured project. Titles never target a chat. |
| Message | Nonempty after whitespace checking, but the stored message itself is not trimmed or normalized. Unicode, whitespace and newlines survive. Dispatch passes it to `sessions.send` as `followUp`, using `schedule:<server-generated-id>`; this prefix is USER input under `inputOrigin`. Existing send/admission policy still applies later. |
| Time | Explicit `trigger: "at"` requires safe-integer epoch milliseconds in 0…8.64e15. Omitted trigger defaults to `on_back`, so a future client must always send `at` explicitly. Past deadlines are accepted, not rejected. A time future at capture can be overdue on arrival. When started/online, the existing sweep treats `at <= now` as due. Offline/reachability can delay dispatch, so a chosen time is not an exact execution guarantee. |
| Limits | Serialized target ≤16 KiB, including JSON escaping and session ID, not just message length. Optional title is nonempty and ≤200 JavaScript UTF-16 units, then trimmed. Store limits are 1000 retained records and 4 MiB aggregate target payload. Native composer capacity is not the schedule payload limit. |
| Successful ACK | 201 contains the created `ScheduledItem` with server UUID, revision 1 and initial pending state. SQLite uses WAL and `synchronous=FULL`; worker insert resolves before cache/listener update and response. This acknowledges creation, not a future send or agent completion, nor necessarily the row's state when the response is displayed. |
| Errors | Validation and generic internal exceptions can both be HTTP 400. A synthetic listener failure after insertion produces 400 **with the row already committed**. Thus status alone is not a safe rejection classification. 404/503 exist, but no structured per-attempt no-effect receipt is returned. |
| Lost ACK | No client creation ID/idempotency contract, no receipt lookup. Equal requests receive different UUIDs; an idempotency header does not deduplicate. A matching later GET is an observation, never proof of this attempt. Never automatically retry or offer a blind retry after dispatch. |
| Side effects | Creation itself does not send synchronously. A started service observes store changes, queues a sweep and manages detection/timers; overdue work can dispatch independently of the HTTP response. Creating a row is therefore permission for automatic future work, not a passive save. |

Unknown remains usable as an honest outcome after transmission, but it does not
solve the pre-creation destination fence. Likewise, lack of idempotency alone is
**not** this blocker: an immutable retained attempt with no replay can represent
it truthfully. Do not claim that all HTTP errors mean nothing was scheduled.

## Historical and native surface audit

Swift `SendLaterMenu` separates scheduling from Send. Its `ScheduleSheet` uses a
local-calendar DatePicker, a suggested time and a client-side `date > Date()`
check, then reduces to minute-granularity epoch milliseconds. `ChatView.schedule`
clears the draft/attachments before POST and restores them on every thrown
error. That is historical behavior, not a safe lost-ACK model to copy. Its sheet
does not establish the missing server identity fence or explain ambiguous local
wall times.

Next's ordinary `ChatEditor`/`DeliveryOwner` capture immutable drafts and retain
uncertain sends; that durable-operation route has no schedule-create kind.
Settings' `ScheduledMessages` owner only reads the roster and exact details.
Do not turn entering a date, typing a message, changing chat/project, Return in
an ordinary editor or closing a form into scheduling.

Once the contract decision is resolved, the narrow UI still needs a separate
explicit confirmation naming the exact target and absolute future instant,
saying it **will send automatically**, with an unambiguous timezone/offset
(UTC is sufficient). Reject invalid/past instants before submission; surface the
existing overdue/offline behavior instead of promising exact-time execution.
Preserve the captured target/message/time through Pending, errors and Unknown;
never replace it with the newly selected chat or resolve it by list matching.
Refuse attachment scheduling explicitly before submission, never silently strip
attachments or adopt Swift attachment paths. Cron/repeat/edit/cancel, mission
workers and batch creation remain outside this slice.

## Verification and limits

`schedules-create-contract.test.ts` uses isolated temporary homes, real loopback
HTTP servers and real SQLite workers, faux sessions and an injected numeric
clock. It checks exact bytes/ACK, destination replacement after preflight, lost
ACK, missing idempotency, overdue acceptance, post-save error and validation
limits. **No scheduler is started, signalled or triggered.** Timer, detector,
reachability, send and spawn spies must stay untouched. A durable snapshot
SELECT verifies inserts; it is test evidence, never a client receipt substitute.

The existing passive roster tests/probes are unchanged. There is no new native
surface to exercise at 680/1100 light/dark, and no native creation/keyboard/IME
or real automatic-send qualification is claimed. Rust builds, native probes,
Swift builds and live data/provider/app/daemon/service/install/release actions
are unnecessary for this tests-and-documentation fallback and were not run.
