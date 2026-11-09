# Day interview and agreement backend

Host-only implementation. No production route, coordinator startup flag, native confirmation,
dispatch adapter, legacy enrollment or gate activation is installed. Local tests use temporary
homes and a faux admission adapter. Passing these tests is not native acceptance or permission
to activate the flow. Existing mission admission behavior is unchanged.

## New-flow enrollment and confirmation boundaries

`MissionInterviews` consumes purpose-bound `DurableOperation` envelopes through `OperationJournal`.
The integrating host must enforce native host-action ingress for creation, answer saves, submission,
approval and starts. Question rounds come from the authorized coordinator, not a trusted user label.
No `actor` field or skill instruction grants that authority. Do not expose this seam as an
unauthenticated legacy route.

- `interview-create` targets a fresh host-chosen enrollment ID. It creates a new planningVersion 1
  mission, attaches the named coordinator, and saves the initial question set in one transaction.
  It accepts no existing mission ID. Enrollment is unique and creation recovery is exact lookup.
  The host must hold the new coordinator at the interview boundary, not start an ordinary legacy
  coordinator and assume these records will stop it. Creation cannot itself dispatch work.
- `interview-questions` appends a complete frontier. `interview-save` saves explicit selections and
  custom text. Both require the exact mission, enrollment, coordinator, question-set revision,
  answer revision and saved-state revision. Neither wakes the coordinator.
- `interview-submit` is one explicit action over the complete saved snapshot. Missing/blank answers,
  stale question meanings or option identity/wording refuse. It atomically saves the submitted
  snapshot and maps its exact answers to a new agreement brief. Submission grants no tool, model,
  build or delivery authority. The historic snapshot and receipt stay intact after amendments.
- `interview-continue` is a separately journaled planning-only admission of that exact submission.
  A production host must retain its envelope and dedupe by submission ID, not send an ordinary
  user message or invent a new operation after losing the ACK. Autosave/individual answers never
  call it. A new frontier invalidates an unentered continuation from the preceding round.
- Existing `WorkflowConfirmations` prepares and confirms the complete immutable package, now
  including the exact interview submission for enrolled missions. Complete submission is not
  workflow approval. A changed answer/question, brief, owner, decision or configuration invalidates
  the prior approval. No amendment inherits old authority, including edit/revert. All affected
  work needs a fresh complete submission and exact approval. This conservative first version
  does not infer which refinements fall within a delegated envelope.
- `agreement-start` consumes the exact submission, approval operation/package and a host-owned
  assignment/owner/allocation digest. The host authorizer must check assignment scope against the
  approved agreement, not accept a coordinator-provided digest as proof. Independent model,
  permission, review and delivery checks remain required.
- `small-ask-start` is the direct path for one explicitly confirmed standalone Build request. Its
  host-prepared package binds request ID, project, exact text and current model/permission/project
  configuration. A qualified adapter creates a **new** standalone Build clone. It never creates a
  hidden mission, adopts an existing session or interprets an ordinary message as confirmation.
  Permission denial, unavailable adapters and changed configuration do not admit work.

## Saved state and recovery

`mission_interviews` is append-only in `missions.sqlite`, with the existing in-memory transaction,
replica and `durable()` barrier. Question IDs stay stable within the interview. Recommendations
are separate from user-selected options. Selected options keep their ID and exact displayed meaning;
custom text keeps exact bytes. Question changes keep earlier draft meanings/text. Changed questions
cannot become answered merely by copying the latest digest. Removed answers remain in history.
Submission uses only answers belonging to the current full list.

The service checks the coordinator/membership event fences, including owner ABA, on reads and writes.
Reads pin state before durability and reject changes afterward. Snapshot writes use exact CAS inside
the transaction. The workflow approval package includes the full submitted evidence and refuses above
60 KiB rather than truncating it.

`mission_flow_entries` reserves one continuation per submitted snapshot, one start per exact assignment
digest and one small-ask start per request ID. A second envelope cannot bypass an uncertain first
entry. Before effects, the journal durably checkpoints exact purpose and payload hash. Replies follow
store durability. Any re-entry, including restart, is lookup-only. Missing/unreadable rows, missing
checkpoints and uncertain admissions remain pending (Unknown), never replay. Exact historic rows or
committed adapter receipts may settle the original operation without renewing current authority.

`QualifiedMissionFlowAdapter` is deliberately absent in production. It must perform its own current
model/permission/lifecycle checks and invoke the supplied synchronous guard at the actual admission
commit, after all asynchronous preparation. It must durably record the complete operation and provide
exact lookup. A queued future start without that guarded commit is not acceptance. Approval guards
also refuse pending revocations or journal I/O that could hide a not-yet-published revocation.
These records do not stop already-running agents; mission Pause is a separate protocol.

## Actual upstream skills

The kernel bundles unmodified `mattpocock/skills` `grill-with-docs`, `grilling`, `domain-modeling` and
the latter's format references. The pinned source, version and MIT attribution are in
`packages/kernel/skills/mission-interview/UPSTREAM.md` and `upstream/LICENSE`.

The explicit host-only `NativeAdapterOptions.missionInterview` requires the trusted coordinator
profile. It adds the actual entries through Pi's normal resource loader and captures their paths
in the existing coordinator skill-reader allowlist. Missing/shadowed upstream entries fail closed;
personal skills are not overwritten. Ask/read-only profiles cannot enable it. Runtime packaging
already copies the kernel skills tree; paths resolve relative to the relocated module.

The adapter tells Pi to read the actual dependencies instead of invoking an unavailable Skill tool.
It adapts upstream's whole-frontier rounds to saved full-list native questions, options plus text,
and the exact submission gate. Documentation remains a proposal within existing write permissions.
Skill prose cannot start subagents, write files, expand permissions or bypass lifecycle checks.
There is no parallel imitation grilling prompt. Real generation and native confirmation journeys
still need the new host/UI integration; loader and receipt fixtures do not establish that acceptance.

## Checks

`mission-interviews.test.ts` covers partial answers, recommendations, option/custom/detail answers,
changed meanings/frontiers, concurrent edits, stale and duplicate submissions, owner ABA, changed
agreements, stale approval, denied/unavailable starts, final commit rechecks, pending revocation,
lost ACKs, restart, missing effects and durability failures. `mission-interview-skills.test.ts` checks
real loader/reader selection, upstream hashes/license, collision refusal and relocated entry paths.
