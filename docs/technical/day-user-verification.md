# Explicit user verification of delivered work

Backend/native-host contract only. Native Today controls are separate work.
Verification records an explicit user's assessment. It is not coordinator task
status, agent completion, review judgement, workflow `accept-outcome` delegation,
PR merge, release detection, or permission to execute more work.

## Canonical sources

`MissionStore.completion()` reads the existing immutable `task_completions`
commit/checks/issues. Those legacy records validate commit format, not actual
landing or successful checks. `nonCodeDelivery()` reads existing immutable
`task_non_code_deliveries` with pinned brief/artifact references, checks and
limitations. Neither is invented from task Done or an agent report.

The indexed `taskOutputs()` reads only that task's saved PR resources and
artifact links, including last-observed PR state and `mergedAt`. It performs no
GitHub refresh, release lookup, source sync, or external write. Unpinned artifact
links remain unpinned, not silently promoted to a verified revision. The latest
canonical evidence submission ID also participates in delivery currentness;
its claim/limitations/evidence references are included as agent claims, while
coordinator evidence judgements remain separate. Standalone chats use their
current saved Done outcome/time/reason and input generation, not mission tasks
or ordinary questions. `session-outcomes.ts` makes `outcomeAt` a monotonic
per-chat outcome version across worker clocks, failures and conversation attempts;
it is not treated as a merely unique wall-clock timestamp.

`user_verifications` adds immutable assessment revisions in the same canonical
`missions.sqlite`, using its transactions and off-thread durable writer.
`user_verification_intents` keeps exact operation reservations and domain
receipts. These are app-owned records, not a hidden mission, new task status or
copies of the underlying deliveries. The receipt store refuses above 16,384
operations rather than dropping history.

## Authenticated, passive reads

Both routes require the existing `x-pilot-github-capability` native capability
and return `Cache-Control: no-store`:

* `GET /api/projects/:projectId/missions/:missionId/tasks/:taskId/delivered-work`
* `GET /api/projects/:projectId/chats/:sessionId/delivered-work`

The task route checks exact project/mission/task scope. The chat route requires
a standalone chat in that project, not a mission worker or coordinator.
`DeliveredWork` in `packages/protocol/src/user-verification.ts` is the complete
typed read model. Important fields:

* `targetId` is the opaque journal target. Use it unchanged.
* `deliveryId` is an opaque digest of the exact subject, owner, delivery records,
  task definition, evidence submission and linked artifact pins/PR identities.
  Null means no canonical delivery. Task status and changing PR tracking state
  do not change delivery identity. Production is always `not_tracked`.
* `verificationRevision` is the latest saved assessment revision, starting at 0.
* `verification` is the latest historical assessment, even if stale.
  `verificationCurrent` requires both the same delivery and a matching accepted
  outer/domain receipt. A prior delivery's Done never accepts a newer delivery.
* `verificationReceiptState` is `accepted` only when both receipts agree.
  `pendingOperationId` blocks further assessment while an entered outcome is
  uncertain. Do not display success from the domain row alone.

Reads cross durability barriers and recheck live scope after receipt I/O.
They never mark a result checked, subscribe/start a worker, or reconcile by
repeating an effect.

## Explicit operations

Use the existing version-1 `DurableOperation` envelope and native capability
with `POST /api/operations`. Save the exact envelope in the native journal before
sending. Kind is `user-verification`, `targetId` comes from the read model,
`bindingId` is `deliveryId`, and `bindingGeneration` is 1. Origin must be this
daemon lineage with `hostId: "local"`. Payload fields are exactly:

```json
{
  "purpose": "user-verification",
  "subject": {"kind":"task","projectId":"p","missionId":"m","taskId":"t"},
  "deliveryId": "<opaque digest from read>",
  "expectedRevision": 0,
  "action": "done",
  "note": ""
}
```

For standalone work the subject is `{kind:"chat",projectId,sessionId}`.
Actions are `done`, `send_back`, and `reopen`. Send back requires a nonblank
note, at most 8,000 UTF-8 bytes. Other actions require an empty note. Notes keep
their exact bytes. Done saves `done`; Send back saves `sent_back`; Reopen saves
`open` as a new revision. Changing an assessment of the same delivery requires
Reopen first. A new delivery needs its new identity and the latest revision,
not an old assessment copied forward. CAS and a pending subject reservation
serialize competing commands.

Send back reserves durably before passing the exact note and operation ID to
`SessionManager.sendDurable(..., "followUp", ...)`. Its normal message admission
owns all execution, permissions, lifecycle and Stop behavior. A synchronous
delivery/owner/input-generation fence runs immediately before input admission,
after async waits. Archived, sleep/offline/subscription-held or mission-paused
owners are refused without restore/resume. The adapter does not call retry,
restart, continuation or task status changes. It does not grant approval,
spending, Linear/Slack, merge, deploy or release authority. Existing admission
may refuse a retired/otherwise unavailable owner; no substitute chat is chosen.

After durable ordinary-message admission acknowledges, the saved verification
includes `messageReceipt:{sessionId,requestId,state:"admitted"}`. This means the
note entered the durable message path, not that an agent read/fixed the result.

## Receipts, Unknown and reopen

Execution and `POST /api/operations/receipt` return `UserVerificationLookup`:
`{receipt,verificationReceipt}`. Check submits the original immutable operation
only to the receipt endpoint. It is lookup-only, including after daemon reopen.

For success, the host must check outer `accepted`, exact envelope identity,
operation ID/payload hash/target/destination, domain `accepted`, the matching
intent, and equality of outer `result` with domain `verification`. Send back
also needs its exact message receipt. A GET, task Done, merged PR, or domain row
without that matching outer receipt does not prove operation success.

Missing, pending, malformed or lost ACKs are Unknown and Check-only. Neither
recovery nor an exact repeated execute re-enters verification or message
admission. If the domain settled but outer receipt publication was lost, reads
also stay Unknown. A pending domain blocks new assessment operations for that
subject; a new operation ID is not recovery permission. This intentionally has
no automatic reset, resend, retarget or fabricated receipt. A stale delivery
cannot be changed by replaying an old Done/Send back. Historical exact receipts
can still be checked under current scope access.

## Verification

`user-verification.test.ts` covers revision CAS, Reopen, exact note bytes,
standalone outcome changes, new canonical deliveries, status/merge separation,
holds, concurrent commands, lost input/outer ACKs, restart persistence and
no replay. `user-verification-http.test.ts` uses an isolated daemon/home with
synthetic work and worker startup disabled. It exercises native capability
checks, canonical output reads, both receipts, durable ordinary-message outbox
admission and zero external calls. These are not visible native UI acceptance
or evidence that a real user checked any result.
