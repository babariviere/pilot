# Retained contribution allocation (internal)

This dormant host-only foundation records **later coordinator allocation of selected
retained contributions to a task's assessment scope**. It does not establish the
task that originally caused a jj operation. Historical task attribution remains
**Unknown**, even for a worker with proven creation/custody provenance. Enrollment
tasks, the current assignment, text, author and apparent intent cannot fill that gap.
Archived investigation chats are not restored or adopted.

## Exact bounded scope

`MissionService.recordContributionAllocation(sessionId, taskRef, request)` accepts
schema-v1 `action: allocate` with:

- Mission-local operation ID and `expectedAllocationId` (latest record CAS, initially null).
- Exact current [delivery submission](delivery-evidence.md) ID, full assignment
  revision/content including classification, actual owner, and the existing
  `sharedDefinitionRevision` as `definitionRevision`. These must match the submission
  and current task, not merely a caller's declaration of its task.
- `expectedContextFence`: the existing review brief/decision/artifact/member event
  fence extended **only for allocation** with the latest existing coordinator event
  ID. Historical [review records](mission-review-records.md) are unchanged. Mission-wide
  conservative invalidation catches pin/custodian/membership and coordinator A→B→A
  churn, including continuation/detach. No global revision counter is added.
- 1–20 selected `sources`, each an exact submitted reference, digest, custodian and
  retained availability, plus a concise reason describing the bounded scope.

Sources may be a subset of submitted evidence. `scopeCoverage: selected-only` is
always explicit, even when every submitted reference is selected. This is neither
exhaustive contribution inventory nor criterion coverage. Code submissions **must
select their own exact retained comparison**, not rely on an unselected snapshot
or a report/image alone. A partial/unavailable required comparison cannot allocate.
Native UI/report artifacts are proportional retained evidence, not code-free proof
or proof of native rendering/input. A research kind cannot establish no code work.

Source bytes stay in existing [snapshot](review-snapshots.md), artifact and brief
stores. No duplicated blobs, receipt vault, arbitrary path/URL, latest revision or
live-workspace fallback exists. Snapshot IDs bind exact repository/change,
operation, base/head and comparison scope through their hashed retained manifest.
Frozen creation/custody provenance remains there, separately from later allocation.
Only the existing proven same-worker/same-mission snapshot custody is supported;
Unknown, borrowed/other-worker and unsupported custody are explicitly refused,
never inferred or transferred. A stack comparison does not prove the worker created
all ancestor content. Non-code custodians must be current same-mission/project
members and artifacts must have exact task pins; custody is not authorship.

## Append, invalidate, recover

Records append to one table in the existing mission SQLite database. Allocation
supersedes the exact latest record. `action: withdraw` has only operation ID,
expected latest allocation ID and reason, so the coordinator can withdraw stale
scope without reading vanished sources. Withdrawal never reactivates a predecessor.
A new allocation after withdrawal still needs a new current submission/fences.
Bounded history pages (1–100) and indexed exact/latest reads retain prior records.
Records use the existing review-record 256 KiB cap; source reads run sequentially
with existing reader bounds.

Host-supplied session identity, current project, durable membership and current
coordinator role are checked **before even retry/lookup**. Payload actor/role/gate
fields are rejected. No former-coordinator recovery privilege exists. Exact operation
identity includes mission, task, recorder, action and complete normalized request;
any difference conflicts. Operation IDs are local to this record domain, not a
cross-domain execution journal. Exact retries and `lookupContributionAllocation`
recover the same historical record before consulting mutable source/CAS state.
An absent lookup means no such record was found at the lookup's read point and the
durability barrier then completed. No in-flight reservation is tracked: a concurrent
write still resolving sources may append later. Absence is not proof that an
arbitrary external action never happened. Lost ACK remains Unknown
until authorized exact lookup/retry succeeds. No shell/JS replay is performed.

All successful writes, retries and present/absent lookups await `durable()` and
recheck recorder authorization before returning. Disk failure does not produce a
successful ACK. New writes recheck assignment, owner/definition, submission,
context, latest-ID CAS, task pins and source actors after asynchronous reads and
inside the mission-store transaction. The retained stores and session metadata do
**not** share that transaction. This is point-in-time host admission, not atomic
cross-store freshness, hostile-filesystem isolation or authenticated shell/REST
confinement. Successful persistence is not ongoing authorization or applicability.

`evaluateContributionAllocation` re-resolves exact selected identities and compares
the latest submission/allocation and task/context fences. It reports pinned-record
applicability as `current`, `outdated` or `unavailable`, with reasons. Release/reclaim
ABA, reassignment, changed criteria/content, source revisions, continuation and
context churn never resurrect old approval. Missing/corrupt/partial required refs
stay unavailable. A validated retained manifest is **not readable-all-blobs proof**:
individual later source reads can fail and must remain unavailable, never fall back.

## Deliberately not acceptance

Allocation is separate from worker claim, coordinator delivery judgement,
check/review outcome, authority, independent/human review, current live-source
freshness, acceptance and integration. Every corresponding gate output stays
unavailable, including completion eligibility and contribution completeness.
Unknown, missing, stale, failed or skipped gates never pass. No allocation marks
done, proves landing/CI, code-free research or independent review, grants authority,
or waives any delivery gate. Earlier evidence/review/legacy retry semantics remain
unchanged, and no existing gate consumes these records.

Activation still requires trusted transport design, explicit compatibility/adoption,
implemented check/review/authority policy and observations, contribution completeness,
live-source and integration verification, and final coordinator/user acceptance.
No agent/HTTP/IPC/UI transport, execution/check runner, active acceptance/completion,
live migration, interception, cleanup, merge, release or restart is installed here.

### Proportional examples

| Submission | Selected allocation | Unproved |
| --- | --- | --- |
| Code | Exact retained layer/stack snapshot, optionally pinned test report | Original task purpose, exhaustive scope, tests/review, current source, landing |
| Native UI | Exact pinned capture/report revisions | Real native interaction, code-free work, independent review |
| Research | Pinned report/artifact or current exact brief revision | Complete research, source truth, code-free work, required gates |
