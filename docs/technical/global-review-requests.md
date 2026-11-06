# Global optional Review requests

`ReviewRequests` is the authoritative source for **explicit optional suggestions** at exact retained
comparisons. It shares `missions.sqlite`, its transaction/replica/durability lane and retained readers
with human feedback. It is not an approval service. No required-request writer, required-check or
fresh-agent-review producer is installed. Production actionability is always `unknown`, never ready
because an item is pending. No provider, reviewer, automatic Inbox attention or gate is started.

Capture, browse, feedback, task completion and tier labels create no request. Existing missions and
chats are not adopted or backfilled. Unsupported/unretained targets cannot create a suggestion.
Retained content bytes stay in the existing snapshot store. Chat and mission are source provenance
and access context, not Review destinations or approval units.

## Explicit producers and authority

The coordinator-only `mission` actions `requestReview` and `retireReview` take a nested `request`.
The IPC supplies the actor, never a body field. Admission requires the **current** active same-project
coordinator and target member in the same active mission, plus current exact retained custody.
Retirement is limited to that original coordinator's own optional suggestion. A replacement
coordinator cannot retire another actor's suggestion. There is no inferred cancellation action.

The Local app may explicitly suggest an existing standalone or mission-origin comparison, withdraw,
snooze or resume attention. Purpose-specific HTTP actions require the existing native host-action
capability (`x-pilot-github-capability`, historical shared filename/header), not an ordinary REST
identity or agent-supplied actor. This is the existing practical app-workflow boundary, not verified
human presence, OS isolation or protection against hostile same-user processes. No native UI is
added here. Required/user-protected requests remain unsupported and untouched.

Suggestion (`requestReview`, or native `POST /api/review/requests/suggest`):

```ts
{
  operationId, target: ReviewDispositionTarget, title, reason,
  replacesRequestId: null | string,
  replacesExpectedRevision: null | number
}
```

The target is the existing exact project/session/snapshot/repository/change/base/head/layer/patch/
comparison digest. The host validates it through `NativeReviewReader.qualify()` and gets the exact
indexed `NativeReviewComparison`, including its original comparison sequence. Local app target
selection can use the existing capability-protected `POST /api/review-feedback/target`; selection
itself does not create a request. Coordinator callers must supply the same exact retained pins,
not an untrusted current-file path, whole-chat coverage or guessed task attribution.

Transition (`retireReview`, or native `POST /api/review/requests/{withdraw,snooze,resume}`):

```ts
{ operationId, requestId, expectedRevision, reason }
```

States are `pending|snoozed|withdrawn|retired|replaced`. Only pending/snoozed suggestions can
transition. Resume requires snoozed. Snoozing has no timer, default expiry or scheduler. Snoozed
work remains visible in global Review; it changes attention only. Withdrawal/retirement/replacement
never approve, resolve threads, waive a requirement or change a human disposition. No operation
can reactivate a terminal request. A genuinely new exact target needs a new explicit suggestion.

## Identity, history and recovery

Host-derived lineage binds actor origin, project, source session, repository, change and layer.
The exact target digest adds the snapshot, base/head, patch and comparison identity. The database
deduplicates `(lineage, target)`; distinct native/coordinator origins cannot borrow retirement rights.
Reusing a target with different suggestion content or original predecessor revision conflicts.
An explicit replacement must match
the actor's lineage and exact prior revision; it appends a new request and a replaced predecessor
revision atomically. A new base/head/layer never inherits an approval. A capture alone never replaces.

Original target, title, reason, revision and successor history remain in append-only request history.
The creator `actor` stays pinned; `changedBy` and `operationId` identify each explicit revision's action.
Current rows are an indexed projection. Each exact operation stores actor, canonical complete payload
and immutable effect receipt in the same transaction, not in a second generic approval journal.
An operation ID with another payload or actor conflicts. Concurrent exact calls deduplicate.

`GET /api/review/requests/operations/:operationId` is native-capability-only, lookup-only status.
It returns the **original effect** `{operationId,actor,payloadHash,requestId,revision,state,target}`, or
`{state:"unknown"}` when absent. Historical pending is not current pending or permission to send a
new action. Coordinator exact retries use the same `operationId` and complete payload through IPC;
they return their original receipt without reinstating a withdrawn, retired or replaced request.
There is no POST status workaround. A lost response is recovered by exact lookup/retry, not by
finding similar current state. Current actor/project/source authority is still required on recovery.

Readers pin observed rows and authority before `durable()`, then recheck after async work. They never
select a later unsaved latest row or authority as positive evidence. Concurrent request row changes
refuse the read. On queue pages only, source/project/custody failures redact the affected row rather
than failing the whole page or silently omitting it. History, receipt lookup and mutations still
refuse unavailable source access. Workspace loss alone does not remove readable retained bytes.
This does not widen existing read scope or promise source access after membership/custody loss.

## Fixed global read seam

```
GET /api/review/requests?after=N[&sessionId=id]
=> {requests:[{requestId,sequence,state,actionability,projectId,sessionId,title,comparison}],next}
```

Each queue entry is either the unchanged healthy row above or exactly:

```ts
{ requestId, sequence, state, unavailable: true }
```

An unavailable row has no title, project/session IDs, target/comparison, reason, path, raw error or
actionability. It keeps its original sequence and state. Clients must show it as disabled/unavailable,
never empty, ready or reviewed. A passive Refresh can recover the healthy row when legitimate current
access returns. GET does not restore access, move a chat, replace a target, grant authority or change
requests, history, requirements or receipts. Withdrawal, snooze, retirement, history and operation
recovery keep their existing current-access checks; the redacted row grants none of these actions.

At most 20 rows per page, ascending **request creation sequence**, independent of `comparison.sequence`.
`next` is the last request sequence when more rows exist, otherwise null. This is read-point
pagination, not an atomic cross-page snapshot or a change feed. A later refresh from zero sees
transitions to existing rows. All persisted states, including snoozed and terminal history entries,
remain readable; consumers may present waiting/history filters without inventing state. `sessionId`
is equality-only and optional. No automatic focused-chat/mission filter. Unknown filters/duplicate
query keys are rejected. The default spans all supported requests, with current access checked per
row and after async reads. Only per-row source access, qualification and fence failures become
unavailable entries. Earlier rows are rechecked while later rows await and after durability; a revoked
row loses its details too. Once redacted, a row stays redacted for that read, without selecting fresh
authority after the barrier. All slots, including unavailable entries, count toward the 20-row limit
and keep the original cursor position and exact optional session filter. Page/store, durability and
cursor failures still fail the whole request, never fabricate empty success. There is no live-file
fallback. Missing request service is 503.
Successful empty coverage means no matching supported **optional suggestions**, not that required
approvals are satisfied or that every capture was reviewed.

`GET /api/review/requests/:requestId/history?after=revision` returns at most 20 original request
revisions under the same current Local app source access. It is not an approval history replacement.

`HumanReviews.requirement(target)` uses the request store's exact per-target request IDs, revisions
and states. Pending/snoozed optional suggestions project `requested`; absent suggestions project
`not_requested`; terminal suggestions project `withdrawn`; excessive/unsupported coverage remains
`unknown`. None returns `required`. The identity changes with explicit transitions, fencing stale
feedback packages. The human-review store still owns dispositions, blockers and human-owned threads.
Missing production prerequisites continue to refuse Approve, regardless of optional request state.

## Verification and limits

Focused request tests exercise real missions.sqlite reopen, exact/concurrent deduplication, lost
acknowledgements, original historical lookup after withdrawal/replacement, distinct actor origins,
revision CAS, bounded/equality-only reads, exact redaction at first/middle/later-page slots, stable
cursors, missing/moved chats, removed projects, unreadable snapshots, revocation during later-row
reads and durability, fresh-access recovery, and global store/barrier/cursor refusal. They also cover
retained workspace loss, native capability admission, real standalone/v1 mission custody and IPC producers.
Feedback tests preserve exact per-target fences and no production approval prerequisites.
Native submission UI, required-request creation, authoritative work cancellation, Inbox links,
learning, provider execution and gate activation remain separate. No live data was adopted.
