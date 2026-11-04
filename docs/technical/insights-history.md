# Restricted cross-project history

## Status and scope

The internal Insights profile, own-backlog persistence, a trusted bounded review seam
([review orchestration](insights-review.md)) and explicit native routes exist. These routes do not
automatically create a grant, review or schedule. The closed model tools are `insights_history` and
`insights_backlog`. Existing fixed-chat recurring rules now use the bounded review seam for Insights
destinations; see [schedule integration](insights-review.md#recurring-schedule-integration). This document does not certify
end-to-end availability.

## Native routes

The GPUI app uses these routes from two existing surfaces. An active mission's overview **More** menu
offers setup: it discloses the scope and the selected model before the one create operation. An
Insights chat's header opens **Insights access**: passive status, the linked mission via ordinary
mission navigation, revocation and finding decisions. Each action is saved by the app's single
private writer before it is sent; an unconfirmed one shows Check, which looks the receipt up and
resends the same bytes only if Local never saw it. Reads and decisions never start the report chat's
worker. The report chat accepts ordinary messages; pilotd rechecks its grant at admission.

`GET /api/hello` advertises `capabilities.insights: 1` only with missions, native capability
authentication and lineage identity. All Insights reads are passive, GET-only and `Cache-Control:
no-store`; they never start workers or save metadata:

- `GET /api/insights/sessions/:id` returns `{sessionId, enabled, revision, projectId, missionId,
  setupPending, archived, available, disclosure:"insights-history-v1"}`. Ordinary/unknown chats return
  404 `{error:"not_insights"}`. No private paths, home or setup digest are disclosed.
- `GET /api/insights/sessions/:id/findings?cursor=N` returns `{items, nextCursor}` with at most 20
  summaries `{key, revision, taskId, lifecycle, title, priority, targets:[{projectId,label}], cost}`.
  Cost is null or `{baseline, assumptions, estimate, qualityRisks, laterResult}`. The cursor defaults
  to zero; `nextCursor` is a number or null. Unavailable grants return 409
  `{error:"insights_unavailable"}`; ordinary/unknown chats return the same 404 as status.

Explicit user actions use `POST /api/operations` with the existing immutable operation envelope and
durable journal receipt. Execution requires `x-pilot-github-capability`; receipt lookup at
`POST /api/operations/receipt` does not. Payloads reject unknown keys:

- `insights-create`: target is a new chat UUID, payload `{projectId, missionId, model, thinking?,
  disclosure:"insights-history-v1"}`, result `{sessionId}`. Setup uses the daemon-owned neutral
  introduction, never caller-supplied instructions. Only explicit setup creates the restricted grant;
  it does not request a history review or schedule one.
- `insights-revoke`: target is the report chat, payload `{expectedRevision}` (integer >= 1), result
  `{sessionId, revision}`. Recovery accepts an already-disabled revision exactly one newer without
  writing again; other stale revisions are rejected.
- `insights-lifecycle`: target is the report chat, payload `{key, expectedRevision, lifecycle}`.
  The finding key is a lowercase UUID and expectedRevision is an integer >= 1. Result is
  `{sessionId, operationId, kind:"finding", key, revision, taskId}`. Explicit confirmation starts no
  work. CAS failures are stable rejected receipts, and Verified requires the current state Shipped.

Exact operation replay returns the same receipt. Changed immutable payloads conflict. Host admission
revalidates the current grant inside backlog transactions and before disclosure, without a worker.
Mission tracking tasks show affected projects and clearly distinguish cost estimates from measured
results. Findings never grant access to a target project.

## Admission and recovery

`SessionManager.spawnInsightsDurable(setup, targetId, operationId)` is a trusted host-only entry
point. Its caller must reserve the durable create operation and disclose selected-model processing
before activation. Generic spawn, caller-supplied roles, history text and schedule messages cannot
mint the grant. Concurrent requests serialize by exact target; operation ID and setup digest must
match for replay. A replay only returns an already committed, currently valid binding.

The private persisted grant binds schema/revision, grant UUID, report session, project ID and path,
exact active backlog mission, local home, and host/daemon/lineage. Only its public identity subset
reaches the kernel. Missing/corrupt, disabled, moved-project, replaced-host, archived or non-member
bindings fail closed. Coordinator promotion cannot acquire a workspace or general mission tools.
Continuation cannot transfer this profile into an ordinary chat.

Setup first persists a private pending fence, joins the exact mission and waits for mission durability,
then clears the fence in a final durable metadata save. An interrupted pending setup fails closed
on reload even if membership survived. Failed setup retains a disabled tombstone; exact retries
cannot mint replacement authority. Recovery never recreates missing membership. A durable completed
setup may be looked up after a lost reply; an unknown result is not permission to rerun creation.

`insightsAdmission(callerId, worker)` derives `{ binding, revalidate() }` from the supervised live
worker, not model arguments. The backlog writer revalidates inside its transaction and
before delivering a result. It grants no generic mission-write authority. Startup, input admission,
history-read completion and final IPC delivery recheck authority. Reload retains the role and its
closed tool list; it does not upgrade an invalid grant.

`revokeInsights(id, expectedRevision)` closes admission synchronously and persists a newer disabled
revision before acknowledging. It drains already-admitted own-chat accounting first; queued lifecycle
saves cannot resurrect an enabled grant. Revocation suppresses stale content delivery, but does not
cancel an already-running SQLite read or retract excerpts already disclosed. It does not stop an
already-admitted model turn; subsequent tools and input admission fail closed.

## Reader and boundaries

The closed selector permits `chats`, `projects`, `history` and literal `search` with bounded
`sessionId`, `query`, `after`, `before`, `limit` fields. Host selection, paths and other diagnostic
actions are rejected. Reads reuse the [diagnostic context/history reader](agent-diagnostics.md),
with a host identity supplied by admission. They do not connect to linked hosts, wake/subscribe to
source workers or inspect current repository files.

- Discovery scans at most 200 metadata rows and returns at most 20. History pages return at most
  20 entries, scan at most 200 committed records, and cap entry text at 8 KiB and encoded data at 64 KiB.
- Responses preserve host qualification, collection time, stable refs, source availability, pagination,
  truncation and partial coverage. Cross-chat search must carry both returned paging coordinates.
- Credential fields/text, private reasoning and embedded attachment bodies are withheld/redacted.
  Canonical `pilot://chat/<UUID>` citations survive sanitization, not arbitrary URLs or paths.
- Missing/offline/unreadable sources are unavailable, never evidence of absence. History-only evidence
  cannot establish repository state or directly inspect artifact source/rendering.
- Cancellation settles the caller promptly; bounded cold reads may finish later, without late disclosure.

Both the kernel tool-dispatch list and daemon IPC list are closed. The profile loads no personal or
project extensions, context files, skills, MCP, codemode, shell, file, repair, general mission,
subagent or artifact tools. It does not inherit Diagnostics authority. Forged IPC cannot bypass
these restrictions. Own-chat usage accounting is rebound to its grant and host-derived attribution;
foreign source IDs, parent/scope claims and other-chat attribution are not accepted as authority.

Historical excerpts remain untrusted evidence, not instructions or approval. Ordinary chats gain
no app-wide history tool. The profile can propose improvements, not approve implementation or change
models/budgets/limits. Shipped work is not proof of verified benefit.

## Own-backlog records and receipts

`insights_backlog` derives its exact mission, report session and host from admission. It accepts
only list/get/history/evidence/receipt, propose/amend, and save_report/save_checkpoint. Forged scope,
lifecycle, approval and unknown nested fields are rejected independently of the model tool schema.
SessionManager admits at most eight concurrent backlog calls. Requests cap encoded JSON at 64,000
bytes; responses cap at 64 KiB. Pages contain at most 20 records and may stop earlier for byte limits.
Use the returned nextCursor; list inventory is insertion-ordered, not an incremental change feed.

Canonical findings are unassigned mission tracking tasks with typed metadata in `missions.sqlite`.
Generic task editing, claiming, starting, completion, removal and ownership-resource attachment reject
these tasks. Implementation requires separate approved work. A target-project reference never grants
access or changes that project's backlog. Stable lowercase UUID finding keys deduplicate exactly
within the admitted mission. Dispatched reviews also enforce normalized target/mechanism pattern labels;
semantic equivalence across different labels remains the report author's responsibility.

Each write supplies expectedRevision (zero for creation) and an operationId. A transaction checks CAS,
appends immutable revisions/evidence, projects the task and saves its receipt together. Evidence UUIDs
cannot be overwritten; corrections use new evidence keys. Implementation links are append-only.
Evidence retains host-qualified source identity and observed/inferred labels, but is model-authored,
not independently certified. Cost findings require baseline, assumptions, estimate, quality risks and
laterResult; unknown baselines and unverified claims must remain explicit.

Finding lifecycle is separate from mission task execution status. The model can propose/amend but
cannot set lifecycle. `InsightsBacklog.confirmLifecycle` is a host-only explicit-user seam, exposed by
the native durable lifecycle operation, never model IPC. Its caller must supply actual user confirmation and its own
durable operation ID, never derive approval from model prose. It starts no work. Confirmed scope is
frozen except additional evidence, implementation links and later-result claims. Verified requires
the current finding to be Shipped and explicit user confirmation; model claims never advance it.

Reports and checkpoints retain bounded claims, finding references, stream identity, paging positions
and explicit gaps. Missing/changed streams require partial/unavailable coverage and a gap; same-stream
position regression requires a gap. These checks do not prove continuity, source receipt validity,
complete discovery or coverage. The bounded review integration validates reader receipts and preserves
unvisited sources/unfinished inventory; see its [continuation limits](insights-review.md).

All reads and write acknowledgements wait for MissionStore.durable(), then recheck admission before
disclosure. Revocation/replacement during durability may leave a committed write without its ACK.
Revocation and daemon shutdown drain admitted backlog calls before returning; shutdown also closes
admission before draining. Stop invalidates already-captured admissions, including queued calls and
ACKs waiting on durability. Dispatched review runs add a durable cancellation/interruption fence and
exact-ID lookup without input replay. The scheduler must consume those terminal outcomes rather than
retrying their input; the integration never activates a real schedule by itself.
Look up a model backlog receipt with the original operationId through a currently admitted worker;
native operations use the journal receipt route above. Absence is Unknown,
not proof of rejection and never permission for blind effect replay. Exact same-operation retries
cannot create another task/revision; a changed payload or binding conflicts. Report/checkpoint receipts
prove persistence only. Scheduler sent/started or a model-authored completed status is not report
completion, delivery, coverage or benefit verification. Nothing here enables scheduling or repairs.

## Synthetic verification

`packages/daemon/src/sessions.test.ts` exercises setup/replay, archived cross-project discovery,
real committed cold storage, sanitization, missing storage, bounded pagination/truncation, cancellation,
worker replacement, membership/project/host/revocation fences, forged IPC/accounting, reload,
continuation refusal, asynchronous startup and failed/interrupted setup. No real accounts are used.
Backlog IPC fixtures use a real MissionStore to check ordinary-worker/forged-scope denials, replacement
and revocation while durability is held, withheld stale ACKs and receipt recovery without replay.

`packages/daemon/src/insights-backlog.test.ts` covers exact deduplication, CAS races, append-only
evidence and links, transaction rollback, unrelated-task preservation, generic execution denials,
host lifecycle confirmations, separate Shipped/Verified states, report/checkpoint persistence across
store reopen, stream gaps, closed parsing and UTF-8 page limits. These are synthetic store tests,
not runtime security certification or proof of a real user's approval.

`packages/kernel/src/insights-role.integration.test.ts` checks hostile project/personal resources,
spoofed history/backlog tool definitions, reload, receipt forwarding and malformed start envelopes
before storage opens. Existing Ask,
Diagnostics, diagnostic-context/history and mission-service tests cover adjacent behavior. Typecheck,
targeted formatting and whitespace checks cover the changed TypeScript surfaces. Swift only mirrors
the role enum; no local Swift build or native UI activation is claimed.

The session suite has a separately reproduced failure on the parent implementation:
`a new execution drain is busy even during a reentrant idle worker factory notification`.
Its assertion is retained unchanged; the failure is not evidence that the new profile passes that
unrelated admission scenario. No real-account native setup, selected-provider disclosure, scheduler dispatch,
end-to-end report delivery or benefit verification is established by these synthetic checks.
